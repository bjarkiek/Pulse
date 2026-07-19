#Requires -Version 7.0
<#
.SYNOPSIS
  Creates all Azure resources for DataCentral Pulse (App Service container host,
  Azure SQL Database, Key Vault, Storage, Container Registry) by deploying
  infra/main.bicep, then wires the App Service managed identity to pull from ACR.

.DESCRIPTION
  Run this ONCE per environment. It is safe to re-run (idempotent). It does NOT
  build or ship the app image — run infra/deploy.ps1 for that.

  Authentication model created here:
    * Azure SQL uses Entra-only auth. YOU (the signed-in az user) become the SQL
      Entra admin, so deploy.ps1 can run migrations and grant the app access.
    * The App Service uses a system-assigned managed identity for SQL, Blob,
      Key Vault, and ACR pull — there are no SQL passwords anywhere.

  Secrets (session key, MCP signing key, DataCentral HMAC secret, webhook/job
  secrets) are generated here and stored in Key Vault. They are never written to
  disk. Retrieve the DataCentral HMAC secret from Key Vault ('dc-app-secret') if
  you need to configure the DataCentral host.

.PREREQUISITES
  * Azure CLI (`az`) logged in:  az login
  * Rights to create resources + role assignments in the target subscription.
  * You are an interactive user (not a service principal) so you can be the SQL
    Entra admin.

.EXAMPLE
  ./provision.ps1 -NamePrefix dcpulseprod -Location westeurope

.EXAMPLE
  # With standalone Microsoft sign-in + the AI assistant enabled:
  ./provision.ps1 -NamePrefix dcpulseprod `
    -EntraClientId <app-client-id> -EntraClientSecret <secret> `
    -AnthropicApiKey sk-ant-...
#>
[CmdletBinding()]
param(
  # 3-18 chars, lowercase letters/digits/dashes. Used to name every resource.
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z][a-z0-9-]{1,16}[a-z0-9]$')]
  [string]$NamePrefix,

  [string]$ResourceGroup = "$NamePrefix-rg",
  [string]$Location = 'westeurope',
  [string]$SubscriptionId,

  # --- Optional feature configuration (leave unset to provision without them) ---
  # Microsoft Entra standalone sign-in (OIDC). Without these, the only way in is
  # the DataCentral embed; there is no built-in username/password login.
  [string]$EntraClientId,
  [string]$EntraTenantId,
  [string]$EntraClientSecret,

  # AI assistant (in-app chat + Slack). Optional.
  [string]$AnthropicApiKey,
  [string]$SlackBotToken,
  [string]$SlackAppToken,

  # Azure Communication Services email (notification delivery). Optional.
  [string]$CommunicationEmailEndpoint,
  [string]$CommunicationEmailSender,

  # ACR SKU. Basic is plenty for a single app.
  [ValidateSet('Basic', 'Standard', 'Premium')]
  [string]$AcrSku = 'Basic'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor Gray }

function Invoke-Az {
  # Runs `az` and throws on non-zero exit. Returns raw stdout (usually JSON).
  param([Parameter(ValueFromRemainingArguments)][string[]]$AzArgs)
  $out = & az @AzArgs
  if ($LASTEXITCODE -ne 0) { throw "az $($AzArgs -join ' ') failed (exit $LASTEXITCODE)" }
  return $out
}

function New-Base64Secret([int]$Bytes = 48) {
  $buf = [byte[]]::new($Bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buf)
  return [Convert]::ToBase64String($buf)
}

function Get-OrNewSecret {
  # Reuse the current Key Vault value on re-provision so generated secrets don't
  # rotate (rotating them would drop every session, invalidate MCP tokens, and
  # break the already-configured DataCentral embed). First provision generates,
  # because the vault doesn't exist yet.
  param([string]$SecretName, [int]$Bytes = 48)
  $existing = & az keyvault secret show --vault-name $script:vaultName --name $SecretName --query value -o tsv 2>$null
  if ($LASTEXITCODE -eq 0 -and $existing) { return $existing.Trim() }
  return New-Base64Secret $Bytes
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$bicep = Join-Path $PSScriptRoot 'main.bicep'
if (-not (Test-Path $bicep)) { throw "main.bicep not found next to this script ($bicep)" }

# ACR name: globally unique, alphanumeric, 5-50 chars.
$acrName = ($NamePrefix -replace '-', '') + 'acr'
if ($acrName.Length -gt 50) { $acrName = $acrName.Substring(0, 50) }
$appName = "$NamePrefix-app"

# Key Vault name, derived exactly as main.bicep does: take(replace(prefix,'-',''),18)+'-kv'.
$vaultBase = ($NamePrefix -replace '-', '')
if ($vaultBase.Length -gt 18) { $vaultBase = $vaultBase.Substring(0, 18) }
$vaultName = "$vaultBase-kv"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
Write-Step 'Preflight'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) is not installed or not on PATH.' }

$acctJson = & az account show -o json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $acctJson) { throw 'Not logged in. Run: az login' }
$account = $acctJson | ConvertFrom-Json
if ($SubscriptionId) { Invoke-Az account set --subscription $SubscriptionId | Out-Null; $account = Invoke-Az account show -o json | ConvertFrom-Json }
Write-Info "Subscription: $($account.name) ($($account.id))"

# The signed-in user becomes the SQL Entra admin.
$me = Invoke-Az ad signed-in-user show -o json | ConvertFrom-Json
if (-not $me.id) { throw 'Could not resolve the signed-in user. Sign in as an interactive user (not a service principal).' }
$sqlAdminLogin = $me.userPrincipalName
$sqlAdminOid = $me.id
Write-Info "SQL Entra admin will be: $sqlAdminLogin"

# Entra sign-in prerequisites: bicep requires a value for entraClientSecret even
# when standalone login is off. Generate a harmless placeholder if not using it.
if ($EntraClientId -and -not $EntraClientSecret) {
  throw 'When -EntraClientId is set you must also pass -EntraClientSecret (the confidential-client secret).'
}
$entraSecretValue = if ($EntraClientSecret) { $EntraClientSecret } else { Get-OrNewSecret 'entra-client-secret' }
$entraTenantValue = if ($EntraTenantId) { $EntraTenantId } else { $account.tenantId }

# ---------------------------------------------------------------------------
# Resource group + container registry
# ---------------------------------------------------------------------------
Write-Step "Resource group ($ResourceGroup)"
Invoke-Az group create --name $ResourceGroup --location $Location -o none
Write-Info 'ready'

Write-Step "Container registry ($acrName)"
Invoke-Az acr create --resource-group $ResourceGroup --name $acrName --sku $AcrSku --admin-enabled false -o none
$acrLoginServer = (Invoke-Az acr show --name $acrName --query loginServer -o tsv).Trim()
$acrId = (Invoke-Az acr show --name $acrName --query id -o tsv).Trim()
$containerImage = "$acrLoginServer/pulse:latest"
Write-Info "login server: $acrLoginServer"
Write-Info "The Web App will be created pointing at $containerImage (pushed by deploy.ps1)."

# ---------------------------------------------------------------------------
# Deploy the Bicep template (App Service, SQL, Key Vault, Storage, secrets)
# ---------------------------------------------------------------------------
Write-Step 'Deploying infra/main.bicep'

# Build an ARM parameters file so generated secrets never hit the command line
# or shell history. Written to a temp file and deleted in finally.
$params = [ordered]@{
  namePrefix            = @{ value = $NamePrefix }
  location              = @{ value = $Location }
  containerImage        = @{ value = $containerImage }
  sqlEntraAdminLogin    = @{ value = $sqlAdminLogin }
  sqlEntraAdminObjectId = @{ value = $sqlAdminOid }
  scanWebhookSecret     = @{ value = (Get-OrNewSecret 'attachment-scan-webhook-secret') }
  notificationJobSecret = @{ value = (Get-OrNewSecret 'notification-job-secret') }
  webhookSigningSecret  = @{ value = (Get-OrNewSecret 'webhook-signing-secret') }
  sessionSecret         = @{ value = (Get-OrNewSecret 'pulse-session-secret') }
  entraClientSecret     = @{ value = $entraSecretValue }
  dcAppSecret           = @{ value = (Get-OrNewSecret 'dc-app-secret') }
  mcpTokenSigningKey    = @{ value = (Get-OrNewSecret 'mcp-token-signing-key' 64) }
  entraTenantId         = @{ value = $entraTenantValue }
}
if ($EntraClientId) { $params['entraClientId'] = @{ value = $EntraClientId } }
if ($AnthropicApiKey) { $params['anthropicApiKey'] = @{ value = $AnthropicApiKey } }
if ($SlackBotToken) { $params['slackBotToken'] = @{ value = $SlackBotToken } }
if ($SlackAppToken) { $params['slackAppToken'] = @{ value = $SlackAppToken } }
if ($CommunicationEmailEndpoint) { $params['communicationEmailEndpoint'] = @{ value = $CommunicationEmailEndpoint } }
if ($CommunicationEmailSender) { $params['communicationEmailSender'] = @{ value = $CommunicationEmailSender } }

$paramDoc = @{
  '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters     = $params
}
$paramFile = Join-Path ([System.IO.Path]::GetTempPath()) ("pulse-params-" + [Guid]::NewGuid().ToString('N') + '.json')
$deploymentName = "pulse-provision-$(Get-Date -Format 'yyyyMMddHHmmss')"
try {
  $paramDoc | ConvertTo-Json -Depth 6 | Set-Content -Path $paramFile -Encoding utf8
  $deployJson = Invoke-Az deployment group create `
    --resource-group $ResourceGroup `
    --name $deploymentName `
    --template-file $bicep `
    --parameters "@$paramFile" `
    -o json
}
finally {
  Remove-Item $paramFile -ErrorAction SilentlyContinue
}
$outputs = ($deployJson | ConvertFrom-Json).properties.outputs
$appUrl = $outputs.applicationUrl.value
$appPrincipalId = $outputs.applicationPrincipalId.value
$sqlServerName = $outputs.sqlServerName.value
$sqlFqdn = "$sqlServerName.database.windows.net"
$storageAccount = $outputs.storageAccountName.value
Write-Info "App URL:        $appUrl"
Write-Info "App identity:   $appPrincipalId"
Write-Info "SQL server:     $sqlFqdn"

# ---------------------------------------------------------------------------
# Let the App Service managed identity pull from ACR
# ---------------------------------------------------------------------------
Write-Step 'Granting the app identity AcrPull + enabling managed-identity pull'
Invoke-Az role assignment create `
  --assignee-object-id $appPrincipalId `
  --assignee-principal-type ServicePrincipal `
  --role AcrPull `
  --scope $acrId -o none
$siteId = (Invoke-Az webapp show --resource-group $ResourceGroup --name $appName --query id -o tsv).Trim()
Invoke-Az resource update --ids "$siteId/config/web" --set properties.acrUseManagedIdentityCreds=true -o none
Write-Info 'done'

# ---------------------------------------------------------------------------
# Open the SQL firewall for THIS machine so deploy.ps1 can run migrations
# ---------------------------------------------------------------------------
Write-Step 'Allowing this machine through the SQL firewall (for migrations)'
try {
  $myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 10).Trim()
  Invoke-Az sql server firewall-rule create `
    --resource-group $ResourceGroup --server $sqlServerName `
    --name 'deployer-machine' `
    --start-ip-address $myIp --end-ip-address $myIp -o none
  Write-Info "allowed $myIp (rule 'deployer-machine')"
}
catch {
  Write-Warning "Could not add a firewall rule automatically ($_). Before running deploy.ps1, add your IP: az sql server firewall-rule create -g $ResourceGroup -s $sqlServerName -n deployer-machine --start-ip-address <ip> --end-ip-address <ip>"
}

# ---------------------------------------------------------------------------
# Persist environment facts for deploy.ps1 (no secrets — names/URLs only)
# ---------------------------------------------------------------------------
$envFile = Join-Path $PSScriptRoot "azure-env.$NamePrefix.json"
[ordered]@{
  namePrefix      = $NamePrefix
  subscriptionId  = $account.id
  resourceGroup   = $ResourceGroup
  location        = $Location
  acrName         = $acrName
  acrLoginServer  = $acrLoginServer
  appName         = $appName
  appPrincipalId  = $appPrincipalId
  appUrl          = $appUrl
  sqlServerName   = $sqlServerName
  sqlFqdn         = $sqlFqdn
  sqlDatabase     = 'Pulse'
  storageAccount  = $storageAccount
} | ConvertTo-Json | Set-Content -Path $envFile -Encoding utf8

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Step 'Provisioning complete'
Write-Host @"
  Resource group : $ResourceGroup
  Registry       : $acrLoginServer
  App URL        : $appUrl   (shows an error until you run deploy.ps1)
  Environment    : $envFile

  NEXT:  ./deploy.ps1 -NamePrefix $NamePrefix
"@ -ForegroundColor Green

if (-not $EntraClientId) {
  Write-Warning @"
No Entra sign-in configured. The app will run but nobody can sign in through
Microsoft (the demo login is disabled in production). To enable standalone
sign-in, register an Entra app with redirect URI $appUrl/auth/callback and
re-run with -EntraClientId/-EntraClientSecret, or configure the DataCentral
embed (its HMAC secret is in Key Vault as 'dc-app-secret').
"@
}

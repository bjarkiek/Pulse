#Requires -Version 7.0
<#
.SYNOPSIS
  Builds and ships DataCentral Pulse to the Azure resources created by
  provision.ps1: builds the container image in ACR, points the Web App at it,
  grants the App Service managed identity access to Azure SQL, applies database
  migrations, restarts, and health-checks.

.DESCRIPTION
  Safe to run repeatedly — every deploy. The image is built in Azure Container
  Registry (ACR Tasks), so no local Docker is required. Migrations are tracked
  in dbo.SchemaMigrations and applied only once each.

  You must be the Azure SQL Entra admin (the user who ran provision.ps1) so the
  script can create the app's SQL login and run migrations. Uses your az login
  for a short-lived SQL access token — no passwords.

.PREREQUISITES
  * Azure CLI (`az`) logged in as the SQL Entra admin:  az login
  * PowerShell 'SqlServer' module (auto-installed for the current user if absent)
  * Your machine's IP allowed through the SQL firewall (provision.ps1 does this)

.EXAMPLE
  ./deploy.ps1 -NamePrefix dcpulseprod

.EXAMPLE
  # Skip the DB steps (image-only redeploy):
  ./deploy.ps1 -NamePrefix dcpulseprod -SkipMigrations
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z][a-z0-9-]{1,16}[a-z0-9]$')]
  [string]$NamePrefix,

  [string]$ResourceGroup,
  [string]$SubscriptionId,

  # Image tag. Defaults to the git short SHA, else a timestamp.
  [string]$Tag,

  # Skip the SQL user/grant + migration step (image-only redeploy).
  [switch]$SkipMigrations
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments)][string[]]$AzArgs)
  $out = & az @AzArgs
  if ($LASTEXITCODE -ne 0) { throw "az $($AzArgs -join ' ') failed (exit $LASTEXITCODE)" }
  return $out
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerfile = Join-Path $repoRoot 'Dockerfile'
$migrationsDir = Join-Path $repoRoot 'database/migrations'
if (-not (Test-Path $dockerfile)) { throw "Dockerfile not found at $dockerfile" }

# ---------------------------------------------------------------------------
# Resolve environment (prefer azure-env.<prefix>.json from provision.ps1)
# ---------------------------------------------------------------------------
Write-Step 'Preflight'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) is not installed or not on PATH.' }
$acctJson = & az account show -o json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $acctJson) { throw 'Not logged in. Run: az login' }
if ($SubscriptionId) { Invoke-Az account set --subscription $SubscriptionId | Out-Null }

$envFile = Join-Path $PSScriptRoot "azure-env.$NamePrefix.json"
$appPrincipalId = $null
if (Test-Path $envFile) {
  $envCfg = Get-Content $envFile -Raw | ConvertFrom-Json
  if (-not $ResourceGroup) { $ResourceGroup = $envCfg.resourceGroup }
  $acrName = $envCfg.acrName
  $acrLoginServer = $envCfg.acrLoginServer
  $appName = $envCfg.appName
  $sqlServerName = $envCfg.sqlServerName
  $sqlFqdn = $envCfg.sqlFqdn
  $sqlDatabase = $envCfg.sqlDatabase
  if ($envCfg.PSObject.Properties.Name -contains 'appPrincipalId') { $appPrincipalId = $envCfg.appPrincipalId }
}
else {
  Write-Info "No $envFile found; deriving names from the prefix."
  if (-not $ResourceGroup) { $ResourceGroup = "$NamePrefix-rg" }
  $acrName = ($NamePrefix -replace '-', '') + 'acr'
  $appName = "$NamePrefix-app"
  $sqlServerName = "$NamePrefix-sql"
  $acrLoginServer = (Invoke-Az acr show --name $acrName --query loginServer -o tsv).Trim()
  $sqlFqdn = "$sqlServerName.database.windows.net"
  $sqlDatabase = 'Pulse'
}
$appUrl = "https://$((Invoke-Az webapp show --resource-group $ResourceGroup --name $appName --query defaultHostName -o tsv).Trim())"
if (-not $appPrincipalId) {
  $appPrincipalId = (Invoke-Az webapp identity show --resource-group $ResourceGroup --name $appName --query principalId -o tsv).Trim()
}
Write-Info "Resource group: $ResourceGroup"
Write-Info "App:            $appName ($appUrl)"
Write-Info "Registry:       $acrLoginServer"
Write-Info "SQL:            $sqlFqdn/$sqlDatabase"

# Image tag: git short SHA, else timestamp.
if (-not $Tag) {
  $Tag = (& git -C $repoRoot rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $Tag) { $Tag = Get-Date -Format 'yyyyMMddHHmmss' }
  $Tag = $Tag.Trim()
}
$image = "$acrLoginServer/pulse:$Tag"

# ---------------------------------------------------------------------------
# Build the image in ACR (cloud build from the Dockerfile — no local Docker)
# ---------------------------------------------------------------------------
Write-Step "Building image in ACR  (pulse:$Tag)"
Invoke-Az acr build `
  --registry $acrName `
  --image "pulse:$Tag" `
  --image 'pulse:latest' `
  --file 'Dockerfile' `
  $repoRoot
Write-Info "built and pushed $image"

# ---------------------------------------------------------------------------
# Database: app SQL user + grants, then migrations (as the Entra admin = you)
# ---------------------------------------------------------------------------
if (-not $SkipMigrations) {
  Write-Step 'Database — SQL access + migrations'

  if (-not (Get-Module -ListAvailable -Name SqlServer)) {
    Write-Info 'Installing the SqlServer PowerShell module (current user)...'
    try { Install-Module SqlServer -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop }
    catch { throw "Could not install the SqlServer module: $_. Install it manually (Install-Module SqlServer -Scope CurrentUser) and re-run." }
  }
  Import-Module SqlServer -ErrorAction Stop

  $token = (Invoke-Az account get-access-token --resource 'https://database.windows.net/' --query accessToken -o tsv).Trim()

  # Common Invoke-Sqlcmd params (encryption param name varies by module version).
  $sqlCommon = @{
    ServerInstance = $sqlFqdn
    Database       = $sqlDatabase
    AccessToken    = $token
    QueryTimeout   = 300
    ErrorAction    = 'Stop'
  }
  $icmd = Get-Command Invoke-Sqlcmd
  if ($icmd.Parameters.ContainsKey('Encrypt')) { $sqlCommon.Encrypt = 'Mandatory' }
  elseif ($icmd.Parameters.ContainsKey('EncryptConnection')) { $sqlCommon.EncryptConnection = $true }

  # Migration tracking table.
  Invoke-Sqlcmd @sqlCommon -Query @'
IF OBJECT_ID('dbo.SchemaMigrations','U') IS NULL
    CREATE TABLE dbo.SchemaMigrations (
        filename   nvarchar(260) NOT NULL PRIMARY KEY,
        applied_at datetime2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
'@
  $applied = @(Invoke-Sqlcmd @sqlCommon -Query 'SELECT filename FROM dbo.SchemaMigrations' |
    Select-Object -ExpandProperty filename)

  $files = Get-ChildItem -Path (Join-Path $migrationsDir '*.sql') | Sort-Object Name
  if (-not $files) { throw "No migrations found in $migrationsDir" }
  $newCount = 0
  foreach ($f in $files) {
    if ($applied -contains $f.Name) { Write-Info "skip  $($f.Name)"; continue }
    Write-Info "apply $($f.Name)"
    # -InputFile runs GO-separated batches on one connection, preserving the
    # file's BEGIN TRAN...COMMIT; XACT_ABORT rolls back on any error.
    Invoke-Sqlcmd @sqlCommon -InputFile $f.FullName -AbortOnError
    $safeName = $f.Name.Replace("'", "''")
    Invoke-Sqlcmd @sqlCommon -Query "INSERT INTO dbo.SchemaMigrations (filename) VALUES (N'$safeName')"
    $newCount++
  }
  Write-Info "$newCount migration(s) applied, $($files.Count - $newCount) already current"

  # Grant the App Service managed identity access (idempotent). Sequences need
  # UPDATE for NEXT VALUE FOR, so this runs after the tables/sequences exist.
  # The user is created via FROM EXTERNAL PROVIDER when the SQL server can read
  # the directory, else by SID (object id of the managed identity) — the latter
  # needs no Microsoft Graph permission, so it works in locked-down tenants.
  $sidBytes = ([Guid]$appPrincipalId).ToByteArray()
  $appSid = '0x' + ([System.BitConverter]::ToString($sidBytes).Replace('-', ''))
  Write-Info "granting SQL access to the app identity [$appName]"
  Invoke-Sqlcmd @sqlCommon -Variable @("AppUser=$appName", "AppSid=$appSid") -Query @'
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$(AppUser)')
BEGIN
    BEGIN TRY
        EXEC('CREATE USER [$(AppUser)] FROM EXTERNAL PROVIDER;');
    END TRY
    BEGIN CATCH
        -- Directory lookup not permitted for the server identity: create by SID.
        -- TYPE = E covers Azure AD users, service principals, and managed
        -- identities (TYPE = X is for Azure AD groups).
        EXEC('CREATE USER [$(AppUser)] WITH SID = $(AppSid), TYPE = E;');
    END CATCH
END
ALTER ROLE db_datareader ADD MEMBER [$(AppUser)];
ALTER ROLE db_datawriter ADD MEMBER [$(AppUser)];
DECLARE @g nvarchar(max) = N'';
SELECT @g += N'GRANT UPDATE ON OBJECT::' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N' TO [$(AppUser)];'
FROM sys.sequences;
IF LEN(@g) > 0 EXEC sys.sp_executesql @g;
'@
  Write-Info 'SQL access granted'
}
else {
  Write-Warning 'Skipping migrations (-SkipMigrations). Only use this once the database has already been migrated and the app SQL user exists — on a first deploy the app will not be able to reach SQL.'
}

# ---------------------------------------------------------------------------
# Point the Web App at the new image and restart
# ---------------------------------------------------------------------------
Write-Step 'Updating the Web App container'
Invoke-Az webapp config set `
  --resource-group $ResourceGroup --name $appName `
  --linux-fx-version "DOCKER|$image" -o none
# Re-assert managed-identity ACR pull (harmless if already set).
$siteId = (Invoke-Az webapp show --resource-group $ResourceGroup --name $appName --query id -o tsv).Trim()
Invoke-Az resource update --ids "$siteId/config/web" --set properties.acrUseManagedIdentityCreds=true -o none
Invoke-Az webapp restart --resource-group $ResourceGroup --name $appName -o none
Write-Info "pointed at $image and restarted"

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
Write-Step 'Waiting for the app to become healthy'
$healthUrl = "$appUrl/api/health"
$healthy = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 10
    if ($resp.StatusCode -eq 200) { $healthy = $true; break }
  }
  catch { }
  Start-Sleep -Seconds 10
  Write-Info "still starting... ($($i * 10)s)"
}

if ($healthy) {
  Write-Step 'Deploy complete'
  Write-Host "  $appUrl  is live (image pulse:$Tag)." -ForegroundColor Green
}
else {
  Write-Warning @"
The app did not return 200 from $healthUrl within ~5 minutes. The image and DB
are in place; the container may still be starting, or something failed at boot.
Check logs:  az webapp log tail --resource-group $ResourceGroup --name $appName
"@
}

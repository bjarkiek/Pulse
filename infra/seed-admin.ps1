#Requires -Version 7.0
<#
.SYNOPSIS
  Seeds (or repairs) the first System-admin account in the Pulse database.

.DESCRIPTION
  Production disables the demo identity and /dc-auth signs in only
  pre-provisioned users (403 not_provisioned otherwise), while the in-app Users
  UI cannot grant the 'System admin' role — so the first admin must be inserted
  directly (DEPLOY.md "Signing in"). This script does that, idempotently:

    * ensures an Internal organization exists (default ORG-INTERNAL),
    * ensures a Users row exists for -Email,
    * ensures an Active 'System admin' membership linking the two.

  Safe to re-run; re-running repairs a disabled membership or demoted role.
  Use the SAME email DataCentral launches you with (decode the dcdata URL
  parameter if unsure — it contains userEmail).

.PREREQUISITES
  * az login as the SQL Entra admin (the user who ran provision.ps1)
  * Your IP allowed through the SQL firewall (provision.ps1 added it)

.EXAMPLE
  ./seed-admin.ps1 -NamePrefix dcpulseprod -Email bjarki@datacentral.ai -Name "Bjarki Kristjánsson"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z][a-z0-9-]{1,16}[a-z0-9]$')]
  [string]$NamePrefix,

  # Must match the sign-in identity's email exactly (DataCentral launch payload
  # userEmail, or the Entra account's email for standalone sign-in).
  [Parameter(Mandatory)]
  [string]$Email,

  [Parameter(Mandatory)]
  [string]$Name,

  [string]$OrgId = 'ORG-INTERNAL',
  [string]$OrgName = 'DataCentral'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Resolve the SQL endpoint the same way deploy.ps1 does.
$envFile = Join-Path $PSScriptRoot "azure-env.$NamePrefix.json"
if (Test-Path $envFile) {
  $envCfg = Get-Content $envFile -Raw | ConvertFrom-Json
  $sqlFqdn = $envCfg.sqlFqdn
  $sqlDatabase = $envCfg.sqlDatabase
}
else {
  $sqlFqdn = "$NamePrefix-sql.database.windows.net"
  $sqlDatabase = 'Pulse'
}
Write-Host "SQL: $sqlFqdn/$sqlDatabase" -ForegroundColor Gray
Write-Host "Seeding System admin: $Name <$Email> into $OrgId ($OrgName)" -ForegroundColor Cyan

if (-not (Get-Module -ListAvailable -Name SqlServer)) {
  Install-Module SqlServer -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
}
Import-Module SqlServer -ErrorAction Stop

$token = (& az account get-access-token --resource 'https://database.windows.net/' --query accessToken -o tsv)
if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Could not get a SQL access token. Run: az login' }
$token = $token.Trim()

$sqlCommon = @{
  ServerInstance = $sqlFqdn
  Database       = $sqlDatabase
  AccessToken    = $token
  QueryTimeout   = 60
  ErrorAction    = 'Stop'
}
$icmd = Get-Command Invoke-Sqlcmd
if ($icmd.Parameters.ContainsKey('Encrypt')) { $sqlCommon.Encrypt = 'Mandatory' }
elseif ($icmd.Parameters.ContainsKey('EncryptConnection')) { $sqlCommon.EncryptConnection = $true }

# Values ride Invoke-Sqlcmd -Variable (sqlcmd $(vars)), never string-built SQL.
$result = Invoke-Sqlcmd @sqlCommon -Variable @(
  "SeedEmail=$Email", "SeedName=$Name", "SeedOrgId=$OrgId", "SeedOrgName=$OrgName"
) -Query @'
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM dbo.Organizations WHERE id = N'$(SeedOrgId)')
    INSERT INTO dbo.Organizations (id, name, type, status)
    VALUES (N'$(SeedOrgId)', N'$(SeedOrgName)', 'Internal', 'Active');

DECLARE @userId uniqueidentifier =
    (SELECT id FROM dbo.Users WHERE email = N'$(SeedEmail)');
IF @userId IS NULL
BEGIN
    SET @userId = NEWID();
    INSERT INTO dbo.Users (id, email, display_name, status, auth_method)
    VALUES (@userId, N'$(SeedEmail)', N'$(SeedName)', 'Active', 'Entra ID');
END
ELSE
    UPDATE dbo.Users SET status = 'Active' WHERE id = @userId;

IF EXISTS (SELECT 1 FROM dbo.Memberships
           WHERE user_id = @userId AND organization_id = N'$(SeedOrgId)')
    UPDATE dbo.Memberships
    SET role = N'System admin', status = 'Active'
    WHERE user_id = @userId AND organization_id = N'$(SeedOrgId)';
ELSE
    INSERT INTO dbo.Memberships (id, user_id, organization_id, role, status)
    VALUES (NEWID(), @userId, N'$(SeedOrgId)', N'System admin', 'Active');

COMMIT;

SELECT u.email, u.display_name, m.role, o.name AS organization, o.type
FROM dbo.Users u
JOIN dbo.Memberships m ON m.user_id = u.id
JOIN dbo.Organizations o ON o.id = m.organization_id
WHERE u.email = N'$(SeedEmail)';
'@

Write-Host "`nSeeded — current grants for ${Email}:" -ForegroundColor Green
$result | Format-Table email, display_name, role, organization, type -AutoSize

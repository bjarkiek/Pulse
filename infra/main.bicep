targetScope = 'resourceGroup'

@description('Globally unique prefix, for example dcpulseprod')
@minLength(3)
@maxLength(18)
param namePrefix string
param location string = resourceGroup().location
param containerImage string
param sqlEntraAdminLogin string
param sqlEntraAdminObjectId string
@description('Microsoft Entra External ID application client ID. Leave empty only for an infrastructure bootstrap deployment.')
param entraClientId string = ''
@description('Tenant containing the External ID application and email OTP user flow.')
param entraTenantId string = tenant().tenantId
@secure()
param scanWebhookSecret string
@secure()
param notificationJobSecret string
@secure()
param webhookSigningSecret string
@description('Signs and verifies the app-level Pulse session cookie (replaces Easy Auth token store).')
@secure()
param sessionSecret string
@description('Microsoft Entra confidential-client secret for the AUTH_ENTRA_* OIDC login/callback flow.')
@secure()
param entraClientSecret string
@description('Shared HMAC secret validating signed DataCentral iframe launch (dcdata/dcsig) requests.')
@secure()
param dcAppSecret string
@description('Azure Communication Services endpoint. The verified sender domain is configured outside this template.')
param communicationEmailEndpoint string = ''
@description('Verified MailFrom address in Azure Communication Services Email.')
param communicationEmailSender string = ''
@description('Anthropic API key for the AI assistant (in-app chat and the Slack bot). Leave empty to leave the assistant unconfigured.')
@secure()
param anthropicApiKey string = ''
@description('Model id used by the AI assistant.')
param anthropicModel string = 'claude-opus-4-8'
@description('Slack bot token (xoxb-…) for the Socket Mode assistant integration. Leave empty to leave Slack unconfigured.')
@secure()
param slackBotToken string = ''
@description('Slack app-level token (xapp-…) for Socket Mode. Leave empty to leave Slack unconfigured.')
@secure()
param slackAppToken string = ''

var tags = { application: 'DataCentral Pulse', environment: 'production' }
var storageName = '${take(replace(namePrefix, '-', ''), 18)}files'
var sqlName = '${namePrefix}-sql'
var vaultName = '${take(replace(namePrefix, '-', ''), 18)}-kv'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  tags: tags
  properties: { retentionInDays: 30 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-insights'
  location: location
  kind: 'web'
  tags: tags
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    sku: { family: 'A', name: 'standard' }
  }
}

resource scanSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'attachment-scan-webhook-secret'
  properties: { value: scanWebhookSecret }
}

resource notificationSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'notification-job-secret'
  properties: { value: notificationJobSecret }
}

resource webhookSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'webhook-signing-secret'
  properties: { value: webhookSigningSecret }
}

resource pulseSessionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'pulse-session-secret'
  properties: { value: sessionSecret }
}

resource entraClientSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'entra-client-secret'
  properties: { value: entraClientSecret }
}

resource dcAppSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'dc-app-secret'
  properties: { value: dcAppSecret }
}

resource anthropicApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(anthropicApiKey)) {
  parent: vault
  name: 'anthropic-api-key'
  properties: { value: anthropicApiKey }
}

resource slackBotTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(slackBotToken)) {
  parent: vault
  name: 'slack-bot-token'
  properties: { value: slackBotToken }
}

resource slackAppTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(slackAppToken)) {
  parent: vault
  name: 'slack-app-token'
  properties: { value: slackAppToken }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 7 } }
}

resource attachments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'pulse-attachments'
  properties: { publicAccess: 'None' }
}

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlName
  location: location
  tags: tags
  properties: {
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'User'
      login: sqlEntraAdminLogin
      sid: sqlEntraAdminObjectId
      tenantId: tenant().tenantId
      azureADOnlyAuthentication: true
    }
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: 'Pulse'
  location: location
  tags: tags
  sku: { name: 'S1', tier: 'Standard' }
  properties: { zoneRedundant: false, requestedBackupStorageRedundancy: 'Zone' }
}

// Slack Socket Mode + in-memory OAuth/chat caches require a single instance — do not scale out.
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${namePrefix}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: 'P1v3', tier: 'PremiumV3', capacity: 1 }
  properties: { reserved: true, zoneRedundant: false }
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: '${namePrefix}-app'
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerImage}'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/health'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '3000' }
        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
        { name: 'AZURE_STORAGE_CONTAINER', value: attachments.name }
        { name: 'AZURE_SQL_SERVER', value: sqlServer.properties.fullyQualifiedDomainName }
        { name: 'AZURE_SQL_DATABASE', value: database.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'ATTACHMENT_SCAN_WEBHOOK_SECRET', value: '@Microsoft.KeyVault(SecretUri=${scanSecret.properties.secretUriWithVersion})' }
        { name: 'NOTIFICATION_JOB_SECRET', value: '@Microsoft.KeyVault(SecretUri=${notificationSecret.properties.secretUriWithVersion})' }
        { name: 'WEBHOOK_SIGNING_SECRET', value: '@Microsoft.KeyVault(SecretUri=${webhookSecret.properties.secretUriWithVersion})' }
        { name: 'AZURE_COMMUNICATION_EMAIL_ENDPOINT', value: communicationEmailEndpoint }
        { name: 'AZURE_COMMUNICATION_EMAIL_SENDER', value: communicationEmailSender }
        { name: 'PULSE_PUBLIC_URL', value: 'https://${namePrefix}-app.azurewebsites.net' }
        { name: 'PULSE_ALLOW_DEMO_IDENTITY', value: 'false' }
        { name: 'PULSE_SESSION_SECRET', value: '@Microsoft.KeyVault(SecretUri=${pulseSessionSecret.properties.secretUriWithVersion})' }
        { name: 'AUTH_ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'AUTH_ENTRA_CLIENT_ID', value: entraClientId }
        { name: 'AUTH_ENTRA_CLIENT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${entraClientSecretResource.properties.secretUriWithVersion})' }
        { name: 'DC_APP_SECRET', value: '@Microsoft.KeyVault(SecretUri=${dcAppSecretResource.properties.secretUriWithVersion})' }
        { name: 'DC_ALLOWED_PARENT_ORIGINS', value: 'https://app.datacentral.ai' }
        { name: 'DC_FRAME_ANCESTORS', value: '\'self\' https://*.datacentral.ai' }
        { name: 'DC_SESSION_CHECK', value: 'when-available' }
        // App-level session auth (below) is now authoritative; Easy Auth headers are
        // not trusted for identity unless explicitly re-enabled during migration.
        { name: 'PULSE_TRUST_EASYAUTH_HEADERS', value: 'false' }
        // AI assistant (in-app chat panel + Slack bot). Each of these three is optional;
        // the assistant/Slack integration stays unconfigured until its secret is set.
        { name: 'ANTHROPIC_API_KEY', value: !empty(anthropicApiKey) ? '@Microsoft.KeyVault(SecretUri=${anthropicApiKeySecret!.properties.secretUriWithVersion})' : '' }
        { name: 'ANTHROPIC_MODEL', value: anthropicModel }
        { name: 'SLACK_BOT_TOKEN', value: !empty(slackBotToken) ? '@Microsoft.KeyVault(SecretUri=${slackBotTokenSecret!.properties.secretUriWithVersion})' : '' }
        { name: 'SLACK_APP_TOKEN', value: !empty(slackAppToken) ? '@Microsoft.KeyVault(SecretUri=${slackAppTokenSecret!.properties.secretUriWithVersion})' : '' }
      ]
    }
  }
}

resource authentication 'Microsoft.Web/sites/config@2024-04-01' = if (!empty(entraClientId)) {
  parent: app
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true, runtimeVersion: '~1' }
    globalValidation: {
      requireAuthentication: true
      // App-level session auth (PULSE_SESSION_SECRET / AUTH_ENTRA_* / DC_APP_SECRET
      // above) is now authoritative for authorization; Easy Auth's own top-level
      // redirect breaks when the app is framed inside the DataCentral iframe, so
      // it must not gate requests. AllowAnonymous lets every request through to
      // the app, which then enforces its own session/DataCentral checks.
      // NOTE: this is an explicit operational step on an already-deployed
      // authsettingsV2 resource — flipping this value in the template does not
      // retroactively change a site that was deployed with the old value until
      // this template is redeployed to it.
      unauthenticatedClientAction: 'AllowAnonymous'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [
        '/api/health'
        '/api/v1/attachments/*/scan-result'
        '/api/v1/internal/jobs/notifications'
        '/api/v1/internal/jobs/retention'
        '/api/v1/internal/jobs/webhooks'
      ]
    }
    httpSettings: {
      requireHttps: true
      routes: { apiPrefix: '/.auth' }
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [ entraClientId, 'api://${entraClientId}' ]
          defaultAuthorizationPolicy: { allowedApplications: [ entraClientId ] }
        }
      }
    }
    login: {
      tokenStore: { enabled: true }
      preserveUrlFragmentsForLogins: true
    }
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, 'blob-contributor')
  scope: storage
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, app.id, 'key-vault-secrets-user')
  scope: vault
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','4633458b-17de-408a-b874-0445c86b69e6')
  }
}

output applicationUrl string = 'https://${app.properties.defaultHostName}'
output applicationPrincipalId string = app.identity.principalId
output sqlServerName string = sqlServer.name
output storageAccountName string = storage.name

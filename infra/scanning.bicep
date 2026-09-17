// Deploy AFTER the application endpoint is reachable. This enables a billed service.
param storageAccountName string
param applicationUrl string
param location string = resourceGroup().location
@secure()
param scanWebhookSecret string
param monthlyScanCapGb int = 500
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }
resource topic 'Microsoft.EventGrid/topics@2022-06-15' = {
 name: '${storageAccountName}-scan-results'
 location: location
 properties: { inputSchema: 'EventGridSchema' }
}
resource scanner 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = {
 name: 'current'
 scope: storage
 properties: {
  isEnabled: true
  overrideSubscriptionLevelSettings: true
  malwareScanning: {
   onUpload: { isEnabled: true, capGBPerMonth: monthlyScanCapGb }
   scanResultsEventGridTopicResourceId: topic.id
  }
  sensitiveDataDiscovery: { isEnabled: false }
 }
}
resource subscription 'Microsoft.EventGrid/eventSubscriptions@2022-06-15' = {
 name: 'pulse-scanner'
 scope: topic
 properties: {
  eventDeliverySchema: 'EventGridSchema'
  filter: { includedEventTypes: ['Microsoft.Security.MalwareScanningResult'] }
  destination: {
   endpointType: 'WebHook'
   properties: {
    endpointUrl: '${applicationUrl}/api/v1/internal/attachments/scan-events'
    deliveryAttributeMappings: [{ name: 'x-pulse-scan-secret', type: 'Static', properties: { value: scanWebhookSecret, isSecret: true } }]
   }
  }
  retryPolicy: { maxDeliveryAttempts: 30, eventTimeToLiveInMinutes: 1440 }
 }
}

// =============================================================================
// Secrets Module for Azure Container Apps
// =============================================================================
// Manages secrets via Azure Key Vault for Container Apps
// =============================================================================

@description('Name of the Key Vault')
param keyVaultName string

@description('Azure region')
param location string

@description('Environment name (kept for future use)')
#disable-next-line no-unused-params
param environment string

// =============================================================================
// Key Vault
// =============================================================================

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Note: enablePurgeProtection cannot be disabled once enabled
    // We always enable it for safety (data protection)
    enablePurgeProtection: true
  }
}

// Role assignments are managed by the CI/CD pipeline's pre-populate step (az role assignment create)
// to avoid RoleAssignmentExists errors on re-deploys. The pipeline assigns:
// - Key Vault Secrets User (read-only) for the Container Apps managed identity
// - Key Vault Secrets Officer (read+write+delete) for the GitHub Actions SP

// =============================================================================
// Outputs
// =============================================================================

output keyVaultId string = keyVault.id
output keyVaultUri string = keyVault.properties.vaultUri
output keyVaultName string = keyVault.name


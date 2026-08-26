// =============================================================================
// Azure Policy guardrails (SOC 2 CC5.3 / CC7.1)
// =============================================================================
// CC5.3 asks for control activities codified as Infrastructure-as-Code and
// enforced by preventive guardrails rather than manual steps. CC7.1 asks for
// configuration drift detection running continuously against deployed
// resources. This module is that artifact: the intended posture, expressed as
// policy assignments, evaluated continuously by Azure Policy.
//
// Every rule here restates an intent the remediation register already holds
// (N1 — restrict public network access on KV/ACR/Redis; Key Vault protective
// deletion). Nothing new is invented; this makes the existing intents
// machine-checkable instead of prose.
//
// -----------------------------------------------------------------------------
// AUDIT ONLY, DELIBERATELY
// -----------------------------------------------------------------------------
// Every assignment uses the `Audit` effect. `Deny` would block deploys on the
// very findings we already know are open — KV/ACR/Redis all currently have
// public network access enabled (N1), so a Deny assignment would fail the next
// deploy and get switched off. Audit produces the compliance/drift report now;
// flipping an individual rule to Deny is a one-line effect change once its
// baseline is clean. A guardrail that has to be disabled to ship is worse than
// no guardrail — that is exactly how the dependency audit gate ended up blind.
//
// Expect these to report NON-COMPLIANT on first evaluation. That is the point:
// the non-compliance IS the drift evidence CC7.1 asks for, and it matches the
// register's known-open N1 items rather than contradicting them.
//
// -----------------------------------------------------------------------------
// WHY THIS IS OFF BY DEFAULT (`enablePolicyGuardrails`)
// -----------------------------------------------------------------------------
// The deploy identity cannot create policy assignments. `setup-github-oidc.sh`
// grants the GitHub OIDC service principal `Contributor` at subscription scope,
// and Contributor's notActions explicitly exclude `Microsoft.Authorization/*/
// Write` — which is what `policyAssignments` writes. Enabling this without
// first granting the SP a role that permits policy assignment would fail the
// deploy with AuthorizationFailed.
//
// To enable, an Owner / User Access Administrator grants the deploy SP the
// built-in `Resource Policy Contributor` role, then flips the parameter:
//
//   az role assignment create \
//     --assignee <AZURE_CLIENT_ID> \
//     --role "Resource Policy Contributor" \
//     --scope "/subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<resource-group>"
//
// Verify afterwards with:
//   az policy state list -g <resource-group> \
//     --query "[].{policy:policyDefinitionName,state:complianceState}" -o table
//
// Policy definition IDs below were read from the live Azure catalog
// (`az policy definition list`), not transcribed from memory.
// =============================================================================

@description('Deploy the Azure Policy guardrails. Requires the deploy identity to hold a role permitting Microsoft.Authorization/policyAssignments/write (e.g. Resource Policy Contributor) — Contributor alone is NOT sufficient. See the header.')
param enablePolicyGuardrails bool = false

@description('Azure region for the assignment identities.')
param location string

// Built-in definitions. Both the IDs and the fact that each one accepts an
// `effect` parameter with `Audit` among its allowedValues were read from the
// live catalog on 2026-07-16 (`az policy definition show`), not assumed — a
// definition without an `effect` parameter rejects the assignment below.
var guardrails = [
  {
    name: 'fabric-kv-purge-protection'
    displayName: 'Fabric: Key Vaults should have deletion (purge) protection enabled'
    definitionId: '0b60c0b2-2dc2-4e1c-b5c9-abbed971de53'
  }
  {
    name: 'fabric-kv-soft-delete'
    displayName: 'Fabric: Key Vaults should have soft delete enabled'
    definitionId: '1e66c121-a66a-4b1f-9b83-0fd99bf0fc2d'
  }
  {
    name: 'fabric-kv-public-access'
    displayName: 'Fabric: Key Vault should disable public network access (register N1)'
    definitionId: '405c5871-3e91-4644-8a63-58e19d68ff5b'
  }
  {
    name: 'fabric-acr-network'
    displayName: 'Fabric: Container registries should not allow unrestricted network access (register N1)'
    definitionId: 'd0793b48-0edc-4296-a390-4c75d1bdfd71'
  }
  {
    name: 'fabric-redis-public-access'
    displayName: 'Fabric: Azure Cache for Redis should disable public network access (register N1)'
    definitionId: '470baccb-7e51-4549-8b1a-3e5be069f663'
  }
]

resource assignments 'Microsoft.Authorization/policyAssignments@2024-04-01' = [
  for g in guardrails: if (enablePolicyGuardrails) {
    name: g.name
    location: location
    identity: {
      type: 'SystemAssigned'
    }
    properties: {
      displayName: g.displayName
      description: 'SOC 2 CC5.3 / CC7.1 — intended posture codified as IaC and evaluated continuously. Audit effect: reports drift, never blocks a deploy.'
      policyDefinitionId: subscriptionResourceId('Microsoft.Authorization/policyDefinitions', g.definitionId)
      enforcementMode: 'Default'
      parameters: {
        effect: {
          value: 'Audit'
        }
      }
    }
  }
]

@description('Names of the deployed policy assignments (empty when the guardrails are disabled).')
output assignmentNames array = [for (g, i) in guardrails: enablePolicyGuardrails ? g.name : '']

# Connector Truth Table

Date: 2026-04-03

Purpose: distinguish between connector catalog breadth and real end-to-end implementation coverage in Fabric, using the local Onyx source tree as a comparison point.

## Summary

Fabric already has the right product model:

- searchable knowledge integrations
- runtime/action integrations
- federated freshness
- sync jobs, connection detail pages, and provider taxonomy

But the current implementation is uneven:

- the action/runtime plugin catalog is broad
- the searchable connector catalog is moderately broad
- the actual indexed connector backend coverage is still narrow

Onyx has a much deeper connector bench in the Onyx repository's `backend/onyx/connectors`, with concrete connector implementations for Confluence, Notion, Google Drive, Slack, GitHub, Gmail, Gong, HubSpot, Salesforce, Zendesk, Jira, Linear, SharePoint, Teams, and many more.

## Fabric Truth Table

Legend:

- `UI`: provider appears in Fabric UI/catalog
- `OAuth`: Fabric has auth/provider setup support
- `Action`: runtime/workflow action integration exists
- `Indexed Sync`: searchable sync/indexing path exists end to end
- `Federated`: live/fresh search exists
- `Status`: `real`, `partial`, or `stub`

| Provider | UI | OAuth | Action | Indexed Sync | Federated | Status | Notes |
|---|---|---:|---:|---:|---:|---|---|
| Google Drive | yes | yes | partial | yes | no | partial | real Google Drive sync exists via Temporal project sync path; data-connection generic path is not the main implementation |
| GitHub | yes | yes | yes | partial | yes | partial | federated GitHub search exists; action plugin exists; indexed searchable connector path is not fully closed end to end |
| Slack | yes | yes | yes | partial | yes | partial | Slack connector and Slack federated search exist, but connector storage/index path still contains TODOs |
| Notion | yes | yes | yes | partial | no | partial | OAuth and workflow/plugin surfaces exist; generic connector sync implementation is still stubbed |
| Confluence | yes | partial | yes | partial | no | partial | workflow/plugin surface exists; no full Fabric connector backend comparable to Onyx connector yet |
| Microsoft Graph / Microsoft 365 | yes | yes | yes | partial | no | partial | OAuth exists for `MICROSOFT_GRAPH`; searchable `MICROSOFT_365` product object exists, but connector backend is not closed |
| Linear | yes | no | yes | partial | no | partial | strong action/plugin support; searchable/indexed knowledge path is not completed |
| Zendesk | yes | no | no | no | no | stub | provider exists in searchable catalog, but no finished Fabric connector implementation found |
| Gong | yes | no | no | no | no | stub | provider exists in searchable catalog, but no finished Fabric connector implementation found |
| Salesforce | yes | no | no | no | no | stub | provider exists in searchable catalog, but no finished Fabric connector implementation found |
| HubSpot | yes | no | no | no | no | stub | provider exists in searchable catalog, but no finished Fabric connector implementation found |
| Gmail | yes | no | no | no | no | stub | provider exists in searchable catalog, but no OAuth or connector implementation found in Fabric |
| Intercom | yes | no | no | no | no | stub | provider exists in searchable catalog, but no finished Fabric connector implementation found |
| Snowflake | yes | no | yes | no | no | partial | action/query style provider shape exists; not a document-style indexed connector |
| BigQuery | yes | no | yes | no | no | partial | action/query style provider shape exists; not a document-style indexed connector |
| Firecrawl | yes | n/a | yes | n/a | n/a | real | runtime/tool provider, not a searchable indexed connector |
| Perplexity | yes | n/a | yes | n/a | n/a | real | runtime/tool provider, not a searchable indexed connector |
| Resend | yes | n/a | yes | n/a | n/a | real | runtime/tool provider |
| MCP | yes | n/a | yes | n/a | n/a | real | advanced action/runtime infrastructure, not a searchable connector |
| FAL | yes | n/a | yes | n/a | n/a | real | runtime/tool provider |
| AI Gateway | yes | n/a | yes | n/a | n/a | real | runtime/model provider, not a connector in the Onyx sense |

## Where Fabric Is Strong

- broad action/runtime plugin surface in `apps/web/modules/saas/workflows/lib/plugins`
- OAuth support for GitHub, Google Drive, Microsoft Graph, Slack, and Notion in `packages/api/modules/integrations/lib/oauth-providers.ts`
- federated live search support for Slack and GitHub in `packages/connectors/src/*-federated.ts`
- productized searchable integration surfaces in `apps/web/modules/saas/data-connections`

## Where Fabric Is Not Yet Onyx-Level

- the generic connector sync pipeline still has stubbed provider logic:
  - `discoverResources()` is stubbed in `packages/temporal/src/activities/connector-sync.ts`
  - `fetchResourceDocuments()` is stubbed in `packages/temporal/src/activities/connector-sync.ts`
- only one real connector implementation currently exists in `packages/connectors/src`: Slack
- Google Drive has a real sync path, but it is separate and specialized rather than a generalized connector backend
- several provider tiles in the searchable catalog are product objects without complete backend connector implementations

## Onyx Adaptation Assessment

Yes, Onyx connector code can inform Fabric implementation, but it should be adapted, not copied directly.

What can transfer well:

- resource discovery flow
- pagination/checkpoint strategy
- permission extraction logic
- document normalization patterns
- full sync vs incremental sync vs slim/prune flow
- provider-specific API traversal details

What does not transfer directly:

- Python classes/interfaces must be rewritten into Fabric's TypeScript connector/activity model
- Onyx indexing pipeline assumes different backend contracts and persistence structure
- Fabric has stricter tenant/XOR isolation requirements that must be preserved in every API, workflow, and query path
- Fabric separates searchable integrations, action providers, MCP, and workflow plugins differently than Onyx

## Recommended Implementation Tranche

Close the highest-value searchable connectors first:

1. GitHub
2. Notion
3. Confluence
4. Slack
5. Google Drive

For each provider, the definition of done should be:

- auth flow works
- scope selection works
- full sync works
- incremental sync works
- synced resources persist
- documents are chunked and indexed
- unified search returns results
- sync health is visible in UI
- optional federated freshness is wired where relevant
- action/runtime capabilities remain available where relevant

## Immediate Next Engineering Step

Do not expand the connector catalog further yet.

Instead:

1. make the connector-sync activity layer real for one provider
2. route one provider fully through the generic searchable connector system
3. prove the pattern
4. repeat across the priority tranche

Recommended first generic connector to close:

- Notion

Reason:

- high product value
- OAuth already exists
- Onyx has a mature Notion connector to study
- document-style indexing is a good fit for Fabric's searchable integrations model

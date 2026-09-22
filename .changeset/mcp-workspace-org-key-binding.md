---
"fabric-app": patch
---

Organization-scoped API keys are now refused as not found on workspaces hosted by another organization, in the MCP gateway's `fabric_get_workspace` and `fabric_query_workspace` tools and in the v1 REST `POST /workspaces/:id/query` route, so a key issued for one organization can no longer read another organization's workspace through its creator's membership there.

Workspace access used to accept an organization it never checked, so these surfaces bound nothing to the key's tenant. The gateway tools now apply the same credential rule as the project tools: workspace access, plus an organization key must match the workspace's hosting organization, checked before any workspace row is read, query embedded or search run. Personal API keys and browser sessions are unchanged on the gateway. The v1 query route now also requires the workspace to be in the organization the request resolved to, the rule `GET /workspaces/:id` already applied, so a personal key reaching a workspace in another of its owner's organizations names that organization with `?org=`.

Agent instance create and update now also require each attached workspace to belong to the instance's own organization (or, for a personal instance, to be a personal workspace), since the workspace's documents are read at run time by whoever can run the instance.

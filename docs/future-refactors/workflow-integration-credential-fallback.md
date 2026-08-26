# Add WorkflowIntegration as Credential Fallback for Code Analysis

## Problem

When a repo is linked to a project, the `existingProjectSetupWorkflow` runs `findMcpConfigsForRepos` to resolve credentials. This activity only checks:

1. `ProjectRepositoryIntegration` (Team Access shared credentials)
2. User's MCP configs (GitHub MCP server in Settings -> MCP Servers)

It does **not** check `WorkflowIntegration` (the user's GitHub OAuth connection used for browsing repos). Most users have GitHub OAuth via `WorkflowIntegration` but not a GitHub MCP server config, so code analysis silently skips with:

```
No MCP configs or project integrations found for any repos, skipping code analysis
```

## Where the Gap Is

- **Activity**: `findMcpConfigsForRepos` in `packages/temporal/src/activities/existing-project-setup.ts`
- **Current chain**: ProjectRepositoryIntegration -> User MCP configs -> (nothing, skip)
- **Missing fallback**: `WorkflowIntegration` with `provider: "GITHUB"` and `isActive: true`

## What Already Works

The internal code search API route (`apps/web/app/api/internal/code-search/route.ts`) already has a `resolveCodeSearchCredentials` function that falls back to `WorkflowIntegration`. The same pattern should be applied to `findMcpConfigsForRepos`.

## Proposed Fix

In `findMcpConfigsForRepos`, after checking project-level integrations and MCP configs, add a third fallback:

```typescript
// Strategy 3: User's OAuth integration (WorkflowIntegration)
const integration = await db.workflowIntegration.findFirst({
  where: {
    userId,
    ...orgFilter,
    provider: parsed.provider, // "GITHUB" or "AZURE_DEVOPS"
    isActive: true,
  },
  select: { id: true, credentials: true },
  orderBy: { updatedAt: "desc" },
});
```

The challenge is that `findMcpConfigsForRepos` returns MCP config IDs (used by the orchestrator to connect to MCP servers for tool calls). A `WorkflowIntegration` credential is a raw OAuth token, not an MCP config. So either:

### Option A: Create a temporary MCP config from WorkflowIntegration credentials
- When WorkflowIntegration is found, create an ephemeral MCP config pointing to the GitHub MCP server with the OAuth token
- The orchestrator uses this config normally
- Clean up after workflow completes

### Option B: Pass raw credentials as an alternative path
- Extend the workflow to accept raw tokens alongside MCP config IDs
- The orchestrator checks for raw credentials before MCP config resolution
- Cleaner but requires changes to the orchestrator execution pipeline

### Option C: Auto-create ProjectRepositoryIntegration from WorkflowIntegration
- When a repo is linked and user has GitHub OAuth, auto-create a `ProjectRepositoryIntegration` record with the same credentials
- This makes the existing `findMcpConfigsForRepos` flow work naturally
- Also enables Team Access for the repo automatically

## Files to Modify

- `packages/temporal/src/activities/existing-project-setup.ts` — `findMcpConfigsForRepos` activity
- `packages/temporal/src/activities/code-based-setup.ts` — `findGitHubMcpConfig` activity (same gap)
- Possibly `packages/api/modules/projects/procedures/update-project.ts` — if Option C, create integration on repo link

## Impact

This also affects the manual "Start Code-Based Setup" flow which uses `findGitHubMcpConfig` (same gap — only checks MCP configs, not WorkflowIntegration).

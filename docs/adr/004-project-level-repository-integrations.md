# ADR-004: Project-Level Repository Integrations

**Status:** Accepted
**Date:** 2026-03-27
**Authors:** Engineering

## Context

Fabric supports multi-user projects where team members collaborate on specifications, documents, and code analysis. Users connect external repositories (GitHub, Azure DevOps) via OAuth integrations or MCP connections. These integrations are **user-scoped** — only the user who configured them can use the repository as LLM context.

This creates a collaboration gap: when User A connects their GitHub account and adds a repository to a project, Users B and C (invited as EDITOR or VIEWER) cannot leverage that repository for document generation or code analysis. They must independently configure their own GitHub OAuth tokens, which:

1. Requires every team member to have repository access credentials
2. Breaks the "configure once, use everywhere" project model
3. Creates confusion when one member's context includes repo data but another's doesn't
4. Violates the principle that project context should be shared among all members

## Decision

### New `ProjectRepositoryIntegration` Model (Not Reusing `DataConnection`)

We introduce a dedicated `ProjectRepositoryIntegration` table that stores repository credentials at the **project level**, shared among all project members.

**Why not reuse `DataConnection`?**

| Factor | DataConnection | New Model |
|--------|---------------|-----------|
| Semantic fit | Org-wide knowledge sync (Notion, Drive) | Project-scoped code context |
| Unique constraints | `[userId, provider, workspaceId]` | `[projectId, provider, owner, repo]` |
| Sync target | WorkspaceDocument | ProjectContext |
| Tenant isolation | userId/organizationId XOR | projectId + hasProjectAccess() |
| Migration risk | Modifies production table with active sync jobs | New table, zero risk |

The architectural boundary between "org-level knowledge sync" and "project-level code context" is fundamental. Forcing both through one model would create a leaky abstraction.

### Auth Choices for v1

**GitHub: OAuth (existing flow)**
- Reuses the existing GitHub OAuth flow (`/integrations/github/oauth/start` + callback)
- Extended with `targetType: "project"` in the OAuth state to route credentials to `ProjectRepositoryIntegration` instead of `WorkflowIntegration`
- Token refresh uses the same GitHub client credentials

**Azure DevOps: PAT (Personal Access Token)**
- Simplest credential type — owner pastes a read-scoped PAT
- No OAuth app registration required for Azure DevOps
- PAT validated via Temporal activity before saving (test API call to `/_apis/connectionData`)
- PAT expiry detected by scheduled health check workflow

### Tool Layer: Credential Resolution, Not New Wrappers

Rather than building new REST API wrappers or MCP servers, we **inject project credentials into the existing tool execution path**:

```
findRepoCredentials(repoUrl, projectId, userId, organizationId)
  │
  ├─ Check ProjectRepositoryIntegration (project-level)
  │   → If ACTIVE: return decrypted credentials
  │
  └─ Fallback: existing findGitHubMcpConfig / findAzureDevOpsMcpConfig (user-level)
```

The existing `executeGitHubTool()` function gains an optional `projectAccessToken` parameter. When provided, it skips the `WorkflowIntegration` lookup and uses the project-level token directly. All downstream tool handlers (list_repositories, get_file_contents, search_code, etc.) remain unchanged.

## Consequences

### What becomes easier

- **Collaborative code analysis**: Any project member can trigger code scans using the shared credential
- **Onboarding**: New team members get immediate access to repo context without configuring their own integrations
- **Audit trail**: All repo access is logged with the requesting user's identity, not the credential owner's

### What becomes harder

- **Token management**: A single token's rate limit is shared across all members. High-activity projects may hit GitHub's 5,000 req/hr limit faster.
- **Credential lifecycle**: When the configuring user leaves, their token is invalidated. The integration is set to DISCONNECTED and a new owner must re-configure.

### What is explicitly deferred

| Capability | Reason for deferral |
|-----------|-------------------|
| **Org-level integrations** | The model supports layering this later via a `findRepoCredentials` priority chain (project → org → user) |
| **GitHub App installation** | Eliminates per-user token management but requires building GitHub App support (larger lift) |
| **Push / write access** | v1 is read-only. Write operations (create PR, push commits) would require additional OAuth scopes and a separate security review |
| **GitLab / Bitbucket** | `RepositoryProvider` enum is extensible. Provider-specific auth flows can be added following the same pattern |
| **Per-member branch/path restrictions** | All members get read-only access to all branches. Fine-grained access can be added later |
| **Rate limit budgets** | Rate limit headers are logged but not enforced per-member |

## References

- Schema: `packages/database/prisma/schema.prisma` — `ProjectRepositoryIntegration` model
- Credential resolution: `packages/database/prisma/queries/project-repository-integrations.ts`
- Health check: `packages/temporal/src/workflows/repo-integration-health-check.ts`
- OAuth routing: `packages/api/modules/integrations/procedures/github-oauth.ts`

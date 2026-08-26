# Developer Guide: Project Repository Integrations

How a project connects a code repository, and what that connection is then used for.

- **Audience**: engineers working on repository connections; support engineers diagnosing a project whose repo access or QA sync is failing
- **Owner**: Projects / Platform team

## Overview

Project-level repository integrations allow a project owner to configure repository credentials once, making the repository available as read-only LLM context for all project members (OWNER, EDITOR, VIEWER).

## How `findRepoCredentials` Resolution Works

When a workflow needs repository access (e.g., code analysis, document generation), it calls `findMcpConfigsForRepos()` which checks credentials in this priority order:

```
1. ProjectRepositoryIntegration (project-level, shared)
   └─ Only returns ACTIVE integrations (TOKEN_EXPIRED is skipped)
   └─ Matched by: projectId + provider + repositoryOwner + repositoryName

2. User-level MCP config (existing behavior)
   └─ findGitHubMcpConfig(userId, organizationId)
   └─ findAzureDevOpsMcpConfig(userId, organizationId)
```

**Why expired project tokens don't fall through:** If a project integration exists but is `TOKEN_EXPIRED`, the function returns `source: "none"` — it does NOT silently fall through to the user's personal credentials. This is intentional: using a different user's credentials would bypass the project owner's audit trail and potentially expose repos the project shouldn't have access to.

## Adding a New Repository Provider

Follow these steps to add support for a new provider (e.g., GitLab, Bitbucket):

### Step 1: Add Enum Value

```prisma
// packages/database/prisma/schema.prisma
enum RepositoryProvider {
  GITHUB
  AZURE_DEVOPS
  GITLAB        // ← Add here
}
```

Run migration:
```bash
cd packages/database
pnpm dotenv -c -e ../../.env.local -- pnpm prisma migrate dev --name add_gitlab_provider
pnpm generate
```

### Step 2: Add Auth Method (if needed)

If the provider uses a new auth mechanism (e.g., Deploy Token), add to `RepositoryAuthMethod`:

```prisma
enum RepositoryAuthMethod {
  OAUTH
  PAT
  DEPLOY_TOKEN  // ← New
}
```

### Step 3: Update URL Parser

In `packages/database/prisma/queries/project-repository-integrations.ts`, add a regex to `parseRepoUrl()`:

```typescript
// GitLab: https://gitlab.com/owner/repo
const gitlabMatch = trimmed.match(
  /gitlab\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i,
);
if (gitlabMatch) {
  return { provider: "GITLAB", owner: gitlabMatch[1], name: gitlabMatch[2] };
}
```

### Step 4: Add Health Check Handler

In `packages/temporal/src/activities/repo-health-check.ts`, add a case to `checkRepoIntegrationHealth()`:

```typescript
if (provider === "GITLAB" && authMethod === "DEPLOY_TOKEN") {
  return await checkGitLabHealth(input);
}
```

Implement `checkGitLabHealth()` following the pattern of `checkGitHubHealth()`:
- Make a lightweight API call (e.g., `GET /api/v4/user`)
- Probe the repository itself (`verifyRepositoryAccess`) — the account-level
  call proves the credential is alive, the repo probe proves Fabric can work
  with this repository; a credential with no access answers `/user` with 200
  forever
- Capture rate limit headers
- Attempt token refresh if applicable
- Map failures through `integrationStatusForRepoAccess`: 401 → `TOKEN_EXPIRED`
  (reconnect fixes it); 403/404 → `REPO_UNAVAILABLE` (the app must be installed
  on the repository, or re-add with a PAT — reconnecting adds nothing);
  5xx/rate-limit walls leave the status unchanged

### Step 5: Add Tool Execution Support

If the provider uses different API endpoints, create a new tool handler file in `packages/integrations/src/gitlab/index.ts` following the pattern of `github/index.ts`. Add an optional `projectAccessToken` parameter to skip user-level credential lookup.

### Step 6: Update `findMcpConfigsForRepos`

In `packages/temporal/src/activities/code-based-setup.ts`, add URL detection for the new provider:

```typescript
const isGitLab = /gitlab\.com/i.test(trimmed);
```

### Step 7: Write Tests

Add test cases to:
- `packages/database/__tests__/project-repository-integrations.test.ts` — parseRepoUrl
- `packages/temporal/__tests__/repo-credential-resolution.test.ts` — credential priority

## Health Check Workflow Lifecycle

The `repoIntegrationHealthCheckWorkflow` runs as a **Temporal scheduled workflow**:

```
Schedule: Every 30 minutes (via schedules.ts)
Task Queue: fabric-worker
Workflow ID: repo-integration-health-check (singleton via ScheduleAlreadyRunning)

Loop:
  1. Wait 30 minutes (or cancel signal)
  2. Fetch all ACTIVE integrations
  3. For each integration:
     a. Decrypt token
     b. Make lightweight API call (GET /user for GitHub, GET /_apis/connectionData for ADO)
     c. Probe the repository itself (GitHub/GitLab) and map the outcome via integrationStatusForRepoAccess
     d. If 401: attempt refresh → if refresh fails, set TOKEN_EXPIRED
     e. Update lastHealthCheck timestamp
  4. Log audit entries for status changes
  5. Every 100 iterations: continueAsNew to prevent history buildup
```

**Scaling note:** v1 uses a single global schedule. If latency becomes an issue with many integrations (hundreds+), shard into per-organization workflows.

## Registering New Read-Only Tools

The project integration only provides credentials to existing tool handlers. To add a new read-only tool:

1. Add the handler to `packages/integrations/src/github/index.ts` in `TOOL_HANDLERS`
2. The handler receives `(accessToken: string, args: Record<string, unknown>)` — it doesn't know or care whether the token came from a user-level or project-level integration
3. No changes needed to the credential resolution layer

## Local Development: Testing with a Real GitHub Repo

1. **Create a GitHub OAuth App** (Settings → Developer Settings → OAuth Apps)
   - Set callback URL to `http://localhost:3001/api/integrations/github/oauth/callback`
   - Copy Client ID and Client Secret

2. **Set environment variables** in `.env.local`:
   ```bash
   FABRIC_GITHUB_CLIENT_ID=your_client_id
   FABRIC_GITHUB_CLIENT_SECRET=your_client_secret
   ```

3. **Create a test project** and navigate to Settings → Execution Systems

4. **Connect a repository** via the OAuth flow — the UI will open a GitHub popup

5. **Verify the integration** was created:
   ```sql
   SELECT id, provider, status, "repositoryOwner", "repositoryName"
   FROM project_repository_integration
   WHERE "projectId" = 'your-project-id';
   ```

6. **Invite another user** to the project and verify they can trigger code analysis without their own GitHub credentials

7. **Simulate token expiry** to test degradation:
   ```sql
   UPDATE project_repository_integration
   SET status = 'TOKEN_EXPIRED', "lastError" = 'Simulated expiry'
   WHERE id = 'your-integration-id';
   ```

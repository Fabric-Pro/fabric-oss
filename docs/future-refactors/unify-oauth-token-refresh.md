# Unify OAuth Token Refresh Into a Shared Helper

## Problem

GitHub (and GitLab, Microsoft) OAuth token refresh is implemented **five times** across the codebase with diverging behavior. Each implementation hand-rolls the `fetch` call to the token endpoint, parses the response, and handles errors. Bugs like the ones fixed in `#446` (missing `Accept: application/json` header, missing failure-count recording, missing `KNOWN_TOKEN_ENDPOINTS` fallback) had to be fixed in multiple files. They probably still exist in the implementations that PR did not touch.

## Current State — Five Refresh Implementations

| # | Location | Used by | Notes |
|---|---|---|---|
| 1 | `packages/database/prisma/queries/mcp.ts:refreshAccessToken` | MCP tool execution via `getDecryptedAccessToken` | form-encoded, `safeFetchOutbound`, Accept header, public client support, failure recording (all post-#446) |
| 2 | `packages/mcp/lib/oauth-provider.ts` inner `refreshAccessToken` | MCP AI SDK OAuth client provider | form-encoded, **raw `fetch`** (no SSRF guard), Accept header, public client support, failure recording (all post-#446) |
| 3 | `packages/integrations/src/github/index.ts:performTokenRefresh` | `WorkflowIntegration` — workflow builder GitHub actions. **Not triggered by code search.** | JSON body, raw `fetch`, Accept header, module-level `Map<string,Promise>` concurrent-refresh lock, **no public client support** |
| 4 | `packages/temporal/src/activities/repo-health-check.ts:tryGitHubTokenRefresh` | `ProjectRepositoryIntegration`, only from the scheduled `repo-integration-health-check` workflow | JSON body, raw `fetch`, Accept header, optimistic-lock CAS via `refreshProjectRepoToken`, **no public client support** |
| 5 | `packages/api/modules/integrations/lib/github-oauth.ts:refreshGitHubToken` | **Dead code — zero callers** | JSON body, raw `fetch`, Accept header |

Parallel dead/alive GitLab and Microsoft implementations exist in `packages/integrations/src/gitlab/index.ts`, `packages/integrations/src/microsoft/index.ts`, and `packages/api/modules/integrations/lib/gitlab-oauth.ts`. Out of scope for the first pass but covered by the same shared helper.

### Behavior divergences

- **Body encoding**: implementations 1 and 2 use form-encoded per RFC 6749 §6; implementations 3, 4, and 5 use JSON. GitHub's token endpoint accepts both, but the divergence is a code smell and makes it harder to share tests.
- **SSRF protection**: only #1 uses `safeFetchOutbound`. The other four use raw `fetch`. A malicious `tokenEndpoint` value (from a compromised MCP server config or DCR registration) could cause SSRF from the other four paths.
- **Public OAuth clients**: #1 and #2 support `token_endpoint_auth_method: "none"`; #3, #4, and #5 hard-require `client_secret`.
- **Concurrency**: #3 uses a module-level `Map<integrationId, Promise>` lock to dedupe concurrent refreshes. #4 uses optimistic-lock CAS on `updatedAt` to avoid burning rotating refresh tokens. #1 and #2 have no locking — concurrent callers can double-refresh and potentially break rotating refresh token chains (relevant for Notion, whose tokens rotate on each refresh).
- **Failure tracking**: only #1 and #2 call `recordRefreshFailure` and thus surface "needs re-auth" in the UI. #3 throws; #4 returns `false`. The workflow builder and repo-health-check UIs rely on different signals (`status: "ERROR"`, `lastError` columns) to surface auth failures.
- **Client credential source**: each implementation reads credentials from a different place — `MCPConfig.oauthClientId`/`encryptedOauthClientSecret`, `getGitHubClientCredentials(userId, organizationId)`, or `process.env.FABRIC_GITHUB_CLIENT_ID`/`FABRIC_GITHUB_CLIENT_SECRET`. The env var naming is also inconsistent (`GITHUB_CLIENT_ID` vs `FABRIC_GITHUB_CLIENT_ID`).

## Related Bug: Code Search Never Refreshes Tokens

Separately — and worth noting because it is in the same credential neighborhood — `apps/web/app/api/internal/code-search/route.ts` calls `resolveCodeSearchCredentials` which reads `WorkflowIntegration.credentials`, decrypts the stored JSON blob, and grabs `access_token`. **It never checks `tokenExpiresAt` and never calls any refresh function.** If the WorkflowIntegration access token is expired when code search runs, the GitHub API call will 401 and code search will fail silently. The WorkflowIntegration refresh function (`performTokenRefresh` in `packages/integrations/src/github/index.ts`) is only triggered when a workflow builder node runs against GitHub — never from code search, never from the project AI Assistant, never from the task planner.

This bug predates #446 and is independent of the refactor, but it should be fixed as part of the same effort because:
- The unified helper makes the fix trivial — `code-search/route.ts` just calls `refreshOAuthToken` when the token is expired.
- Both concerns (the refactor and this bug) touch the same code paths, so batching them avoids a second round of changes to the same files.
- It's the single most user-visible symptom of the current fragmentation: users connect GitHub in project settings, come back the next day, and the AI Assistant silently can't see their code.

## Proposed Shared Helper

Location: `packages/utils/lib/oauth-refresh.ts`, exported from `@repo/utils`. Chosen because `@repo/utils` is already a dependency of all four live call sites and already houses `safeFetchOutbound`, `encryptApiKey`, and `decryptApiKey`.

```ts
// packages/utils/lib/oauth-refresh.ts

export type OAuthRefreshRequest = {
  tokenEndpoint: string;       // resolved URL; caller handles discovery/fallbacks
  refreshToken: string;        // plaintext; caller handles decryption
  clientId: string;
  clientSecret?: string;       // undefined => public client (token_endpoint_auth_method: "none")
  scope?: string;              // some providers require echoing scope
};

export type OAuthRefreshSuccess = {
  ok: true;
  accessToken: string;
  refreshToken: string | null; // null if provider didn't rotate
  expiresIn: number | null;    // seconds; caller applies their own default if null
  tokenType: string | null;
  scope: string | null;
};

export type OAuthRefreshFailure = {
  ok: false;
  errorCode: string;           // RFC 6749 error code, "network_error", "invalid_response", or "http_<status>"
  errorMessage: string;        // human-readable, safe to store in lastRefreshError columns
};

export type OAuthRefreshResult = OAuthRefreshSuccess | OAuthRefreshFailure;

export async function refreshOAuthToken(
  request: OAuthRefreshRequest,
): Promise<OAuthRefreshResult>;
```

### Behavior guarantees

- Body: `URLSearchParams` form-encoded per RFC 6749 §6. Consistent across all callers.
- Headers: `content-type: application/x-www-form-urlencoded` + `accept: application/json`. Fixes the GitHub form-encoded response bug in all callers — not just the two PR #446 patched.
- `client_secret` omitted from the body when `clientSecret` is undefined (public client support).
- Uses `safeFetchOutbound` so SSRF protection is consistent across all callers.
- **Never throws.** Returns a typed discriminated union. Callers decide failure policy without a try/catch.
- Returns `null` for `expiresIn` when the provider didn't send `expires_in`. Callers apply their own defaults.

### What the helper deliberately does not do

- Decryption / encryption of stored tokens.
- Persistence of refreshed tokens to any database table.
- Failure counting or circuit breaker state (`recordRefreshFailure`, `setIntegrationStatus`).
- Concurrent-refresh locks (module `Map` in `integrations/src/github/index.ts`, optimistic CAS in `repo-health-check.ts`).
- Token endpoint discovery / `KNOWN_TOKEN_ENDPOINTS` fallback.
- Client credential resolution (env vars, MCP config, etc.).

All of those stay with their respective stores. The helper is narrowly "do the HTTP exchange correctly" and nothing more.

## Implementation Plan

One commit per step so the series is bisectable.

### Step 0 — Foundation

1. Create `packages/utils/lib/oauth-refresh.ts` implementing `refreshOAuthToken`.
2. Add `packages/utils/__tests__/oauth-refresh.test.ts` with vitest unit tests mocking `safeFetchOutbound`:
   - Happy path: successful response → `OAuthRefreshSuccess` with all fields.
   - Rotating refresh token: provider returns new `refresh_token` → preserved in result.
   - Missing refresh token in response: result has `refreshToken: null`.
   - Public client (no `clientSecret`): request body omits `client_secret`.
   - Confidential client (`clientSecret` set): request body includes `client_secret`.
   - HTTP 4xx with JSON error body: `errorCode` = provider's `error` field, `errorMessage` from `error_description`.
   - HTTP 4xx with **non-JSON body** (the original GitHub form-encoded regression — the reason PR #446 existed): result is `ok: false` with `errorCode = http_<status>` and `errorMessage` includes the raw body snippet.
   - HTTP 5xx: `errorCode = http_5xx`.
   - Network error (mock `safeFetchOutbound` throws): `errorCode = network_error`.
   - Request body is URL-encoded form (not JSON): assert `content-type` header and body shape.
   - `accept: application/json` header always set.
3. Export `refreshOAuthToken` and the types from `packages/utils/index.ts`.

This step has zero callers and can merge safely on its own.

### Step 1 — Port `packages/database/prisma/queries/mcp.ts:refreshAccessToken`

- Replace the inline fetch + JSON parse + error handling block with a call to `refreshOAuthToken`.
- Keep `recordRefreshFailure`, `clearRefreshFailures`, `updateMcpConfigTokens`, `SERVER_DEFAULT_TOKEN_EXPIRY`, and the `getKnownTokenEndpoint` fallback exactly where they are.
- On `result.ok === false`: `await recordRefreshFailure({ configId, errorMessage: \`Token refresh failed: ${result.errorMessage}\` })`.
- On `result.ok === true`: apply the server default expiry fallback for servers like Notion, encrypt tokens, call `updateMcpConfigTokens`, and `clearRefreshFailures`.

### Step 2 — Port `packages/mcp/lib/oauth-provider.ts` inner `refreshAccessToken`

- Same pattern as Step 1.
- Keep the `isPublicOAuthClient` check, `getTokenEndpoint` call, `recordRefreshFailure` calls, and `updateMcpConfigTokens` call where they are.
- Inherit `safeFetchOutbound` from the helper — this replaces the raw `fetch` used here today. Minor security improvement PR #446 did not include.

### Step 3 — Port `packages/integrations/src/github/index.ts:performTokenRefresh`

- Replace the fetch + JSON + credential-string writeback logic with `refreshOAuthToken` + the existing JSON stringification into `workflowIntegration.credentials`.
- Keep the `refreshInProgress` module-level lock `Map` as-is — the helper does not handle locking.
- Keep `getGitHubClientCredentials(userId, organizationId)` for client credentials.
- GitHub OAuth app client secrets are always confidential here, so `clientSecret` is always defined. No behavior change for that path, but the code becomes consistent with the MCP paths.

### Step 4 — Port `packages/temporal/src/activities/repo-health-check.ts:tryGitHubTokenRefresh`

- Replace the fetch block with `refreshOAuthToken`.
- Keep `refreshProjectRepoToken` with its optimistic-lock CAS — the helper does not handle locking.
- Read client credentials from `process.env.FABRIC_GITHUB_CLIENT_ID` / `FABRIC_GITHUB_CLIENT_SECRET` as before.
- Return `false` on `result.ok === false` to preserve current behavior.

### Step 5 — Delete dead code

Remove `refreshGitHubToken` export from `packages/api/modules/integrations/lib/github-oauth.ts`. Zero callers, one-line commit.

### Step 6 — Fix the code-search refresh gap (this doc's secondary concern)

Extend `apps/web/app/api/internal/code-search/route.ts:resolveCodeSearchCredentials` (and the analogous project-repo-integration branch) to check `tokenExpiresAt` on the resolved credential and trigger `refreshOAuthToken` + persist the refreshed token when expired. Both branches (`ProjectRepositoryIntegration` and `WorkflowIntegration`) need this — the current code reads a stale token from either store and hands it to Octokit with no expiry check.

Because code search is called from an HTTP request path, the refresh must happen synchronously before the credentials are returned. The existing optimistic-lock CAS in `refreshProjectRepoToken` handles the concurrency case for project-level credentials. For `WorkflowIntegration`, reuse the module-level `refreshInProgress` lock from `packages/integrations/src/github/index.ts` (or move it into a shared location — see Open Questions).

### Step 7 — Rebuild and verify

- Run `pnpm type-check` and `pnpm biome check` across the monorepo.
- Rebuild any langchain agent whose tsup bundle inlines `@repo/utils`. Per the memory, all eight JS agents (`document-generator-agent`, `project-document-generator-agent`, `api-agent`, `custom-agent-runtime`, `data-analyst-agent`, `prompt-enhancer-agent`, `story-breakdown-agent`, `task-planner-agent`) need rebuild-and-restart after `@repo/agent-core` or `@repo/agent-prompts` changes — confirm whether `@repo/utils` changes also trigger inclusion before batch-rebuilding.
- Restart `temporal-worker` via Aspire MCP since `packages/temporal` changed.
- Manual verification:
  - GitHub MCP force-expiry + MCP tool call (Steps 1 and 2 covered).
  - Notion MCP force-aged `updatedAt` + MCP tool call (Steps 1 and 2 covered).
  - WorkflowIntegration-driven GitHub workflow node (Step 3 covered).
  - Scheduled repo-integration-health-check run (Step 4 covered).
  - AI Assistant code search against an expired `ProjectRepositoryIntegration` token (Step 6 covered).

## Testing Strategy

**Only unit tests for the helper.** The helper's vitest coverage is comprehensive — the callers rely on existing integration coverage, which should continue to pass unchanged since this is a pure refactor.

No integration tests that mock the token endpoint and run each caller's full refresh-then-persist flow in scope for this PR. Those would provide strong regression coverage but are a meaningful extra investment. Revisit if a future OAuth bug still sneaks through after this refactor.

## Scope — What Is and Is Not In This PR

**In scope (all in one PR):**
- Steps 0–7 above.
- GitHub refresh consolidation across the four live call sites.
- Deletion of the dead `refreshGitHubToken` export.
- Code-search on-demand refresh (Step 6).

**Explicitly out of scope:**
- GitLab refresh consolidation. The same helper can handle it since GitLab OAuth is RFC 6749 compliant and just uses a different token endpoint. Deferred to a follow-up PR.
- Microsoft refresh consolidation. Microsoft OAuth has extra nuances (tenant-specific endpoints, conditional access, MSAL-specific flows).
- Schema unification of `WorkflowIntegration` + `ProjectRepositoryIntegration` + `MCPConfig` into a single credential table.
- `FABRIC_GITHUB_CLIENT_ID` vs `GITHUB_CLIENT_ID` env var naming cleanup.
- Migrating the `WorkflowIntegration.credentials` opaque JSON blob to typed columns.

## Open Questions

1. **Concurrent refresh locking for the shared path.** The four callers have three different locking strategies (module Map, optimistic CAS, none). The helper does not handle locking — each caller keeps its own. Is that the right call, or should there be a shared `withOAuthRefreshLock(key, fn)` utility that callers opt into? For Step 6 (code search refresh), picking "none" means concurrent code-search requests could double-refresh; picking the module Map from `integrations/src/github/index.ts` means importing from that package into the web app, which is probably fine but needs verification.
2. **Rebuild-and-restart scope for agents.** Does a change to `@repo/utils` force rebuilds of all eight JS agents, or only ones whose tsup bundle actually imports from the new module? Verify with `pnpm --filter <agent> ls` or tsup config before committing to a mass rebuild.
3. **Notion rotating refresh tokens.** The MCP refresh paths (#1, #2) have no concurrency lock today. Notion rotates refresh tokens on every refresh, so two concurrent refreshes can permanently break the rotation chain. This is a real correctness gap the shared helper does not address — arguably should be fixed by adding optimistic-lock CAS to MCP refresh as well, which would be a small additive change during Steps 1 and 2. Worth doing alongside this refactor, but flagging explicitly since it's a behavioral change not just a refactor.

## Why This Is Worth Doing

- **Prevents #446-class bugs.** The next time someone fixes a token-refresh quirk (new provider error code, new header requirement, new OAuth spec clarification), the fix lands in one place and all four stores benefit.
- **Removes real latent bugs.** Implementations #3, #4, and #5 today lack public client support and SSRF protection. This refactor fixes them as a side effect.
- **Fixes the code-search gap.** The "AI Assistant silently can't see the codebase the day after you connect GitHub" bug is the single most user-visible consequence of the current fragmentation.
- **Kills dead code.** One exported-but-unused refresh function removed.
- **Does not require a data migration.** No schema changes. Pure code refactor. Reversible commit-by-commit.

## Why This Is Not Worth Doing Right Now

- It touches four packages and the temporal worker. Blast radius is moderate; a bad merge during a release window could regress token refresh across the product. Schedule it during a quiet period.
- If the rebuild-scope question (Open Question 2) turns out to force all eight agents to be rebuilt, that is an additional operational cost each time this PR is deployed to a developer's environment.
- The gains are engineering quality, not user-visible features. Easy to deprioritize if other work is competing.

## Precedent

PR `#446` fixed the MCP refresh path for GitHub and Notion. This refactor exists because that PR had to touch three files to fix one bug — a one-file fix would have been better, and would have automatically carried the same corrections to the other two call sites.

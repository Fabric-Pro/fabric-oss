/**
 * The single definition of how an OAuth-refresh advisory lock is addressed.
 *
 * Deliberately dependency-free — no Prisma client, no `db` import — so every
 * refresh implementation can share it regardless of whether it owns its own
 * transaction or borrows one. That matters because the alternative (forcing
 * everything through one `withRefreshLock` wrapper) would break the structural
 * `db` accessor abstraction the GitLab helper uses for testability.
 *
 * WHY THIS EXISTS: refresh locks were previously addressed four different ways.
 * Two used `pg_advisory_xact_lock(int4, int4)`, two used
 * `pg_advisory_xact_lock(int8)` — and Postgres treats those as SEPARATE lock
 * spaces, so they could never block each other. The GitLab personal connection
 * was the live casualty: `gitlab/index.ts` locked it as `wfint:<id>` in the
 * two-int space while the repo/branch pickers locked the SAME row as
 * `user:<id>` in the bigint space. Neither waited for the other, both spent the
 * same single-use rotating refresh token, and the loser flagged a healthy
 * connection as needing re-authentication.
 *
 * Two rules keep that fixed:
 *   1. every caller uses `REFRESH_ADVISORY_CLASS` + `advisoryObjectKey`, so all
 *      locks live in one space;
 *   2. the key comes from a builder below, so the same row is always addressed
 *      by the same string no matter which code path reaches it.
 */

/**
 * Advisory-lock class id namespacing OAuth refresh exchanges (arbitrary but
 * stable). Paired with a per-credential object key so refreshes of the SAME
 * credential serialize across every process, while different credentials stay
 * independent.
 */
export const REFRESH_ADVISORY_CLASS = 0x52674b; // "RgK"

/**
 * Stable signed-int32 hash (FNV-1a) of a key for the advisory-lock object id.
 *
 * Must stay byte-identical across callers: two paths that hash the same key
 * differently would land on different lock ids and silently stop serializing.
 */
export function advisoryObjectKey(id: string): number {
	let hash = 0x811c9dc5; // offset basis
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime
	}
	return hash | 0; // coerce to signed int32
}

/**
 * Lock key for a personal/org connection (`WorkflowIntegration`) — the store
 * behind the workflow builder, repo pickers and agent tool calls.
 */
export function workflowIntegrationLockKey(integrationId: string): string {
	return `wfint:${integrationId}`;
}

/**
 * Lock key for a project-repository connection
 * (`ProjectRepositoryIntegration`) — the store behind cloning, indexing,
 * code search and scans.
 */
export function repoIntegrationLockKey(integrationId: string): string {
	return `repo:${integrationId}`;
}

/** Lock key for an MCP server credential (`MCPConfig`). */
export function mcpConfigLockKey(configId: string): string {
	return `mcp:${configId}`;
}

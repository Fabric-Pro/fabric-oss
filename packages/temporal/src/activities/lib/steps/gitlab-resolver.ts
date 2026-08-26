/**
 * Shared GitLab source resolver for Temporal step activities.
 *
 * Picks an MCPConfig (official GitLab MCP) if present, otherwise falls back
 * to the WorkflowIntegration REST token. Step activities then dispatch via
 * `callMcpWithRestFallback` with a REST-fallback closure built on
 * `gitlabFetch` / `gitlabPost`.
 */

import { db } from "@repo/database";
import {
	createGitLabRefreshFailureWriter,
	type GitLabSource,
	getGitLabAccessToken,
	refreshMcpConfigToken,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";
import { decryptApiKey } from "@repo/utils";

export async function resolveGitLabRestTokenForStep(opts: {
	userId: string;
	organizationId?: string;
}): Promise<string | null> {
	// Route through getGitLabAccessToken (not the raw credential fetch) so the
	// step REST path gets a refreshed token. GitLab OAuth tokens expire ~2h;
	// returning the stored token directly made codebase step calls 401 once it
	// lapsed, with no refresh on this path.
	return getGitLabAccessToken(opts.userId, opts.organizationId ?? undefined);
}

export async function resolveGitLabSourceForStep(opts: {
	userId: string;
	organizationId?: string;
}): Promise<GitLabSource | null> {
	return resolveGitLabSource({
		userId: opts.userId,
		organizationId: opts.organizationId ?? null,
		// PrismaClient is structurally compatible at runtime; the explicit
		// resolver interface narrows to a tiny accessor surface and asserting
		// `as never` here matches the pattern used at the api call sites.
		db: db as never,
		decrypt: decryptApiKey,
		refresh: (configId) =>
			refreshMcpConfigToken({ configId, db: db as never }),
		getRestToken: ({ userId, organizationId }) =>
			resolveGitLabRestTokenForStep({
				userId,
				organizationId: organizationId ?? undefined,
			}),
		// Shared with the API procedures and the PM adapter so a workflow
		// step can't be the one call site that silently records nothing. A
		// transient step failure must not condemn a working credential —
		// only a provider rejection sets `needsReauth`; see the writer's own
		// doc comment.
		markRefreshFailure: createGitLabRefreshFailureWriter(db as never),
	});
}

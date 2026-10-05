/**
 * Shared GitLab source resolver for Temporal step activities.
 *
 * Uses the person's GitLab connection through the official GitLab MCP
 * endpoint when it is capable, otherwise through REST. Step activities then dispatch via
 * `callMcpWithRestFallback` with a REST-fallback closure built on
 * `gitlabFetch` / `gitlabPost`.
 */

import {
	type GitLabApiCredential,
	type GitLabSource,
	getGitLabApiCredential,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";

export async function resolveGitLabRestTokenForStep(opts: {
	userId: string;
	organizationId?: string;
}): Promise<GitLabApiCredential | null> {
	// Route through the connection service (not the raw credential fetch) so
	// the step REST path gets a refreshed token — GitLab OAuth tokens expire
	// ~2h — together with the REST base of the instance that issued it, so a
	// self-hosted credential is never sent to gitlab.com.
	return getGitLabApiCredential(
		opts.userId,
		opts.organizationId ?? undefined,
	);
}

export async function resolveGitLabSourceForStep(opts: {
	userId: string;
	organizationId?: string;
}): Promise<GitLabSource | null> {
	// Both transports carry the person's one GitLab connection; see
	// `resolveGitLabSource`.
	return resolveGitLabSource({
		userId: opts.userId,
		organizationId: opts.organizationId ?? null,
	});
}

/**
 * The one answer to "is this person's GitLab connected?", for the screens that show it.
 *
 * The surfaces that show a person's GitLab status — the integration
 * settings, the generic OAuth status, the integration lists, the MCP server
 * tile, the project-management picker — read it through here, so the same
 * (user, organization) gets the same answer on each of them; the agreement is
 * checked by `packages/api/modules/integrations/__tests__/procedures/gitlab-one-status.test.ts`
 * and the MCP status route's own test. A new status surface has to read it
 * here too for that to hold. It is a thin view of
 * `getGitLabConnectionStatus` (the connection service's own status, after the
 * same classification of a legacy row every service read runs); nothing here
 * reads a token or a project repository link. A person whose only GitLab access is a
 * project repository link is therefore "not connected": a repository link is
 * a team grant with its own token, never the person's connection.
 */

import {
	type GitLabConnectionDeps,
	type GitLabConnectionStatus,
	type GitLabTenant,
	getGitLabConnectionStatus,
	readStoredGitLabConnectionStatus,
} from "./connection";

/**
 * - `connected` — a usable personal connection.
 * - `needs-reconnect` — a connection exists but its grant is dead (or its
 *   stored credential cannot be read); the person must reconnect.
 * - `not-connected` — no connection, or it was disconnected.
 */
export type GitLabPersonalConnectionState =
	| "connected"
	| "needs-reconnect"
	| "not-connected";

export type GitLabPersonalConnectionSummary = {
	state: GitLabPersonalConnectionState;
	/** The WorkflowIntegration row backing the connection, when one exists. */
	integrationId: string | null;
	/** The GitLab instance that issued the credential; null when unknown. */
	origin: string | null;
	account: {
		username: string | null;
		name: string | null;
		avatarUrl: string | null;
	} | null;
};

export function gitlabConnectionStateOf(
	status: Pick<GitLabConnectionStatus, "connected" | "needsReauth">,
): GitLabPersonalConnectionState {
	if (!status.connected) {
		return "not-connected";
	}
	return status.needsReauth ? "needs-reconnect" : "connected";
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function summarizeGitLabConnection(
	status: GitLabConnectionStatus,
): GitLabPersonalConnectionSummary {
	const state = gitlabConnectionStateOf(status);
	if (state === "not-connected") {
		return {
			state,
			integrationId: null,
			origin: null,
			account: null,
		};
	}
	const settings = status.settings ?? {};
	return {
		state,
		integrationId: status.integrationId ?? null,
		origin: status.origin || null,
		account: {
			username: stringOrNull(settings.gitlabUsername),
			name: stringOrNull(settings.gitlabName),
			avatarUrl: stringOrNull(settings.gitlabAvatarUrl),
		},
	};
}

/**
 * The person's GitLab connection status and its summary, read once. Callers
 * that need fields the summary does not carry (transport probe results, the
 * generation for a fenced write) use `status`.
 */
export async function readGitLabPersonalConnection(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<{
	status: GitLabConnectionStatus;
	summary: GitLabPersonalConnectionSummary;
}> {
	const status = await getGitLabConnectionStatus(tenant, overrides);
	return { status, summary: summarizeGitLabConnection(status) };
}

/**
 * The same summary WITHOUT classification or any other write: the connection
 * exactly as stored (`readStoredGitLabConnectionStatus`). For a read about a
 * tenant other than the one the request acts in, which must not change that
 * tenant's rows.
 */
export async function inspectGitLabPersonalConnection(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<GitLabPersonalConnectionSummary> {
	return summarizeGitLabConnection(
		await readStoredGitLabConnectionStatus(tenant, overrides),
	);
}

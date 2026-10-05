/**
 * Provider-level "is it connected?" for the screens that summarise a whole
 * provider (the Connections catalogue, the workflow integration settings),
 * from the workflow integration list (`workflows.integrations.list` /
 * `listStatus`) and the Data Connection sources.
 *
 * GitLab is answered by the person's own connection only, the state every
 * GitLab screen reports. The integration list carries it as
 * `connectionState` on exactly one kind of row: the caller's own personal
 * GitLab row (`gitlabConnectionRowStatus` in
 * `packages/api/modules/integrations/lib/gitlab-list-status.ts`). Every
 * other GitLab row keeps its raw `hasCredentials` and no state, and none of
 * them is the person's connection:
 *
 *  - a workflow-scoped GitLab credential (`workflowId` set) belongs to that
 *    workflow and survives a personal disconnect on purpose;
 *  - the `GITLAB_OAUTH_APP` row holds the OAuth client, not a grant;
 *  - another member's personal row, in an organization-wide list.
 *
 * So a GitLab provider is connected only when that state is `connected`; no
 * row carrying it means not connected. The raw per-row `hasCredentials`
 * stays the evidence where workflow credentials themselves are managed.
 */

export type GitLabPersonalConnectionState =
	| "connected"
	| "needs-reconnect"
	| "not-connected";

type IntegrationListRow = {
	provider: string;
	hasCredentials: boolean;
	connectionState?: GitLabPersonalConnectionState;
};

/** The person's GitLab connection state, as the integration list reports it. */
export function gitlabStateFromIntegrationList(
	rows: readonly IntegrationListRow[] | null | undefined,
): GitLabPersonalConnectionState {
	for (const row of rows ?? []) {
		if (row.provider === "GITLAB" && row.connectionState) {
			return row.connectionState;
		}
	}
	return "not-connected";
}

/**
 * Whether this list row is evidence that its provider is connected. A GitLab
 * row never is on its own: GitLab is decided by
 * `gitlabStateFromIntegrationList`.
 */
export function rowShowsProviderConnected(row: IntegrationListRow): boolean {
	return row.provider !== "GITLAB" && row.hasCredentials;
}

/** Whether a provider counts as connected, from the whole list. */
export function providerConnectedInIntegrationList(
	rows: readonly IntegrationListRow[] | null | undefined,
	provider: string,
): boolean {
	if (provider === "GITLAB") {
		return gitlabStateFromIntegrationList(rows) === "connected";
	}
	return (rows ?? []).some(
		(row) => row.provider === provider && rowShowsProviderConnected(row),
	);
}

/**
 * Whether a Data Connection source can search now. A source outlives its
 * grant: a disconnect leaves it EXPIRED, an unfinished OAuth leaves it
 * PENDING, and neither can search. GitLab sources search with the acting
 * person's own GitLab connection, so one counts only while that connection
 * is connected.
 */
export function isSearchSourceConnected(
	source: { provider: string; status?: string | null },
	gitlabState: GitLabPersonalConnectionState,
): boolean {
	if (source.status === "EXPIRED" || source.status === "PENDING") {
		return false;
	}
	if (source.provider === "GITLAB") {
		return gitlabState === "connected";
	}
	return true;
}

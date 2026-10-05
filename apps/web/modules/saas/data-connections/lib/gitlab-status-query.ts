import { orpcClient } from "@shared/lib/orpc-client";

/**
 * The one definition of the `gitlab.status` query.
 *
 * Three screens read this status under the same query key (the workflow
 * GitLab settings, the project repository settings and the connection page).
 * React Query keeps one cache entry per key, so a consumer that swallowed a
 * failed request into `{ connected: false }` cached that guess as a fresh
 * success for every other consumer for the next 30 seconds: the workflow
 * settings then saw neither "connected" nor an error. They all share these
 * options so a failure stays a failure (`isError`) for everyone. A failed
 * first load leaves no data; a failed refetch keeps the last successful data,
 * as React Query does by default.
 */
export const GITLAB_STATUS_QUERY_KEY = "gitlab-oauth-status";

export function gitlabStatusQueryOptions(
	organizationId: string | null | undefined,
) {
	return {
		queryKey: [GITLAB_STATUS_QUERY_KEY, organizationId ?? null] as const,
		queryFn: () =>
			orpcClient.integrations.gitlab.status({
				organizationId: organizationId ?? null,
			}),
		staleTime: 30_000,
		retry: 1,
		retryDelay: 500,
	};
}

/**
 * Every cached query that renders the person's GitLab connection state, by
 * key prefix:
 *
 * - `gitlab.status` (this file): the workflow GitLab settings, the project
 *   repository settings and the GitLab provider page;
 * - `workflows.integrations.list` (`workflow-integrations`): the provider
 *   page, the workflow integration settings, the agent tool and data-source
 *   sheets and the agent builder;
 * - `workflows.integrations.listStatus` (`workflow-integration-status`): the
 *   Connections page;
 * - the PM picker (`mcp.availablePmTools`);
 * - Data Connections (`data-connections`, `data-connection`), which a
 *   disconnect marks expired;
 * - the MCP server configs (`mcp-configs`) and the Connections page's MCP
 *   registry tiles (`connections`, `mcp-registry`);
 * - the integration settings' account summary
 *   (`account-settings-integrations`).
 */
const GITLAB_CONNECTION_VIEW_QUERY_KEYS: ReadonlyArray<readonly string[]> = [
	[GITLAB_STATUS_QUERY_KEY],
	["workflow-integrations"],
	["workflow-integration-status"],
	["mcp.availablePmTools"],
	["data-connections"],
	["data-connection"],
	["mcp-configs"],
	["connections", "mcp-registry"],
	["account-settings-integrations"],
];

/**
 * After a personal GitLab disconnect from any screen, refresh every other
 * screen that shows the connection, so none keeps showing it connected.
 */
export async function invalidateGitLabConnectionViews(queryClient: {
	invalidateQueries: (filters: { queryKey: readonly string[] }) => unknown;
}): Promise<void> {
	await Promise.all(
		GITLAB_CONNECTION_VIEW_QUERY_KEYS.map((queryKey) =>
			queryClient.invalidateQueries({ queryKey }),
		),
	);
}

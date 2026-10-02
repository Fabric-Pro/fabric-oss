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

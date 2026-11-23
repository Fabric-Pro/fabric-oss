"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

/**
 * How many proposals the Rejected proposals list holds, for the count on the
 * Roadmap's Rejected proposals entry. Keyed under the inbox badge count, so
 * every inbox action that refreshes the badge refreshes this count too.
 */
export function useRejectedProposalsCount(
	projectId: string,
	organizationId: string | null,
): number {
	const { data } = useQuery({
		queryKey: [
			"teams-channel-monitor-pending-proposals-count",
			projectId,
			organizationId,
			"rejected",
		],
		queryFn: () =>
			orpcClient.projects.teamsChannelMonitor.pendingProposals.count({
				projectId,
				organizationId,
				rejected: true,
			}),
		enabled: !!projectId,
		refetchInterval: 30_000,
		refetchOnWindowFocus: true,
	});
	return data?.count ?? 0;
}

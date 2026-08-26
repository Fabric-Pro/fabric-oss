"use client";

import { useTenantQuery } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";

/**
 * Slow enough that an idle workspace costs almost nothing, fast enough that a
 * job started in another tab shows up without a reload. Matches the
 * notification bell's cadence, which this badge sits next to.
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * Count of running background jobs — drives the navigation badge.
 *
 * `enabled` is honoured so the kill switch actually stops the traffic: if the
 * reason to disable the Job Hub is load, hiding the icon while every client
 * keeps polling would not help.
 */
export function useActiveJobCount(enabled = true) {
	return useTenantQuery<{ count: number }>({
		baseKey: ["jobs", "activeCount"],
		queryFn: (organizationId) =>
			orpcClient.jobs.activeCount({ organizationId }) as Promise<{
				count: number;
			}>,
		enabled,
		refetchOnWindowFocus: true,
		refetchInterval: POLL_INTERVAL_MS,
		staleTime: POLL_INTERVAL_MS / 2,
	});
}

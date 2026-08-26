"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useInvalidatePmSyncState } from "../use-invalidate-pm-sync-state";

/**
 * Unified Review Center client state.
 *
 * The actionable inbox is a LIVE query (`reviewCenter.items` / `reviewCenter.count`)
 * — it reads neither `PmSyncLog` rows nor pre-built history. The per-row actions
 * are the EXISTING resolve / retry / accept-reject surfaces; this module only owns
 * the shared invalidation so the badge count and the grouped list both refresh on
 * success (the reused mutations don't know about `reviewCenter.*`).
 */

export function useReviewCenterCount(projectId: string) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		...orpc.projects.reviewCenter.count.queryOptions({
			input: { projectId, organizationId },
		}),
		// Actionable items are produced by worker syncs out-of-band, so the
		// roadmap badge must stay current without a page reload: poll, and also
		// refetch on mount / window focus (overrides the global 60s staleTime).
		refetchInterval: 60_000,
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: true,
	});
}

export function useReviewCenterItems(projectId: string, enabled: boolean) {
	const { organizationId } = useOrganizationContext();

	return useQuery({
		...orpc.projects.reviewCenter.items.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled,
		// Re-fetch every time the panel opens / window refocuses so the grouped
		// list reflects conflicts/failures created since it was last viewed.
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: true,
	});
}

/**
 * Returns a callback that refreshes every PM-sync surface after a row action:
 * `reviewCenter.items` + `reviewCenter.count` (the grouped list + the toolbar
 * badge) AND the roadmap/editor story queries (`stories.list` / `stories.get`).
 * A row action must clear the conflict pill on the card behind the sheet, not
 * just its own list and badge — so this delegates to the shared helper.
 */
export function useInvalidateReviewCenter(projectId: string) {
	return useInvalidatePmSyncState(projectId);
}

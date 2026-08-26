"use client";

import type { NotificationType } from "@repo/database";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";

export type NotificationsListInput = {
	limit?: number;
	status?: "all" | "unread" | "archived";
	category?:
		| "MENTION"
		| "REPLY"
		| "ASSIGNMENT"
		| "STATUS"
		| "AGENT"
		| "PROJECT"
		| "SYSTEM";
	/** Precise type filter used by the inbound/conflict tabs (AC-10). */
	types?: NotificationType[];
};

/**
 * Cursor-paginated notifications list, scoped to the active tenant.
 *
 * The query key intentionally starts with `["tenant", organizationId,
 * "notifications", "list", ...]` so that the broader invalidation in
 * `use-archive.ts` (which targets `["tenant", organizationId,
 * "notifications"]`) still refreshes every paginated variant after an
 * archive/restore mutation.
 *
 * The popover should clamp to `pages[0]`; the full Notifications page can
 * call `fetchNextPage` behind a Load-more button. We intentionally avoid
 * auto-infinite scroll for the page — the user requests the next page.
 */
export function useNotifications(input: NotificationsListInput = {}) {
	const organizationId = useOrganizationId();
	const status = input.status ?? "all";
	const category = input.category;
	const types = input.types;
	const limit = input.limit ?? 20;

	return useInfiniteQuery({
		queryKey: [
			"tenant",
			organizationId,
			"notifications",
			"list",
			{ status, category, types, limit },
		] as const,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			orpcClient.notifications.list({
				organizationId,
				cursor: pageParam,
				limit,
				status,
				category,
				types,
			}),
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		refetchOnWindowFocus: true,
	});
}

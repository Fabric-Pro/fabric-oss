"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

/**
 * Sync History tab client state.
 *
 * Read-only, paginated, filtered, newest-first view of `PmSyncLog` rows for a
 * project. The procedure (`projects.pmSyncLog.list`) is gated on `PROJECT_READ`
 * — the same permission as the change log it sits beside — and is NOT itself
 * audited (D-Q11). The query is fully driven by `filters` + `page`; nothing
 * mutates here.
 */

export const PM_SYNC_LOG_PAGE_SIZE = 50;

export type PmSyncLogStatusFilter = "SUCCESS" | "FAILURE" | "CONFLICT";

export type PmSyncLogFilters = {
	pmTool?: string;
	entityId?: string;
	status?: PmSyncLogStatusFilter;
	dateFrom?: Date;
	dateTo?: Date;
};

type UsePmSyncLogArgs = {
	projectId: string;
	filters: PmSyncLogFilters;
	page: number;
	/** Pause while the tab is hidden — the panel stays mounted to preserve
	 *  filters, but a background tab must not poll or refetch. */
	enabled?: boolean;
};

export function usePmSyncLog({
	projectId,
	filters,
	page,
	enabled = true,
}: UsePmSyncLogArgs) {
	const { organizationId } = useOrganizationContext();

	const input = {
		projectId,
		organizationId,
		pmTool: filters.pmTool,
		entityId: filters.entityId,
		status: filters.status,
		dateFrom: filters.dateFrom,
		dateTo: filters.dateTo,
		limit: PM_SYNC_LOG_PAGE_SIZE,
		offset: page * PM_SYNC_LOG_PAGE_SIZE,
	};

	return useQuery({
		...orpc.projects.pmSyncLog.list.queryOptions({ input }),
		enabled: enabled && Boolean(projectId),
		placeholderData: keepPreviousData,
		// pm_sync_log rows are written by the Temporal worker out-of-band, so the
		// tab must re-fetch when reopened or the window refocuses — otherwise the
		// global 60s staleTime serves cached rows until a full page reload.
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: true,
	});
}

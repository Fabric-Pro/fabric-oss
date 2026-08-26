"use client";

import { useCallback, useState } from "react";
import { HistoryError } from "../../BacklogHistoryShared";
import { SyncHistoryFilters } from "./SyncHistoryFilters";
import {
	type PmSyncLogRow,
	SyncHistoryPager,
	SyncHistoryTable,
} from "./SyncHistoryTable";
import { type PmSyncLogFilters, usePmSyncLog } from "./use-pm-sync-log";

type Props = {
	projectId: string;
	/** False while the sibling tab is showing. The panel stays mounted so its
	 *  filters and page survive a tab switch; the query pauses meanwhile. */
	active: boolean;
};

/**
 * Read-only, filtered, paginated, newest-first view of `PmSyncLog` for a
 * project. Rendered as the "Sync History" tab of the roadmap's change-history
 * modal (`BacklogAuditDialog`), which supplies the surrounding heading.
 *
 * Lays itself out as pinned filter chrome / scrolling rows / pinned pager to
 * match the Change History tab — the two tabs sit in one window, so scrolling
 * the filters away on one and not the other is felt immediately.
 *
 * Filters compose with AND server-side; changing any filter resets to page 0.
 * Full pagination (page size 50). No mutations.
 */
export function SyncHistoryView({ projectId, active }: Props) {
	const [filters, setFilters] = useState<PmSyncLogFilters>({});
	const [page, setPage] = useState(0);

	const handleFiltersChange = useCallback((next: PmSyncLogFilters) => {
		setFilters(next);
		setPage(0);
	}, []);

	const { data, isLoading, isFetching, isError, refetch } = usePmSyncLog({
		projectId,
		filters,
		page,
		enabled: active,
	});

	const rows = (data?.rows ?? []) as PmSyncLogRow[];
	const total = data?.total ?? 0;

	return (
		<>
			<div className="border-border/60 border-b px-6 py-3">
				<SyncHistoryFilters
					filters={filters}
					onChange={handleFiltersChange}
				/>
			</div>

			{/* Focusable because it is the scroll container. Radix gives a
			    `TabsContent` `tabIndex={0}`, so while the panel itself scrolled
			    the rows were keyboard-reachable for free; pinning the chrome
			    moved the scrolling onto this div and would otherwise have left
			    a page of failure rows (which contain no links at all) with no
			    way to scroll it. */}
			<div
				// biome-ignore lint/a11y/noNoninteractiveTabindex: axe's scrollable-region-focusable requires the opposite — a scroll container with no focusable child is unreachable by keyboard (WCAG 2.1.1) unless it takes focus itself.
				tabIndex={0}
				role="group"
				aria-label="Sync history entries"
				className="min-h-0 flex-1 overflow-y-auto px-6 py-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
			>
				{isError ? (
					<HistoryError onRetry={() => refetch()} />
				) : (
					<SyncHistoryTable
						rows={rows}
						total={total}
						isLoading={isLoading}
						isFetching={isFetching}
					/>
				)}
			</div>

			{!isError && total > 0 && (
				<div className="border-border/60 border-t px-6 py-3">
					<SyncHistoryPager
						rowCount={rows.length}
						total={total}
						page={page}
						isFetching={isFetching}
						onPageChange={setPage}
					/>
				</div>
			)}
		</>
	);
}

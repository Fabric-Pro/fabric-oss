"use client";

/**
 * AuditLogViewer
 *
 * Orchestrates the audit-log read surface — stats strip, filter chips,
 * active filter pills, sort dropdown, paginated table, JSON-metadata
 * drawer, the CSV/NDJSON export button, and the auto-refresh control.
 * Holds the filter state (URL-synced inside `AuditLogFilters`), the row
 * the user clicked to expand, the sort order, and the user's preferred
 * auto-refresh cadence (persisted to localStorage).
 *
 * Item 13/26: also owns the API key management drawer, opened from a
 * "Manage API keys" button next to Export/Refresh. The Sheet sits over
 * the page so the operator can rotate/revoke keys without leaving the
 * viewer.
 *
 * Keyboard shortcuts at the viewer level:
 *   - `r` → refetch the audit list
 *   - `/` → focus the correlation-ID filter search input
 *   - `Esc` → close the metadata drawer (the Sheet primitive already
 *     handles this; we just wire `onCorrelationClick` / row clicks)
 *   - `j`/`k` and `Enter` are handled inside `AuditLogTable`.
 *
 * Spec: docs/audit-log/README.md §8.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { KeyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AuditLogActivePills } from "./AuditLogActivePills";
import { AuditLogApiKeysDrawer } from "./AuditLogApiKeysDrawer";
import { AuditLogAutoRefreshControl } from "./AuditLogAutoRefreshControl";
import { AuditLogExportButton } from "./AuditLogExportButton";
import { AuditLogFilters } from "./AuditLogFilters";
import { AuditLogMetadataDrawer } from "./AuditLogMetadataDrawer";
import { AuditLogScopeToggle } from "./AuditLogScopeToggle";
import { AuditLogSortControl } from "./AuditLogSortControl";
import { AuditLogStatsStrip } from "./AuditLogStatsStrip";
import { AuditLogTable } from "./AuditLogTable";
import { AuditTraceDiagram } from "./AuditTraceDiagram";
import {
	type AuditLogFiltersState,
	type AuditSortOrder,
	type AuditViewerUser,
	EMPTY_FILTERS_STATE,
} from "./types";

interface AuditLogViewerProps {
	/**
	 * In-product viewer modes only. The admin "Audit Log Explorer" mounts
	 * the underlying components directly (not through this orchestrator)
	 * with its own data-source wiring, so `"explorer"` is never passed
	 * here.
	 */
	mode: "organization" | "personal";
	organizationId: string | null;
	viewerTimezone: string;
	canExport: boolean;
	currentUser: AuditViewerUser;
	docsEnabled: boolean;
}

export function AuditLogViewer({
	mode,
	organizationId,
	viewerTimezone,
	canExport,
	currentUser,
	docsEnabled,
}: AuditLogViewerProps) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	// Same query key and staleTime as the one inside AuditLogFilters, so react-query
	// serves both from one cached response rather than issuing a second request.
	const { data: taxonomy } = useQuery({
		queryKey: ["audit-log", "taxonomy"] as const,
		queryFn: () => orpcClient.audit.taxonomy({}),
		staleTime: 1000 * 60 * 60,
	});
	const [filters, setFilters] = useState<AuditLogFiltersState>(() =>
		mode === "personal"
			? { ...EMPTY_FILTERS_STATE, actorIds: [currentUser.id] }
			: EMPTY_FILTERS_STATE,
	);
	const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
	const [refreshInterval, setRefreshInterval] = useState<number | false>(
		false,
	);
	const [sort, setSort] = useState<AuditSortOrder>("newest");
	const [apiKeysOpen, setApiKeysOpen] = useState(false);
	const [traceCorrelationId, setTraceCorrelationId] = useState<string | null>(
		null,
	);

	// Global keyboard shortcuts. `r` refetches every audit-log query in
	// the cache; `/` focuses the correlation filter (the only persistent
	// text input in the toolbar). Handlers no-op when focus is inside an
	// existing input/textarea so typing in a filter never triggers them.
	useEffect(() => {
		function handle(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			const inEditable =
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target?.isContentEditable;

			if (event.key === "/" && !inEditable) {
				event.preventDefault();
				const el = document.querySelector<HTMLInputElement>(
					"[data-audit-filter-search]",
				);
				el?.focus();
				el?.select();
				return;
			}
			if (
				event.key === "r" &&
				!inEditable &&
				!event.metaKey &&
				!event.ctrlKey
			) {
				event.preventDefault();
				queryClient.invalidateQueries({ queryKey: ["audit-log"] });
				return;
			}
		}
		window.addEventListener("keydown", handle);
		return () => window.removeEventListener("keydown", handle);
	}, [queryClient]);

	return (
		// `min-w-0` lets the flex item shrink below content width so the
		// table's overflow-x:auto kicks in instead of pushing the parent
		// past the viewport edge (item 1 — sidebar toggle was being
		// covered by an over-wide table on narrow viewports).
		<div className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<AuditLogStatsStrip organizationId={organizationId} />
			</div>
			<AuditLogScopeToggle
				filters={filters}
				onFiltersChange={setFilters}
				allCategories={taxonomy?.categories ?? []}
			/>
			<div className="flex flex-col gap-3">
				<AuditLogFilters
					mode={mode}
					organizationId={organizationId}
					filters={filters}
					onFiltersChange={setFilters}
					currentUser={currentUser}
				/>
				{/* Toolbar splits along the dominant axis: active filter
				 * pills (the "what's narrowing this table?" signal) on the
				 * left, view + action controls on the right. At narrow
				 * widths the right side wraps to its own row first so the
				 * pills stay anchored to the filter card above. */}
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<AuditLogActivePills
						mode={mode}
						filters={filters}
						currentUser={currentUser}
						onFiltersChange={setFilters}
					/>
					<div
						className="ml-auto flex flex-wrap items-center justify-end gap-2"
						role="toolbar"
						aria-label={t("settings.auditLog.label")}
					>
						{/* View controls — sort + auto-refresh. Visually
						 * grouped via a hairline outline so the "how am I
						 * looking at this data" pair reads as one unit,
						 * distinct from the destructive/exporty actions on
						 * the right. */}
						<div className="flex items-center gap-1 rounded-md border border-border/50 bg-card/70 p-0.5">
							<AuditLogSortControl
								value={sort}
								onChange={setSort}
							/>
							<AuditLogAutoRefreshControl
								value={refreshInterval}
								onChange={setRefreshInterval}
							/>
						</div>
						{/* Data actions — export + API key management.
						 * Separate cluster keeps actions that change
						 * external state from the view-only controls. */}
						<div className="flex items-center gap-2">
							{canExport ? (
								<AuditLogExportButton
									organizationId={organizationId}
									filters={filters}
								/>
							) : null}
							<Button
								variant="outline"
								size="sm"
								onClick={() => setApiKeysOpen(true)}
								className="h-9 gap-2"
								data-testid="audit-open-api-keys"
							>
								<KeyIcon className="size-3.5" />
								{t(
									"settings.auditLog.apiKeysDrawer.openButton",
								)}
							</Button>
						</div>
					</div>
				</div>
			</div>
			<AuditLogTable
				mode={mode}
				organizationId={organizationId}
				filters={filters}
				viewerTimezone={viewerTimezone}
				onRowSelect={setSelectedRowId}
				onCorrelationClick={(id) =>
					setFilters((prev) => ({ ...prev, correlationId: id }))
				}
				refetchInterval={refreshInterval}
				sort={sort}
				currentUser={currentUser}
			/>
			<AuditLogMetadataDrawer
				organizationId={organizationId}
				filters={filters}
				selectedRowId={selectedRowId}
				viewerTimezone={viewerTimezone}
				onClose={() => {
					// Closing the row drawer also dismisses any open
					// trace panel (item 1: "closing the drawer dismisses
					// both"). The trace panel is anchored to a row, so
					// it doesn't make sense to keep it open once the row
					// detail goes away.
					setSelectedRowId(null);
					setTraceCorrelationId(null);
				}}
				onTraceCorrelation={(id) => {
					// v2 item 1: keep the row drawer open underneath so
					// the user can return to the row detail by closing
					// the left-side trace panel. The metadata drawer is
					// a right-side Sheet; the trace is a left-side Sheet
					// — both can be open simultaneously.
					setTraceCorrelationId(id);
				}}
			/>
			<AuditLogApiKeysDrawer
				mode={mode}
				organizationId={organizationId}
				docsEnabled={docsEnabled}
				open={apiKeysOpen}
				onOpenChange={setApiKeysOpen}
				onViewAuditTrail={(keyId) => {
					// Scope the main table to the lifecycle events for this
					// key. The key's CUID lives in the resourceId column so
					// a correlationId-scope is not quite right; we add a
					// dedicated quick filter via the resourceId equality —
					// for v1 we set the resourceName/projectId as a hint
					// inside the URL filter (full implementation deferred).
					setApiKeysOpen(false);
					setFilters((prev) => ({
						...prev,
						actions:
							mode === "organization"
								? [
										"org.api_key.created",
										"org.api_key.rotated",
										"org.api_key.revoked",
										"audit.api_request",
									]
								: [
										"account.api_key.created",
										"account.api_key.rotated",
										"account.api_key.revoked",
										"audit.api_request",
									],
						correlationId: keyId,
					}));
				}}
			/>
			<AuditTraceDiagram
				organizationId={organizationId}
				correlationId={traceCorrelationId}
				open={traceCorrelationId !== null}
				onClose={() => setTraceCorrelationId(null)}
				onShowInTable={(id) => {
					// "Show in main table" dismisses the full row-detail
					// surface — both the trace panel (left) AND the row
					// drawer (right) — so the user lands cleanly on the
					// filtered table. Previously only the trace panel
					// closed, leaving the row drawer stranded on top of
					// the table.
					setFilters((prev) => ({ ...prev, correlationId: id }));
					setTraceCorrelationId(null);
					setSelectedRowId(null);
				}}
			/>
		</div>
	);
}

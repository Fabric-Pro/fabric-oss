"use client";

/**
 * AuditLogExportButton
 *
 * Split-button: primary action runs an export (CSV/NDJSON), chevron
 * opens a dropdown with the last 5 exports the viewer can re-run.
 *
 * v2 item 6: history dropdown sources from existing `audit.exported`
 * audit-log rows (no new tables, no async jobs). Each entry surfaces
 * timestamp, format, row count, the user who triggered (org mode), and
 * a compact summary of the filter snapshot. Clicking "Re-download" on
 * a row re-runs the same export synchronously — v1 doesn't reuse the
 * original file, it just re-runs the query with the saved filter.
 *
 * Spec: docs/audit-log/README.md §8.2.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { useToast } from "@ui/hooks/use-toast";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ChevronDown,
	DownloadIcon,
	HistoryIcon,
	Loader2,
	RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import type { AuditLogFiltersState } from "./types";
import { filtersStateToApi } from "./types";

/**
 * Optional export-data-source override. When provided, the button skips
 * the in-product `orpc.audit.export` mutation + history dropdown and
 * instead runs the caller's aggregation pipeline. The admin "Audit Log
 * Explorer" passes one of these to walk the proxy procedure page by page
 * (the REST surface has no `export` endpoint) and build CSV/NDJSON
 * client-side.
 */
export interface AuditLogExportDataSource {
	/**
	 * Run the aggregation + return a downloadable Blob payload. Called
	 * once per `Export` click; the button shows a spinner while pending.
	 */
	export: (args: {
		format: "csv" | "ndjson";
		filter: ReturnType<typeof filtersStateToApi>;
	}) => Promise<{ body: string; filename: string; contentType: string }>;
}

interface AuditLogExportButtonProps {
	organizationId: string | null;
	filters: AuditLogFiltersState;
	/** Optional — see {@link AuditLogExportDataSource}. */
	dataSource?: AuditLogExportDataSource;
}

const LARGE_EXPORT_THRESHOLD = 5_000;
const HISTORY_LIMIT = 5;

function triggerDownload(args: {
	body: string;
	filename: string;
	contentType: string;
}): void {
	const blob = new Blob([args.body], { type: args.contentType });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = args.filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Defer the revoke so Safari has time to start the download. 100ms
	// is plenty in practice; we don't want to keep the URL alive.
	setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * Pull the filter snapshot off an `audit.exported` audit row's metadata.
 * The procedure stores the full input filter under `metadata.filters`.
 * Returns null for older rows that predate the snapshot.
 */
function readFilterSnapshot(metadata: unknown): Record<string, unknown> | null {
	if (!metadata || typeof metadata !== "object") {
		return null;
	}
	const m = metadata as Record<string, unknown>;
	if (m.filters && typeof m.filters === "object") {
		return m.filters as Record<string, unknown>;
	}
	return null;
}

/**
 * Compact human summary of a filter snapshot for the history dropdown.
 * Shows up to 2 fields inline + a "+N more" badge for the rest. Falls
 * back to a hint when no filter was applied.
 */
function summarizeFilter(snapshot: Record<string, unknown> | null): {
	primary: string;
	more: number;
	full: Record<string, unknown> | null;
} {
	if (!snapshot) {
		return { primary: "—", more: 0, full: null };
	}
	const parts: string[] = [];
	const entries = Object.entries(snapshot).filter(([, v]) => {
		if (v === null || v === undefined) {
			return false;
		}
		if (Array.isArray(v) && v.length === 0) {
			return false;
		}
		if (typeof v === "string" && v.length === 0) {
			return false;
		}
		return true;
	});
	if (entries.length === 0) {
		return { primary: "No filters", more: 0, full: snapshot };
	}
	let i = 0;
	for (const [key, value] of entries) {
		if (parts.length >= 2) {
			break;
		}
		if (Array.isArray(value)) {
			parts.push(`${key}: ${value.slice(0, 2).join(",")}`);
		} else if (typeof value === "string" || typeof value === "number") {
			parts.push(`${key}: ${String(value)}`);
		} else {
			parts.push(`${key}: …`);
		}
		i++;
	}
	const more = entries.length - parts.length;
	return { primary: parts.join(" · "), more, full: snapshot };
}

interface ExportHistoryEntry {
	id: string;
	createdAt: string;
	format: "csv" | "ndjson";
	rowCount: number;
	actorEmailSnapshot: string | null;
	filterSnapshot: Record<string, unknown> | null;
}

function rowToHistoryEntry(row: {
	id: string;
	createdAt: string | Date;
	actorEmailSnapshot: string | null;
	metadata: unknown;
}): ExportHistoryEntry | null {
	const md = (row.metadata ?? null) as {
		format?: unknown;
		rowCount?: unknown;
	} | null;
	const format = md?.format === "ndjson" ? "ndjson" : "csv";
	const rowCount =
		typeof md?.rowCount === "number" ? (md.rowCount as number) : 0;
	const createdAt =
		row.createdAt instanceof Date
			? row.createdAt.toISOString()
			: String(row.createdAt);
	return {
		id: row.id,
		createdAt,
		format,
		rowCount,
		actorEmailSnapshot: row.actorEmailSnapshot,
		filterSnapshot: readFilterSnapshot(row.metadata),
	};
}

export function AuditLogExportButton({
	organizationId,
	filters,
	dataSource,
}: AuditLogExportButtonProps) {
	const t = useTranslations();
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const queryFilter = filtersStateToApi(filters);
	const [pendingFormat, setPendingFormat] = useState<"csv" | "ndjson" | null>(
		null,
	);
	const isCustomSource = dataSource !== undefined;
	// In-flight guard against double-export: the disabled prop on the Button
	// only flips to `true` after React re-renders, so a fast follow-up
	// pointer event (observed in staging with Playwright: two POST
	// /api/rpc/audit/export ~70ms apart producing two CSV downloads + two
	// audit.exported rows) can sneak a second runExport call past the
	// `disabled` check. A ref flips synchronously on the first call inside
	// the same tick and blocks any re-entry until the mutation finishes.
	const inFlightRef = useRef(false);

	// Pull the totalCount from any cached page of the list query. The
	// table now uses page-based pagination (no `pages: []` wrapper) so we
	// look directly at the cached payload's `totalCount` field. Matching
	// on prefix covers any in-flight cached entries.
	const totalCount = useCallback((): number | undefined => {
		// queryFilter is retained in the closure so re-renders driven by
		// filter changes still re-evaluate this lookup.
		void queryFilter;
		const matches = queryClient.getQueriesData<{
			items?: unknown[];
			totalCount?: number;
		}>({ queryKey: ["audit-log", organizationId] });
		for (const [, data] of matches) {
			if (!data || typeof data !== "object") {
				continue;
			}
			const candidate = (data as { totalCount?: number }).totalCount;
			if (typeof candidate === "number") {
				return candidate;
			}
		}
		return undefined;
	}, [organizationId, queryFilter, queryClient]);

	// v2 item 6: pull the last 5 `audit.exported` rows for this tenant
	// to populate the history dropdown. Skipped in custom-data-source
	// mode (the explorer) — the public REST surface does not let staff
	// page audit rows via a separate filter without a second proxy hop,
	// and the explorer is staff-only so we don't need to surface
	// customer-side export history.
	const { data: historyData } = useQuery({
		queryKey: ["audit-log", "export-history", organizationId] as const,
		queryFn: () =>
			orpcClient.audit.list({
				organizationId: organizationId ?? null,
				cursor: undefined,
				limit: HISTORY_LIMIT,
				filter: { actions: ["audit.exported"] },
				sort: "newest",
			}),
		staleTime: 10 * 1000,
		refetchOnWindowFocus: false,
		enabled: !isCustomSource,
	});

	const history: ExportHistoryEntry[] = (historyData?.items ?? [])
		.map((row) =>
			rowToHistoryEntry({
				id: row.id,
				createdAt:
					row.createdAt instanceof Date
						? row.createdAt.toISOString()
						: String(row.createdAt),
				actorEmailSnapshot: row.actorEmailSnapshot,
				metadata: row.metadata,
			}),
		)
		.filter((e): e is ExportHistoryEntry => e !== null);

	const exportMutation = useMutation({
		mutationFn: async (args: {
			format: "csv" | "ndjson";
			filter?: Record<string, unknown>;
		}) => {
			// Custom export pipeline (audit-log explorer): aggregate pages
			// from the proxy procedure client-side and serialize. The
			// caller controls cap/page-size semantics.
			if (dataSource) {
				return await dataSource.export({
					format: args.format,
					filter: (args.filter ?? queryFilter) as ReturnType<
						typeof filtersStateToApi
					>,
				});
			}
			return await orpcClient.audit.export({
				organizationId: organizationId ?? null,
				format: args.format,
				filter: (args.filter ?? queryFilter) as never,
			});
		},
		onSuccess: (result) => {
			triggerDownload({
				body: result.body,
				filename: result.filename,
				contentType: result.contentType,
			});
			toast({
				title: t("settings.auditLog.export.success"),
				description: result.filename,
			});
			// Refresh the stats strip + history so the new export row shows
			// up immediately. Skipped in custom-data-source mode — the
			// explorer has no stats strip or in-product history view.
			if (!isCustomSource) {
				queryClient.invalidateQueries({
					queryKey: ["audit-log", "stats"],
				});
				queryClient.invalidateQueries({
					queryKey: ["audit-log", "export-history"],
				});
			}
		},
		onError: () => {
			// a11y / spec §8.5: never surface raw err.message — the toast
			// description must come from i18n so we don't leak internal
			// error details to users.
			toast({
				title: t("settings.auditLog.export.failed"),
				description: t("settings.auditLog.error.defaultMessage"),
				variant: "destructive",
			});
		},
	});

	const runExport = useCallback(
		(format: "csv" | "ndjson") => {
			// Synchronous re-entry guard — see `inFlightRef` declaration.
			if (inFlightRef.current || exportMutation.isPending) {
				return;
			}
			// Skip the 5k confirm dialog in explorer mode — the explorer's
			// `dataSource.export` is responsible for its own row-cap
			// semantics (50k client-side cap), and totalCount comes from
			// a different cache namespace.
			if (!isCustomSource) {
				const count = totalCount();
				if (
					typeof count === "number" &&
					count > LARGE_EXPORT_THRESHOLD
				) {
					setPendingFormat(format);
					return;
				}
			}
			inFlightRef.current = true;
			exportMutation.mutate(
				{ format },
				{
					onSettled: () => {
						inFlightRef.current = false;
					},
				},
			);
		},
		[isCustomSource, totalCount, exportMutation],
	);

	const confirmAndExport = useCallback(() => {
		if (!pendingFormat) {
			return;
		}
		if (inFlightRef.current || exportMutation.isPending) {
			return;
		}
		inFlightRef.current = true;
		exportMutation.mutate(
			{ format: pendingFormat },
			{
				onSettled: () => {
					inFlightRef.current = false;
				},
			},
		);
		setPendingFormat(null);
	}, [pendingFormat, exportMutation]);

	const reRun = useCallback(
		(entry: ExportHistoryEntry) => {
			if (inFlightRef.current || exportMutation.isPending) {
				return;
			}
			inFlightRef.current = true;
			exportMutation.mutate(
				{
					format: entry.format,
					filter: entry.filterSnapshot ?? {},
				},
				{
					onSettled: () => {
						inFlightRef.current = false;
					},
				},
			);
		},
		[exportMutation],
	);

	const totalCountDisplay = totalCount() ?? "";

	const noRows = totalCount() === 0;
	const exportsToday = history.filter((h) => {
		const dt = new Date(h.createdAt);
		const start = new Date();
		start.setUTCHours(0, 0, 0, 0);
		return dt.getTime() >= start.getTime();
	}).length;

	return (
		<TooltipProvider>
			<div
				className="inline-flex items-stretch"
				data-testid="audit-export-group"
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							aria-label={t("settings.auditLog.export.ariaLabel")}
							disabled={exportMutation.isPending || noRows}
							className={cn(
								"h-9 gap-2 rounded-r-none border-r-0",
							)}
							onClick={() => runExport("csv")}
							data-testid="audit-export-primary"
						>
							{exportMutation.isPending ? (
								<Loader2 className="size-3.5 motion-safe:animate-spin" />
							) : (
								<DownloadIcon className="size-3.5" />
							)}
							{t("settings.auditLog.export.label")}
							{exportsToday > 0 ? (
								<Badge
									variant="outline"
									data-testid="audit-export-today-badge"
									className="ml-1 h-5 border-border/60 bg-card px-1.5 text-[10px] text-muted-foreground"
								>
									{exportsToday}
								</Badge>
							) : null}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{t("settings.auditLog.tooltips.exportSplit")}
					</TooltipContent>
				</Tooltip>
				<DropdownMenu modal={false}>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							aria-label={t(
								"settings.auditLog.export.historyAriaLabel",
							)}
							disabled={exportMutation.isPending}
							className="h-9 gap-1 rounded-l-none px-2"
							data-testid="audit-export-chevron"
						>
							<ChevronDown className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="w-[360px]"
						data-testid="audit-export-history-menu"
					>
						<DropdownMenuLabel className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
							<DownloadIcon className="size-3 opacity-70" />
							{t("settings.auditLog.export.dropdownHeading")}
						</DropdownMenuLabel>
						<DropdownMenuItem
							onSelect={() => runExport("csv")}
							data-testid="audit-export-csv-now"
						>
							<DownloadIcon className="size-3.5" />
							<span className="ml-2">
								{t("settings.auditLog.export.csv")}
							</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => runExport("ndjson")}
							data-testid="audit-export-ndjson-now"
						>
							<DownloadIcon className="size-3.5" />
							<span className="ml-2">
								{t("settings.auditLog.export.ndjson")}
							</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
							<HistoryIcon className="size-3 opacity-70" />
							{t("settings.auditLog.export.historyHeading")}
						</DropdownMenuLabel>
						{isCustomSource ? (
							<div
								className="px-2 py-3 text-xs text-muted-foreground"
								data-testid="audit-export-history-empty"
							>
								{t("settings.auditLog.export.historyEmpty")}
							</div>
						) : history.length === 0 ? (
							<div
								className="px-2 py-3 text-xs text-muted-foreground"
								data-testid="audit-export-history-empty"
							>
								{t("settings.auditLog.export.historyEmpty")}
							</div>
						) : (
							history.map((entry) => {
								const dt = new Date(entry.createdAt);
								let relative = "";
								try {
									relative = formatDistanceToNow(dt, {
										addSuffix: true,
									});
								} catch {
									relative = dt.toISOString();
								}
								const summary = summarizeFilter(
									entry.filterSnapshot,
								);
								return (
									<div
										key={entry.id}
										className="flex flex-col gap-1 px-2 py-2"
										data-testid="audit-export-history-entry"
									>
										<div className="flex items-center justify-between gap-2 text-xs">
											<div className="flex items-center gap-2">
												<span className="font-mono uppercase text-[10px] tracking-wider text-muted-foreground">
													{entry.format}
												</span>
												<span className="text-foreground">
													{relative}
												</span>
												<Badge
													variant="outline"
													className="h-4 border-border/60 bg-card px-1.5 text-[10px] text-muted-foreground"
												>
													{entry.rowCount.toLocaleString()}{" "}
													rows
												</Badge>
											</div>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
														className="h-6 gap-1 px-2 text-[11px]"
														onClick={(e) => {
															e.preventDefault();
															reRun(entry);
														}}
														aria-label={t(
															"settings.auditLog.export.reDownload",
														)}
														data-testid="audit-export-redownload"
													>
														<RefreshCwIcon className="size-3" />
														{t(
															"settings.auditLog.export.reDownload",
														)}
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t(
														"settings.auditLog.tooltips.exportReDownload",
													)}
												</TooltipContent>
											</Tooltip>
										</div>
										{organizationId &&
										entry.actorEmailSnapshot ? (
											<div className="text-[10px] text-muted-foreground">
												{entry.actorEmailSnapshot}
											</div>
										) : null}
										<Tooltip>
											<TooltipTrigger asChild>
												<div
													className="flex items-center gap-1 truncate text-[10px] text-muted-foreground"
													data-testid="audit-export-filter-summary"
												>
													<span className="truncate">
														{summary.primary}
													</span>
													{summary.more > 0 ? (
														<Badge
															variant="outline"
															className="h-4 shrink-0 border-border/60 bg-card px-1 text-[9px] text-muted-foreground"
														>
															+{summary.more}{" "}
															{t(
																"settings.auditLog.export.moreFilters",
															)}
														</Badge>
													) : null}
												</div>
											</TooltipTrigger>
											<TooltipContent className="max-w-xs">
												<pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px]">
													{JSON.stringify(
														summary.full ?? {},
														null,
														2,
													)}
												</pre>
											</TooltipContent>
										</Tooltip>
									</div>
								);
							})
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<Dialog
				open={pendingFormat !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingFormat(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{t("settings.auditLog.export.confirmTitle", {
								count: totalCountDisplay.toLocaleString
									? totalCountDisplay.toLocaleString()
									: String(totalCountDisplay),
							})}
						</DialogTitle>
						<DialogDescription>
							{t("settings.auditLog.export.confirmDescription")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setPendingFormat(null)}
						>
							{t("settings.auditLog.export.cancel")}
						</Button>
						<Button onClick={confirmAndExport}>
							{t("settings.auditLog.export.confirmCta")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</TooltipProvider>
	);
}

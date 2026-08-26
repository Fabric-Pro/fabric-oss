"use client";

/**
 * Active incidents surface — `status IN (FIRING, ACKNOWLEDGED)` across BOTH
 * `ErrorRateIncident` and `IntegrationIncident` streams.
 *
 * Layout: list-of-cards, not an HTML table. The previous implementation used
 * a 7-column `<table>` with `min-w-[860px]` inside `overflow-x-auto`, which
 * forced narrow viewports into a horizontal scroll the user explicitly does
 * not want. Each incident is now a self-contained card with vertical
 * hierarchy:
 *
 *   [SEV badge] [Service / provider]                       [STATUS badge]
 *   [Kind chip] · [Feature / source] · started X ago
 *   [Acknowledge] [Resolve] [Comment]                            (right)
 *
 * On wide viewports the meta line still reads in a single row; on narrow
 * viewports it wraps cleanly because every chunk is an inline-flex item.
 *
 * The semantic structure (`<ol>` / `<li>` / `<Card>`) preserves screen-
 * reader expectations — each card is an addressable list item with its own
 * action toolbar — without re-implementing the access pattern that
 * `<table>` afforded. `aria-label="Active incidents"` lives on the `<ol>`
 * so SRs still hear "list, N items, Active incidents".
 *
 * Data sources:
 *  - `incidents.errorRate.list` — admin-only, cursor-paginated.
 *  - `integrationHealth.listActiveIncidents` — every authenticated user can
 *    read, but on this admin-only page we filter client-side for
 *    FIRING/ACKNOWLEDGED to match the surface contract.
 *
 * Sorting: most-recent-first by the relevant timestamp (`firedAt` for error
 * rate, `startedAt` for integration). A "Severity" toggle re-orders by
 * SEV rank, breaking ties by recency.
 */

import { Pagination } from "@saas/shared/components/Pagination";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import {
	AlertTriangleIcon,
	CheckIcon,
	CpuIcon,
	MessageSquareIcon,
	PlugIcon,
	XCircleIcon,
} from "lucide-react";
import { parseAsInteger, useQueryState } from "nuqs";
import { useEffect, useMemo, useState } from "react";
import { HelpTooltip, InlineTooltip } from "./HelpTooltip";
import {
	IncidentAckResolveDialog,
	type IncidentAction,
	type IncidentDialogTarget,
	MONITORING_QUERY_KEYS,
} from "./IncidentAckResolveDialog";

/**
 * Maximum cards rendered per page. Beyond ~20 entries the page becomes
 * scroll-heavy; the rest fall into subsequent pages and the URL records
 * the current page via `?incidents_page=N` so the link is shareable
 * across admins coordinating on a Teams call.
 */
const INCIDENTS_PAGE_SIZE = 20;

type IncidentRow = {
	id: string;
	kind: "errorRate" | "integration" | "component";
	severity: "SEV1" | "SEV2" | "SEV3";
	status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	label: string;
	subject: string;
	feature: string;
	startedAt: Date;
	target: IncidentDialogTarget | null;
};

type SortKey = "recent" | "severity";

const SEVERITY_RANK: Record<IncidentRow["severity"], number> = {
	SEV1: 0,
	SEV2: 1,
	SEV3: 2,
};

const SEVERITY_TONE: Record<
	IncidentRow["severity"],
	"error" | "warning" | "secondary"
> = {
	SEV1: "error",
	SEV2: "warning",
	SEV3: "secondary",
};

const SEVERITY_TOOLTIP: Record<IncidentRow["severity"], string> = {
	SEV1: "SEV-1 — customer-impacting outage. Pages on-call immediately.",
	SEV2: "SEV-2 — degraded but functional. Business-hours response.",
	SEV3: "SEV-3 — chronic issue. Ticket-only, no paging.",
};

const STATUS_TONE: Record<
	IncidentRow["status"],
	"error" | "warning" | "success"
> = {
	FIRING: "error",
	ACKNOWLEDGED: "warning",
	RESOLVED: "success",
};

// Small colored dot rendered alongside the status badge. Reuses the
// design tokens so dot color tracks light/dark theme automatically and
// gives admins an at-a-glance status read without parsing the badge
// text. Pulse animation on FIRING draws the eye to incidents that
// haven't been claimed yet (respects prefers-reduced-motion via Tailwind's
// motion-safe variant — paused entirely when the user opts out).
const STATUS_DOT_CLS: Record<IncidentRow["status"], string> = {
	FIRING: "bg-destructive motion-safe:animate-pulse",
	ACKNOWLEDGED: "bg-highlight",
	RESOLVED: "bg-secondary",
};

const STATUS_TOOLTIP: Record<IncidentRow["status"], string> = {
	FIRING: "Active and unclaimed — no admin has acknowledged it yet.",
	ACKNOWLEDGED:
		"An admin claimed this and is investigating. The underlying signal may still be firing.",
	RESOLVED:
		"Hidden. The alert no longer shows in this list — it lives in the timeline below.",
};

const KIND_TOOLTIP: Record<IncidentRow["kind"], string> = {
	errorRate:
		"Our app's own 5xx burn rate breached the threshold — see Configuration below for the exact rule.",
	integration:
		"A third-party provider failed a health check (statuspage, synthetic probe, or circuit breaker).",
	component:
		"A Fabric subsystem is degraded (Temporal worker stalled, Prisma drift, RAG indexer queue backed up, agent rail down, etc.).",
};

function kindLabel(kind: IncidentRow["kind"]): string {
	if (kind === "errorRate") {
		return "Error rate";
	}
	if (kind === "component") {
		return "Component";
	}
	return "Integration";
}

export function ActiveIncidentsTable() {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogTarget, setDialogTarget] =
		useState<IncidentDialogTarget | null>(null);
	const [dialogAction, setDialogAction] =
		useState<IncidentAction>("acknowledge");
	const [sort, setSort] = useState<SortKey>("recent");
	// URL-backed page state. `?incidents_page=2` is shareable; without the
	// param we default to page 1. nuqs handles SSR-safety + history
	// integration so back/forward navigation moves between pages.
	const [page, setPage] = useQueryState(
		"incidents_page",
		parseAsInteger.withDefault(1),
	);

	const errorRateQuery = useQuery({
		queryKey: [
			...MONITORING_QUERY_KEYS.errorRateList,
			{ status: "FIRING+ACK" },
		],
		queryFn: async () => {
			const [firing, ack] = await Promise.all([
				orpcClient.incidents.errorRate.list({
					status: "FIRING",
					limit: 100,
				}),
				orpcClient.incidents.errorRate.list({
					status: "ACKNOWLEDGED",
					limit: 100,
				}),
			]);
			return [...firing.incidents, ...ack.incidents];
		},
	});

	const integrationQuery = useQuery({
		queryKey: [...MONITORING_QUERY_KEYS.activeIncidents],
		queryFn: async () => {
			const result =
				await orpcClient.integrationHealth.listActiveIncidents({});
			return result;
		},
	});

	const rows = useMemo<IncidentRow[]>(() => {
		const all: IncidentRow[] = [];
		for (const item of errorRateQuery.data ?? []) {
			// `listErrorRateIncidents` types its items as `T | null` because
			// of an internal `findUnique`-shape helper; skip the (in
			// practice never-occurring) null entries to keep TS happy.
			if (!item || item.status === "RESOLVED") {
				continue;
			}
			all.push({
				id: item.id,
				kind: "errorRate",
				severity: item.severity as IncidentRow["severity"],
				status: item.status as IncidentRow["status"],
				label: item.alertName,
				subject: item.service,
				feature: item.feature,
				startedAt: new Date(item.firedAt),
				target: {
					kind: "errorRate",
					incidentId: item.id,
					alertName: item.alertName,
					status: item.status as IncidentRow["status"],
				},
			});
		}
		for (const item of integrationQuery.data?.integration ?? []) {
			if (!item || item.status === "RESOLVED") {
				continue;
			}
			all.push({
				id: item.id,
				kind: "integration",
				severity: item.severity as IncidentRow["severity"],
				status: item.status as IncidentRow["status"],
				label: item.providerName,
				subject: item.providerKey,
				feature: item.detectionMethod ?? "—",
				startedAt: new Date(item.startedAt),
				target: {
					kind: "integration",
					incidentId: item.id,
					providerName: item.providerName,
					status: item.status as IncidentRow["status"],
				},
			});
		}
		// v3 admin-incidents pass: surface ComponentIncident rows alongside
		// the other two kinds. Ack/resolve isn't wired through the dialog
		// for component incidents yet — the dialog target stays null and
		// the row's action buttons are disabled with a tooltip. Read-only
		// surfaces the alert until the lifecycle UI catches up.
		for (const item of integrationQuery.data?.component ?? []) {
			if (!item || item.status === "RESOLVED") {
				continue;
			}
			all.push({
				id: item.id,
				kind: "component",
				severity: item.severity as IncidentRow["severity"],
				status: item.status as IncidentRow["status"],
				label: item.componentName,
				subject: item.componentKey,
				feature: "subsystem",
				startedAt: new Date(item.firedAt ?? Date.now()),
				target: null,
			});
		}
		const sorted = [...all];
		if (sort === "recent") {
			sorted.sort(
				(a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
			);
		} else {
			sorted.sort((a, b) => {
				const sev =
					SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
				if (sev !== 0) {
					return sev;
				}
				return b.startedAt.getTime() - a.startedAt.getTime();
			});
		}
		return sorted;
	}, [errorRateQuery.data, integrationQuery.data, sort]);

	const isLoading = errorRateQuery.isLoading || integrationQuery.isLoading;
	const hasError = errorRateQuery.isError || integrationQuery.isError;

	const totalIncidents = rows.length;
	const totalPages = Math.max(
		1,
		Math.ceil(totalIncidents / INCIDENTS_PAGE_SIZE),
	);
	// Clamp the URL-provided page into the valid range — defends against
	// users navigating with `?incidents_page=999` from a stale URL after
	// auto-resolves cleared the long tail. If the URL drifted out of
	// range, snap it back to the last valid page on the next render so
	// the address bar matches the rendered state.
	const currentPage = Math.min(Math.max(1, page), totalPages);
	useEffect(() => {
		if (page !== currentPage) {
			void setPage(currentPage);
		}
	}, [page, currentPage, setPage]);

	const pageStartIndex = (currentPage - 1) * INCIDENTS_PAGE_SIZE;
	const pageEndIndex = Math.min(
		pageStartIndex + INCIDENTS_PAGE_SIZE,
		totalIncidents,
	);
	const pageRows = useMemo(
		() => rows.slice(pageStartIndex, pageEndIndex),
		[rows, pageStartIndex, pageEndIndex],
	);
	const showPagination = totalIncidents > INCIDENTS_PAGE_SIZE;

	function openDialog(target: IncidentDialogTarget, action: IncidentAction) {
		setDialogTarget(target);
		setDialogAction(action);
		setDialogOpen(true);
	}

	return (
		<section
			aria-labelledby="active-incidents-heading"
			className="space-y-4"
		>
			<header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="app-editorial-label">Active</p>
					<div className="flex flex-wrap items-center gap-2">
						<h2
							id="active-incidents-heading"
							className="font-serif text-2xl font-normal tracking-tight text-foreground/95"
						>
							Open incidents
						</h2>
						<HelpTooltip label="open incidents">
							Incidents currently FIRING or ACKNOWLEDGED across
							the error-rate, integration, and component streams.
							Hidden incidents move to the 30-day timeline below —
							expand any entry there to see comments and the full
							ack/hide lifecycle.
						</HelpTooltip>
					</div>
					{/* Lifecycle hint reads as one sentence so the difference
					 * between Acknowledge and Hide is unmissable at the surface
					 * where the buttons live. */}
					<p className="max-w-3xl text-sm text-muted-foreground">
						<span className="font-medium text-foreground/85">
							Acknowledge
						</span>{" "}
						claims the alert so other admins know you're
						investigating ·{" "}
						<span className="font-medium text-foreground/85">
							Hide
						</span>{" "}
						removes the alert from every admin's open list once the
						work is done. Both stay readable from the timeline
						below.
					</p>
				</div>
				<div
					className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end"
					role="group"
					aria-label="Sort active incidents"
				>
					<span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
						Sort
					</span>
					<Button
						type="button"
						size="sm"
						variant={sort === "recent" ? "default" : "outline"}
						onClick={() => setSort("recent")}
						aria-pressed={sort === "recent"}
					>
						Recent
					</Button>
					<Button
						type="button"
						size="sm"
						variant={sort === "severity" ? "default" : "outline"}
						onClick={() => setSort("severity")}
						aria-pressed={sort === "severity"}
					>
						Severity
					</Button>
				</div>
			</header>

			{isLoading ? (
				<Card className="app-surface border-border/60">
					<CardContent className="p-6 text-sm text-muted-foreground">
						Loading active incidents...
					</CardContent>
				</Card>
			) : hasError ? (
				<Card className="border-destructive/40 bg-destructive/5">
					<CardContent className="p-6 text-sm text-destructive">
						Failed to load incidents. Please refresh the page.
					</CardContent>
				</Card>
			) : rows.length === 0 ? (
				<Card className="app-surface border-border/60">
					<CardContent className="p-6 text-center text-sm text-muted-foreground">
						All quiet — no active incidents in either stream.
					</CardContent>
				</Card>
			) : (
				<>
					<ol
						aria-label="Active incidents"
						className="space-y-2"
						data-testid="active-incidents-list"
					>
						{pageRows.map((row) => (
							<li key={`${row.kind}:${row.id}`}>
								<IncidentCard row={row} onAction={openDialog} />
							</li>
						))}
					</ol>
					{showPagination ? (
						<div
							className="flex flex-col gap-2 pt-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
							data-testid="active-incidents-pagination"
						>
							<p>
								Showing{" "}
								<span className="font-medium text-foreground/80">
									{pageStartIndex + 1}–{pageEndIndex}
								</span>{" "}
								of{" "}
								<span className="font-medium text-foreground/80">
									{totalIncidents}
								</span>{" "}
								incidents · Page{" "}
								<span className="font-medium text-foreground/80">
									{currentPage}
								</span>{" "}
								of{" "}
								<span className="font-medium text-foreground/80">
									{totalPages}
								</span>
							</p>
							<Pagination
								totalItems={totalIncidents}
								itemsPerPage={INCIDENTS_PAGE_SIZE}
								currentPage={currentPage}
								onChangeCurrentPage={(next) => {
									void setPage(next);
								}}
							/>
						</div>
					) : null}
				</>
			)}

			<IncidentAckResolveDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				target={dialogTarget}
				defaultAction={dialogAction}
			/>
		</section>
	);
}

/**
 * Single incident card. Self-contained so the parent list keeps its
 * `<ol>/<li>` semantics intact and the card layout decisions stay local.
 */
function IncidentCard({
	row,
	onAction,
}: {
	row: IncidentRow;
	onAction: (target: IncidentDialogTarget, action: IncidentAction) => void;
}) {
	return (
		<Card
			className="app-surface border-border/60"
			data-testid={`incident-row-${row.id}`}
		>
			<CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 flex-1 space-y-2">
					{/* Top line — severity, label, status. Wraps naturally on
					 * narrow viewports because every chunk is an inline-flex
					 * item. */}
					<div className="flex flex-wrap items-center gap-2">
						<InlineTooltip
							label={`Severity ${row.severity}`}
							content={SEVERITY_TOOLTIP[row.severity]}
						>
							<Badge status={SEVERITY_TONE[row.severity]}>
								{row.severity}
							</Badge>
						</InlineTooltip>
						<span className="min-w-0 break-words text-sm font-medium text-foreground/90">
							{row.label}
						</span>
						<InlineTooltip
							label={`Status ${row.status}`}
							content={STATUS_TOOLTIP[row.status]}
						>
							<span className="inline-flex items-center gap-1.5">
								<span
									className={`size-2 shrink-0 rounded-full ${STATUS_DOT_CLS[row.status]}`}
									aria-hidden
									data-testid={`status-dot-${row.status.toLowerCase()}`}
								/>
								<Badge status={STATUS_TONE[row.status]}>
									{row.status}
								</Badge>
							</span>
						</InlineTooltip>
					</div>
					{/* Meta line — kind chip · feature/source · started X ago.
					 * Uses small bullets so the row reads as one sentence; on
					 * narrow viewports each chunk wraps independently. */}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<InlineTooltip
							label={`Kind ${kindLabel(row.kind)}`}
							content={KIND_TOOLTIP[row.kind]}
						>
							<span className="inline-flex items-center gap-1.5">
								{row.kind === "errorRate" ? (
									<AlertTriangleIcon className="size-3.5" />
								) : row.kind === "component" ? (
									<CpuIcon className="size-3.5" />
								) : (
									<PlugIcon className="size-3.5" />
								)}
								{kindLabel(row.kind)}
							</span>
						</InlineTooltip>
						{row.kind === "errorRate" ||
						row.kind === "component" ? (
							<span className="break-all">{row.subject}</span>
						) : null}
						<span className="break-all">{row.feature}</span>
						<time
							dateTime={row.startedAt.toISOString()}
							title={row.startedAt.toLocaleString()}
						>
							started {formatRelative(row.startedAt)}
						</time>
					</div>
				</div>
				{/* Actions — right-aligned on wide viewports, single row
				 * with native button `title` tooltips so the labels never
				 * wrap mid-button. (Radix Tooltip wrappers would nest
				 * buttons here, which is invalid HTML and breaks screen
				 * readers — the native title carries the same hint.) For
				 * component incidents the lifecycle dialog is not yet
				 * wired through, so the action buttons are replaced by a
				 * read-only badge that explains where lifecycle controls
				 * live. */}
				<div className="flex shrink-0 items-center gap-1 sm:justify-end">
					{row.target ? (
						<>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={row.status !== "FIRING"}
								onClick={() =>
									row.target &&
									onAction(row.target, "acknowledge")
								}
								aria-label={`Acknowledge ${row.label}`}
								title="Claim this alert so other admins know you're investigating. The underlying signal may still be firing."
							>
								<CheckIcon className="size-3.5" />
								<span className="sr-only md:not-sr-only md:ml-1">
									Acknowledge
								</span>
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() =>
									row.target &&
									onAction(row.target, "resolve")
								}
								aria-label={`Hide ${row.label} for all admins`}
								title="Hide this alert from every admin's open list. It moves to the timeline below — any comments stay readable from there. (The DB still records the action as RESOLVED for backwards-compat.)"
							>
								<XCircleIcon className="size-3.5" />
								<span className="sr-only md:not-sr-only md:ml-1">
									Hide
								</span>
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() =>
									row.target &&
									onAction(row.target, "comment")
								}
								aria-label={`Add comment to ${row.label}`}
								title="Add a note to the audit trail. Always allowed — even after the alert is closed."
							>
								<MessageSquareIcon className="size-3.5" />
								<span className="sr-only">Comment</span>
							</Button>
						</>
					) : (
						<InlineTooltip
							label={`${row.label} read-only`}
							content="Lifecycle controls for component incidents arrive in a follow-up release. The signal is recorded; the page is read-only for now."
						>
							<Badge status="secondary">Read-only</Badge>
						</InlineTooltip>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Format a date as a short relative-time string suitable for incident-card
 * meta lines. Falls back to a localised timestamp once the delta exceeds
 * 24h so we never render an ambiguous "23h ago" for a 2-day-old row.
 */
export function formatRelative(date: Date, now: Date = new Date()): string {
	const diffMs = now.getTime() - date.getTime();
	const seconds = Math.max(0, Math.floor(diffMs / 1000));
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	if (days < 30) {
		return `${days}d ago`;
	}
	return date.toLocaleDateString();
}

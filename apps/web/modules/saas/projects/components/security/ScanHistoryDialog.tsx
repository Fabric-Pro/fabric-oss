"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	CheckCircle2Icon,
	type LucideIcon,
	PencilIcon,
	RotateCcwIcon,
	ShieldAlertIcon,
	ShieldCheckIcon,
	ShieldXIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	TicketIcon,
	Trash2Icon,
	XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import type { ScanActivity, ScanActivityType } from "./lib";

type HistoryGroup = "SCANS" | "FINDINGS";

type Props = {
	projectId: string;
	organizationId: string | null;
	/** Which slice of activity to show. Omit for the full feed. */
	group?: HistoryGroup;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/** Title / description / empty copy per history view. */
const GROUP_META: Record<
	HistoryGroup | "ALL",
	{ title: string; description: string; empty: string }
> = {
	SCANS: {
		title: "Scans history",
		description:
			"Scan runs and configuration changes for this project — with each run's duration, cost, and model.",
		empty: "No scans yet.",
	},
	FINDINGS: {
		title: "Findings history",
		description:
			"Status changes, triage edits (severity / category), AI review runs, and work-item conversions for individual findings.",
		empty: "No finding updates yet.",
	},
	ALL: {
		title: "History",
		description:
			"Scan runs, finding updates, work-item conversions, and configuration changes for this project.",
		empty: "No activity yet.",
	},
};

/** Show this many entries, then a "Show more" expander (Atlas-style). */
const PAGE_SIZE = 5;

/** Per-type icon + tint for a history entry. Colors map to design tokens. */
const ACTIVITY_ICON: Record<
	ScanActivityType,
	{ Icon: LucideIcon; className: string }
> = {
	SCAN_STARTED: { Icon: ShieldAlertIcon, className: "text-muted-foreground" },
	SCAN_COMPLETED: { Icon: ShieldCheckIcon, className: "text-secondary" },
	SCAN_FAILED: { Icon: ShieldXIcon, className: "text-destructive" },
	FINDING_RESOLVED: { Icon: CheckCircle2Icon, className: "text-secondary" },
	FINDING_DISMISSED: {
		Icon: XCircleIcon,
		className: "text-muted-foreground",
	},
	FINDING_REOPENED: {
		Icon: RotateCcwIcon,
		className: "text-muted-foreground",
	},
	FINDING_CONVERTED: { Icon: TicketIcon, className: "text-primary" },
	FINDING_EDITED: { Icon: PencilIcon, className: "text-muted-foreground" },
	CONFIG_UPDATED: {
		Icon: SlidersHorizontalIcon,
		className: "text-muted-foreground",
	},
	// AI review lifecycle + purge — surfaced in the Findings history view.
	REVIEW_STARTED: { Icon: SparklesIcon, className: "text-muted-foreground" },
	REVIEW_CANCELLED: { Icon: XCircleIcon, className: "text-muted-foreground" },
	FINDINGS_REVIEWED: { Icon: SparklesIcon, className: "text-primary" },
	FINDINGS_PURGED: { Icon: Trash2Icon, className: "text-destructive" },
	// The security-finding-grouping pipeline ran (theme tickets created/updated).
	// Distinct tint from FINDING_CONVERTED/FINDINGS_REVIEWED (both text-primary)
	// so the three "became a ticket"-adjacent events stay visually distinguishable.
	FINDINGS_GROUPED: { Icon: TicketIcon, className: "text-highlight" },
};

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

export function ScanHistoryDialog({
	projectId,
	organizationId,
	group,
	open,
	onOpenChange,
}: Props) {
	const [visible, setVisible] = useState(PAGE_SIZE);
	const meta = GROUP_META[group ?? "ALL"];

	const activityQuery = useQuery(
		orpc.projects.scan.activity.queryOptions({
			input: {
				projectId,
				organizationId,
				limit: 100,
				...(group ? { group } : {}),
			},
			enabled: open,
		}),
	);

	const activity = activityQuery.data?.activity ?? [];
	const shown = activity.slice(0, visible);
	const remaining = activity.length - shown.length;

	const handleOpenChange = (next: boolean) => {
		// Reset paging when the dialog closes so it reopens at the first page.
		if (!next) {
			setVisible(PAGE_SIZE);
		}
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{meta.title}</DialogTitle>
					<DialogDescription>{meta.description}</DialogDescription>
				</DialogHeader>

				{activityQuery.isLoading ? (
					<ul className="space-y-3" aria-hidden="true">
						{[0, 1, 2, 3].map((i) => (
							<li key={i} className="flex items-start gap-3">
								<Skeleton className="size-8 rounded-full" />
								<div className="flex-1 space-y-1.5">
									<Skeleton className="h-4 w-3/4" />
									<Skeleton className="h-3 w-1/3" />
								</div>
							</li>
						))}
					</ul>
				) : activity.length === 0 ? (
					<p className="rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center text-muted-foreground text-sm">
						{meta.empty}
					</p>
				) : (
					<div className="space-y-2">
						<ul className="space-y-1">
							{shown.map((entry) => (
								<ActivityRow key={entry.id} entry={entry} />
							))}
						</ul>
						{remaining > 0 ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="w-full text-muted-foreground"
								onClick={() => setVisible((v) => v + PAGE_SIZE)}
							>
								Show more ({remaining})
							</Button>
						) : null}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ActivityRow({ entry }: { entry: ScanActivity }) {
	const { Icon, className } =
		ACTIVITY_ICON[entry.type as ScanActivityType] ??
		ACTIVITY_ICON.CONFIG_UPDATED;
	const actor = entry.user?.name ?? "Someone";
	const when = toDate(entry.createdAt);

	return (
		<li className="flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/50">
			<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-muted">
				<Icon aria-hidden="true" className={cn("size-4", className)} />
			</span>
			<div className="min-w-0 flex-1">
				<p className="break-words text-foreground text-sm">
					{entry.summary ?? "Activity"}
				</p>
				<p className="mt-0.5 text-muted-foreground text-xs">
					{actor}
					{when ? (
						<>
							{" · "}
							<time
								dateTime={when.toISOString()}
								title={when.toLocaleString()}
							>
								{formatDistanceToNow(when, { addSuffix: true })}
							</time>
						</>
					) : null}
				</p>
				{entry.type === "SCAN_COMPLETED" ? (
					<ScanTelemetry meta={readScanMeta(entry.metadata)} />
				) : null}
			</div>
		</li>
	);
}

type ScanMeta = {
	mode?: string;
	durationMs?: number;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	modelName?: string;
	/** Which scanners ran (Security / Accessibility / Semgrep / Git history). */
	scanners?: string[];
	/** Branch the repo-based scanners ran against, when one was resolved. */
	branch?: string;
};

function readScanMeta(metadata: unknown): ScanMeta {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return {};
	}
	return metadata as ScanMeta;
}

function formatTokens(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
	}
	return String(n);
}

/** Atlas-style per-scan telemetry chips: mode · duration · tokens · cost · model. */
function ScanTelemetry({ meta }: { meta: ScanMeta }) {
	const chips: string[] = [];
	if (meta.mode) {
		chips.push(meta.mode === "INCREMENTAL" ? "Incremental" : "Full scan");
	}
	if (typeof meta.durationMs === "number" && meta.durationMs > 0) {
		chips.push(`${Math.round(meta.durationMs / 100) / 10}s`);
	}
	const tokens = (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
	if (tokens > 0) {
		chips.push(`${formatTokens(tokens)} tokens`);
	}
	if (typeof meta.costUsd === "number" && meta.costUsd > 0) {
		chips.push(`$${meta.costUsd.toFixed(4)}`);
	}
	const scanners = meta.scanners ?? [];
	if (
		chips.length === 0 &&
		!meta.modelName &&
		scanners.length === 0 &&
		!meta.branch
	) {
		return null;
	}
	return (
		<div className="mt-1.5 space-y-1">
			{meta.branch ? (
				<p className="text-[11px] text-muted-foreground">
					<span className="font-medium">Branch:</span>{" "}
					<span className="font-mono">{meta.branch}</span>
				</p>
			) : null}
			{scanners.length > 0 ? (
				<p className="text-[11px] text-muted-foreground">
					<span className="font-medium">Scanned:</span>{" "}
					{scanners.join(" · ")}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-1.5">
				{chips.map((chip) => (
					<span
						key={chip}
						className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
					>
						{chip}
					</span>
				))}
				{meta.modelName ? (
					<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
						{meta.modelName}
					</span>
				) : null}
			</div>
		</div>
	);
}

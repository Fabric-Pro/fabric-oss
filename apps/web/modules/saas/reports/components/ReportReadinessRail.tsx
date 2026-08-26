"use client";

import { InfoHint } from "@saas/reports/components/InfoHint";
import type {
	CheckStatus,
	ReadinessTone,
	ReportReadiness,
} from "@saas/reports/lib/report-readiness";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	ChevronRightIcon,
	FileTextIcon,
	Loader2Icon,
	type LucideIcon,
	PlayIcon,
	PlugIcon,
	XCircleIcon,
} from "lucide-react";
import { CancelExecutionButton } from "./CancelExecutionButton";
import { ExecutionStatusBadge } from "./ExecutionStatusBadge";

interface RailExecution {
	id: string;
	status: string;
	userId?: string;
	startedAt?: string | Date | null;
	createdAt?: string | Date | null;
	duration?: number | null;
	artifacts?: { id: string; name: string }[] | null;
}

const VERDICT: Record<
	ReadinessTone,
	{ container: string; icon: string; Icon: LucideIcon }
> = {
	success: {
		container: "border-success/30 bg-success/5",
		icon: "bg-success/10 text-success",
		Icon: CheckCircle2Icon,
	},
	warning: {
		container: "border-highlight/40 bg-highlight/5",
		icon: "bg-highlight/10 text-highlight",
		Icon: AlertCircleIcon,
	},
	destructive: {
		container: "border-destructive/30 bg-destructive/5",
		icon: "bg-destructive/10 text-destructive",
		Icon: XCircleIcon,
	},
	muted: {
		container: "border-border bg-card",
		icon: "bg-muted text-muted-foreground",
		Icon: CheckCircle2Icon,
	},
};

const CHECK: Record<CheckStatus, { Icon: LucideIcon; cls: string }> = {
	ok: { Icon: CheckCircle2Icon, cls: "text-success" },
	warn: { Icon: AlertCircleIcon, cls: "text-highlight" },
	fail: { Icon: XCircleIcon, cls: "text-destructive" },
};

const CHECK_HINT: Partial<Record<string, string>> = {
	connection:
		"Whether a working data source is connected. Generation is blocked until at least the required sources are connected.",
	params: "Required template parameters that must have a value before the report can run.",
	skills: "Skills inherited from the template are injected into the AI system prompt to shape the report.",
	output: "The output format and primary data source this report produces.",
};

function RailLabel({ children }: { children: React.ReactNode }) {
	return (
		<p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
			{children}
		</p>
	);
}

/**
 * Sticky right-hand rail for the Reports instance page. Gives an at-a-glance
 * readiness verdict, the primary Generate / Test actions (Generate disabled when
 * there's a hard blocker), a "Latest run" glance, the full readiness checklist,
 * and an at-a-glance metadata summary. It is a single shared instance rendered
 * once outside the tab panels, so it stays identical (and sticky) across the
 * Overview and Execution History tabs — generating is always one click away.
 */
export function ReportReadinessRail({
	readiness,
	onGenerate,
	isGenerating,
	onTest,
	isTesting,
	latestExecution,
	executionCount,
	onViewHistory,
	meta,
	onViewArtifact,
	organizationId = null,
	viewerUserId,
	viewerIsOrgAdmin = false,
	onExecutionCancelled,
}: {
	readiness: ReportReadiness;
	onGenerate: () => void;
	isGenerating: boolean;
	onTest: () => void;
	isTesting: boolean;
	latestExecution?: RailExecution;
	executionCount: number;
	onViewHistory: () => void;
	meta: {
		template: string;
		dataSource: string;
		output: string;
		skillsCount: number;
	};
	onViewArtifact?: (artifactId: string, artifactName: string) => void;
	/** Report tenant + viewer identity — gate the per-run Cancel control (R11). */
	organizationId?: string | null;
	viewerUserId?: string;
	viewerIsOrgAdmin?: boolean;
	onExecutionCancelled?: () => void;
}) {
	const verdict = VERDICT[readiness.verdict.tone];
	const VerdictIcon = verdict.Icon;

	const startedAt = latestExecution?.startedAt ?? latestExecution?.createdAt;
	const startedLabel = startedAt
		? formatDistanceToNow(new Date(startedAt), { addSuffix: true })
		: null;
	const durationLabel =
		latestExecution?.duration != null
			? `${(latestExecution.duration / 1000).toFixed(1)}s`
			: null;
	// A cancelled run must not surface an artifact even if one raced into
	// existence before the cancel landed (R10 — "no artifact for a cancelled run").
	const firstArtifact =
		latestExecution?.status === "CANCELLED"
			? undefined
			: latestExecution?.artifacts?.[0];
	const isRunning =
		latestExecution?.status === "RUNNING" ||
		latestExecution?.status === "PENDING";

	return (
		<aside
			className="space-y-3 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:overflow-x-clip lg:pr-1"
			aria-label="Report readiness"
		>
			{/* Verdict */}
			<div
				className={cn(
					"flex items-center gap-3 rounded-xl border p-4",
					verdict.container,
				)}
			>
				<span
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-lg",
						verdict.icon,
					)}
				>
					<VerdictIcon className="size-5" aria-hidden />
				</span>
				<div className="min-w-0">
					<p className="text-sm font-semibold text-foreground">
						{readiness.verdict.title}
					</p>
					<p className="text-xs text-muted-foreground">
						{readiness.verdict.subtitle}
					</p>
				</div>
			</div>

			{/* Primary actions */}
			<div className="space-y-2 rounded-xl border bg-card p-4">
				<Button
					className="w-full"
					size="lg"
					onClick={onGenerate}
					disabled={readiness.hardBlocked || isGenerating}
					autoLoading={false}
				>
					{isGenerating ? (
						<Loader2Icon className="size-4 animate-spin" />
					) : (
						<PlayIcon className="size-4" />
					)}
					Generate Report
				</Button>
				<Button
					variant="outline"
					className="w-full"
					onClick={onTest}
					disabled={isTesting}
					autoLoading={false}
				>
					{isTesting ? (
						<Loader2Icon className="size-4 animate-spin" />
					) : (
						<PlugIcon className="size-4" />
					)}
					{isTesting ? "Testing connections…" : "Test connections"}
				</Button>
				{readiness.hardBlocked && readiness.blockReason && (
					<p className="px-1 pt-0.5 text-center text-xs leading-relaxed text-muted-foreground">
						{readiness.blockReason}
					</p>
				)}
			</div>

			{/* Latest run glance (Overview only) */}
			{latestExecution && (
				<div className="rounded-xl border bg-card p-4">
					<div className="mb-3 flex items-center justify-between gap-2">
						<RailLabel>Latest run</RailLabel>
						<button
							type="button"
							onClick={onViewHistory}
							className="-mt-3 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							View all ({executionCount})
							<ChevronRightIcon
								className="size-3.5"
								aria-hidden
							/>
						</button>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<ExecutionStatusBadge status={latestExecution.status} />
						{startedLabel && (
							<span className="text-xs text-muted-foreground">
								{startedLabel}
							</span>
						)}
						{durationLabel && (
							<>
								<span
									aria-hidden
									className="text-muted-foreground/50"
								>
									·
								</span>
								<span className="font-mono text-xs text-muted-foreground">
									{durationLabel}
								</span>
							</>
						)}
						<CancelExecutionButton
							executionId={latestExecution.id}
							executionStatus={latestExecution.status}
							executionUserId={latestExecution.userId ?? ""}
							organizationId={organizationId}
							viewerUserId={viewerUserId}
							viewerIsOrgAdmin={viewerIsOrgAdmin}
							onCancelled={() => onExecutionCancelled?.()}
						/>
					</div>
					{firstArtifact ? (
						<button
							type="button"
							onClick={() =>
								onViewArtifact?.(
									firstArtifact.id,
									firstArtifact.name,
								)
							}
							className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
						>
							<FileTextIcon className="size-3.5" aria-hidden />
							{firstArtifact.name}
						</button>
					) : isRunning ? (
						<p className="mt-2.5 text-xs text-muted-foreground">
							Generating report…
						</p>
					) : null}
				</div>
			)}

			{/* Readiness checklist */}
			<div className="rounded-xl border bg-card p-4">
				<RailLabel>Readiness</RailLabel>
				<ul className="space-y-3">
					{readiness.checks.map((c) => {
						const cfg = CHECK[c.status];
						const CheckIcon = cfg.Icon;
						const hint = CHECK_HINT[c.key];
						return (
							<li key={c.key} className="flex gap-2.5">
								<CheckIcon
									className={cn(
										"mt-0.5 size-[15px] shrink-0",
										cfg.cls,
									)}
									aria-hidden
								/>
								<div className="min-w-0">
									<div className="flex items-center gap-1.5">
										<span className="text-sm font-medium text-foreground">
											{c.label}
										</span>
										{hint && (
											<InfoHint
												label={c.label}
												content={hint}
											/>
										)}
									</div>
									<p className="text-xs leading-snug text-muted-foreground">
										{c.note}
									</p>
								</div>
							</li>
						);
					})}
				</ul>
			</div>

			{/* At a glance */}
			<div className="rounded-xl border bg-card p-4">
				<RailLabel>At a glance</RailLabel>
				<dl className="text-sm">
					<GlanceRow label="Template" value={meta.template} />
					<GlanceRow
						label="Data source"
						value={
							<span className="font-mono text-xs">
								{meta.dataSource}
							</span>
						}
					/>
					<GlanceRow
						label="Output"
						value={
							<Badge variant="outline" className="text-[11px]">
								{meta.output}
							</Badge>
						}
					/>
					<GlanceRow
						label="Skills"
						value={`${meta.skillsCount} active`}
					/>
				</dl>
			</div>
		</aside>
	);
}

function GlanceRow({
	label,
	value,
}: {
	label: string;
	value: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="truncate text-right text-[13px] text-foreground/90">
				{value}
			</dd>
		</div>
	);
}

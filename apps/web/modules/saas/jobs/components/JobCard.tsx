"use client";

import { Badge } from "@ui/components/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	CircleIcon,
	Loader2Icon,
	MinusCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { JobListItem, JobStep, JobStepStatus } from "../hooks/use-jobs";
import { formatJobCounts } from "../lib/format-job";

function StatusBadge({ status }: { status: JobListItem["status"] }) {
	const t = useTranslations("app.jobs");

	if (status === "RUNNING") {
		return (
			<Badge
				variant="secondary"
				role="status"
				aria-label={t("status.running")}
				className="gap-1.5"
			>
				<Loader2Icon
					className="size-3 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				{t("status.running")}
			</Badge>
		);
	}

	if (status === "FAILED") {
		return (
			<Badge
				variant="error"
				role="status"
				aria-label={t("status.failed")}
				className="gap-1.5"
			>
				<AlertTriangleIcon className="size-3" aria-hidden="true" />
				{t("status.failed")}
			</Badge>
		);
	}

	return (
		<Badge
			variant="success"
			role="status"
			aria-label={t("status.completed")}
			className="gap-1.5"
		>
			<CheckCircle2Icon className="size-3" aria-hidden="true" />
			{t("status.completed")}
		</Badge>
	);
}

/**
 * Step icon. Colors come from tokens, not from the raw blue/green/red the
 * shared `ai-elements/task` primitive hardcodes.
 */
function StepIcon({ status }: { status: JobStepStatus }) {
	if (status === "running") {
		return (
			<Loader2Icon
				className="size-3.5 shrink-0 text-highlight motion-safe:animate-spin"
				aria-hidden="true"
			/>
		);
	}
	if (status === "completed") {
		return (
			<CheckCircle2Icon
				className="size-3.5 shrink-0 text-secondary"
				aria-hidden="true"
			/>
		);
	}
	if (status === "failed") {
		return (
			<AlertTriangleIcon
				className="size-3.5 shrink-0 text-destructive"
				aria-hidden="true"
			/>
		);
	}
	if (status === "skipped") {
		return (
			<MinusCircleIcon
				className="size-3.5 shrink-0 text-muted-foreground/50"
				aria-hidden="true"
			/>
		);
	}
	return (
		<CircleIcon
			className="size-3.5 shrink-0 text-muted-foreground/50"
			aria-hidden="true"
		/>
	);
}

function JobSteps({ steps }: { steps: JobStep[] }) {
	const t = useTranslations("app.jobs");

	return (
		<ul className="mt-3 space-y-1.5 border-t border-border pt-3">
			{steps.map((step) => (
				<li key={step.key} className="flex items-start gap-2 text-xs">
					<StepIcon status={step.status} />
					<span
						className={cn(
							"flex-1",
							step.status === "pending" ||
								step.status === "skipped"
								? "text-muted-foreground/70"
								: "text-foreground",
						)}
					>
						{t(`steps.${step.key}`)}
						{step.error ? (
							<span className="mt-0.5 block text-destructive">
								{step.error}
							</span>
						) : null}
					</span>
					<span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
						{t(`stepStatus.${step.status}`)}
					</span>
				</li>
			))}
		</ul>
	);
}

export function JobCard({ job }: { job: JobListItem }) {
	const t = useTranslations("app.jobs");
	// Running jobs start expanded: the reason to open the panel mid-run is to
	// see which step is taking so long.
	const [open, setOpen] = useState(job.status === "RUNNING");

	const counts = formatJobCounts(job.counts, (key, values) =>
		t(`counts.${key}`, values),
	);
	const timestamp = job.completedAt ?? job.startedAt;
	// Skipped counts as settled: a finished job showing "6/7" implies one step
	// is still to come, which is never true once the run is over.
	const completedSteps = job.steps.filter(
		(step) => step.status === "completed" || step.status === "skipped",
	).length;

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className={cn(
				"rounded-lg border bg-card px-4 py-3",
				job.status === "FAILED"
					? "border-destructive/30"
					: "border-border",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-sm text-foreground">
						{job.title}
					</p>
					<p className="mt-0.5 truncate text-xs text-muted-foreground">
						{t(`kinds.${job.kind}`)} · {job.projectName}
					</p>
				</div>
				<StatusBadge status={job.status} />
			</div>

			{counts.length > 0 ? (
				<p className="mt-2 text-xs text-muted-foreground tabular-nums">
					{counts.join(" · ")}
				</p>
			) : null}

			{job.error ? (
				<p className="mt-2 text-xs text-destructive">{job.error}</p>
			) : null}

			<div className="mt-2 flex items-center justify-between gap-2">
				<span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
					{job.status === "RUNNING"
						? t("startedAgo", {
								time: formatDistanceToNow(
									new Date(job.startedAt),
								),
							})
						: t("finishedAgo", {
								time: formatDistanceToNow(new Date(timestamp)),
							})}
				</span>

				{job.steps.length > 0 ? (
					<CollapsibleTrigger
						className="group flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
						aria-label={t("toggleSteps")}
					>
						{t("stepsCount", {
							completed: completedSteps,
							total: job.steps.length,
						})}
						<ChevronDownIcon
							className="size-3 transition-transform group-data-[state=open]:rotate-180"
							aria-hidden="true"
						/>
					</CollapsibleTrigger>
				) : null}
			</div>

			{job.steps.length > 0 ? (
				<CollapsibleContent>
					<JobSteps steps={job.steps} />
				</CollapsibleContent>
			) : null}
		</Collapsible>
	);
}

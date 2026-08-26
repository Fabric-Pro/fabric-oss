"use client";

import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { PipelineProviderIcon } from "./PipelineProviderIcon";
import {
	formatAbsoluteTime,
	formatDuration,
	type PipelineRun,
	timeAgo,
} from "./pipeline-run";

/**
 * One CI run, rendered identically wherever runs are listed (feature-editor QA
 * tab and the project QA tab).
 *
 * The row itself opens the in-Fabric run detail (per-test breakdown); the
 * trailing external link opens the run in its CI provider. Those are two
 * distinct destinations, so the external link stops propagation rather than
 * nesting an anchor inside a button — which would be invalid markup and would
 * make the keyboard order ambiguous.
 */
export function PipelineRunRow({
	run,
	onOpenDetail,
	className,
}: {
	run: PipelineRun;
	onOpenDetail: (runId: string) => void;
	className?: string;
}) {
	const t = useTranslations("projects.stories.maturation.qa.pipelineRuns");

	const hasFailures = run.failedCount > 0;
	// A run that reported NO tests is not a pass. A pipeline that dies before the
	// test step ingests with every count at zero, and a green "0/0 passed" badge
	// read as a clean run — the one shape where success tone is actively wrong.
	const reportedNothing = run.totalCount === 0;
	const occurredAt = run.startedAt ?? run.createdAt;
	const when = timeAgo(occurredAt);
	const absoluteWhen = formatAbsoluteTime(occurredAt);
	const duration = formatDuration(run.durationMs);
	const title = run.pipelineName ?? t("runLabel", { id: run.externalRunId });

	return (
		<li
			className={cn("flex items-center justify-between gap-3", className)}
		>
			<button
				type="button"
				onClick={() => onOpenDetail(run.id)}
				aria-label={t("openDetail", { name: title })}
				className="flex min-w-0 flex-1 items-center gap-3 rounded px-3 py-2.5 text-left motion-safe:transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<PipelineProviderIcon provider={run.provider} />
				<div className="min-w-0 space-y-1">
					<div className="flex items-center gap-2">
						<Badge
							variant={
								hasFailures
									? "error"
									: reportedNothing
										? "secondary"
										: "success"
							}
							className="shrink-0"
						>
							{run.passedCount}/{run.totalCount} {t("passed")}
						</Badge>
						<span className="truncate font-medium text-sm">
							{title}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
						{hasFailures && (
							<span className="text-destructive">
								{t("failedCount", { count: run.failedCount })}
							</span>
						)}
						{run.branch && (
							<span className="truncate font-mono">
								{run.branch}
							</span>
						)}
						{run.triggeredByActor && (
							<span className="truncate">
								{t("runBy", { actor: run.triggeredByActor })}
							</span>
						)}
						{duration && <span>{duration}</span>}
						{when && (
							<time
								dateTime={
									occurredAt
										? new Date(occurredAt).toISOString()
										: undefined
								}
								title={absoluteWhen ?? undefined}
							>
								{when}
							</time>
						)}
					</div>
				</div>
			</button>

			{run.runUrl && (
				<a
					href={run.runUrl}
					target="_blank"
					rel="noopener noreferrer"
					onClick={(e) => e.stopPropagation()}
					aria-label={t("openRun")}
					title={t("openRun")}
					className="shrink-0 rounded p-2 text-muted-foreground/70 motion-safe:transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<ExternalLinkIcon className="size-4" aria-hidden="true" />
				</a>
			)}
		</li>
	);
}

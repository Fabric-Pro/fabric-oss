"use client";

/**
 * ExecutionTimeline - Visual timeline showing duration per execution step
 *
 * Displays a horizontal bar for each step, proportional to its duration
 * relative to total elapsed time. Color-coded by agent, with animated
 * fill for the currently-running step.
 */

import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckCircleIcon,
	CircleIcon,
	Loader2Icon,
	XCircleIcon,
} from "lucide-react";

interface TimelineStep {
	id: string;
	text: string;
	agent: string;
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
	startedAt?: string | Date | null;
	completedAt?: string | Date | null;
}

interface ExecutionTimelineProps {
	steps: TimelineStep[];
	executionStartedAt?: string | Date | null;
}

const AGENT_COLORS: Record<string, string> = {
	thread: "bg-blue-500",
	spindle: "bg-purple-500",
	shuttle: "bg-primary",
	weft: "bg-emerald-500",
	warp: "bg-red-500",
	loom: "bg-primary/80",
};

const AGENT_COLORS_LIGHT: Record<string, string> = {
	thread: "bg-blue-500/15",
	spindle: "bg-purple-500/15",
	shuttle: "bg-primary/15",
	weft: "bg-emerald-500/15",
	warp: "bg-red-500/15",
	loom: "bg-primary/10",
};

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds > 0 ? `${remainingSeconds}s` : ""}`.trim();
}

function getStepDuration(step: TimelineStep): number | null {
	if (!step.startedAt) {
		return null;
	}
	const start = new Date(step.startedAt).getTime();
	const end = step.completedAt
		? new Date(step.completedAt).getTime()
		: Date.now();
	return end - start;
}

function formatTimestamp(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function ExecutionTimeline({
	steps,
	executionStartedAt,
}: ExecutionTimelineProps) {
	// Calculate total elapsed time
	const totalElapsed = executionStartedAt
		? Date.now() - new Date(executionStartedAt).getTime()
		: 0;

	// Calculate durations
	const stepsWithDuration = steps.map((step) => ({
		...step,
		duration: getStepDuration(step),
	}));

	const maxDuration = Math.max(
		...stepsWithDuration.map((s) => s.duration ?? 0),
		1,
	);

	return (
		<TooltipProvider delayDuration={500}>
			<div className="space-y-1.5">
				<div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
					<span className="uppercase tracking-[0.18em] font-medium">
						Timeline
					</span>
					{totalElapsed > 0 && (
						<span>Total: {formatDuration(totalElapsed)}</span>
					)}
				</div>

				{stepsWithDuration.map((step, index) => {
					const widthPercent =
						step.duration && maxDuration > 0
							? Math.max((step.duration / maxDuration) * 100, 4)
							: step.status === "in_progress"
								? 30
								: 0;

					const agentColor =
						AGENT_COLORS[step.agent] || "bg-muted-foreground";
					const agentColorLight =
						AGENT_COLORS_LIGHT[step.agent] || "bg-muted";

					return (
						<Tooltip key={step.id}>
							<TooltipTrigger asChild>
								<div className="flex items-center gap-2 group">
									{/* Step number + status icon */}
									<div className="flex items-center gap-1.5 w-20 shrink-0">
										<span className="text-xs text-muted-foreground w-4 text-right">
											{index + 1}.
										</span>
										{step.status === "completed" ? (
											<CheckCircleIcon className="size-3.5 text-secondary" />
										) : step.status === "in_progress" ? (
											<Loader2Icon className="size-3.5 animate-spin text-primary" />
										) : step.status === "failed" ? (
											<XCircleIcon className="size-3.5 text-destructive" />
										) : (
											<CircleIcon className="size-3.5 text-muted-foreground/40" />
										)}
										<Badge
											variant="outline"
											className="text-[10px] px-1 py-0"
										>
											{step.agent}
										</Badge>
									</div>

									{/* Duration bar */}
									<div
										className={cn(
											"flex-1 h-5 rounded-sm relative overflow-hidden",
											agentColorLight,
										)}
									>
										<div
											className={cn(
												"absolute inset-y-0 left-0 rounded-sm transition-all duration-500",
												agentColor,
												step.status === "in_progress" &&
													"animate-pulse",
											)}
											style={{
												width: `${widthPercent}%`,
												opacity:
													step.status === "pending"
														? 0
														: 0.8,
											}}
										/>
										{/* Duration label inside bar */}
										{step.duration && step.duration > 0 && (
											<span className="absolute inset-y-0 left-2 flex items-center text-[10px] font-medium text-foreground mix-blend-difference">
												{formatDuration(step.duration)}
											</span>
										)}
									</div>
								</div>
							</TooltipTrigger>
							<TooltipContent side="top" className="max-w-xs">
								<div className="space-y-1">
									<p className="font-medium text-xs">
										{step.text}
									</p>
									<div className="text-xs text-muted-foreground space-y-0.5">
										<p>Agent: {step.agent}</p>
										{step.startedAt && (
											<p>
												Started:{" "}
												{formatTimestamp(
													new Date(step.startedAt),
												)}
											</p>
										)}
										{step.completedAt && (
											<p>
												Completed:{" "}
												{formatTimestamp(
													new Date(step.completedAt),
												)}
											</p>
										)}
										{step.duration && (
											<p>
												Duration:{" "}
												{formatDuration(step.duration)}
											</p>
										)}
									</div>
								</div>
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
		</TooltipProvider>
	);
}

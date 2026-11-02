"use client";

/**
 * TrajectorySteps - Inline reasoning trace visualization for chat messages
 *
 * A compact, expandable view of agent execution steps that appears
 * within chat messages. Inspired by CUGA's reasoning trace visualization.
 */

import { SparklesIcon } from "@saas/shared/components/icons/SparklesIcon";
import { Badge } from "@ui/components/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Loader2,
	SquareTerminal,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DeferredResponse as Response } from "../../../../../components/ai-elements/deferred-response";

/**
 * Simplified step type for inline display
 */
export interface TrajectoryStep {
	id: string;
	type:
		| "thinking"
		| "tool_call"
		| "tool_result"
		| "decision"
		| "hitl"
		| "approval"
		| "error"
		| "reflection";
	title: string;
	description?: string;
	status: "pending" | "running" | "success" | "error" | "waiting";
	duration?: number; // milliseconds
	metadata?: {
		toolName?: string;
		agentName?: string;
		input?: Record<string, unknown>;
		output?: unknown;
		error?: string;
		// HITL/Approval specific
		requestId?: string;
		requestType?: "approval" | "input" | "choice";
		prompt?: string;
		riskLevel?: "low" | "medium" | "high" | "critical";
		riskScore?: number;
		approved?: boolean;
		responseValue?: unknown;
		// Reflection specific
		qualityScore?: number;
	};
	timestamp?: string;
}

interface TrajectoryStepsProps {
	steps: TrajectoryStep[];
	isRunning?: boolean;
	className?: string;
	defaultExpanded?: boolean;
	/**
	 * Per-step expansion control. When `false`, each `StepItem` renders
	 * as a static row — its `CollapsibleTrigger` is disabled, the chevron
	 * is suppressed, and the JSON Tool/Input/Output panel never appears.
	 * The outer "Reasoning Trace" Collapsible is unaffected (users can
	 * still expand/collapse the whole box).
	 *
	 * Surfaces that intentionally hide tool internals (Fabric Loom
	 * launcher) opt in with `stepsExpandable={false}`. Other call sites
	 * keep the default `true` so the Orchestrator chat retains its
	 * inline-JSON debugging affordance.
	 *
	 * Mirrors the `expandable` prop on `<Tool>` (apps/web/components/ai-elements/tool.tsx)
	 * — same intent, different rendering layer. Without this, PR 1093's
	 * `<Tool expandable={false}>` only collapses the bottom "skill ·
	 * Completed" card; the inline trajectory steps inside the Reasoning
	 * Trace box still expanded to raw JSON, which the user observed on a
	 * staging deployment.
	 */
	stepsExpandable?: boolean;
}

// Risk level styling
const RISK_STYLE: Record<string, string> = {
	low: "bg-green-100 text-green-700",
	medium: "bg-amber-100 text-amber-700",
	high: "bg-orange-100 text-orange-700",
	critical: "bg-red-100 text-red-700",
};

function formatDuration(ms?: number): string {
	if (!ms) {
		return "";
	}
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

function StepStatusIcon({ status }: { status: TrajectoryStep["status"] }) {
	switch (status) {
		case "running":
			return <Loader2 className="h-3 w-3 animate-spin text-primary" />;
		case "success":
			return <CheckCircle2 className="h-3 w-3 text-success" />;
		case "error":
			return <XCircle className="h-3 w-3 text-destructive" />;
		case "waiting":
			return <Clock className="h-3 w-3 animate-pulse text-orange-500" />;
		default:
			return <Clock className="h-3 w-3 text-gray-400" />;
	}
}

function StepItem({
	step,
	expandable = true,
}: {
	step: TrajectoryStep;
	isLast?: boolean;
	expandable?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const isHITL = step.type === "hitl" || step.type === "approval";
	const isToolStep = step.type === "tool_call" || step.type === "tool_result";
	// `hasDetails` is gated by `expandable` so the chevron and click handler
	// also disappear in non-expandable mode — Fabric Loom wants a flat row
	// per step, no affordance to dig into raw JSON.
	const hasDetails = Boolean(
		expandable &&
			(step.metadata?.input ||
				step.metadata?.output ||
				step.metadata?.error ||
				(isHITL &&
					(step.metadata?.prompt || step.metadata?.riskLevel))),
	);

	return (
		<div className="relative">
			{/* Timeline node dot on the vertical spine for thinking/reasoning/status steps */}
			{!isToolStep && (
				<span
					aria-hidden="true"
					className={cn(
						"absolute -left-[24.5px] top-1.5 h-2 w-2 rounded-full ring-2 ring-background",
						step.status === "running"
							? "bg-primary animate-pulse"
							: step.status === "error"
								? "bg-destructive"
								: step.status === "waiting"
									? "bg-orange-500 animate-pulse"
									: "bg-muted-foreground/35",
					)}
				/>
			)}

			<Collapsible open={expanded} onOpenChange={setExpanded}>
				<div
					className={cn(
						isToolStep
							? "rounded-lg border border-border/80 bg-card px-3 py-2 shadow-2xs transition-colors"
							: "py-0.5",
					)}
				>
					<div className="flex items-center gap-2 flex-wrap">
						{isToolStep && (
							<span className="shrink-0 text-muted-foreground">
								{step.status === "running" ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
								) : step.status === "error" ? (
									<XCircle className="h-3.5 w-3.5 text-destructive" />
								) : (
									<SquareTerminal className="h-4 w-4 text-muted-foreground" />
								)}
							</span>
						)}
						<CollapsibleTrigger
							className={cn(
								"flex items-center gap-1.5 text-left text-[13px] leading-relaxed text-foreground",
								isToolStep ? "font-normal" : "font-normal",
								hasDetails && "hover:underline cursor-pointer",
							)}
							disabled={!hasDetails}
						>
							{hasDetails &&
								(expanded ? (
									<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
								) : (
									<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
								))}
							<span className="truncate">
								{step.type === "thinking" &&
								step.status === "success" &&
								step.duration
									? `Thought for ${formatDuration(step.duration)}`
									: step.title}
							</span>
						</CollapsibleTrigger>
						{!isToolStep && step.status === "running" && (
							<StepStatusIcon status={step.status} />
						)}
						{!isToolStep && step.status === "error" && (
							<StepStatusIcon status={step.status} />
						)}
						{step.duration && step.type !== "thinking" && (
							<span className="ml-auto text-[11px] text-muted-foreground">
								{formatDuration(step.duration)}
							</span>
						)}
						{/* HITL-specific badges */}
						{isHITL && step.metadata?.riskLevel && (
							<Badge
								variant="secondary"
								className={cn(
									"text-[9px] h-4 px-1.5",
									RISK_STYLE[step.metadata.riskLevel],
								)}
							>
								{step.metadata.riskLevel.toUpperCase()}
								{step.metadata.riskScore !== undefined &&
									` ${step.metadata.riskScore}%`}
							</Badge>
						)}
						{isHITL && step.metadata?.approved !== undefined && (
							<Badge
								variant={
									step.metadata.approved
										? "default"
										: "destructive"
								}
								className="text-[9px] h-4 px-1.5"
							>
								{step.metadata.approved
									? "Approved"
									: "Rejected"}
							</Badge>
						)}
					</div>

					{step.description && step.type === "thinking" ? (
						<div className="text-[13px] leading-relaxed text-foreground/90 mt-1 max-w-prose">
							<Response>{step.description}</Response>
						</div>
					) : step.description ? (
						<p className="text-xs text-muted-foreground mt-0.5 truncate">
							{step.description}
						</p>
					) : null}

					{/* Waiting indicator for HITL */}
					{isHITL && step.status === "waiting" && (
						<div className="flex items-center gap-1 text-xs text-highlight mt-1">
							<Clock className="h-3 w-3 animate-pulse" />
							<span>Awaiting human response...</span>
						</div>
					)}

					{hasDetails && (
						<CollapsibleContent className="mt-2">
							<div className="text-xs p-2 bg-muted/50 rounded-md space-y-1.5 font-mono">
								{/* HITL-specific details */}
								{isHITL && step.metadata?.prompt && (
									<div>
										<span className="text-muted-foreground">
											Prompt:{" "}
										</span>
										<span className="text-foreground">
											{step.metadata.prompt}
										</span>
									</div>
								)}
								{isHITL && step.metadata?.requestType && (
									<div>
										<span className="text-muted-foreground">
											Type:{" "}
										</span>
										<span className="text-foreground capitalize">
											{step.metadata.requestType}
										</span>
									</div>
								)}
								{isHITL &&
									step.metadata?.responseValue !==
										undefined && (
										<div>
											<span className="text-muted-foreground">
												Response:{" "}
											</span>
											<span className="text-foreground">
												{String(
													step.metadata.responseValue,
												)}
											</span>
										</div>
									)}
								{/* Standard details */}
								{step.metadata?.toolName ? (
									<div>
										<span className="text-muted-foreground">
											Tool:{" "}
										</span>
										<span className="text-foreground">
											{step.metadata.toolName}
										</span>
									</div>
								) : null}
								{step.metadata?.input ? (
									<div>
										<span className="text-muted-foreground">
											Input:{" "}
										</span>
										<span className="text-foreground break-all">
											{JSON.stringify(
												step.metadata.input,
											).slice(0, 200)}
											{JSON.stringify(step.metadata.input)
												.length > 200 && "..."}
										</span>
									</div>
								) : null}
								{step.metadata?.output ? (
									<div>
										<span className="text-muted-foreground">
											Output:{" "}
										</span>
										<span className="text-foreground break-all">
											{JSON.stringify(
												step.metadata.output as object,
											).slice(0, 200)}
											{JSON.stringify(
												step.metadata.output as object,
											).length > 200 && "..."}
										</span>
									</div>
								) : null}
								{step.metadata?.error && (
									<div className="text-destructive">
										<span className="text-red-400">
											Error:{" "}
										</span>
										{step.metadata.error}
									</div>
								)}
							</div>
						</CollapsibleContent>
					)}
				</div>
			</Collapsible>
		</div>
	);
}

export function TrajectorySteps({
	steps,
	isRunning = false,
	className,
	defaultExpanded = false,
	stepsExpandable = true,
}: TrajectoryStepsProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);

	// Calculate summary
	const summary = useMemo(() => {
		const toolCalls = steps.filter((s) => s.type === "tool_call").length;
		const errors = steps.filter((s) => s.status === "error").length;
		const totalDuration = steps.reduce(
			(sum, s) => sum + (s.duration || 0),
			0,
		);
		return { total: steps.length, toolCalls, errors, totalDuration };
	}, [steps]);

	if (steps.length === 0) {
		return null;
	}

	return (
		<Collapsible
			open={expanded}
			onOpenChange={setExpanded}
			className={cn("py-1", className)}
		>
			{/* Databricks Genie "Thought process v" Header */}
			<CollapsibleTrigger className="group inline-flex items-center gap-2 py-1 text-left transition-colors">
				<SparklesIcon className="h-4 w-4 shrink-0 text-primary" />
				<span className="text-[13px] font-semibold text-muted-foreground group-hover:text-foreground">
					Thought process
				</span>
				<span className="sr-only">Reasoning Trace</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 text-muted-foreground transition-transform duration-150",
						!expanded && "-rotate-90",
					)}
				/>
				{isRunning && (
					<Loader2 className="h-3 w-3 animate-spin text-primary" />
				)}
				{summary.errors > 0 && (
					<Badge
						variant="destructive"
						className="text-[10px] h-4 px-1.5"
					>
						{summary.errors} errors
					</Badge>
				)}
			</CollapsibleTrigger>

			{/* Databricks Genie vertical timeline spine + steps */}
			<CollapsibleContent>
				<div className="ml-2 mt-1 border-l border-border pl-5 py-1.5 space-y-2.5">
					{steps.map((step, index) => (
						<StepItem
							key={step.id}
							step={step}
							isLast={index === steps.length - 1}
							expandable={stepsExpandable}
						/>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

"use client";

/**
 * TrajectorySteps - Inline reasoning trace visualization for chat messages
 *
 * A compact, expandable view of agent execution steps that appears
 * within chat messages. Inspired by CUGA's reasoning trace visualization.
 */

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Response } from "../../../../../components/ai-elements/response";
import { Badge } from "@ui/components/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	Brain,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	GitBranch,
	Loader2,
	MessageSquare,
	ShieldCheck,
	Sparkles,
	Wrench,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

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
	 * Trace box still expanded to raw JSON, which the user observed in
	 * production on staging.fabric.pro.
	 */
	stepsExpandable?: boolean;
}

// Step type configurations
const STEP_CONFIG: Record<
	TrajectoryStep["type"],
	{ icon: typeof Brain; color: string; label: string }
> = {
	thinking: { icon: Brain, color: "text-primary", label: "Thinking" },
	tool_call: { icon: Wrench, color: "text-secondary", label: "Tool Call" },
	tool_result: {
		icon: CheckCircle2,
		color: "text-teal-500",
		label: "Result",
	},
	decision: { icon: GitBranch, color: "text-highlight", label: "Decision" },
	hitl: {
		icon: MessageSquare,
		color: "text-orange-500",
		label: "Human Input",
	},
	approval: { icon: ShieldCheck, color: "text-cyan-500", label: "Approval" },
	error: { icon: AlertTriangle, color: "text-destructive", label: "Error" },
	reflection: {
		icon: Sparkles,
		color: "text-indigo-500",
		label: "Reflection",
	},
};

// Risk level styling
const RISK_STYLE: Record<string, string> = {
	low: "bg-green-100 text-green-700",
	medium: "bg-amber-100 text-amber-700",
	high: "bg-orange-100 text-orange-700",
	critical: "bg-red-100 text-red-700",
};

// Known internal (non-MCP) tools
const INTERNAL_TOOLS = new Set([
	"code_executor",
	"task_planner",
	"document_generator",
	"web_search",
	"file_read",
	"file_write",
	"list_workflows",
	"get_workflow_details",
	"execute_workflow",
]);

/**
 * Check if a tool is a Fabric AI tool based on its name
 */
function isFabricAiTool(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	return toolName.startsWith("fabric_");
}

/**
 * Check if a tool is a workflow tool
 */
function isWorkflowTool(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	return (
		toolName === "list_workflows" ||
		toolName === "get_workflow_details" ||
		toolName === "execute_workflow"
	);
}

/**
 * Check if a tool is an MCP tool based on its name
 */
function isMcpTool(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	// Internal tools are not MCP tools
	if (INTERNAL_TOOLS.has(toolName)) {
		return false;
	}
	// Fabric AI tools are not MCP tools
	if (isFabricAiTool(toolName)) {
		return false;
	}
	// MCP tools typically have underscores and are from external servers
	// e.g., firecrawl_search, firecrawl_scrape, slack_post_message
	return toolName.includes("_");
}

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
			return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />;
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
	isLast,
	expandable = true,
}: {
	step: TrajectoryStep;
	isLast: boolean;
	expandable?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const config = STEP_CONFIG[step.type];
	const Icon = config.icon;
	const isHITL = step.type === "hitl" || step.type === "approval";
	const toolName = step.metadata?.toolName;
	const isFabric = step.type === "tool_call" && isFabricAiTool(toolName);
	const isWorkflow = step.type === "tool_call" && isWorkflowTool(toolName);
	const isMcp = step.type === "tool_call" && isMcpTool(toolName);
	// `hasDetails` is gated by `expandable` so the chevron and click handler
	// also disappear in non-expandable mode — Fabric Loom wants a flat row
	// per step, no affordance to dig into raw JSON.
	const hasDetails =
		expandable &&
		(step.metadata?.input ||
			step.metadata?.output ||
			step.metadata?.error ||
			(isHITL && (step.metadata?.prompt || step.metadata?.riskLevel)));

	// Determine tool type label
	const _toolTypeLabel = isFabric
		? "Fabric AI"
		: isWorkflow
			? "Workflow"
			: isMcp
				? "MCP"
				: null;

	return (
		<div className="relative">
			{/* Connector line */}
			{!isLast && (
				<div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
			)}

			<div className="flex gap-3">
				{/* Icon */}
				<div
					className={cn(
						"flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center",
						"bg-background border border-border",
						step.status === "waiting" &&
							"animate-pulse border-orange-300",
					)}
				>
					{isFabric ? (
						<FabricLogo size={14} />
					) : isMcp ? (
						<McpLogo size={14} />
					) : isWorkflow ? (
						<GitBranch className="h-3.5 w-3.5 text-purple-500" />
					) : (
						<Icon className={cn("h-3.5 w-3.5", config.color)} />
					)}
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0 pb-3">
					<Collapsible open={expanded} onOpenChange={setExpanded}>
						<div className="flex items-center gap-2 flex-wrap">
							<CollapsibleTrigger
								className={cn(
									"flex items-center gap-1 text-sm font-medium",
									hasDetails &&
										"hover:underline cursor-pointer",
								)}
								disabled={!hasDetails}
							>
								{hasDetails &&
									(expanded ? (
										<ChevronDown className="h-3 w-3 text-muted-foreground" />
									) : (
										<ChevronRight className="h-3 w-3 text-muted-foreground" />
									))}
								<span className="truncate">
									{step.type === "thinking" &&
									step.status === "success" &&
									step.duration
										? `Thought for ${formatDuration(step.duration)}`
										: step.title}
								</span>
							</CollapsibleTrigger>
							<StepStatusIcon status={step.status} />
							{step.duration && step.type !== "thinking" && (
								<span className="text-[10px] text-muted-foreground">
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
							{isHITL &&
								step.metadata?.approved !== undefined && (
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
							<div className="text-xs text-muted-foreground mt-1 max-w-prose">
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
														step.metadata
															.responseValue,
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
												{JSON.stringify(
													step.metadata.input,
												).length > 200 && "..."}
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
													step.metadata
														.output as object,
												).slice(0, 200)}
												{JSON.stringify(
													step.metadata
														.output as object,
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
					</Collapsible>
				</div>
			</div>
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
			className={cn(
				"border rounded-lg bg-muted/30 overflow-hidden shadow-sm",
				className,
			)}
		>
			{/* Header */}
			<CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors">
				<div className="flex items-center gap-2">
					<Brain className="h-4 w-4 text-muted-foreground" />
					<span className="text-xs font-medium">Reasoning Trace</span>
					{isRunning && (
						<Loader2 className="h-3 w-3 animate-spin text-blue-500" />
					)}
				</div>
				<div className="flex items-center gap-2">
					<Badge variant="secondary" className="text-[10px] h-5">
						{summary.total} steps
					</Badge>
					{summary.toolCalls > 0 && (
						<Badge variant="outline" className="text-[10px] h-5">
							{summary.toolCalls} tools
						</Badge>
					)}
					{summary.errors > 0 && (
						<Badge
							variant="destructive"
							className="text-[10px] h-5"
						>
							{summary.errors} errors
						</Badge>
					)}
					{expanded ? (
						<ChevronDown className="h-4 w-4 text-muted-foreground" />
					) : (
						<ChevronRight className="h-4 w-4 text-muted-foreground" />
					)}
				</div>
			</CollapsibleTrigger>

			{/* Steps List */}
			<CollapsibleContent>
				<div className="px-4 py-3 border-t space-y-1">
					{steps.map((step, index) => (
						<StepItem
							key={step.id}
							step={step}
							isLast={index === steps.length - 1}
							expandable={stepsExpandable}
						/>
					))}

					{/* Duration footer */}
					{summary.totalDuration > 0 && (
						<div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground mt-3 pt-3 border-t">
							<Clock className="h-3 w-3" />
							Total: {formatDuration(summary.totalDuration)}
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

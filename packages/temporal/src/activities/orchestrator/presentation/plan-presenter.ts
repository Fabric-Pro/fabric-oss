/**
 * Plan Presenter
 *
 * Factory AI-style plan presentation for user transparency.
 * Shows reasoning, decisions, assumptions, and execution steps
 * in a clear, understandable format.
 *
 * Part of Improvement 5: Factory AI-style Plan Presentation
 */

import type { Assumption, Decision, JourneyState } from "../journey/types";
import type { RoutingDecision, TaskPlan, TaskStep } from "../types";

/**
 * Options for plan presentation.
 */
export interface PresentationOptions {
	showReasoning: boolean;
	showAlternatives: boolean;
	showAssumptions: boolean;
	showRiskDetails: boolean;
	showApprovalPoints: boolean;
	showTimingEstimates: boolean;
	verbosity: "brief" | "normal" | "detailed";
	format: "markdown" | "plain";
}

const DEFAULT_OPTIONS: PresentationOptions = {
	showReasoning: true,
	showAlternatives: false,
	showAssumptions: true,
	showRiskDetails: true,
	showApprovalPoints: true,
	showTimingEstimates: false,
	verbosity: "normal",
	format: "markdown",
};

/**
 * Presents a task plan in Factory AI style.
 */
export function presentPlan(
	plan: TaskPlan,
	routingDecision: RoutingDecision,
	journeyState?: JourneyState,
	options: Partial<PresentationOptions> = {},
): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const sections: string[] = [];

	// Header
	sections.push(formatHeader(plan, opts));

	// Understanding section
	sections.push(formatUnderstanding(plan, routingDecision, opts));

	// Approach section
	sections.push(formatApproach(plan, routingDecision, opts));

	// Plan steps
	sections.push(formatPlanSteps(plan, opts));

	// Decisions made (if journey state available)
	if (journeyState && opts.showReasoning) {
		sections.push(formatDecisions(journeyState.decisions, opts));
	}

	// Assumptions
	if (opts.showAssumptions) {
		const assumptions =
			journeyState?.assumptions ||
			inferAssumptions(plan, routingDecision);
		sections.push(formatAssumptions(assumptions, opts));
	}

	// Risk summary
	if (opts.showRiskDetails) {
		sections.push(formatRiskSummary(plan, routingDecision, opts));
	}

	// Approval requirements
	if (opts.showApprovalPoints) {
		sections.push(formatApprovalRequirements(plan, opts));
	}

	// Filter out empty sections and join
	return sections.filter((s) => s.trim()).join("\n\n");
}

/**
 * Formats the header section.
 */
function formatHeader(_plan: TaskPlan, opts: PresentationOptions): string {
	if (opts.format === "plain") {
		return `EXECUTION PLAN\n${"=".repeat(50)}`;
	}
	return "## Execution Plan";
}

/**
 * Formats the understanding section.
 */
function formatUnderstanding(
	plan: TaskPlan,
	routingDecision: RoutingDecision,
	opts: PresentationOptions,
): string {
	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push("### Understanding Your Request");
		lines.push("");
	} else {
		lines.push("UNDERSTANDING YOUR REQUEST:");
	}

	// Main goal
	lines.push(`I'll help you with: "${truncate(plan.description, 150)}"`);

	// Detected intent (if available)
	if (routingDecision.userIntent) {
		const intents: string[] = [];
		if (routingDecision.userIntent.requestedWorkspace) {
			intents.push("workspace document access");
		}
		if (routingDecision.userIntent.requestedWorkflow) {
			intents.push("workflow execution");
		}
		if (routingDecision.userIntent.requestedMcpTools) {
			intents.push("external service integration");
		}
		if (routingDecision.userIntent.requestedAgent) {
			intents.push(`${routingDecision.userIntent.requestedAgent} agent`);
		}

		if (intents.length > 0) {
			lines.push("");
			lines.push(`Detected needs: ${intents.join(", ")}`);
		}
	}

	return lines.join("\n");
}

/**
 * Formats the approach section.
 */
function formatApproach(
	plan: TaskPlan,
	routingDecision: RoutingDecision,
	opts: PresentationOptions,
): string {
	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push("### My Approach");
		lines.push("");
	} else {
		lines.push("MY APPROACH:");
	}

	// Strategy explanation
	const strategyExplanations: Record<string, string> = {
		api: "Using direct API calls for efficient execution",
		browser: "Using browser automation for interactive tasks",
		hybrid: "Combining multiple approaches for best results",
		agent: "Delegating to specialized agent for domain expertise",
		workflow: "Using pre-defined workflow for consistency",
		research: "Gathering information before taking action",
		generate: "Creating content based on your requirements",
		verify: "Validating and checking the results",
	};

	const strategyDesc =
		strategyExplanations[plan.strategy || "api"] ||
		"Executing requested task";
	lines.push(strategyDesc);

	// Primary executor
	if (
		routingDecision.primaryAgent &&
		routingDecision.primaryAgent !== "llm_only"
	) {
		lines.push("");
		if (routingDecision.primaryAgent === "mcp_direct") {
			lines.push("**Primary Method**: Direct tool execution");
		} else {
			lines.push(
				`**Primary Agent**: ${formatAgentName(routingDecision.primaryAgent)}`,
			);
		}
	}

	// Confidence
	if (opts.verbosity !== "brief" && routingDecision.confidence) {
		lines.push(`**Confidence**: ${routingDecision.confidence}%`);
	}

	// Reasoning
	if (opts.showReasoning && routingDecision.reasoning) {
		lines.push("");
		lines.push(`**Reasoning**: ${routingDecision.reasoning}`);
	}

	return lines.join("\n");
}

/**
 * Formats the plan steps section.
 */
function formatPlanSteps(plan: TaskPlan, opts: PresentationOptions): string {
	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push(`### Steps (${plan.steps.length} total)`);
		lines.push("");
	} else {
		lines.push(`STEPS (${plan.steps.length} total):`);
	}

	for (const step of plan.steps) {
		lines.push(formatStep(step, opts));

		if (opts.verbosity === "detailed") {
			// Add extra details for detailed view
			if (step.executor) {
				lines.push(`   Using: ${formatAgentName(step.executor)}`);
			}
			if (step.expectedOutput) {
				lines.push(`   Output: ${truncate(step.expectedOutput, 80)}`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Formats a single step.
 */
function formatStep(step: TaskStep, opts: PresentationOptions): string {
	const parts: string[] = [];

	// Status/number
	parts.push(`${step.order}.`);

	// Risk indicator
	if (opts.showRiskDetails) {
		if (step.riskLevel === "critical") {
			parts.push(opts.format === "markdown" ? "🔴" : "[CRITICAL]");
		} else if (step.riskLevel === "high") {
			parts.push(opts.format === "markdown" ? "⚠️" : "[HIGH]");
		}
	}

	// Description
	if (opts.format === "markdown") {
		parts.push(`**${truncate(step.description, 100)}**`);
	} else {
		parts.push(truncate(step.description, 100));
	}

	const line = parts.join(" ");
	const extras: string[] = [];

	// Executor info (brief)
	if (opts.verbosity !== "detailed" && step.executor) {
		extras.push(`Using: ${formatAgentName(step.executor)}`);
	}

	// Approval indicator
	if (opts.showApprovalPoints && step.requiresApproval) {
		extras.push(
			opts.format === "markdown"
				? "⏸️ Requires approval"
				: "[Requires approval]",
		);
	}

	if (extras.length > 0) {
		return `${line}\n   ${extras.join(" | ")}`;
	}

	return line;
}

/**
 * Formats decisions section.
 */
function formatDecisions(
	decisions: Decision[],
	opts: PresentationOptions,
): string {
	if (decisions.length === 0) {
		return "";
	}

	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push("### Key Decisions Made");
		lines.push("");
	} else {
		lines.push("KEY DECISIONS:");
	}

	const recentDecisions = decisions.slice(-5);
	for (const decision of recentDecisions) {
		if (opts.format === "markdown") {
			lines.push(`- **${decision.description}**: ${decision.reasoning}`);
		} else {
			lines.push(`- ${decision.description}: ${decision.reasoning}`);
		}

		if (opts.showAlternatives && decision.alternatives.length > 0) {
			const altNames = decision.alternatives
				.map((a) => a.description)
				.join(", ");
			lines.push(`  Alternatives considered: ${altNames}`);
		}
	}

	return lines.join("\n");
}

/**
 * Formats assumptions section.
 */
function formatAssumptions(
	assumptions: Assumption[] | string[],
	opts: PresentationOptions,
): string {
	if (!assumptions || assumptions.length === 0) {
		return "";
	}

	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push("### Assumptions I'm Making");
		lines.push("");
	} else {
		lines.push("ASSUMPTIONS:");
	}

	for (const assumption of assumptions) {
		if (typeof assumption === "string") {
			lines.push(`- ${assumption}`);
		} else {
			const status =
				assumption.isValid === true
					? "✓"
					: assumption.isValid === false
						? "✗"
						: "";
			lines.push(`- ${status} ${assumption.description}`);
		}
	}

	return lines.join("\n");
}

/**
 * Infers assumptions from plan and routing decision.
 */
function inferAssumptions(
	plan: TaskPlan,
	routingDecision: RoutingDecision,
): string[] {
	const assumptions: string[] = [];

	// Infer based on plan characteristics
	if (plan.steps.length === 1) {
		assumptions.push("This task can be completed in a single step");
	}

	if (routingDecision.useMcpDirect) {
		assumptions.push(
			"External service integration is available and configured",
		);
	}

	if (plan.steps.some((s) => s.type === "research")) {
		assumptions.push(
			"Gathering additional information will improve results",
		);
	}

	if (plan.steps.some((s) => s.capability === "agent")) {
		assumptions.push("Specialized agent has the required capabilities");
	}

	// Add common assumptions
	if (routingDecision.riskLevel === "low") {
		assumptions.push(
			"This task has minimal risk and doesn't require approval",
		);
	}

	return assumptions;
}

/**
 * Formats risk summary section.
 */
function formatRiskSummary(
	plan: TaskPlan,
	routingDecision: RoutingDecision,
	opts: PresentationOptions,
): string {
	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push("### Risk Assessment");
		lines.push("");
	} else {
		lines.push("RISK ASSESSMENT:");
	}

	// Overall risk
	const riskLabel = (
		plan.riskLevel ||
		routingDecision.riskLevel ||
		"low"
	).toUpperCase();
	const riskIcon = getRiskIcon(
		plan.riskLevel || routingDecision.riskLevel,
		opts.format,
	);
	lines.push(`**Overall Risk**: ${riskIcon} ${riskLabel}`);

	// Risk factors
	if (routingDecision.riskFactors && routingDecision.riskFactors.length > 0) {
		lines.push("");
		lines.push("Factors:");
		for (const factor of routingDecision.riskFactors) {
			lines.push(`- ${factor}`);
		}
	}

	// Step-level risks
	const highRiskSteps = plan.steps.filter(
		(s) => s.riskLevel === "high" || s.riskLevel === "critical",
	);
	if (highRiskSteps.length > 0) {
		lines.push("");
		lines.push(`${highRiskSteps.length} step(s) flagged as elevated risk`);
	}

	return lines.join("\n");
}

/**
 * Formats approval requirements section.
 */
function formatApprovalRequirements(
	plan: TaskPlan,
	opts: PresentationOptions,
): string {
	const approvalSteps = plan.steps.filter((s) => s.requiresApproval);

	if (approvalSteps.length === 0) {
		return opts.format === "markdown"
			? "### Approval\n\nNo approval required for this plan."
			: "APPROVAL: Not required";
	}

	const lines: string[] = [];

	if (opts.format === "markdown") {
		lines.push("### Approval Required");
		lines.push("");
	} else {
		lines.push("APPROVAL REQUIRED:");
	}

	lines.push(`${approvalSteps.length} step(s) will pause for your approval:`);
	lines.push("");

	for (const step of approvalSteps) {
		const riskIcon = getRiskIcon(step.riskLevel, opts.format);
		lines.push(
			`${step.order}. ${riskIcon} ${truncate(step.description, 80)}`,
		);
	}

	return lines.join("\n");
}

/**
 * Presents execution progress.
 */
export function presentProgress(
	plan: TaskPlan,
	currentStepIndex: number,
	_journeyState?: JourneyState,
	opts: Partial<PresentationOptions> = {},
): string {
	const options = { ...DEFAULT_OPTIONS, ...opts };
	const lines: string[] = [];

	const completedCount = currentStepIndex;
	const totalCount = plan.steps.length;
	const percentComplete = Math.round((completedCount / totalCount) * 100);

	if (options.format === "markdown") {
		lines.push("## Progress Update");
		lines.push("");
		lines.push(
			`**Status**: ${completedCount}/${totalCount} steps complete (${percentComplete}%)`,
		);
	} else {
		lines.push(
			`PROGRESS: ${completedCount}/${totalCount} steps (${percentComplete}%)`,
		);
	}

	// Current step
	if (currentStepIndex < plan.steps.length) {
		const current = plan.steps[currentStepIndex];
		lines.push("");
		lines.push(`**Current**: ${current.description}`);
	}

	// Progress bar (markdown only)
	if (options.format === "markdown") {
		lines.push("");
		const filledBlocks = Math.round(percentComplete / 10);
		const emptyBlocks = 10 - filledBlocks;
		const progressBar = "█".repeat(filledBlocks) + "░".repeat(emptyBlocks);
		lines.push(`[${progressBar}] ${percentComplete}%`);
	}

	return lines.join("\n");
}

/**
 * Presents an error or issue.
 */
export function presentError(
	error: string,
	step?: TaskStep,
	recovery?: string,
	opts: Partial<PresentationOptions> = {},
): string {
	const options = { ...DEFAULT_OPTIONS, ...opts };
	const lines: string[] = [];

	if (options.format === "markdown") {
		lines.push("## Issue Encountered");
		lines.push("");
		lines.push(`**Error**: ${error}`);
	} else {
		lines.push(`ERROR: ${error}`);
	}

	if (step) {
		lines.push("");
		lines.push(`**During**: Step ${step.order} - ${step.description}`);
	}

	if (recovery) {
		lines.push("");
		lines.push(`**Recovery**: ${recovery}`);
	}

	return lines.join("\n");
}

/**
 * Presents completion summary.
 */
export function presentCompletion(
	plan: TaskPlan,
	journeyState?: JourneyState,
	response?: string,
	opts: Partial<PresentationOptions> = {},
): string {
	const options = { ...DEFAULT_OPTIONS, ...opts };
	const lines: string[] = [];

	if (options.format === "markdown") {
		lines.push("## Execution Complete");
		lines.push("");
	} else {
		lines.push("EXECUTION COMPLETE");
	}

	// Summary stats
	const completed = plan.steps.filter((s) => s.status === "complete").length;
	const failed = plan.steps.filter((s) => s.status === "error").length;
	const skipped = plan.steps.filter((s) => s.status === "skipped").length;

	lines.push(
		`**Steps**: ${completed} completed, ${failed} failed, ${skipped} skipped`,
	);

	if (journeyState) {
		const durationSec = Math.round(
			(Date.now() - journeyState.startedAt.getTime()) / 1000,
		);
		lines.push(`**Duration**: ${formatDuration(durationSec)}`);
	}

	// Response preview
	if (response && response.length > 0) {
		lines.push("");
		lines.push("### Result");
		lines.push("");
		lines.push(truncate(response, 500));
	}

	return lines.join("\n");
}

// Helper functions

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength - 3)}...`;
}

function formatAgentName(agentId: string): string {
	const nameMap: Record<string, string> = {
		mcp_direct: "Direct Tool Execution",
		llm_only: "LLM Analysis",
		cuga_generalist: "CUGA (Code/Browser)",
		project_document_generator: "Document Generator",
		story_breakdown: "Story Breakdown Agent",
		task_planner: "Task Planner",
	};
	return nameMap[agentId] || agentId.replace(/_/g, " ");
}

function getRiskIcon(
	risk: string | undefined,
	format: "markdown" | "plain",
): string {
	if (format === "plain") {
		return risk === "critical" ? "[!!!]" : risk === "high" ? "[!]" : "";
	}
	return risk === "critical"
		? "🔴"
		: risk === "high"
			? "⚠️"
			: risk === "medium"
				? "🟡"
				: "🟢";
}

function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}m ${secs}s`;
}

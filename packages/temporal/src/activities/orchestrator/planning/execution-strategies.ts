/**
 * Execution Strategies
 *
 * Defines the different execution strategies available to the orchestrator
 * and the logic for selecting the optimal strategy based on task characteristics.
 */

import type {
	Capability,
	ContextRequirements,
	ExecutionStrategy,
	RoutingDecision,
} from "../types";

/**
 * Strategy definition with metadata.
 */
export interface StrategyDefinition {
	name: ExecutionStrategy;
	description: string;
	phases: string[];
	bestFor: string[];
	riskTolerance: "low" | "medium" | "high";
	parallelizable: boolean;
	requiresResearch: boolean;
}

/**
 * Available execution strategies.
 */
export const EXECUTION_STRATEGIES: Record<
	ExecutionStrategy,
	StrategyDefinition
> = {
	"research-then-generate": {
		name: "research-then-generate",
		description: "Gather context through research before generating output",
		phases: ["research", "synthesize", "generate", "verify"],
		bestFor: [
			"document creation",
			"analysis tasks",
			"reports",
			"recommendations",
			"PRDs",
			"proposals",
		],
		riskTolerance: "low",
		parallelizable: true,
		requiresResearch: true,
	},
	"iterative-refinement": {
		name: "iterative-refinement",
		description:
			"Generate, review, and refine in cycles until quality threshold met",
		phases: ["generate", "review", "refine"],
		bestFor: [
			"creative content",
			"code generation",
			"iterative improvement",
			"quality-sensitive tasks",
		],
		riskTolerance: "medium",
		parallelizable: false,
		requiresResearch: false,
	},
	"parallel-gather": {
		name: "parallel-gather",
		description:
			"Gather information from multiple sources in parallel, then synthesize",
		phases: ["parallel-research", "synthesize", "generate"],
		bestFor: [
			"market research",
			"competitive analysis",
			"multi-source aggregation",
			"comprehensive reports",
		],
		riskTolerance: "low",
		parallelizable: true,
		requiresResearch: true,
	},
	"hierarchical-delegation": {
		name: "hierarchical-delegation",
		description:
			"Decompose task and delegate to specialized agents with coordination",
		phases: ["decompose", "delegate", "coordinate", "aggregate"],
		bestFor: [
			"complex multi-domain tasks",
			"tasks requiring multiple specialists",
			"large projects",
		],
		riskTolerance: "medium",
		parallelizable: true,
		requiresResearch: false,
	},
	"direct-execution": {
		name: "direct-execution",
		description: "Direct execution without research or iteration",
		phases: ["execute"],
		bestFor: [
			"simple tasks",
			"well-defined operations",
			"CRUD operations",
			"simple queries",
		],
		riskTolerance: "high",
		parallelizable: false,
		requiresResearch: false,
	},
};

/**
 * Selects the optimal execution strategy based on task characteristics.
 */
export function selectExecutionStrategy(
	task: string,
	contextRequirements: ContextRequirements,
	routingDecision: RoutingDecision,
	capabilities: Capability[],
): ExecutionStrategy {
	const taskLower = task.toLowerCase();

	// Check for explicit strategy hints in the task
	const strategyHints = detectStrategyHints(taskLower);
	if (strategyHints) {
		return strategyHints;
	}

	// If research is explicitly required
	if (contextRequirements.requiresResearch) {
		// If we have multiple research queries, use parallel-gather
		if (contextRequirements.researchQueries.length > 2) {
			return "parallel-gather";
		}
		return "research-then-generate";
	}

	// If generalist agent with complete-task delegation
	if (
		routingDecision.isGeneralistAgent &&
		routingDecision.delegationMode === "complete-task"
	) {
		return "direct-execution";
	}

	// If multiple specialized agents needed
	const agentCapabilities = capabilities.filter((c) => c.type === "agent");
	if (agentCapabilities.length > 2 && isComplexTask(taskLower)) {
		return "hierarchical-delegation";
	}

	// Check for creative/quality-sensitive tasks
	if (isQualitySensitiveTask(taskLower)) {
		return "iterative-refinement";
	}

	// Check for research-oriented tasks
	if (isResearchOrientedTask(taskLower)) {
		return "research-then-generate";
	}

	// Default to direct execution for simple tasks
	if (isSimpleTask(taskLower, contextRequirements)) {
		return "direct-execution";
	}

	// Default strategy
	return "research-then-generate";
}

/**
 * Detect explicit strategy hints in task text.
 */
function detectStrategyHints(task: string): ExecutionStrategy | null {
	// Research-first hints
	if (
		task.includes("research first") ||
		task.includes("gather information") ||
		task.includes("find out about") ||
		task.includes("learn about")
	) {
		return "research-then-generate";
	}

	// Iterative hints
	if (
		task.includes("refine") ||
		task.includes("iterate") ||
		task.includes("improve") ||
		task.includes("polish")
	) {
		return "iterative-refinement";
	}

	// Parallel hints
	if (
		task.includes("compare") ||
		task.includes("multiple sources") ||
		task.includes("comprehensive")
	) {
		return "parallel-gather";
	}

	// Delegation hints
	if (
		task.includes("coordinate") ||
		task.includes("multiple agents") ||
		task.includes("team")
	) {
		return "hierarchical-delegation";
	}

	return null;
}

/**
 * Check if task is complex enough for hierarchical delegation.
 */
function isComplexTask(task: string): boolean {
	const complexIndicators = [
		"comprehensive",
		"complete",
		"full",
		"end-to-end",
		"entire",
		"all aspects",
		"multiple",
		"various",
		"different areas",
	];

	return complexIndicators.some((indicator) => task.includes(indicator));
}

/**
 * Check if task is quality-sensitive.
 */
function isQualitySensitiveTask(task: string): boolean {
	const qualityIndicators = [
		"high quality",
		"professional",
		"polished",
		"publication ready",
		"client-facing",
		"formal",
		"creative",
		"engaging",
	];

	return qualityIndicators.some((indicator) => task.includes(indicator));
}

/**
 * Check if task is research-oriented.
 */
function isResearchOrientedTask(task: string): boolean {
	const researchIndicators = [
		"research",
		"analyze",
		"investigate",
		"explore",
		"study",
		"examine",
		"prd",
		"product requirements",
		"market analysis",
		"competitive analysis",
		"report",
		"recommendation",
		"proposal",
	];

	return researchIndicators.some((indicator) => task.includes(indicator));
}

/**
 * Check if task is simple enough for direct execution.
 */
function isSimpleTask(
	task: string,
	contextRequirements: ContextRequirements,
): boolean {
	// No research needed
	if (contextRequirements.requiresResearch) {
		return false;
	}

	// Few or no information needs
	if (contextRequirements.informationNeeds.length > 1) {
		return false;
	}

	// Short task description suggests simplicity
	if (task.length > 200) {
		return false;
	}

	// Simple action indicators
	const simpleIndicators = [
		"just",
		"simply",
		"quick",
		"basic",
		"simple",
		"easy",
	];

	return simpleIndicators.some((indicator) => task.includes(indicator));
}

/**
 * Gets the phases for a given strategy.
 */
export function getStrategyPhases(strategy: ExecutionStrategy): string[] {
	return EXECUTION_STRATEGIES[strategy]?.phases || ["execute"];
}

/**
 * Checks if a strategy supports parallel execution.
 */
export function isParallelizableStrategy(strategy: ExecutionStrategy): boolean {
	return EXECUTION_STRATEGIES[strategy]?.parallelizable || false;
}

/**
 * Checks if a strategy requires research.
 */
export function strategyRequiresResearch(strategy: ExecutionStrategy): boolean {
	return EXECUTION_STRATEGIES[strategy]?.requiresResearch || false;
}

/**
 * Enhanced Task Planner
 *
 * Creates intelligent, strategy-based task plans that leverage
 * context requirements, capability matching, and execution strategies.
 */

import type {
	Capability,
	CapabilityMatch,
	ContextRequirements,
	EnhancedTaskPlan,
	ExecutionStrategy,
	PlanRiskAssessment,
	RoutingDecision,
	SynthesizedContext,
	TaskPhase,
	TaskStep,
} from "../types";
import {
	getStrategyPhases,
	selectExecutionStrategy,
} from "./execution-strategies";

/**
 * Input for creating an enhanced task plan.
 */
export interface CreateEnhancedPlanInput {
	task: string;
	contextRequirements: ContextRequirements;
	synthesizedContext?: SynthesizedContext;
	routingDecision: RoutingDecision;
	capabilities: Capability[];
	capabilityMatches: CapabilityMatch[];
	userId: string;
	organizationId?: string;
}

/**
 * Creates an enhanced, strategy-based task plan.
 *
 * This planner:
 * 1. Selects the optimal execution strategy
 * 2. Creates phases based on strategy
 * 3. Maps capabilities to steps
 * 4. Defines context flow between steps
 * 5. Identifies parallelizable groups
 */
export async function createEnhancedTaskPlan(
	input: CreateEnhancedPlanInput,
): Promise<EnhancedTaskPlan> {
	console.log("[Orchestrator] Creating enhanced task plan", {
		task: input.task.substring(0, 100),
		hasContext: !!input.synthesizedContext,
		capabilityCount: input.capabilities.length,
		matchCount: input.capabilityMatches.length,
	});

	// Select execution strategy
	const strategy = selectExecutionStrategy(
		input.task,
		input.contextRequirements,
		input.routingDecision,
		input.capabilities,
	);

	console.log(`[Orchestrator] Selected strategy: ${strategy}`);

	// Get strategy phases
	const phases = getStrategyPhases(strategy);

	// Create phases with steps
	const taskPhases = await createPhasesForStrategy(input, strategy, phases);

	// Build context flow mapping
	const contextFlow = buildContextFlow(taskPhases);

	// Identify parallelizable groups
	const parallelizableGroups = identifyParallelGroups(taskPhases);

	// Assess plan risk
	const riskAssessment = assessPlanRisk(taskPhases, input);

	return {
		id: `enhanced-plan-${Date.now()}`,
		strategy,
		phases: taskPhases,
		contextFlow,
		parallelizableGroups,
		estimatedSteps: taskPhases.reduce((sum, p) => sum + p.steps.length, 0),
		riskAssessment,
	};
}

/**
 * Creates phases for the selected strategy.
 */
async function createPhasesForStrategy(
	input: CreateEnhancedPlanInput,
	strategy: ExecutionStrategy,
	phaseNames: string[],
): Promise<TaskPhase[]> {
	const phases: TaskPhase[] = [];

	for (let i = 0; i < phaseNames.length; i++) {
		const phaseName = phaseNames[i];
		const phase = await createPhase(input, strategy, phaseName, i);
		phases.push(phase);
	}

	return phases;
}

/**
 * Creates a single phase with its steps.
 */
async function createPhase(
	input: CreateEnhancedPlanInput,
	strategy: ExecutionStrategy,
	phaseName: string,
	order: number,
): Promise<TaskPhase> {
	const steps = await createStepsForPhase(input, strategy, phaseName);

	return {
		id: `phase-${phaseName}-${Date.now()}`,
		name: formatPhaseName(phaseName),
		description: getPhaseDescription(phaseName, input.task),
		order,
		steps,
		status: "pending",
	};
}

/**
 * Creates steps for a specific phase.
 */
async function createStepsForPhase(
	input: CreateEnhancedPlanInput,
	_strategy: ExecutionStrategy,
	phaseName: string,
): Promise<TaskStep[]> {
	switch (phaseName) {
		case "research":
		case "parallel-research":
			return createResearchSteps(
				input,
				phaseName === "parallel-research",
			);

		case "synthesize":
			return createSynthesizeSteps(input);

		case "generate":
			return createGenerateSteps(input);

		case "verify":
		case "review":
			return createVerifySteps(input);

		case "refine":
			return createRefineSteps(input);

		case "decompose":
			return createDecomposeSteps(input);

		case "delegate":
			return createDelegateSteps(input);

		case "coordinate":
			return createCoordinateSteps(input);

		case "aggregate":
			return createAggregateSteps(input);

		case "execute":
			return createExecuteSteps(input);

		default:
			return createDefaultSteps(input, phaseName);
	}
}

/**
 * Creates research steps based on context requirements.
 */
function createResearchSteps(
	input: CreateEnhancedPlanInput,
	parallel: boolean,
): TaskStep[] {
	const steps: TaskStep[] = [];
	const { contextRequirements, capabilityMatches } = input;

	// Find research tools
	const researchCapabilities = capabilityMatches.filter(
		(m) =>
			m.capability.type === "mcp_tool" &&
			(m.capability.name.toLowerCase().includes("search") ||
				m.capability.name.toLowerCase().includes("scrape")),
	);

	// Create steps for each research query
	for (let i = 0; i < contextRequirements.researchQueries.length; i++) {
		const query = contextRequirements.researchQueries[i];
		const tool = researchCapabilities[0]?.capability;

		steps.push({
			id: `research-${i + 1}`,
			description: `Research: ${query}`,
			type: "research",
			status: "pending",
			order: i + 1,
			executor: tool?.id,
			capability: "mcp_tool",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				query,
				contextInputs: i > 0 ? [`research-${i}`] : [],
			},
			expectedOutput: `Research findings for: ${query}`,
			parallelGroup: parallel ? "research-parallel" : undefined,
		});
	}

	return steps;
}

/**
 * Creates synthesis steps.
 */
function createSynthesizeSteps(_input: CreateEnhancedPlanInput): TaskStep[] {
	return [
		{
			id: "synthesize-context",
			description: "Synthesize research findings into actionable context",
			type: "generate",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				contextInputs: ["research.*"],
			},
			expectedOutput:
				"Synthesized context with key facts and recommendations",
		},
	];
}

/**
 * Creates generation steps.
 */
function createGenerateSteps(input: CreateEnhancedPlanInput): TaskStep[] {
	const { routingDecision, capabilityMatches } = input;

	// Find the best agent for generation
	const generatorMatch = capabilityMatches.find(
		(m) =>
			m.capability.type === "agent" &&
			(m.capability.skills.includes("generate") ||
				m.capability.skills.includes("create") ||
				m.capability.skills.includes("write")),
	);

	const executor =
		generatorMatch?.capability.id || routingDecision.primaryAgent;

	return [
		{
			id: "generate-output",
			description: `Generate: ${input.task}`,
			type: "generate",
			status: "pending",
			order: 1,
			executor,
			capability: "agent",
			riskLevel: routingDecision.riskLevel,
			requiresApproval: routingDecision.riskLevel !== "low",
			inputs: {
				contextInputs: ["synthesize-context", "research.*"],
				originalTask: input.task,
			},
			expectedOutput: "Generated output based on task and context",
		},
	];
}

/**
 * Creates verification steps.
 */
function createVerifySteps(_input: CreateEnhancedPlanInput): TaskStep[] {
	return [
		{
			id: "verify-output",
			description: "Verify and review generated output",
			type: "verify",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				contextInputs: ["generate-output", "synthesize-context"],
			},
			expectedOutput: "Verification result with quality assessment",
		},
	];
}

/**
 * Creates refinement steps.
 */
function createRefineSteps(_input: CreateEnhancedPlanInput): TaskStep[] {
	return [
		{
			id: "refine-output",
			description: "Refine output based on review feedback",
			type: "generate",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				contextInputs: ["verify-output", "generate-output"],
			},
			expectedOutput: "Refined and improved output",
		},
	];
}

/**
 * Creates decomposition steps for hierarchical delegation.
 */
function createDecomposeSteps(input: CreateEnhancedPlanInput): TaskStep[] {
	return [
		{
			id: "decompose-task",
			description: "Decompose task into sub-tasks for delegation",
			type: "generate",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				task: input.task,
				availableAgents: input.capabilities
					.filter((c) => c.type === "agent")
					.map((c) => c.id),
			},
			expectedOutput: "List of sub-tasks with assigned agents",
		},
	];
}

/**
 * Creates delegation steps.
 */
function createDelegateSteps(input: CreateEnhancedPlanInput): TaskStep[] {
	const agentCapabilities = input.capabilityMatches.filter(
		(m) => m.capability.type === "agent",
	);

	// Create a delegation step for each matched agent
	return agentCapabilities.slice(0, 3).map((match, i) => ({
		id: `delegate-${match.capability.id}`,
		description: `Delegate to ${match.capability.name}: ${match.suggestedUse}`,
		type: "generate" as const,
		status: "pending" as const,
		order: i + 1,
		executor: match.capability.id,
		capability: "agent" as const,
		riskLevel: match.capability.riskLevel,
		requiresApproval: match.capability.requiresApproval,
		inputs: {
			contextInputs: ["decompose-task"],
		},
		expectedOutput: `Result from ${match.capability.name}`,
		parallelGroup: "delegation-parallel",
	}));
}

/**
 * Creates coordination steps.
 */
function createCoordinateSteps(_input: CreateEnhancedPlanInput): TaskStep[] {
	return [
		{
			id: "coordinate-results",
			description:
				"Coordinate and reconcile results from delegated agents",
			type: "generate",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				contextInputs: ["delegate-*"],
			},
			expectedOutput: "Coordinated results with conflict resolution",
		},
	];
}

/**
 * Creates aggregation steps.
 */
function createAggregateSteps(_input: CreateEnhancedPlanInput): TaskStep[] {
	return [
		{
			id: "aggregate-output",
			description: "Aggregate all results into final output",
			type: "generate",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {
				contextInputs: ["coordinate-results", "delegate-*"],
			},
			expectedOutput: "Final aggregated output",
		},
	];
}

/**
 * Creates direct execution steps.
 */
function createExecuteSteps(input: CreateEnhancedPlanInput): TaskStep[] {
	const { routingDecision } = input;

	return [
		{
			id: "execute-task",
			description: input.task,
			type: "generate",
			status: "pending",
			order: 1,
			executor: routingDecision.primaryAgent,
			capability: routingDecision.isGeneralistAgent ? "agent" : "llm",
			riskLevel: routingDecision.riskLevel,
			requiresApproval:
				routingDecision.riskLevel === "high" ||
				routingDecision.riskLevel === "critical",
			inputs: {
				originalTask: input.task,
			},
			expectedOutput: "Task execution result",
		},
	];
}

/**
 * Creates default steps for unknown phases.
 */
function createDefaultSteps(
	_input: CreateEnhancedPlanInput,
	phaseName: string,
): TaskStep[] {
	return [
		{
			id: `${phaseName}-step`,
			description: `Execute ${phaseName} phase`,
			type: "generate",
			status: "pending",
			order: 1,
			capability: "llm",
			riskLevel: "low",
			requiresApproval: false,
			inputs: {},
			expectedOutput: `${phaseName} phase result`,
		},
	];
}

/**
 * Builds context flow mapping between steps.
 */
function buildContextFlow(phases: TaskPhase[]): Record<string, string[]> {
	const flow: Record<string, string[]> = {};

	for (const phase of phases) {
		for (const step of phase.steps) {
			const inputs =
				(step.inputs as { contextInputs?: string[] })?.contextInputs ||
				[];
			if (inputs.length > 0) {
				flow[step.id] = inputs;
			}
		}
	}

	return flow;
}

/**
 * Identifies groups of steps that can run in parallel.
 */
function identifyParallelGroups(phases: TaskPhase[]): string[][] {
	const groups: Map<string, string[]> = new Map();

	for (const phase of phases) {
		for (const step of phase.steps) {
			if (step.parallelGroup) {
				if (!groups.has(step.parallelGroup)) {
					groups.set(step.parallelGroup, []);
				}
				groups.get(step.parallelGroup)?.push(step.id);
			}
		}
	}

	return Array.from(groups.values()).filter((g) => g.length > 1);
}

/**
 * Assesses the overall risk of the plan.
 */
function assessPlanRisk(
	phases: TaskPhase[],
	_input: CreateEnhancedPlanInput,
): PlanRiskAssessment {
	const allSteps = phases.flatMap((p) => p.steps);
	const riskFactors: string[] = [];

	// Count risk levels
	const criticalSteps = allSteps.filter((s) => s.riskLevel === "critical");
	const highSteps = allSteps.filter((s) => s.riskLevel === "high");
	const approvalSteps = allSteps.filter((s) => s.requiresApproval);

	if (criticalSteps.length > 0) {
		riskFactors.push(`${criticalSteps.length} critical-risk step(s)`);
	}
	if (highSteps.length > 0) {
		riskFactors.push(`${highSteps.length} high-risk step(s)`);
	}

	// Check for write operations
	const writeSteps = allSteps.filter(
		(s) =>
			s.description.toLowerCase().includes("create") ||
			s.description.toLowerCase().includes("update") ||
			s.description.toLowerCase().includes("delete"),
	);
	if (writeSteps.length > 0) {
		riskFactors.push(`${writeSteps.length} write operation(s)`);
	}

	// Check for external delegations
	const delegationSteps = allSteps.filter((s) => s.executor);
	if (delegationSteps.length > 2) {
		riskFactors.push(`${delegationSteps.length} agent delegation(s)`);
	}

	// Determine overall risk
	let overallRisk: "low" | "medium" | "high" | "critical" = "low";
	if (criticalSteps.length > 0) {
		overallRisk = "critical";
	} else if (highSteps.length > 0) {
		overallRisk = "high";
	} else if (writeSteps.length > 0 || delegationSteps.length > 2) {
		overallRisk = "medium";
	}

	// Determine if approval is required
	const requiresApproval =
		overallRisk === "high" ||
		overallRisk === "critical" ||
		approvalSteps.length > 0;

	return {
		overallRisk,
		riskFactors,
		requiresApproval,
		criticalStepCount: criticalSteps.length,
		highRiskStepCount: highSteps.length,
	};
}

/**
 * Formats a phase name for display.
 */
function formatPhaseName(name: string): string {
	return name
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * Gets a description for a phase.
 */
function getPhaseDescription(phaseName: string, task: string): string {
	const descriptions: Record<string, string> = {
		research: "Gather information and context relevant to the task",
		"parallel-research":
			"Gather information from multiple sources in parallel",
		synthesize: "Synthesize gathered information into actionable context",
		generate: "Generate the primary output based on context",
		verify: "Verify and review the generated output",
		review: "Review the output for quality and correctness",
		refine: "Refine and improve the output based on feedback",
		decompose: "Break down the task into manageable sub-tasks",
		delegate: "Delegate sub-tasks to specialized agents",
		coordinate: "Coordinate results from multiple agents",
		aggregate: "Aggregate all results into final output",
		execute: "Execute the task directly",
	};

	return descriptions[phaseName] || `Execute ${phaseName} phase for: ${task}`;
}

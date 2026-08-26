/**
 * Strategy Executor
 *
 * Executes enhanced task plans based on their selected strategy.
 * Handles phase orchestration, parallel execution, and context flow.
 */

import type { ALTKConfig } from "../../../workflows/orchestrator/types";
import {
	createContextBag,
	formatContextForDelegation,
	updateContextBag,
} from "../context/context-bag";
import { isParallelizableStrategy } from "../planning/execution-strategies";
import type {
	ContextBag,
	EnhancedTaskPlan,
	ExecuteStepInput,
	ExecuteStepOutput,
	ExecutionStrategy,
	TaskPhase,
	TaskStep,
} from "../types";
import { executeStep } from "./execute-step";

/**
 * Input for strategy execution.
 */
export interface ExecuteStrategyInput {
	plan: EnhancedTaskPlan;
	originalTask: string;
	userId: string;
	organizationId?: string;
	initialContext?: ContextBag;
	/** System prompt for step execution */
	systemPrompt?: string;
	/** Execution mode */
	executionMode?: "fast" | "balanced" | "accurate" | "save_reuse";
	/** ALTK configuration */
	altkConfig?: ALTKConfig;
	/** Enabled MCP config IDs */
	enabledMcpConfigIds?: string[] | null;
	/** Enabled agent IDs */
	enabledAgentIds?: string[] | null;
	/** Letta agent ID for memory */
	lettaAgentId?: string | null;
	/** Conversation history */
	conversationHistory?: Array<{
		role: "user" | "assistant" | "system";
		content: string;
	}>;
	onPhaseStart?: (phase: TaskPhase) => void;
	onPhaseComplete?: (phase: TaskPhase, results: ExecuteStepOutput[]) => void;
	onStepStart?: (step: TaskStep) => void;
	onStepComplete?: (step: TaskStep, result: ExecuteStepOutput) => void;
}

/**
 * Output from strategy execution.
 */
export interface ExecuteStrategyOutput {
	success: boolean;
	finalContext: ContextBag;
	phaseResults: PhaseResult[];
	finalOutput: unknown;
	totalStepsExecuted: number;
	failedSteps: string[];
}

/**
 * Result from a single phase execution.
 */
export interface PhaseResult {
	phaseId: string;
	phaseName: string;
	success: boolean;
	stepResults: ExecuteStepOutput[];
	durationMs: number;
}

/**
 * Executes an enhanced plan using its selected strategy.
 *
 * This executor:
 * 1. Processes phases in order
 * 2. Handles parallel step execution within phases
 * 3. Maintains context flow between steps
 * 4. Reports progress via callbacks
 */
export async function executeStrategy(
	input: ExecuteStrategyInput,
): Promise<ExecuteStrategyOutput> {
	const { plan, originalTask, userId, organizationId } = input;

	console.log("[Orchestrator] Starting strategy execution", {
		strategy: plan.strategy,
		phaseCount: plan.phases.length,
		estimatedSteps: plan.estimatedSteps,
	});

	// Initialize context bag
	const contextBag = input.initialContext || createContextBag();
	const phaseResults: PhaseResult[] = [];
	const failedSteps: string[] = [];
	let totalStepsExecuted = 0;

	// Build execution context with defaults
	const execContext: StepExecutionContext = {
		systemPrompt: input.systemPrompt || "You are a helpful AI assistant.",
		executionMode: input.executionMode || "balanced",
		altkConfig: input.altkConfig,
		enabledMcpConfigIds: input.enabledMcpConfigIds,
		enabledAgentIds: input.enabledAgentIds,
		lettaAgentId: input.lettaAgentId,
		conversationHistory: input.conversationHistory,
		totalSteps: plan.estimatedSteps,
		previousStepResults: [],
	};

	// Execute each phase
	for (const phase of plan.phases) {
		const phaseStart = Date.now();

		input.onPhaseStart?.(phase);

		console.log(`[Orchestrator] Starting phase: ${phase.name}`);

		const stepResults = await executePhase({
			phase,
			contextBag,
			originalTask,
			userId,
			organizationId,
			parallelizable: isParallelizableStrategy(plan.strategy),
			parallelGroups: plan.parallelizableGroups,
			stepStartIndex: totalStepsExecuted,
			execContext,
			onStepStart: input.onStepStart,
			onStepComplete: input.onStepComplete,
		});

		// Update phase status
		const phaseSuccess = stepResults.every(
			(r) => r.status === "completed" || r.status === "partial",
		);

		// Track failed steps
		for (const result of stepResults) {
			if (result.status === "failed") {
				const step = phase.steps.find((s) => s.id === result.stepId);
				if (step) {
					failedSteps.push(step.id);
				}
			}
		}

		totalStepsExecuted += stepResults.length;

		phaseResults.push({
			phaseId: phase.id,
			phaseName: phase.name,
			success: phaseSuccess,
			stepResults,
			durationMs: Date.now() - phaseStart,
		});

		input.onPhaseComplete?.(phase, stepResults);

		console.log(`[Orchestrator] Phase complete: ${phase.name}`, {
			success: phaseSuccess,
			stepCount: stepResults.length,
			durationMs: Date.now() - phaseStart,
		});

		// If phase failed critically, we might want to stop
		if (!phaseSuccess && shouldStopOnFailure(phase, plan.strategy)) {
			console.warn(
				`[Orchestrator] Stopping execution due to phase failure: ${phase.name}`,
			);
			break;
		}
	}

	// Extract final output from the last successful step
	const finalOutput = extractFinalOutput(phaseResults, contextBag);

	const overallSuccess = phaseResults.every((p) => p.success);

	console.log("[Orchestrator] Strategy execution complete", {
		success: overallSuccess,
		phasesExecuted: phaseResults.length,
		totalSteps: totalStepsExecuted,
		failedSteps: failedSteps.length,
	});

	return {
		success: overallSuccess,
		finalContext: contextBag,
		phaseResults,
		finalOutput,
		totalStepsExecuted,
		failedSteps,
	};
}

/**
 * Input for phase execution.
 */
interface ExecutePhaseInput {
	phase: TaskPhase;
	contextBag: ContextBag;
	originalTask: string;
	userId: string;
	organizationId?: string;
	parallelizable: boolean;
	parallelGroups: string[][];
	stepStartIndex: number;
	execContext: StepExecutionContext;
	onStepStart?: (step: TaskStep) => void;
	onStepComplete?: (step: TaskStep, result: ExecuteStepOutput) => void;
}

/**
 * Executes all steps in a phase.
 */
async function executePhase(
	input: ExecutePhaseInput,
): Promise<ExecuteStepOutput[]> {
	const {
		phase,
		contextBag,
		originalTask,
		userId,
		organizationId,
		parallelizable,
		parallelGroups,
		stepStartIndex,
		execContext,
	} = input;

	const results: ExecuteStepOutput[] = [];
	let currentStepIndex = stepStartIndex;

	// Group steps by parallel group
	const stepsByGroup = groupStepsByParallelGroup(phase.steps, parallelGroups);

	for (const group of stepsByGroup) {
		if (parallelizable && group.length > 1) {
			// Execute group in parallel
			const parallelResults = await executeStepsInParallel(
				group,
				contextBag,
				originalTask,
				userId,
				organizationId,
				currentStepIndex,
				execContext,
				input.onStepStart,
				input.onStepComplete,
			);
			results.push(...parallelResults);
			currentStepIndex += group.length;
		} else {
			// Execute sequentially
			for (const step of group) {
				const result = await executeSingleStep(
					step,
					contextBag,
					originalTask,
					userId,
					organizationId,
					currentStepIndex,
					execContext,
					input.onStepStart,
					input.onStepComplete,
				);
				results.push(result);
				currentStepIndex++;
			}
		}
	}

	return results;
}

/**
 * Groups steps by their parallel group.
 */
function groupStepsByParallelGroup(
	steps: TaskStep[],
	parallelGroups: string[][],
): TaskStep[][] {
	const groups: TaskStep[][] = [];
	const processedSteps = new Set<string>();

	// First, add steps that belong to parallel groups
	for (const parallelGroup of parallelGroups) {
		const groupSteps = steps.filter(
			(s) => s.parallelGroup && parallelGroup.includes(s.id),
		);

		if (groupSteps.length > 0) {
			groups.push(groupSteps);
			for (const step of groupSteps) {
				processedSteps.add(step.id);
			}
		}
	}

	// Then, add remaining steps as individual groups (sequential)
	for (const step of steps) {
		if (!processedSteps.has(step.id)) {
			groups.push([step]);
		}
	}

	return groups;
}

/**
 * Additional context for step execution.
 */
interface StepExecutionContext {
	systemPrompt: string;
	executionMode: "fast" | "balanced" | "accurate" | "save_reuse";
	altkConfig?: ALTKConfig;
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
	lettaAgentId?: string | null;
	conversationHistory?: Array<{
		role: "user" | "assistant" | "system";
		content: string;
	}>;
	totalSteps: number;
	previousStepResults: Array<{
		stepId: string;
		stepDescription: string;
		response?: string;
	}>;
}

/**
 * Executes multiple steps in parallel.
 */
async function executeStepsInParallel(
	steps: TaskStep[],
	contextBag: ContextBag,
	originalTask: string,
	userId: string,
	organizationId: string | undefined,
	stepIndex: number,
	execContext: StepExecutionContext,
	onStepStart?: (step: TaskStep) => void,
	onStepComplete?: (step: TaskStep, result: ExecuteStepOutput) => void,
): Promise<ExecuteStepOutput[]> {
	console.log(`[Orchestrator] Executing ${steps.length} steps in parallel`);

	const promises = steps.map((step, idx) =>
		executeSingleStep(
			step,
			contextBag,
			originalTask,
			userId,
			organizationId,
			stepIndex + idx,
			execContext,
			onStepStart,
			onStepComplete,
		),
	);

	return Promise.all(promises);
}

/**
 * Executes a single step by building proper ExecuteStepInput.
 */
async function executeSingleStep(
	step: TaskStep,
	contextBag: ContextBag,
	originalTask: string,
	userId: string,
	organizationId: string | undefined,
	stepIndex: number,
	execContext: StepExecutionContext,
	onStepStart?: (step: TaskStep) => void,
	onStepComplete?: (step: TaskStep, result: ExecuteStepOutput) => void,
): Promise<ExecuteStepOutput> {
	onStepStart?.(step);

	try {
		// Build context for this step
		const stepContext = formatContextForDelegation(
			contextBag,
			step,
			originalTask,
		);

		// Build the full ExecuteStepInput
		const stepInput: ExecuteStepInput = {
			step,
			message: `${originalTask}\n\n${stepContext}`,
			systemPrompt: execContext.systemPrompt,
			variables: contextBag.variables,
			userId,
			organizationId,
			enabledMcpConfigIds: execContext.enabledMcpConfigIds,
			enabledAgentIds: execContext.enabledAgentIds,
			executionMode: execContext.executionMode,
			altkConfig: execContext.altkConfig,
			totalSteps: execContext.totalSteps,
			stepIndex: stepIndex + 1, // 1-based
			previousStepResults: execContext.previousStepResults,
			lettaAgentId: execContext.lettaAgentId,
			conversationHistory: execContext.conversationHistory,
		};

		// Execute the step
		const result = await executeStep(stepInput);

		// Enhance result with step tracking
		const enhancedResult: ExecuteStepOutput = {
			...result,
			stepId: step.id,
			status: result.response ? "completed" : "partial",
		};

		// Update context bag with results
		updateContextBag(contextBag, step, enhancedResult);

		// Track this step result for future steps
		if (enhancedResult.response) {
			execContext.previousStepResults.push({
				stepId: step.id,
				stepDescription: step.description,
				response: enhancedResult.response,
			});
		}

		onStepComplete?.(step, enhancedResult);

		return enhancedResult;
	} catch (error) {
		console.error(
			`[Orchestrator] Step execution failed: ${step.id}`,
			error,
		);

		const failedResult: ExecuteStepOutput = {
			stepId: step.id,
			status: "failed",
			response: error instanceof Error ? error.message : String(error),
		};

		onStepComplete?.(step, failedResult);

		return failedResult;
	}
}

/**
 * Determines if execution should stop on phase failure.
 */
function shouldStopOnFailure(
	phase: TaskPhase,
	strategy: ExecutionStrategy,
): boolean {
	// For iterative-refinement, failures in review phase are expected
	if (strategy === "iterative-refinement" && phase.name.includes("review")) {
		return false;
	}

	// For direct-execution, any failure should stop
	if (strategy === "direct-execution") {
		return true;
	}

	// For research phases, we can continue with partial results
	if (phase.name.toLowerCase().includes("research")) {
		return false;
	}

	// For critical phases like generate or execute, stop on failure
	if (
		phase.name.toLowerCase().includes("generate") ||
		phase.name.toLowerCase().includes("execute")
	) {
		return true;
	}

	return false;
}

/**
 * Extracts the final output from phase results.
 */
function extractFinalOutput(
	phaseResults: PhaseResult[],
	contextBag: ContextBag,
): unknown {
	// Try to get from the last phase's last step
	for (let i = phaseResults.length - 1; i >= 0; i--) {
		const phase = phaseResults[i];
		if (phase.success && phase.stepResults.length > 0) {
			const lastResult = phase.stepResults[phase.stepResults.length - 1];
			if (lastResult.response) {
				return lastResult.response;
			}
		}
	}

	// Fall back to context bag artifacts
	if (contextBag.artifacts.outputs.length > 0) {
		return contextBag.artifacts.outputs[
			contextBag.artifacts.outputs.length - 1
		].content;
	}

	if (contextBag.artifacts.drafts.length > 0) {
		return contextBag.artifacts.drafts[
			contextBag.artifacts.drafts.length - 1
		].content;
	}

	// Fall back to synthesized context
	if (contextBag.synthesized.summary) {
		return contextBag.synthesized.summary;
	}

	return null;
}

/**
 * Creates a simple execution result for single-step strategies.
 */
export async function executeDirectStrategy(
	step: TaskStep,
	originalTask: string,
	userId: string,
	organizationId?: string,
	options?: {
		systemPrompt?: string;
		executionMode?: "fast" | "balanced" | "accurate" | "save_reuse";
		enabledMcpConfigIds?: string[] | null;
		enabledAgentIds?: string[] | null;
	},
): Promise<ExecuteStrategyOutput> {
	const contextBag = createContextBag();
	const startTime = Date.now();

	// Build minimal execution context for direct strategy
	const execContext: StepExecutionContext = {
		systemPrompt:
			options?.systemPrompt || "You are a helpful AI assistant.",
		executionMode: options?.executionMode || "fast",
		altkConfig: undefined, // No ALTK for direct strategy by default
		enabledMcpConfigIds: options?.enabledMcpConfigIds,
		enabledAgentIds: options?.enabledAgentIds,
		totalSteps: 1,
		previousStepResults: [],
	};

	const result = await executeSingleStep(
		step,
		contextBag,
		originalTask,
		userId,
		organizationId,
		0,
		execContext,
	);

	return {
		success: result.status === "completed",
		finalContext: contextBag,
		phaseResults: [
			{
				phaseId: "direct-execute",
				phaseName: "Execute",
				success: result.status === "completed",
				stepResults: [result],
				durationMs: Date.now() - startTime,
			},
		],
		finalOutput: result.response,
		totalStepsExecuted: 1,
		failedSteps: result.status === "failed" ? [step.id] : [],
	};
}

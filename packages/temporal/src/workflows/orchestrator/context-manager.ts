/**
 * Context Manager
 *
 * Manages context flow between orchestrator steps following industry best practices:
 * 1. Full context preservation - no truncation of important data
 * 2. Structured context aggregation from all sources
 * 3. Token budget awareness with intelligent summarization
 * 4. Artifact and output propagation
 */

import { CONTEXT, MAX_CONTEXT_CHARS, OUTPUT } from "./orchestrator-config";
import type {
	AgentVariable,
	OrchestratorStepResult,
	StepExecutionContext,
	WorkflowState,
} from "./types";

/**
 * Build comprehensive step execution context
 *
 * Industry best practice: Include ALL relevant context for each step:
 * - Previous step results with full responses (not truncated)
 * - Variables accumulated across steps
 * - Conversation history
 * - Workspace/RAG context
 * - Plan context (remaining steps)
 */
export function buildStepContext(
	state: WorkflowState,
	stepIndex: number,
	input: {
		message: string;
		history?: Array<{ role: string; content: string }>;
	},
): StepExecutionContext {
	const {
		taskPlan,
		stepResults,
		variables,
		workspaceContext,
		enrichedMessage,
		enrichedSystemPrompt,
	} = state;

	if (!taskPlan) {
		throw new Error("Cannot build step context: no task plan");
	}

	const currentStep = taskPlan.steps[stepIndex];
	const totalSteps = taskPlan.steps.length;

	// Build previous step results with full context
	const previousStepResults = stepResults.map((sr) => ({
		stepId: sr.stepId,
		stepDescription: sr.stepDescription,
		status: sr.status as "complete" | "error" | "skipped",
		response: sr.response,
		toolCalls: sr.toolCalls?.map((tc) => ({
			name: tc.name,
			args: tc.args,
			result: tc.result,
			status: tc.status,
		})),
		artifacts: sr.artifacts?.map((a) => ({
			id: a.id,
			type: a.type,
			name: a.name,
			content: a.content,
		})),
		// Extract key outputs from the step
		keyOutputs: extractKeyOutputs(sr),
	}));

	// Get remaining steps for plan context
	const remainingSteps = taskPlan.steps.slice(stepIndex + 1).map((s) => ({
		id: s.id,
		description: s.description,
		executor: s.executor,
	}));

	return {
		stepIndex,
		totalSteps,
		currentStep,
		previousStepResults,
		variables,
		conversationHistory: input.history,
		originalMessage: input.message,
		enrichedMessage,
		systemPrompt: enrichedSystemPrompt,
		workspaceContext: workspaceContext || undefined,
		remainingSteps,
	};
}

/**
 * Extract key outputs from a step result
 * These are the most important pieces of data that should be preserved
 */
function extractKeyOutputs(
	sr: OrchestratorStepResult,
): Record<string, unknown> {
	const keyOutputs: Record<string, unknown> = {};

	// Extract IDs, counts, and important values from tool results
	if (sr.toolCalls) {
		for (const tc of sr.toolCalls) {
			if (tc.status === "success" && tc.result) {
				const result = tc.result;

				// If result is an array, store the count and IDs
				if (Array.isArray(result)) {
					keyOutputs[`${tc.name}_count`] = result.length;
					keyOutputs[`${tc.name}_items`] = result
						.slice(0, OUTPUT.maxKeyOutputItems)
						.map((item: unknown) => {
							if (typeof item === "object" && item !== null) {
								const obj = item as Record<string, unknown>;
								return {
									id: obj.id,
									name: obj.name || obj.title,
									status: obj.status,
								};
							}
							return item;
						});
				}
				// If result is an object with id, store it
				else if (typeof result === "object" && result !== null) {
					const obj = result as Record<string, unknown>;
					if (obj.id) {
						keyOutputs[`${tc.name}_id`] = obj.id;
					}
					if (obj.name || obj.title) {
						keyOutputs[`${tc.name}_name`] = obj.name || obj.title;
					}
				}
			}
		}
	}

	return keyOutputs;
}

/**
 * Format context for step execution prompt
 * Converts StepExecutionContext into a structured prompt string
 */
export function formatContextForPrompt(context: StepExecutionContext): string {
	const sections: string[] = [];

	// Section 1: Task Overview
	sections.push(`=== TASK OVERVIEW ===
Original Request: ${context.originalMessage}
Current Step: ${context.stepIndex + 1} of ${context.totalSteps}
Step Description: ${context.currentStep.description}`);

	// Section 2: Previous Steps Context (most important for continuity)
	if (context.previousStepResults.length > 0) {
		const prevContext = formatPreviousSteps(context.previousStepResults);
		sections.push(`=== PREVIOUS STEPS COMPLETED ===
${prevContext}`);
	}

	// Section 3: Key Variables (accumulated state)
	const nonSystemVars = Object.entries(context.variables)
		.filter(([k]) => !k.startsWith("sys."))
		.map(([k, v]) => `- ${k}: ${formatVariableValue(v.value)}`);

	if (nonSystemVars.length > 0) {
		sections.push(`=== AVAILABLE DATA ===
${nonSystemVars.join("\n")}`);
	}

	// Section 4: Workspace Context (if available)
	if (context.workspaceContext) {
		sections.push(`=== WORKSPACE DOCUMENTS ===
${context.workspaceContext}`);
	}

	// Section 5: Remaining Steps (plan awareness)
	if (context.remainingSteps.length > 0) {
		const remaining = context.remainingSteps
			.map((s, i) => `${context.stepIndex + 2 + i}. ${s.description}`)
			.join("\n");
		sections.push(`=== UPCOMING STEPS ===
${remaining}`);
	}

	// Join sections and ensure we're within token budget
	let fullContext = sections.join("\n\n");

	if (fullContext.length > MAX_CONTEXT_CHARS) {
		fullContext = smartTruncateContext(fullContext, MAX_CONTEXT_CHARS);
	}

	return fullContext;
}

/**
 * Format previous step results for prompt
 * Preserves full responses for recent steps, summarizes older ones
 */
function formatPreviousSteps(
	steps: StepExecutionContext["previousStepResults"],
): string {
	const formatted: string[] = [];
	const recentCount = CONTEXT.recentStepsFull;

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const isRecent = i >= steps.length - recentCount;

		if (isRecent) {
			// Full details for recent steps
			let stepText = `Step ${i + 1}: ${step.stepDescription}
Status: ${step.status}`;

			if (step.response) {
				stepText += `\nResponse: ${step.response}`;
			}

			if (step.keyOutputs && Object.keys(step.keyOutputs).length > 0) {
				stepText += `\nKey Outputs: ${JSON.stringify(step.keyOutputs, null, 2)}`;
			}

			if (step.toolCalls && step.toolCalls.length > 0) {
				const toolSummary = step.toolCalls
					.map((tc) => `  - ${tc.name}: ${tc.status}`)
					.join("\n");
				stepText += `\nTools Used:\n${toolSummary}`;
			}

			formatted.push(stepText);
		} else {
			// Summary for older steps
			const keyInfo =
				step.keyOutputs && Object.keys(step.keyOutputs).length > 0
					? ` (${Object.keys(step.keyOutputs).join(", ")})`
					: "";
			formatted.push(
				`Step ${i + 1}: ${step.stepDescription} [${step.status}]${keyInfo}`,
			);
		}
	}

	return formatted.join("\n\n");
}

/**
 * Format variable value for display
 */
function formatVariableValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "null";
	}
	if (typeof value === "string") {
		return value.length > 200 ? `${value.slice(0, 200)}...` : value;
	}
	if (Array.isArray(value)) {
		return `[${value.length} items]`;
	}
	if (typeof value === "object") {
		const str = JSON.stringify(value);
		return str.length > 200 ? `${str.slice(0, 200)}...` : str;
	}
	return String(value);
}

/**
 * Smart truncation that preserves most important context.
 *
 * Issue #8: After selecting sections by priority budget, sort them back
 * to their original order so the output reads naturally (TASK OVERVIEW
 * always appears before PREVIOUS STEPS, etc.).
 */
function smartTruncateContext(context: string, maxChars: number): string {
	if (context.length <= maxChars) {
		return context;
	}

	// Split into sections
	const sections = context.split(/\n===\s+/);

	// Priority order for sections (higher = keep more)
	const priorities: Record<string, number> = {
		"TASK OVERVIEW": 5,
		"PREVIOUS STEPS": 4,
		"AVAILABLE DATA": 3,
		"WORKSPACE DOCUMENTS": 2,
		"UPCOMING STEPS": 1,
	};

	// Tag sections with priority and original index
	const taggedSections = sections.map((section, idx) => {
		const firstLine = section.split("\n")[0] || "";
		const priority =
			Object.entries(priorities).find(([key]) =>
				firstLine.toUpperCase().includes(key),
			)?.[1] || 0;
		const prefix = idx === 0 ? "" : "=== ";
		const sectionText = prefix + section;
		return { sectionText, priority, idx };
	});

	// Sort by priority (descending) to decide which sections fit in the budget
	const byPriority = [...taggedSections].sort(
		(a, b) => b.priority - a.priority,
	);

	// Select sections that fit within the budget
	const selected: typeof taggedSections = [];
	let remaining = maxChars;

	for (const entry of byPriority) {
		if (entry.sectionText.length <= remaining) {
			selected.push(entry);
			remaining -= entry.sectionText.length + 2; // +2 for \n\n separator
		} else if (remaining > 500) {
			// Truncate this section to fill remaining space
			selected.push({
				...entry,
				sectionText:
					entry.sectionText.slice(0, remaining - 50) +
					"\n[truncated]",
			});
			break;
		}
	}

	// Sort selected sections back to their ORIGINAL order
	selected.sort((a, b) => a.idx - b.idx);

	return selected.map((s) => s.sectionText).join("\n\n");
}

/**
 * Update variables with step outputs
 * Ensures proper propagation of data between steps
 */
export function updateVariablesFromStep(
	variables: Record<string, AgentVariable>,
	stepId: string,
	outputs: Record<string, unknown> | undefined,
	response: string | undefined,
): Record<string, AgentVariable> {
	const updated = { ...variables };
	const timestamp = new Date().toISOString();

	// Store step response
	if (response) {
		updated[`step.${stepId}.response`] = {
			name: `step.${stepId}.response`,
			value: response,
			setBy: stepId,
			setAt: timestamp,
			scope: "workflow",
		};
	}

	// Store step outputs
	if (outputs) {
		for (const [key, value] of Object.entries(outputs)) {
			// Skip internal keys
			if (key === "response" || key === "toolResults") {
				continue;
			}

			updated[`step.${stepId}.${key}`] = {
				name: `step.${stepId}.${key}`,
				value,
				setBy: stepId,
				setAt: timestamp,
				scope: "workflow",
			};

			// Also store with simpler key for easy access
			if (!updated[key] || updated[key].setBy !== "system") {
				updated[key] = {
					name: key,
					value,
					setBy: stepId,
					setAt: timestamp,
					scope: "workflow",
				};
			}
		}
	}

	return updated;
}

/**
 * Merge step result variables into state
 */
export function mergeStepVariables(
	state: WorkflowState,
	stepVariables: Record<string, AgentVariable> | undefined,
): void {
	if (!stepVariables) {
		return;
	}

	for (const [key, value] of Object.entries(stepVariables)) {
		state.variables[key] = value;
	}
}

/**
 * Get summary of current context for logging/debugging
 */
export function getContextSummary(state: WorkflowState): {
	variableCount: number;
	stepResultCount: number;
	toolCallCount: number;
	hasWorkspaceContext: boolean;
	hasLettaMemory: boolean;
} {
	return {
		variableCount: Object.keys(state.variables).filter(
			(k) => !k.startsWith("sys."),
		).length,
		stepResultCount: state.stepResults.length,
		toolCallCount: state.toolCalls.length,
		hasWorkspaceContext: !!state.workspaceContext,
		hasLettaMemory: !!state.lettaAgentId,
	};
}

/**
 * Build delegation message with full context
 * Used when delegating to agents
 */
export function buildContextualDelegationMessage(
	context: StepExecutionContext,
): string {
	const parts: string[] = [];

	// Task description
	parts.push(`Task: ${context.currentStep.description}`);

	// Context from previous steps
	if (context.previousStepResults.length > 0) {
		const prevContext = context.previousStepResults
			.filter((s) => s.status === "complete" && s.response)
			.map((s) => `Previous: ${s.stepDescription}\nResult: ${s.response}`)
			.join("\n\n");

		if (prevContext) {
			parts.push(`\nContext from previous steps:\n${prevContext}`);
		}
	}

	// Available data
	const dataVars = Object.entries(context.variables)
		.filter(([k]) => k.startsWith("tool.") || k.startsWith("step."))
		.slice(0, 10);

	if (dataVars.length > 0) {
		const dataContext = dataVars
			.map(([k, v]) => `${k}: ${formatVariableValue(v.value)}`)
			.join("\n");
		parts.push(`\nAvailable data:\n${dataContext}`);
	}

	// Original request for context
	if (context.originalMessage !== context.currentStep.description) {
		parts.push(`\nOriginal user request: ${context.originalMessage}`);
	}

	return parts.join("\n");
}

/**
 * Context Bag Utilities
 *
 * The ContextBag is the structured container for all context
 * that flows through an orchestrator execution. It accumulates
 * research, synthesized context, and artifacts as steps execute.
 */

import type {
	AgentVariable,
	ContextBag,
	ExecuteStepOutput,
	ExecutionArtifact,
	ResearchResult,
	SynthesizedContext,
	TaskStep,
} from "../types";

/**
 * Creates a new empty ContextBag, optionally with inherited variables.
 */
export function createContextBag(
	inheritedVariables?: Record<string, AgentVariable>,
): ContextBag {
	return {
		research: {
			webSearchResults: [],
			workspaceExtracts: [],
			agentResponses: [],
			toolOutputs: [],
		},
		synthesized: {
			summary: "",
			keyFacts: [],
			requirements: [],
			constraints: [],
			recommendations: [],
			openQuestions: [],
		},
		artifacts: {
			drafts: [],
			reviews: [],
			outputs: [],
		},
		variables: inheritedVariables ? { ...inheritedVariables } : {},
	};
}

/**
 * Updates the ContextBag with results from a step execution.
 *
 * This function:
 * - Merges new variables
 * - Categorizes outputs into appropriate artifact types
 * - Tracks tool outputs for reference
 */
export function updateContextBag(
	contextBag: ContextBag,
	step: TaskStep,
	result: ExecuteStepOutput,
): void {
	// Update variables
	if (result.variables) {
		for (const [key, value] of Object.entries(result.variables)) {
			contextBag.variables[key] = value;
		}
	}

	// Track tool outputs
	if (result.toolCalls) {
		for (const toolCall of result.toolCalls) {
			if (toolCall.status === "success") {
				contextBag.research.toolOutputs.push({
					toolName: toolCall.name,
					args: toolCall.args,
					output: toolCall.result,
				});
			}
		}
	}

	// Categorize into artifacts based on step type
	if (result.response) {
		const artifact: ExecutionArtifact = {
			id: `artifact-${step.id}-${Date.now()}`,
			name: step.description,
			content: result.response,
			stepId: step.id,
		};

		switch (step.type) {
			case "generate":
				artifact.type = "draft";
				contextBag.artifacts.drafts.push(artifact);
				break;
			case "verify":
				artifact.type = "review";
				contextBag.artifacts.reviews.push(artifact);
				break;
			default:
				artifact.type = "output";
				contextBag.artifacts.outputs.push(artifact);
				break;
		}
	}
}

/**
 * Gets relevant context for a specific step based on its requirements.
 *
 * Steps can declare what context they need via step.inputs.contextInputs.
 */
export function getRelevantContext(
	contextBag: ContextBag,
	step: TaskStep,
): {
	summary: string;
	keyFacts: string[];
	relevantArtifacts: ExecutionArtifact[];
	relevantVariables: Record<string, unknown>;
} {
	const contextInputs =
		(step.inputs as { contextInputs?: string[] })?.contextInputs || [];

	// Get relevant artifacts
	let relevantArtifacts: ExecutionArtifact[] = [];

	if (
		contextInputs.includes("drafts") ||
		contextInputs.includes("artifacts.drafts")
	) {
		relevantArtifacts = [
			...relevantArtifacts,
			...contextBag.artifacts.drafts,
		];
	}

	if (
		contextInputs.includes("reviews") ||
		contextInputs.includes("artifacts.reviews")
	) {
		relevantArtifacts = [
			...relevantArtifacts,
			...contextBag.artifacts.reviews,
		];
	}

	// If no specific inputs requested, provide latest draft for review steps
	if (relevantArtifacts.length === 0 && step.type === "verify") {
		const latestDraft =
			contextBag.artifacts.drafts[contextBag.artifacts.drafts.length - 1];
		if (latestDraft) {
			relevantArtifacts = [latestDraft];
		}
	}

	// Get relevant variables
	const relevantVariables: Record<string, unknown> = {};
	for (const input of contextInputs) {
		if (input.startsWith("variables.") || input.startsWith("var.")) {
			const varName = input.replace(/^(variables\.|var\.)/, "");
			if (contextBag.variables[varName]) {
				relevantVariables[varName] =
					contextBag.variables[varName].value;
			}
		}
	}

	return {
		summary: contextBag.synthesized.summary,
		keyFacts: contextBag.synthesized.keyFacts,
		relevantArtifacts,
		relevantVariables,
	};
}

/**
 * Formats the ContextBag into a string suitable for agent delegation.
 *
 * This creates a structured markdown document with all relevant context.
 */
export function formatContextForDelegation(
	contextBag: ContextBag,
	step: TaskStep,
	originalTask: string,
): string {
	const sections: string[] = [];

	// Original task
	sections.push(`## Task\n${originalTask}`);

	// Current step
	sections.push(`## Current Step\n${step.description}`);

	// Synthesized context
	if (contextBag.synthesized.summary) {
		sections.push(`## Context Summary\n${contextBag.synthesized.summary}`);
	}

	// Key facts
	if (contextBag.synthesized.keyFacts.length > 0) {
		sections.push(
			`## Key Facts\n${contextBag.synthesized.keyFacts.map((f) => `- ${f}`).join("\n")}`,
		);
	}

	// Requirements
	if (contextBag.synthesized.requirements.length > 0) {
		sections.push(
			`## Requirements\n${contextBag.synthesized.requirements.map((r) => `- ${r}`).join("\n")}`,
		);
	}

	// Constraints
	if (contextBag.synthesized.constraints.length > 0) {
		sections.push(
			`## Constraints\n${contextBag.synthesized.constraints.map((c) => `- ${c}`).join("\n")}`,
		);
	}

	// Recommendations
	if (contextBag.synthesized.recommendations.length > 0) {
		sections.push(
			`## Recommendations\n${contextBag.synthesized.recommendations.map((r) => `- ${r}`).join("\n")}`,
		);
	}

	// Previous drafts (if reviewing)
	if (step.type === "verify" && contextBag.artifacts.drafts.length > 0) {
		const latestDraft =
			contextBag.artifacts.drafts[contextBag.artifacts.drafts.length - 1];
		const draftContent = String(latestDraft.content);
		const truncatedContent =
			draftContent.length > 3000
				? `${draftContent.substring(0, 3000)}...\n\n[Content truncated for brevity]`
				: draftContent;
		sections.push(`## Draft to Review\n${truncatedContent}`);
	}

	// Relevant variables
	const relevantVars = Object.entries(contextBag.variables)
		.filter(([key]) => !key.startsWith("sys."))
		.slice(0, 10);

	if (relevantVars.length > 0) {
		const varList = relevantVars
			.map(([key, val]) => `- ${key}: ${formatVariableValue(val.value)}`)
			.join("\n");
		sections.push(`## Context Variables\n${varList}`);
	}

	return sections.join("\n\n");
}

/**
 * Format a variable value for display.
 */
function formatVariableValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "(empty)";
	}
	if (typeof value === "string") {
		return value.length > 100 ? `${value.substring(0, 100)}...` : value;
	}
	if (typeof value === "object") {
		const str = JSON.stringify(value);
		return str.length > 100 ? `${str.substring(0, 100)}...` : str;
	}
	return String(value);
}

/**
 * Adds research results to the context bag.
 */
export function addResearchResults(
	contextBag: ContextBag,
	results: ResearchResult[],
): void {
	contextBag.research.webSearchResults.push(...results);
}

/**
 * Updates the synthesized context.
 */
export function setSynthesizedContext(
	contextBag: ContextBag,
	synthesized: SynthesizedContext,
): void {
	contextBag.synthesized = synthesized;
}

/**
 * Checks if the context bag has meaningful research.
 */
export function hasResearch(contextBag: ContextBag): boolean {
	return (
		contextBag.research.webSearchResults.length > 0 ||
		contextBag.research.workspaceExtracts.length > 0 ||
		contextBag.research.agentResponses.length > 0
	);
}

/**
 * Checks if the context bag has synthesized context.
 */
export function hasSynthesizedContext(contextBag: ContextBag): boolean {
	return (
		contextBag.synthesized.summary.length > 0 ||
		contextBag.synthesized.keyFacts.length > 0
	);
}

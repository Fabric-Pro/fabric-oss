/**
 * Goal Step Execution Activity
 *
 * Executes a single step from the goal-oriented plan.
 * Uses the shared agent executor for tool calling.
 */

import type {
	AgentVariable,
	ExecutedStep,
	TaskStep,
} from "../../workflows/goal-oriented-agent/types";
import { executeAgentTurn } from "../agent-execution-core";

export interface ExecuteGoalStepInput {
	step: TaskStep;
	systemPrompt: string;
	knowledgeContext?: string;
	variables: Record<string, AgentVariable>;
	previousStepResults: ExecutedStep[];
	userId: string;
	organizationId?: string;
	mcpConfigIds: string[];
	model: string;
	/** Execution ID for real-time event publishing via Redis */
	executionId?: string;
	/** Optional image references for multimodal input */
	imageRefs?: Array<{
		storagePath: string;
		mimeType: string;
		name: string;
	}>;
}

export interface ExecuteGoalStepOutput {
	response: string;
	outputs: Record<string, unknown>;
	variables?: Record<string, AgentVariable>;
	toolCalls?: Array<{
		name: string;
		args: Record<string, unknown>;
		result?: unknown;
		status: "success" | "error";
	}>;
	artifacts?: Array<{
		id: string;
		type: string;
		name?: string;
	}>;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export async function executeGoalStep(
	input: ExecuteGoalStepInput,
): Promise<ExecuteGoalStepOutput> {
	const {
		step,
		systemPrompt,
		knowledgeContext,
		variables,
		previousStepResults,
		userId,
		organizationId,
		mcpConfigIds,
		model,
		executionId,
		imageRefs,
	} = input;

	console.log("[GoalStepExecution] Executing step", {
		stepId: step.id,
		description: step.description.slice(0, 100),
		type: step.type,
	});

	// Build context from previous steps
	const previousContext = buildPreviousStepsContext(previousStepResults);

	// Build variables context
	const variablesContext = buildVariablesContext(variables);

	// Build the step execution prompt
	const stepPrompt = `## Current Task
${step.description}

${previousContext ? `## Previous Steps Completed\n${previousContext}` : ""}

${variablesContext ? `## Available Data\n${variablesContext}` : ""}

${step.inputs ? `## Step Inputs\n${JSON.stringify(step.inputs, null, 2)}` : ""}

Please complete this task. Use the available tools if needed.
If this task requires specific data from previous steps, it should be available in the variables above.`;

	// Execute using the shared agent executor
	const result = await executeAgentTurn({
		systemPrompt: `${systemPrompt}\n\nYou are executing a specific step in a goal-oriented plan.`,
		userMessage: stepPrompt,
		knowledgeContext,
		mcpConfigIds,
		model,
		userId,
		organizationId,
		maxIterations: 5, // Limit iterations per step
		executionId,
		imageRefs,
	});

	if (!result.success) {
		throw new Error(result.error || "Step execution failed");
	}

	// Extract outputs from the response
	// Note: step.outputs in TaskStep is Record<string, unknown> for previous outputs
	// We pass undefined since extractOutputs expects optional string[] for expected output names
	const outputs = extractOutputs(result.response);

	// Convert tool calls to the expected format
	const toolCalls = result.toolCalls.map((tc) => ({
		name: tc.name,
		args: tc.args,
		result: tc.result,
		status: tc.status as "success" | "error",
	}));

	// Build variables from outputs
	const newVariables: Record<string, AgentVariable> = {};
	for (const [key, value] of Object.entries(outputs)) {
		newVariables[`step.${step.id}.${key}`] = {
			name: `step.${step.id}.${key}`,
			value,
			setBy: step.id,
			setAt: new Date().toISOString(),
			scope: "step",
		};
	}

	// Also store the raw response
	newVariables[`step.${step.id}.response`] = {
		name: `step.${step.id}.response`,
		value: result.response,
		setBy: step.id,
		setAt: new Date().toISOString(),
		scope: "step",
	};

	console.log("[GoalStepExecution] Step completed", {
		stepId: step.id,
		toolCalls: toolCalls.length,
		outputKeys: Object.keys(outputs),
	});

	return {
		response: result.response,
		outputs,
		variables: newVariables,
		toolCalls,
		tokenUsage: result.tokenUsage,
	};
}

function buildPreviousStepsContext(previousSteps: ExecutedStep[]): string {
	if (previousSteps.length === 0) {
		return "";
	}

	const completedSteps = previousSteps.filter(
		(s) => s.status === "completed",
	);
	if (completedSteps.length === 0) {
		return "";
	}

	return completedSteps
		.map((step, index) => {
			let stepContext = `### Step ${index + 1}: ${step.description}\n`;
			stepContext += `Status: ${step.status}\n`;

			if (step.toolCalls?.length) {
				const successfulTools = step.toolCalls.filter(
					(t) => t.status === "success",
				);
				if (successfulTools.length > 0) {
					stepContext += `Tools used: ${successfulTools.map((t) => t.name).join(", ")}\n`;
				}
			}

			return stepContext;
		})
		.join("\n");
}

function buildVariablesContext(
	variables: Record<string, AgentVariable>,
): string {
	const relevantVars = Object.entries(variables).filter(
		([key]) => key.startsWith("step.") || !key.startsWith("sys."),
	);

	if (relevantVars.length === 0) {
		return "";
	}

	return relevantVars
		.map(([key, v]) => {
			const value =
				typeof v.value === "string"
					? v.value.slice(0, 500)
					: JSON.stringify(v.value).slice(0, 500);
			return `- **${key}**: ${value}`;
		})
		.join("\n");
}

function extractOutputs(
	response: string,
	expectedOutputs?: string[],
): Record<string, unknown> {
	const outputs: Record<string, unknown> = {};

	// Always include the raw response
	outputs.rawResponse = response;

	// Try to extract structured data if the response contains JSON
	const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			if (typeof parsed === "object" && parsed !== null) {
				Object.assign(outputs, parsed);
			}
		} catch {
			// Not valid JSON, continue
		}
	}

	// Try to match expected outputs by looking for patterns
	if (expectedOutputs && Array.isArray(expectedOutputs)) {
		for (const outputName of expectedOutputs) {
			const pattern = new RegExp(`${outputName}[:\\s]+([^\\n]+)`, "i");
			const match = response.match(pattern);
			if (match) {
				outputs[outputName] = match[1].trim();
			}
		}
	}

	return outputs;
}

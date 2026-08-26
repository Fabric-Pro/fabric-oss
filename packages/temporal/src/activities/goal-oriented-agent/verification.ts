/**
 * Goal Verification Activity
 *
 * Verifies whether the goal has been achieved based on:
 * - LLM judge evaluation
 * - Output pattern matching
 * - Tool success requirements
 */

import { generateObject } from "@repo/ai";
import { z } from "zod";
import type {
	AgentVariable,
	ExecutedStep,
	GoalVerificationResult,
	SuccessCriteria,
} from "../../workflows/goal-oriented-agent/types";
import { getAiModel } from "../orchestrator/utils/model-selector";

export interface VerifyGoalInput {
	goal: string;
	successCriteria: SuccessCriteria;
	executedSteps: ExecutedStep[];
	accumulatedResponse: string;
	variables: Record<string, AgentVariable>;
	userId: string;
	organizationId?: string;
}

const VerificationResultSchema = z.object({
	achieved: z.boolean().describe("Whether the goal has been achieved"),
	confidence: z.number().min(0).max(1).describe("Confidence level (0-1)"),
	reasoning: z.string().describe("Detailed explanation of the assessment"),
	missingCriteria: z
		.array(z.string())
		.optional()
		.describe("What criteria are not yet met"),
	suggestions: z
		.array(z.string())
		.optional()
		.describe("Suggestions for achieving the goal if not met"),
});

export async function verifyGoalAchievement(
	input: VerifyGoalInput,
): Promise<GoalVerificationResult> {
	const {
		goal,
		successCriteria,
		executedSteps,
		accumulatedResponse,
		variables,
		userId,
		organizationId,
	} = input;

	console.log("[GoalVerification] Verifying goal achievement", {
		goal: goal.slice(0, 100),
		criteriaType: successCriteria.type,
		stepsExecuted: executedSteps.length,
	});

	// Handle different verification strategies
	switch (successCriteria.type) {
		case "output_contains":
			return verifyOutputContains(
				successCriteria,
				accumulatedResponse,
				executedSteps,
			);

		case "tool_success":
			return verifyToolSuccess(successCriteria, executedSteps);
		default:
			return verifyWithLlmJudge(
				goal,
				successCriteria,
				executedSteps,
				accumulatedResponse,
				variables,
				userId,
				organizationId,
			);
	}
}

async function verifyWithLlmJudge(
	goal: string,
	successCriteria: SuccessCriteria,
	executedSteps: ExecutedStep[],
	accumulatedResponse: string,
	variables: Record<string, AgentVariable>,
	userId: string,
	organizationId?: string,
): Promise<GoalVerificationResult> {
	const model = await getAiModel(userId, organizationId);

	// Build execution summary
	const executionSummary = buildExecutionSummary(executedSteps);

	// Build variables summary (excluding system vars)
	const variablesSummary = Object.entries(variables)
		.filter(([key]) => !key.startsWith("sys."))
		.map(([key, v]) => `- ${key}: ${formatValue(v.value)}`)
		.join("\n");

	const evaluationPrompt = successCriteria.evaluationPrompt
		? `## Custom Evaluation Criteria\n${successCriteria.evaluationPrompt}`
		: "";

	const prompt = `You are evaluating whether a goal has been achieved.

## Goal
${goal}

${evaluationPrompt}

## Steps Executed
${executionSummary}

## Accumulated Output
${accumulatedResponse.slice(0, 5000)}

${variablesSummary ? `## Variables/Data Collected\n${variablesSummary}` : ""}

## Instructions
Evaluate whether the goal has been achieved based on:
1. Were all necessary steps completed successfully?
2. Does the output/result match what the goal required?
3. Is there any critical information missing?

Be strict but fair. If the core objective is met, consider it achieved even if there are minor issues.`;

	const result = await generateObject({
		model,
		schema: VerificationResultSchema,
		prompt,
	});

	const verification = result.object;

	// Apply confidence threshold
	const confidenceThreshold = successCriteria.confidenceThreshold || 0.8;
	const achieved =
		verification.achieved && verification.confidence >= confidenceThreshold;

	console.log("[GoalVerification] LLM judge result", {
		achieved,
		confidence: verification.confidence,
		threshold: confidenceThreshold,
	});

	return {
		achieved,
		confidence: verification.confidence,
		reasoning: verification.reasoning,
		suggestions: verification.suggestions,
		missingCriteria: verification.missingCriteria,
	};
}

function verifyOutputContains(
	successCriteria: SuccessCriteria,
	accumulatedResponse: string,
	executedSteps: ExecutedStep[],
): GoalVerificationResult {
	const requiredOutputs = successCriteria.requiredOutputs || [];

	if (requiredOutputs.length === 0) {
		return {
			achieved: true,
			confidence: 1,
			reasoning: "No required outputs specified",
		};
	}

	const responseLower = accumulatedResponse.toLowerCase();
	const missingOutputs: string[] = [];

	for (const required of requiredOutputs) {
		if (!responseLower.includes(required.toLowerCase())) {
			missingOutputs.push(required);
		}
	}

	// Also check tool results
	for (const step of executedSteps) {
		if (step.toolCalls) {
			for (const toolCall of step.toolCalls) {
				if (toolCall.result) {
					const resultStr = JSON.stringify(
						toolCall.result,
					).toLowerCase();
					for (const required of [...missingOutputs]) {
						if (resultStr.includes(required.toLowerCase())) {
							missingOutputs.splice(
								missingOutputs.indexOf(required),
								1,
							);
						}
					}
				}
			}
		}
	}

	const achieved = missingOutputs.length === 0;
	const confidence = 1 - missingOutputs.length / requiredOutputs.length;

	return {
		achieved,
		confidence,
		reasoning: achieved
			? "All required outputs found"
			: `Missing outputs: ${missingOutputs.join(", ")}`,
		missingCriteria: achieved ? undefined : missingOutputs,
		suggestions: achieved
			? undefined
			: [
					`Include the following in the output: ${missingOutputs.join(", ")}`,
				],
	};
}

function verifyToolSuccess(
	successCriteria: SuccessCriteria,
	executedSteps: ExecutedStep[],
): GoalVerificationResult {
	const requiredTools = successCriteria.requiredTools || [];

	if (requiredTools.length === 0) {
		return {
			achieved: true,
			confidence: 1,
			reasoning: "No required tools specified",
		};
	}

	// Collect all successful tool calls
	const successfulTools = new Set<string>();
	for (const step of executedSteps) {
		if (step.toolCalls) {
			for (const toolCall of step.toolCalls) {
				if (toolCall.status === "success") {
					successfulTools.add(toolCall.name);
					// Also add without prefix for flexibility
					const shortName =
						toolCall.name.split("__").pop() || toolCall.name;
					successfulTools.add(shortName);
				}
			}
		}
	}

	const missingTools: string[] = [];
	for (const required of requiredTools) {
		const found =
			successfulTools.has(required) ||
			successfulTools.has(required.split("__").pop() || required);

		if (!found) {
			missingTools.push(required);
		}
	}

	const achieved = missingTools.length === 0;
	const confidence = 1 - missingTools.length / requiredTools.length;

	return {
		achieved,
		confidence,
		reasoning: achieved
			? "All required tools executed successfully"
			: `Missing tool executions: ${missingTools.join(", ")}`,
		missingCriteria: achieved ? undefined : missingTools,
		suggestions: achieved
			? undefined
			: [`Execute the following tools: ${missingTools.join(", ")}`],
	};
}

function buildExecutionSummary(executedSteps: ExecutedStep[]): string {
	if (executedSteps.length === 0) {
		return "No steps executed yet.";
	}

	return executedSteps
		.map((step, index) => {
			let summary = `### Step ${index + 1}: ${step.description}\n`;
			summary += `Status: ${step.status}\n`;

			if (step.durationMs) {
				summary += `Duration: ${step.durationMs}ms\n`;
			}

			if (step.toolCalls?.length) {
				summary += "Tool calls:\n";
				for (const tc of step.toolCalls) {
					summary += `  - ${tc.name}: ${tc.status}\n`;
				}
			}

			if (step.error) {
				summary += `Error: ${step.error}\n`;
			}

			return summary;
		})
		.join("\n");
}

function formatValue(value: unknown): string {
	if (typeof value === "string") {
		return value.length > 200 ? `${value.slice(0, 200)}...` : value;
	}
	const json = JSON.stringify(value);
	return json.length > 200 ? `${json.slice(0, 200)}...` : json;
}

/**
 * Completion Activity
 *
 * Updates the execution record when the goal-oriented workflow completes.
 */

import { type Prisma, updateExecutionStatus } from "@repo/database";

export interface CompleteGoalInput {
	executionId: string;
	status: "COMPLETED" | "FAILED" | "CANCELLED";
	goalAchieved: boolean;
	output?: Record<string, unknown>;
	error?: string;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
	durationMs: number;
}

export async function completeGoalExecution(
	input: CompleteGoalInput,
): Promise<void> {
	const {
		executionId,
		status,
		goalAchieved,
		output,
		error,
		tokenUsage,
		durationMs,
	} = input;

	console.log("[GoalCompletion] Completing goal execution", {
		executionId,
		status,
		goalAchieved,
		durationMs,
	});

	try {
		const outputData: Record<string, unknown> = {
			goalAchieved,
		};

		// Merge output if provided
		if (output && typeof output === "object") {
			Object.assign(outputData, output);
		}

		await updateExecutionStatus(executionId, status, {
			output: outputData as Prisma.InputJsonValue,
			error,
			completedAt: new Date(),
			duration: durationMs,
			inputTokens: tokenUsage?.inputTokens,
			outputTokens: tokenUsage?.outputTokens,
			totalCost: tokenUsage?.totalCost,
		});

		console.log("[GoalCompletion] Execution record updated", {
			executionId,
		});
	} catch (err) {
		console.error("[GoalCompletion] Failed to update execution status", {
			executionId,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

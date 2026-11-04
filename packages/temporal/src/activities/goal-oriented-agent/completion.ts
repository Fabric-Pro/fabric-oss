/**
 * Completion Activity
 *
 * Updates the execution record when the goal-oriented workflow completes.
 */

import { type Prisma, updateExecutionStatus } from "@repo/database";
import { ApplicationFailure } from "@temporalio/common";
import { prismaErrorCode } from "../../lib/database-error";
import { withHeartbeatTicker } from "../lib/activity-liveness";

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

/** Retry only the update-only projection; completed tool/model steps stay recorded. */
export function completeDurableGoalProjection(
	input: CompleteGoalInput,
): Promise<void> {
	return withHeartbeatTicker(
		async () => {
			try {
				await completeGoalExecution(input);
			} catch (error) {
				if (prismaErrorCode(error) === "P2025")
					throw ApplicationFailure.nonRetryable(
						"The execution row is unavailable; completed agent effects were retained in workflow history.",
						"SAVED_AGENT_EXECUTION_ROW_MISSING",
					);
				throw error;
			}
		},
		{ intervalMs: 5000, details: "saved-agent-goal-terminal-projection" },
	);
}

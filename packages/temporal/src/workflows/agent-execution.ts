/**
 * Agent Execution Workflow
 *
 * Durable workflow for executing agents with automatic retries.
 * Follows the pattern from chat-title-generation.ts.
 */

import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/agent-execution";

const { executeAgent, updateAgentTaskStatus } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

export interface AgentExecutionInput {
	taskId: string;
	agentName: string;
	userId: string;
	organizationId?: string;
	input: Record<string, any>;
}

export interface AgentExecutionOutput {
	taskId: string;
	status: "COMPLETED" | "FAILED";
	result?: Record<string, any>;
	error?: string;
}

/**
 * Execute an agent with durability and automatic retries
 */
export async function agentExecutionWorkflow(
	input: AgentExecutionInput,
): Promise<AgentExecutionOutput> {
	try {
		// Update status to RUNNING
		await updateAgentTaskStatus({
			id: input.taskId,
			status: "RUNNING",
		});

		// Execute the agent
		const result = await executeAgent({
			agentName: input.agentName,
			userId: input.userId,
			organizationId: input.organizationId,
			input: input.input,
		});

		// Update status to COMPLETED
		await updateAgentTaskStatus({
			id: input.taskId,
			status: "COMPLETED",
			result,
			completedAt: new Date(),
		});

		return {
			taskId: input.taskId,
			status: "COMPLETED",
			result,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		// Update status to FAILED
		await updateAgentTaskStatus({
			id: input.taskId,
			status: "FAILED",
			error: errorMessage,
			completedAt: new Date(),
		});

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"AGENT_EXECUTION_FAILED",
		);
	}
}

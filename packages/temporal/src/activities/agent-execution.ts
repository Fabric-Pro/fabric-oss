/**
 * Agent Execution Activities
 *
 * Activities for agent execution workflow.
 */

import { globalAgentRegistry } from "@repo/agent-core";
import {
	createAgentTask as dbCreateAgentTask,
	updateAgentTaskStatus as dbUpdateAgentTaskStatus,
	updateAgentTaskWorkflow as dbUpdateAgentTaskWorkflow,
} from "@repo/database";

/**
 * Execute an agent
 */
export async function executeAgent({
	agentName,
	userId: _userId,
	organizationId: _organizationId,
	input: _input,
}: {
	agentName: string;
	userId: string;
	organizationId?: string;
	input: Record<string, any>;
}): Promise<Record<string, any>> {
	// Get agent from registry
	const adapter = globalAgentRegistry.get(agentName);

	if (!adapter) {
		throw new Error(`Agent "${agentName}" not found in registry`);
	}

	// Check agent health
	const health = await adapter.healthCheck();
	if (!health.healthy) {
		throw new Error(
			`Agent "${agentName}" is not healthy: ${health.error || "Unknown error"}`,
		);
	}

	// For CopilotKit agents, execution happens via CopilotKit runtime
	// This activity just validates the agent is ready
	// Actual execution is handled by the CopilotKit runtime with AG-UI protocol

	// For non-CopilotKit agents, implement direct execution here
	// Example:
	// const response = await fetch(`${adapter.getDeploymentUrl()}/execute`, {
	//   method: "POST",
	//   headers: { "Content-Type": "application/json" },
	//   body: JSON.stringify({ input, userId, organizationId }),
	// });

	return {
		agentName,
		status: "ready",
		deploymentUrl: adapter.getDeploymentUrl(),
	};
}

/**
 * Create an agent task record
 *
 * @param params - Task creation parameters
 * @returns Created agent task
 */
export async function createAgentTask(params: {
	agentId: string;
	userId: string;
	organizationId?: string;
	status: string;
	stage: string;
	input: Record<string, any>;
	framework: string;
}) {
	console.log("[Activity] Creating agent task:", params.agentId);

	try {
		const task = await dbCreateAgentTask(params);
		console.log("[Activity] Agent task created:", task.id);
		return task;
	} catch (error) {
		console.error("[Activity] Failed to create agent task:", error);
		throw new Error(
			`Failed to create agent task: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Update agent task with workflow information
 *
 * @param params - Workflow update parameters
 */
export async function updateAgentTaskWorkflow(params: {
	id: string;
	workflowId: string;
	runId: string;
}) {
	console.log("[Activity] Updating agent task workflow:", params.id);

	try {
		await dbUpdateAgentTaskWorkflow(params);
		console.log("[Activity] Agent task workflow updated");
	} catch (error) {
		console.error(
			"[Activity] Failed to update agent task workflow:",
			error,
		);
		throw new Error(
			`Failed to update agent task workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Update agent task status
 *
 * @param params - Status update parameters
 */
export async function updateAgentTaskStatus(params: {
	id: string;
	status: string;
	state?: Record<string, any>;
	result?: Record<string, any>;
	error?: string;
	completedAt?: Date;
}) {
	console.log(
		"[Activity] Updating agent task status:",
		params.id,
		params.status,
	);

	try {
		await dbUpdateAgentTaskStatus(params);
		console.log("[Activity] Agent task status updated");
	} catch (error) {
		console.error("[Activity] Failed to update agent task status:", error);
		// Don't throw - this is a non-critical operation
	}
}

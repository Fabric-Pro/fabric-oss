/**
 * Agent as Tool Execution Activity
 *
 * Executes agents as composable tools within the orchestrator.
 */

import { delegateToAgent, resolveAgentEndpoint } from "../delegation";
import type { ExecuteAgentAsToolInput } from "../types";

/**
 * Executes an agent as a tool within a larger workflow.
 *
 * This enables composable agent architectures where one agent
 * can invoke another as part of its execution.
 */
export async function executeAgentAsTool(
	input: ExecuteAgentAsToolInput,
): Promise<{ output: unknown; durationMs: number }> {
	console.log(`[Orchestrator] Executing agent as tool: ${input.agentId}`);
	const _startTime = Date.now();

	// First, try to delegate to a real agent via A2A
	const agent = await resolveAgentEndpoint(
		input.agentId,
		input.userId,
		input.organizationId,
	);

	if (!agent) {
		throw new Error(
			`Agent not found: ${input.agentId}. Ensure the agent is registered in the database. Run 'pnpm --filter @repo/database seed:system-agents' to register system agents.`,
		);
	}

	// Delegate to the agent via A2A protocol
	const result = await delegateToAgent({
		agentId: input.agentId,
		message:
			typeof input.input === "string"
				? input.input
				: JSON.stringify(input.input),
		context:
			typeof input.input === "object"
				? (input.input as Record<string, unknown>)
				: undefined,
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
	});

	return {
		output: result.response,
		durationMs: result.durationMs,
	};
}

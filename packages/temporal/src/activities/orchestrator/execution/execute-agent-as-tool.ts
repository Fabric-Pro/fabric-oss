/**
 * Agent as Tool Execution Activity
 *
 * Executes agents as composable tools within the orchestrator.
 */

import { delegateToAgent, resolveAgentEndpoint } from "../delegation";
import { assertTurnDispatchable } from "../turn-dispatch";
import type { ExecuteAgentAsToolInput } from "../types";

/**
 * Executes an agent as a tool within a larger workflow.
 *
 * This enables composable agent architectures where one agent
 * can invoke another as part of its execution.
 */
export async function executeAgentAsTool(
	input: ExecuteAgentAsToolInput,
): Promise<{
	output: unknown;
	durationMs: number;
	status?: Awaited<ReturnType<typeof delegateToAgent>>["status"];
}> {
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

	// A delegated agent runs its own model calls; a stopped turn must not
	// launch one.
	await assertTurnDispatchable(input.turnScope);

	// Delegate to the agent via A2A protocol
	const result = await delegateToAgent({
		agentId: input.agentId,
		...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
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
		...(input.usageConversationId
			? { usageConversationId: input.usageConversationId }
			: {}),
		...(input.usageOrigin ? { usageOrigin: input.usageOrigin } : {}),
		...(input.turnScope ? { turnScope: input.turnScope } : {}),
	});

	return {
		output: result.response,
		status: result.status,
		durationMs: result.durationMs,
	};
}

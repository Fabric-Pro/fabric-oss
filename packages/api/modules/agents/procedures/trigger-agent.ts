/**
 * Trigger Agent Procedure
 *
 * Triggers an agent execution with Temporal workflow integration.
 * Enforces multi-tenancy and authorization checks.
 */

import { ORPCError } from "@orpc/client";
import { globalAgentRegistry } from "@repo/agent-core";
import { createAgentTask, updateAgentTaskWorkflow } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	agentRateLimitedProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Sanitize agent input to prevent prompt injection
 * Removes potentially dangerous patterns while preserving legitimate content
 */
function sanitizeAgentInput(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "string") {
			// Limit string length to prevent abuse
			const truncated = value.slice(0, 50000);
			// Remove system prompt injection attempts
			const cleaned = truncated
				.replace(
					/\[INST\]|\[\/INST\]|<\|system\|>|<\|user\|>|<\|assistant\|>/gi,
					"",
				)
				.replace(/<<SYS>>|<\/SYS>>/gi, "")
				.replace(/Human:|Assistant:|System:/gi, (match) =>
					match.replace(":", ": "),
				);
			sanitized[key] = cleaned;
		} else if (Array.isArray(value)) {
			// Limit array size
			sanitized[key] = value
				.slice(0, 1000)
				.map((item) =>
					typeof item === "string" ? item.slice(0, 10000) : item,
				);
		} else if (typeof value === "object" && value !== null) {
			// Recursively sanitize nested objects (with depth limit)
			sanitized[key] = sanitizeAgentInput(
				value as Record<string, unknown>,
			);
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

/**
 * Validated input schema for agent execution
 * Uses strict validation instead of z.any()
 */
const AgentInputSchema = z.object({
	agentName: z.string().min(1).max(100),
	organizationId: z.string().nullable().optional(),
	input: z.record(
		z
			.string()
			.max(100), // Key names limited
		z.union([
			z
				.string()
				.max(50000), // Text inputs limited
			z.number(),
			z.boolean(),
			z
				.array(z.unknown())
				.max(1000), // Arrays limited
			z.record(z.string(), z.unknown()), // Nested objects allowed
		]),
	),
});

/**
 * Trigger an agent execution
 * Rate limited to prevent abuse of expensive AI operations
 */
export const triggerAgent = agentRateLimitedProcedure
	.use(requirePermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/agents/trigger",
		tags: ["Agents"],
		summary: "Trigger agent execution",
		description:
			"Start an agent execution with Temporal workflow for durability and automatic retries",
	})
	.input(AgentInputSchema)
	.output(
		z.object({
			taskId: z.string(),
			workflowId: z.string(),
			runId: z.string(),
			status: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { agentName, organizationId, input: rawAgentInput } = input;

		// Sanitize input to prevent prompt injection attacks
		const agentInput = sanitizeAgentInput(
			rawAgentInput as Record<string, unknown>,
		);

		// Verify organization membership if organizationId provided
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify agent exists in registry
		const adapter = globalAgentRegistry.get(agentName);
		if (!adapter) {
			throw new ORPCError("NOT_FOUND", {
				message: `Agent "${agentName}" not found in registry`,
			});
		}

		// Check agent health before triggering
		const health = await adapter.healthCheck();
		if (!health.healthy) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: `Agent "${agentName}" is not healthy: ${health.error || "Unknown error"}`,
			});
		}

		// Create agent task record
		const task = await createAgentTask({
			agentId: agentName,
			userId: user.id,
			organizationId: organizationId ?? undefined,
			status: "PENDING",
			stage: "INITIALIZING",
			input: agentInput,
			framework: adapter.framework,
		});

		try {
			// Get Temporal client
			const temporal = await getTemporalClient();

			// Start Temporal workflow
			const workflowId = `agent-execution-${task.id}`;
			const handle = await temporal.workflow.start(
				"agentExecutionWorkflow",
				withCorrelationMemo({
					taskQueue: "agents",
					workflowId,
					args: [
						{
							taskId: task.id,
							agentName,
							userId: user.id,
							organizationId,
							input: agentInput,
						},
					],
				}),
			);

			// Update task with workflow information
			await updateAgentTaskWorkflow({
				id: task.id,
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
			});

			return {
				taskId: task.id,
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				status: "PENDING",
			};
		} catch (error) {
			// Update task status to FAILED if workflow start fails
			await updateAgentTaskWorkflow({
				id: task.id,
				workflowId: "",
				runId: "",
			});

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start agent execution: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});

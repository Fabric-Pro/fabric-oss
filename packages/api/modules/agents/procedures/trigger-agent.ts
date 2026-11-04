/**
 * Trigger Agent Procedure
 *
 * Triggers an agent execution with Temporal workflow integration.
 * Enforces multi-tenancy and authorization checks.
 */

import { ORPCError } from "@orpc/client";
import { globalAgentRegistry } from "@repo/agent-core";
import { REGISTERED_AGENT_EXECUTION_UNSUPPORTED } from "@repo/agent-types";
import { z } from "zod";
import {
	agentRateLimitedProcedure,
	Permissions,
	requireInputOrgPermission,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { resolvedOrganizationId } from "./conversations/resolved-organization";

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
	.use(
		requireInputOrgPermission(Permissions.AGENT_EXECUTE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/agents/trigger",
		tags: ["Agents"],
		summary: "Trigger agent execution",
		description:
			"Registered agents use their interactive runtime; invoke a saved instance for background execution",
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
		const { agentName } = input;
		const organizationId = resolvedOrganizationId(input, context.session);

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

		throw new ORPCError("CONFLICT", {
			message: REGISTERED_AGENT_EXECUTION_UNSUPPORTED.message,
			data: { code: REGISTERED_AGENT_EXECUTION_UNSUPPORTED.code },
		});
	});

/**
 * Get Agent Health Procedure
 *
 * Returns health status for a specific agent or all agents.
 */

import { ORPCError } from "@orpc/client";
import { globalAgentRegistry } from "@repo/agent-core";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Get health status for a specific agent
 */
export const getAgentHealth = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/health/:name",
		tags: ["Agents"],
		summary: "Get agent health status",
		description: "Check if a specific agent is healthy and responsive",
	})
	.input(
		z.object({
			name: z.string(),
		}),
	)
	.output(
		z.object({
			healthy: z.boolean(),
			responseTime: z.number().optional(),
			error: z.string().optional(),
			lastCheck: z.date(),
			version: z.string().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const health = await globalAgentRegistry.healthCheck(input.name);

		if (!health) {
			throw new ORPCError("NOT_FOUND", {
				message: `Agent "${input.name}" not found in registry`,
			});
		}

		return health;
	});

/**
 * Get health status for all agents
 */
export const getAllAgentsHealth = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/health",
		tags: ["Agents"],
		summary: "Get health status for all agents",
		description: "Check health status of all registered agents",
	})
	.output(z.record(z.string(), z.any()))
	.handler(async () => {
		return await globalAgentRegistry.healthCheckAll();
	});

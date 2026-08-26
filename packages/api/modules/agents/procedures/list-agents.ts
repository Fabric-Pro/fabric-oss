/**
 * List Available Agents Procedure
 *
 * Returns all registered agents from the global agent registry.
 * This endpoint provides agent discovery similar to MCP server listing.
 */

import { globalAgentRegistry } from "@repo/agent-core";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * List all available agents
 * Returns agent metadata including framework, language, tools, and health status
 */
export const listAgents = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/list",
		tags: ["Agents"],
		summary: "List available agents",
		description:
			"Get all registered agents with their metadata, capabilities, and health status",
	})
	.output(
		z.object({
			agents: z.array(
				z.object({
					name: z.string(),
					displayName: z.string(),
					description: z.string(),
					framework: z.string(),
					language: z.string(),
					version: z.string(),
					tags: z.array(z.string()),
					deploymentUrl: z.string(),
					tools: z.array(z.string()),
					healthy: z.boolean().optional(),
				}),
			),
			counts: z.object({
				total: z.number(),
				frameworks: z.record(z.string(), z.number()),
				languages: z.record(z.string(), z.number()),
			}),
		}),
	)
	.handler(async () => {
		// Get all agents from registry
		const agents = globalAgentRegistry.getRegistryMetadata();

		// Get health status for all agents
		const healthStatus = await globalAgentRegistry.healthCheckAll();

		// Merge health status into agent metadata
		const agentsWithHealth = agents.map((agent) => ({
			...agent,
			healthy: healthStatus[agent.name]?.healthy,
		}));

		return {
			agents: agentsWithHealth,
			counts: {
				total: globalAgentRegistry.size,
				frameworks: globalAgentRegistry.getFrameworkCounts(),
				languages: globalAgentRegistry.getLanguageCounts(),
			},
		};
	});

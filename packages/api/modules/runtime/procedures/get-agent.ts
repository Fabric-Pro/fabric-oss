/**
 * Get Agent Procedure
 *
 * Gets agent configuration from the database.
 * Used by agents to load their own configuration.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";
import { hasScope, validateApiKey } from "../lib/api-key-auth";
import { AgentConfigSchema } from "../types";

export const getAgentProcedure = publicProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "POST",
		path: "/runtime/get-agent",
		tags: ["Runtime"],
		summary: "Get agent configuration",
		description:
			"Gets the configuration for a specific agent. " +
			"Returns agent metadata and config from the database.",
	})
	.input(
		z.object({
			apiKey: z.string().min(20, "Invalid API key format"),
			agentId: z.string(),
		}),
	)
	.output(AgentConfigSchema.nullable())
	.handler(async ({ input }) => {
		// Validate API key
		const tenant = await validateApiKey(input.apiKey);

		if (!tenant) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Invalid or expired API key",
			});
		}

		// Check scope (agents:read or *)
		if (!hasScope(tenant, "agents:read") && !hasScope(tenant, "*")) {
			throw new ORPCError("FORBIDDEN", {
				message: "API key lacks 'agents:read' scope",
			});
		}

		// Get agent with proper scoping
		const agent = await db.agent.findFirst({
			where: {
				agentId: input.agentId,
				OR: [
					// User's own agents
					{ userId: tenant.userId, scope: "USER" },
					// Organization agents (if user is in org)
					...(tenant.organizationId
						? [
								{
									organizationId: tenant.organizationId,
									scope: "ORGANIZATION" as const,
								},
							]
						: []),
					// System agents (available to all)
					{ scope: "SYSTEM" },
				],
			},
			select: {
				id: true,
				agentId: true,
				name: true,
				displayName: true,
				description: true,
				framework: true,
				deploymentUrl: true,
				status: true,
				scope: true,
				config: true,
				metadata: true,
			},
		});

		if (!agent) {
			return null;
		}

		return {
			id: agent.id,
			agentId: agent.agentId,
			name: agent.name,
			displayName: agent.displayName,
			description: agent.description,
			framework: agent.framework,
			deploymentUrl: agent.deploymentUrl,
			status: agent.status,
			scope: agent.scope,
			config: agent.config as Record<string, unknown> | null,
			metadata: agent.metadata as Record<string, unknown> | null,
		};
	});

/**
 * Get Agent Configuration Procedure
 *
 * Returns agent configuration for runtime execution.
 *
 * SECURITY: Tenant-isolated. Callers must be authenticated and either:
 *   - Own the agent (scope=USER, userId matches caller), OR
 *   - Be a member of the agent's organization (scope=ORGANIZATION), OR
 *   - Be requesting a SYSTEM-scope agent (available to all authenticated users).
 *
 * External agent runtimes (which are not authenticated via session) must use
 * `/api/v1/runtime/get-agent` with an API key — that endpoint enforces the
 * same tenant constraints via the API key's resolved tenant context.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getAgentConfig = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/registry/config/:agentId",
		tags: ["Agent Registry"],
		summary: "Get agent configuration",
		description:
			"Returns configuration for an agent in the caller's tenant (or a SYSTEM-scope agent).",
	})
	.input(
		z.object({
			agentId: z.string(),
		}),
	)
	.output(
		z.object({
			agentId: z.string(),
			displayName: z.string(),
			description: z.string().nullable(),
			status: z.string(),
			scope: z.string(),
			userId: z.string(),
			organizationId: z.string().nullable(),
			runtimeVersion: z.string(),
			config: z
				.object({
					model: z.string().optional(),
					temperature: z.number().optional(),
					maxTokens: z.number().optional(),
					systemPrompt: z.string().optional(),
					tools: z.array(z.string()).optional(),
					mcpServers: z.array(z.string()).optional(),
				})
				.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { agentId } = input;
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		const agent = await db.agent.findFirst({
			where: {
				agentId,
				OR: [
					{ scope: "SYSTEM" },
					{ scope: "USER", userId },
					...(organizationId
						? [
								{
									scope: "ORGANIZATION" as const,
									organizationId,
								},
							]
						: []),
				],
			},
		});

		if (!agent) {
			throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
		}

		if (agent.status !== "ACTIVE") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Agent is not active",
			});
		}

		return {
			agentId: agent.agentId,
			displayName: agent.displayName,
			description: agent.description,
			status: agent.status,
			scope: agent.scope,
			userId: agent.userId,
			organizationId: agent.organizationId,
			runtimeVersion: agent.runtimeVersion,
			config: agent.config as any,
		};
	});

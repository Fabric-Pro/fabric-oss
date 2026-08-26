/**
 * List Registered Agents Procedure
 *
 * Returns agents from the database-backed Agent Registry.
 * Supports filtering by framework, status, and multi-tenancy.
 * Includes SYSTEM scope agents available to all users.
 */

import {
	countRegisteredAgents,
	db,
	listRegisteredAgents as listRegisteredAgentsQuery,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";

/**
 * List registered agents from database
 */
export const listRegisteredAgents = protectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/registry/list",
		tags: ["Agent Registry"],
		summary: "List registered agents",
		description:
			"Get all registered agents from the database with filtering by framework, status, and tenant. Includes SYSTEM scope agents available to all users.",
	})
	.input(
		z.object({
			framework: z.string().optional(),
			status: z.string().optional(),
			// organizationId: null = explicit personal context, undefined = use session fallback
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(100).default(50),
			offset: z.number().min(0).default(0),
		}),
	)
	.output(
		z.object({
			agents: z.array(
				z.object({
					id: z.string(),
					agentId: z.string(),
					name: z.string(),
					displayName: z.string(),
					description: z.string().nullable(),
					framework: z.string(),
					deploymentUrl: z.string().nullable(),
					status: z.string(),
					scope: z.string(),
					userId: z.string().nullable(),
					organizationId: z.string().nullable(),
					config: z.any().nullable(),
					metadata: z.any().nullable(),
					createdAt: z.date(),
					updatedAt: z.date(),
					lastHealthCheck: z.date().nullable(),
					lastHealthError: z.string().nullable(),
					consecutiveHealthFailures: z.number(),
					conversationCount: z.number(),
				}),
			),
			total: z.number(),
			limit: z.number(),
			offset: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { framework, status, limit, offset } = input;
		const userId = context.user.id;
		// Handle null as explicit personal context (convert to undefined for DB query)
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get agents from database (includes SYSTEM agents)
		const agents = await listRegisteredAgentsQuery({
			userId,
			organizationId,
			framework,
			status,
			limit,
			offset,
		});

		// Get total count
		const total = await countRegisteredAgents({
			userId,
			organizationId,
			framework,
			status,
		});

		// Count conversations per agent (by matching agentId string)
		const agentIds = agents.map((a) => a.agentId);
		const conversationCounts =
			agentIds.length > 0
				? await db.agentConversation.groupBy({
						by: ["agentId"],
						where: { agentId: { in: agentIds } },
						_count: { id: true },
					})
				: [];

		const countByAgentId = new Map(
			conversationCounts.map((c) => [c.agentId, c._count.id]),
		);

		return {
			agents: agents.map((agent) => ({
				...agent,
				conversationCount: countByAgentId.get(agent.agentId) ?? 0,
			})),
			total,
			limit,
			offset,
		};
	});

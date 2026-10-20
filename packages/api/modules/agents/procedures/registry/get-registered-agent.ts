/**
 * Get Registered Agent Procedure
 *
 * Returns a single agent from the database-backed Agent Registry.
 * Supports SYSTEM, ORGANIZATION, and USER scoped agents.
 *
 * Accepts either the database ID (UUID) or the agentId (e.g., "prompt_enhancer").
 */

import { ORPCError } from "@orpc/server";
import {
	getRegisteredAgentByAgentId,
	getRegisteredAgentById,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";
import { checkRegisteredAgentAccess } from "../../lib/registered-agent-access";

/**
 * Get registered agent by ID or agentId
 */
export const getRegisteredAgent = protectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/agents/registry/:id",
		tags: ["Agent Registry"],
		summary: "Get registered agent",
		description:
			"Get a single registered agent from the database by ID or agentId. Returns SYSTEM agents for all users, ORGANIZATION agents for org members, and USER agents for owners.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
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
		}),
	)
	.handler(async ({ input, context }) => {
		const { id } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Try to get agent by agentId first (more common for URL-based lookups)
		// Then fall back to database ID
		// Also handle URL slugs with hyphens (e.g., "document-generator" -> "document_generator")
		let agent = await getRegisteredAgentByAgentId(id);
		if (!agent) {
			// Try with underscores instead of hyphens (URL slug -> agentId)
			const normalizedId = id.replace(/-/g, "_");
			if (normalizedId !== id) {
				agent = await getRegisteredAgentByAgentId(normalizedId);
			}
		}
		if (!agent) {
			agent = await getRegisteredAgentById(id);
		}

		if (!agent) {
			throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
		}

		const access = await checkRegisteredAgentAccess(
			agent,
			user.id,
			organizationId,
		);
		if (!access.allowed) {
			throw new ORPCError("FORBIDDEN", { message: access.reason });
		}

		return agent;
	});

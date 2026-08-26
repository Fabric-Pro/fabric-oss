/**
 * Update Registered Agent Procedure
 *
 * Updates an existing agent in the database-backed Agent Registry.
 * Only USER-scoped agents can be updated by their owners.
 * ORGANIZATION-scoped agents can be updated by org admins.
 * SYSTEM agents cannot be updated through this endpoint.
 */

import { ORPCError } from "@orpc/server";
import {
	getRegisteredAgentById,
	updateRegisteredAgent as updateRegisteredAgentQuery,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Update a registered agent
 */
export const updateRegisteredAgent = protectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "PATCH",
		path: "/agents/registry/:id",
		tags: ["Agent Registry"],
		summary: "Update registered agent",
		description:
			"Update an existing agent in the database-backed Agent Registry. Only user-owned agents or org agents (by admins) can be updated.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(100).optional(),
			displayName: z.string().min(1).max(200).optional(),
			description: z.string().optional(),
			deploymentUrl: z.string().url().optional(),
			status: z.string().optional(),
			config: z.any().optional(),
			metadata: z.any().optional(),
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
		const { id, organizationId: inputOrgId, ...updateData } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(inputOrgId, session);

		// Get agent from RegisteredAgent table
		const existingAgent = await getRegisteredAgentById(id);

		if (!existingAgent) {
			throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
		}

		// Only allow updates to USER-scoped agents
		if (existingAgent.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "System agents cannot be modified",
			});
		}

		if (existingAgent.scope === "ORGANIZATION") {
			// Organization-scoped agents require admin membership
			if (!existingAgent.organizationId) {
				throw new ORPCError("FORBIDDEN", {
					message: "Invalid organization agent configuration",
				});
			}

			// Verify user is a member of the agent's organization
			const membership = await verifyOrganizationMembership(
				existingAgent.organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You do not have access to this agent",
				});
			}

			// Check if user has admin role in the organization
			if (membership.role !== "owner" && membership.role !== "admin") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Organization agents can only be modified by administrators",
				});
			}

			// If caller specified an organizationId, it must match the agent's org
			if (
				organizationId &&
				organizationId !== existingAgent.organizationId
			) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Agent does not belong to the specified organization",
				});
			}
		} else if (existingAgent.scope === "USER") {
			// Check authorization (user must own the agent)
			if (existingAgent.userId !== user.id) {
				throw new ORPCError("FORBIDDEN", {
					message: "You do not have access to this agent",
				});
			}
		}

		// Update agent in database
		try {
			const agent = await updateRegisteredAgentQuery(id, updateData);
			return agent;
		} catch (error) {
			console.error(
				"[updateRegisteredAgent] Error updating agent:",
				error,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to update agent",
			});
		}
	});

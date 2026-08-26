/**
 * Delete Registered Agent Procedure
 *
 * Deletes an agent from the database-backed Agent Registry.
 * Only USER-scoped agents can be deleted by their owners.
 * ORGANIZATION-scoped agents can be deleted by org admins.
 * SYSTEM agents cannot be deleted through this endpoint.
 */

import { ORPCError } from "@orpc/server";
import {
	deleteRegisteredAgent as deleteRegisteredAgentQuery,
	getRegisteredAgentById,
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
 * Delete a registered agent
 */
export const deleteRegisteredAgent = protectedProcedure
	.use(requirePermission(Permissions.AGENT_DELETE))
	.route({
		method: "DELETE",
		path: "/agents/registry/:id",
		tags: ["Agent Registry"],
		summary: "Delete registered agent",
		description:
			"Delete an agent from the database-backed Agent Registry. Only user-owned agents or org agents (by admins) can be deleted.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { id } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Get agent from RegisteredAgent table
		const existingAgent = await getRegisteredAgentById(id);

		if (!existingAgent) {
			throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
		}

		// Only allow deletion of USER-scoped agents
		if (existingAgent.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "System agents cannot be deleted",
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
						"Organization agents can only be deleted by administrators",
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

		// Delete agent from database
		try {
			await deleteRegisteredAgentQuery(id);
			return {
				success: true,
				message: "Agent deleted successfully",
			};
		} catch (error) {
			console.error(
				"[deleteRegisteredAgent] Error deleting agent:",
				error,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to delete agent",
			});
		}
	});

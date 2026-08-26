/**
 * List Agent Tasks Procedure
 *
 * Returns agent execution tasks for the current user or organization.
 * Enforces multi-tenancy with proper authorization checks.
 */

import { ORPCError } from "@orpc/client";
import {
	getAgentTasksByOrganizationId,
	getAgentTasksByUserId,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * List agent tasks with multi-tenancy support
 */
export const listAgentTasks = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/tasks",
		tags: ["Agents"],
		summary: "List agent tasks",
		description:
			"Get agent execution tasks for current user or organization with pagination and filtering",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(50).default(10),
			offset: z.number().min(0).default(0),
			status: z.string().optional(),
			agentId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { organizationId, limit, offset, status, agentId } = input;

		// If organizationId provided, verify membership
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

			// Return organization tasks
			return await getAgentTasksByOrganizationId({
				organizationId,
				limit,
				offset,
				status,
				agentId,
			});
		}

		// Return user tasks
		return await getAgentTasksByUserId({
			userId: user.id,
			limit,
			offset,
			status,
			agentId,
		});
	});

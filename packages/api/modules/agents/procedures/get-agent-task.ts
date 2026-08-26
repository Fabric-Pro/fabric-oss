/**
 * Get Agent Task Procedure
 *
 * Returns a specific agent task with authorization checks.
 */

import { ORPCError } from "@orpc/client";
import { getAgentTaskById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Get a specific agent task by ID
 */
export const getAgentTask = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/tasks/:id",
		tags: ["Agents"],
		summary: "Get agent task",
		description: "Get a specific agent task with full details",
	})
	.input(
		z.object({
			id: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const task = await getAgentTaskById(input.id);

		if (!task) {
			throw new ORPCError("NOT_FOUND", {
				message: "Agent task not found",
			});
		}

		// Verify authorization
		if (task.organizationId) {
			// Organization task - verify membership
			const membership = await verifyOrganizationMembership(
				task.organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not authorized to view this task",
				});
			}
		} else if (task.userId !== user.id) {
			// Personal task - verify ownership
			throw new ORPCError("FORBIDDEN", {
				message: "You are not authorized to view this task",
			});
		}

		return task;
	});

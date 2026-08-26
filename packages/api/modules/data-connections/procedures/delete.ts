/**
 * Delete Data Connection
 *
 * Deletes a data connection and all associated sync jobs and resources.
 */

import { ORPCError } from "@orpc/client";
import { deleteDataConnection, getDataConnectionById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const deleteProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "DELETE",
		path: "/data-connections/:id",
		tags: ["DataConnections"],
		summary: "Delete data connection",
		description:
			"Delete a data connection and all associated sync jobs and resources",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		// Delete will cascade to sync jobs, synced resources, and schedules
		const result = await deleteDataConnection({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (result.count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found or not deleted",
			});
		}

		return { success: true };
	});

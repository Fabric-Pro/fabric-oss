/**
 * Get Data Connection
 *
 * Gets a single data connection by ID with full details.
 */

import { ORPCError } from "@orpc/client";
import { getConnectionStats, getDataConnectionById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { toClientConnection } from "../lib/serialize-connection";

export const getProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections/:id",
		tags: ["DataConnections"],
		summary: "Get data connection details",
		description:
			"Get a single data connection with sync jobs and resources",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			includeStats: z.boolean().default(false),
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

		// Optionally include stats
		let stats = null;
		if (input.includeStats) {
			stats = await getConnectionStats(connection.id);
		}

		return { connection: toClientConnection(connection), stats };
	});

/**
 * List Data Connections
 *
 * Lists all data connections for the current tenant with filtering options.
 */

import { ORPCError } from "@orpc/client";
import {
	DataConnectionProviderSchema,
	DataConnectionStatusSchema,
	getDataConnections,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { toClientConnections } from "../lib/serialize-connection";

export const listProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
	.route({
		method: "GET",
		path: "/data-connections",
		tags: ["DataConnections"],
		summary: "List data connections",
		description:
			"List all data connections for the current tenant with optional filtering",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			provider: DataConnectionProviderSchema.optional(),
			status: DataConnectionStatusSchema.optional(),
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

		const connections = await getDataConnections({
			userId: user.id,
			organizationId,
			provider: input.provider as any,
			status: input.status as any,
		});

		return { connections: toClientConnections(connections) };
	});

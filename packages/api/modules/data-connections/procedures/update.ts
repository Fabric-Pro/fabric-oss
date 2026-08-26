/**
 * Update Data Connection
 *
 * Updates an existing data connection's configuration and settings.
 */

import { ORPCError } from "@orpc/client";
import {
	type DataConnectionStatus,
	DataConnectionStatusSchema,
	getDataConnectionById,
	getDataConnectionCredentialById,
	type Prisma,
	updateDataConnection,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { toClientConnection } from "../lib/serialize-connection";

export const updateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "PATCH",
		path: "/data-connections/:id",
		tags: ["DataConnections"],
		summary: "Update data connection",
		description: "Update a data connection's name, config, or status",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(100).optional(),
			status: DataConnectionStatusSchema.optional(),
			config: z.record(z.string(), z.unknown()).optional(),
			credentials: z.record(z.string(), z.unknown()).optional(),
			credentialId: z.string().nullable().optional(),
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

		if (input.credentialId) {
			const credential = await getDataConnectionCredentialById({
				id: input.credentialId,
				userId: user.id,
				organizationId,
			});

			if (!credential) {
				throw new ORPCError("NOT_FOUND", {
					message: "Credential not found",
				});
			}

			if (credential.provider !== connection.provider) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Credential provider does not match this connection",
				});
			}
		}

		const result = await updateDataConnection({
			id: input.id,
			userId: user.id,
			organizationId,
			data: {
				...(input.name && { name: input.name }),
				...(input.status && {
					status: input.status as DataConnectionStatus,
				}),
				...(input.config && {
					config: input.config as Prisma.InputJsonValue,
				}),
				...(input.credentials && {
					credentials: input.credentials as Prisma.InputJsonValue,
				}),
				...(input.credentialId !== undefined && {
					credentialId: input.credentialId,
				}),
			},
		});

		if (result.count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found or not updated",
			});
		}

		// Get the updated connection
		const updatedConnection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		return { connection: toClientConnection(updatedConnection) };
	});

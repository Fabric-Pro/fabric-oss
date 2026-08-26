import { ORPCError } from "@orpc/client";
import {
	createDataConnectionCredential,
	type DataConnectionProvider,
	DataConnectionProviderSchema,
	getDataConnectionById,
	getDataConnectionCredentialById,
	getDataConnectionCredentials,
	updateDataConnection,
} from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

async function ensureTenantAccess(params: {
	organizationId: string | null | undefined;
	userId: string;
}) {
	if (!params.organizationId) {
		return;
	}

	const membership = await verifyOrganizationMembership(
		params.organizationId,
		params.userId,
	);

	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization",
		});
	}
}

export const credentialsProcedures = {
	list: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
		.route({
			method: "GET",
			path: "/data-connections/credentials",
			tags: ["DataConnections"],
			summary: "List connector credentials",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
				provider: DataConnectionProviderSchema.optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			await ensureTenantAccess({
				organizationId,
				userId: context.user.id,
			});

			const credentials = await getDataConnectionCredentials({
				userId: context.user.id,
				organizationId,
				provider: input.provider as DataConnectionProvider | undefined,
			});

			return { credentials };
		}),

	create: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
		.route({
			method: "POST",
			path: "/data-connections/credentials",
			tags: ["DataConnections"],
			summary: "Create connector credential",
		})
		.input(
			z.object({
				organizationId: z.string().nullable().optional(),
				provider: DataConnectionProviderSchema,
				name: z.string().min(1).max(100),
				credentialType: z.string().optional(),
				payload: z.record(z.string(), z.unknown()),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			await ensureTenantAccess({
				organizationId,
				userId: context.user.id,
			});

			const credential = await createDataConnectionCredential({
				userId: context.user.id,
				organizationId,
				provider: input.provider as DataConnectionProvider,
				name: input.name,
				credentialType: input.credentialType,
				encryptedPayload: encryptApiKey(JSON.stringify(input.payload)),
				createdBy: context.user.id,
			});

			return { credential };
		}),

	get: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_READ))
		.route({
			method: "GET",
			path: "/data-connections/credentials/:id",
			tags: ["DataConnections"],
			summary: "Get connector credential metadata",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			await ensureTenantAccess({
				organizationId,
				userId: context.user.id,
			});

			const credential = await getDataConnectionCredentialById({
				id: input.id,
				userId: context.user.id,
				organizationId,
			});

			if (!credential) {
				throw new ORPCError("NOT_FOUND", {
					message: "Credential not found",
				});
			}

			return { credential };
		}),

	assignToConnection: tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
		.route({
			method: "POST",
			path: "/data-connections/:id/credential",
			tags: ["DataConnections"],
			summary: "Assign connector credential to a connection",
		})
		.input(
			z.object({
				id: z.string(),
				credentialId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			await ensureTenantAccess({
				organizationId,
				userId: context.user.id,
			});

			const connection = await getDataConnectionById({
				id: input.id,
				userId: context.user.id,
				organizationId,
			});
			if (!connection) {
				throw new ORPCError("NOT_FOUND", {
					message: "Connection not found",
				});
			}

			const credential = await getDataConnectionCredentialById({
				id: input.credentialId,
				userId: context.user.id,
				organizationId,
			});
			if (!credential) {
				throw new ORPCError("NOT_FOUND", {
					message: "Credential not found",
				});
			}

			await updateDataConnection({
				id: connection.id,
				userId: context.user.id,
				organizationId,
				data: {
					credentialId: credential.id,
					status: "CONNECTED",
				},
			});

			return { ok: true, credentialId: credential.id };
		}),
};

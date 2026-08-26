/**
 * Create Data Connection
 *
 * Creates a new data connection. For OAuth providers, this creates a pending
 * connection that will be activated after OAuth flow completes.
 */

import { ORPCError } from "@orpc/client";
import {
	createDataConnection,
	type DataConnectionProvider,
	DataConnectionProviderSchema,
	type DataConnectionStatus,
	getDataConnectionByProvider,
	getDataConnectionCredentialById,
	type Prisma,
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

export const createProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections",
		tags: ["DataConnections"],
		summary: "Create data connection",
		description:
			"Create a new data connection. Returns pending status for OAuth providers.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			provider: DataConnectionProviderSchema,
			name: z.string().min(1).max(100),
			credentials: z.record(z.string(), z.unknown()).optional(), // For API key providers
			credentialId: z.string().optional(),
			config: z.record(z.string(), z.unknown()).optional(), // Provider-specific config
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

		// Check if connection already exists for this provider
		const existing = await getDataConnectionByProvider({
			provider: input.provider as DataConnectionProvider,
			userId: user.id,
			organizationId,
		});

		if (existing) {
			throw new ORPCError("CONFLICT", {
				message: `A connection to ${input.provider} already exists`,
			});
		}

		// Determine if this is a provider we can validate from submitted credentials
		const apiKeyProviders: DataConnectionProvider[] = [
			"SNOWFLAKE",
			"BIGQUERY",
			"LINEAR",
			"GITLAB",
			"BITBUCKET",
			"S3",
			"GOOGLE_STORAGE",
			"R2",
			"DROPBOX",
			"AIRTABLE",
			"CODA",
			"GITBOOK",
			"ASANA",
			"CLICKUP",
			"INTERCOM",
			"HUBSPOT",
		];
		const manualCredentialProviders: DataConnectionProvider[] = [
			"CONFLUENCE",
			"ZENDESK",
			"JIRA",
			"SALESFORCE",
		];
		const isApiKeyProvider = apiKeyProviders.includes(
			input.provider as DataConnectionProvider,
		);
		const isManualCredentialProvider = manualCredentialProviders.includes(
			input.provider as DataConnectionProvider,
		);

		let credentialId: string | undefined;
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

			if (credential.provider !== input.provider) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Credential provider does not match the selected connector",
				});
			}

			credentialId = credential.id;
		}

		// API-key and manual-credential providers can become connected immediately
		// when credentials are supplied. OAuth providers start as PENDING.
		const status: DataConnectionStatus =
			(isApiKeyProvider || isManualCredentialProvider) &&
			(input.credentials || credentialId)
				? "CONNECTED"
				: "PENDING";

		const connection = await createDataConnection({
			userId: user.id,
			organizationId,
			provider: input.provider as DataConnectionProvider,
			name: input.name,
			createdBy: user.id,
			credentials: input.credentials as Prisma.InputJsonValue | undefined,
			config: input.config as Prisma.InputJsonValue | undefined,
			credentialId,
			status,
		});

		return { connection: toClientConnection(connection) };
	});

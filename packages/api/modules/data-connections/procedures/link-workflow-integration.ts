/**
 * Link Data Connection from Workflow Integration
 *
 * When a user has already authenticated GitHub (or another provider) for
 * workflow actions, this procedure reuses that OAuth token to create or
 * update the corresponding search/sync DataConnection — no second OAuth
 * flow required.
 *
 * Only providers that share the same OAuth app across both paths are
 * supported (currently GITHUB).
 */

import { ORPCError } from "@orpc/client";
import {
	createDataConnection,
	db,
	getDataConnectionByProvider,
	type Prisma,
	updateDataConnection,
} from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { toClientConnection } from "../lib/serialize-connection";

/**
 * Providers that can be linked from a workflow integration credential.
 * Keyed by DataConnectionProvider → WorkflowIntegration provider name.
 * All OAuth providers that have both a workflow integration (actions) and
 * a data connection (search) path share the same OAuth app, so the token
 * can be reused without requiring a second OAuth flow.
 */
const LINKABLE_PROVIDER_MAP: Record<
	string,
	{ workflowProvider: string; dataConnectionProvider: string }
> = {
	ASANA: { workflowProvider: "ASANA", dataConnectionProvider: "ASANA" },
	BITBUCKET: {
		workflowProvider: "BITBUCKET",
		dataConnectionProvider: "BITBUCKET",
	},
	GITHUB: { workflowProvider: "GITHUB", dataConnectionProvider: "GITHUB" },
	GITLAB: { workflowProvider: "GITLAB", dataConnectionProvider: "GITLAB" },
	GMAIL: { workflowProvider: "GMAIL", dataConnectionProvider: "GMAIL" },
	GOOGLE_DRIVE: {
		workflowProvider: "GOOGLE_DRIVE",
		dataConnectionProvider: "GOOGLE_DRIVE",
	},
	HUBSPOT: {
		workflowProvider: "HUBSPOT",
		dataConnectionProvider: "HUBSPOT",
	},
	INTERCOM: {
		workflowProvider: "INTERCOM",
		dataConnectionProvider: "INTERCOM",
	},
	LINEAR: { workflowProvider: "LINEAR", dataConnectionProvider: "LINEAR" },
	// TEAMS uses MICROSOFT_GRAPH as the workflow provider
	TEAMS: {
		workflowProvider: "MICROSOFT_GRAPH",
		dataConnectionProvider: "TEAMS",
	},
	MICROSOFT_365: {
		workflowProvider: "MICROSOFT_GRAPH",
		dataConnectionProvider: "MICROSOFT_365",
	},
	NOTION: { workflowProvider: "NOTION", dataConnectionProvider: "NOTION" },
	SLACK: { workflowProvider: "SLACK", dataConnectionProvider: "SLACK" },
};

function getLinkableProviderInfo(provider: string) {
	return LINKABLE_PROVIDER_MAP[provider] ?? null;
}

export const linkFromWorkflowIntegrationProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/link-workflow",
		tags: ["DataConnections"],
		summary: "Link data connection from workflow integration",
		description:
			"Create or update a search data connection by reusing an existing workflow actions OAuth token. Eliminates the need for a second OAuth flow.",
	})
	.input(
		z.object({
			provider: z.string(),
			name: z.string().min(1).max(100),
			organizationId: z.string().nullable().optional(),
			config: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const providerInfo = getLinkableProviderInfo(input.provider);
		if (!providerInfo) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Provider ${input.provider} does not support credential reuse from workflow integrations`,
			});
		}

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

		const orgIdForQuery = organizationId ?? null;

		// Look up the existing workflow integration for this provider
		const workflowIntegration = await db.workflowIntegration.findFirst({
			where: {
				userId: user.id,
				provider: providerInfo.workflowProvider as any,
				isActive: true,
				...(orgIdForQuery !== null
					? { organizationId: orgIdForQuery }
					: { organizationId: null }),
			},
		});

		if (!workflowIntegration || !workflowIntegration.credentials) {
			throw new ORPCError("NOT_FOUND", {
				message: `No active ${input.provider} workflow integration found. Connect ${input.provider} for actions first.`,
			});
		}

		// Decrypt and extract the access token
		let accessToken: string;
		try {
			const credentialsJson = decryptApiKey(
				workflowIntegration.credentials,
			);
			const credentials = JSON.parse(credentialsJson) as {
				access_token?: string;
			};
			if (!credentials.access_token) {
				throw new Error("No access_token in credentials");
			}
			accessToken = credentials.access_token;
		} catch {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to read credentials from workflow integration",
			});
		}

		// Extract login from settings if available (for connection name)
		const settings = workflowIntegration.settings as Record<
			string,
			unknown
		> | null;
		const login =
			typeof settings?.login === "string" ? settings.login : null;
		const connectionName =
			input.name ||
			(login
				? `${input.provider}: ${login}`
				: `${input.provider} connection`);

		const configJson = (input.config ?? {}) as Prisma.InputJsonValue;
		const dataConnectionProvider =
			providerInfo.dataConnectionProvider as import("@repo/database").DataConnectionProvider;

		// Create or update the DataConnection
		const existing = await getDataConnectionByProvider({
			provider: dataConnectionProvider,
			userId: user.id,
			organizationId,
		});

		if (existing) {
			await updateDataConnection({
				id: existing.id,
				userId: user.id,
				organizationId,
				data: {
					name: connectionName,
					status: "CONNECTED",
					accessToken,
					config: configJson,
				},
			});

			// Re-fetch the updated connection
			const updated = await getDataConnectionByProvider({
				provider: dataConnectionProvider,
				userId: user.id,
				organizationId,
			});

			return { connection: toClientConnection(updated) };
		}

		const connection = await createDataConnection({
			userId: user.id,
			organizationId,
			provider: dataConnectionProvider,
			name: connectionName,
			createdBy: user.id,
			accessToken,
			config: configJson,
			status: "CONNECTED",
		});

		return { connection: toClientConnection(connection) };
	});

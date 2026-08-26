import { ORPCError } from "@orpc/client";
import { listWorkflowIntegrations } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * List integrations procedure
 * Returns all configured integrations for a user/organization
 */

const IntegrationTypeEnum = z.enum([
	"AI_GATEWAY",
	"ASANA",
	"ATTIO",
	"BITBUCKET",
	"BLOB",
	"CANVA",
	"CLERK",
	"CLICKUP",
	"CONFLUENCE",
	"CUSTOM_WEBHOOK",
	"DATABASE",
	"DATABRICKS_VECTOR_SEARCH",
	"FAL",
	"FIRECRAWL",
	"FRESHSERVICE",
	"FRONT",
	"GITHUB",
	"GITLAB",
	"GMAIL",
	"GOOGLE_DRIVE",
	"HUBSPOT",
	"INTERCOM",
	"JIRA",
	"LINEAR",
	"MCP",
	"MICROSOFT_GRAPH",
	"NHTSA_VPIC",
	"NOTION",
	"PERPLEXITY",
	"RESEND",
	"SALESFORCE",
	"SLACK",
	"STRIPE",
	"SUPERAGENT",
	"TELEGRAM",
	"WEBFLOW",
	"ZENDESK",
]);

export const listIntegrationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/integrations",
		tags: ["Workflows", "Integrations"],
		summary: "List integrations",
		description:
			"List all configured integrations for the user/organization",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			provider: IntegrationTypeEnum.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
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

		const integrations = await listWorkflowIntegrations({
			userId: user.id,
			organizationId,
			provider: input.provider,
		});

		// Return integrations with decrypted credentials (masked for security)
		return {
			integrations: integrations.map(
				(integration: {
					id: string;
					provider: string;
					name: string;
					isActive: boolean;
					credentials: string;
					lastUsedAt: Date | null;
					createdAt: Date;
				}) => {
					let hasCredentials = false;
					let credentialKeys: string[] = [];

					// Integrations that require no credentials (public APIs)
					const NO_CREDENTIALS_REQUIRED = ["NHTSA_VPIC"];

					try {
						const decrypted = JSON.parse(
							decryptApiKey(integration.credentials),
						);
						hasCredentials =
							Object.keys(decrypted).length > 0 ||
							NO_CREDENTIALS_REQUIRED.includes(
								integration.provider,
							);
						credentialKeys = Object.keys(decrypted);
					} catch (error) {
						// Surface decrypt/parse failures rather than swallowing —
						// a silently-false `hasCredentials` looks identical in the
						// UI to "never connected" and routes test/save flows down
						// the wrong path. Common causes: BETTER_AUTH_SECRET
						// rotation invalidating older AES-GCM auth tags, or a
						// row corrupted by partial write.
						console.error("[listIntegrations] decrypt failed", {
							integrationId: integration.id,
							provider: integration.provider,
							error:
								error instanceof Error
									? error.message
									: String(error),
						});
					}

					return {
						id: integration.id,
						provider: integration.provider,
						name: integration.name,
						isActive: integration.isActive,
						hasCredentials,
						credentialKeys,
						lastUsedAt: integration.lastUsedAt,
						createdAt: integration.createdAt,
					};
				},
			),
		};
	});

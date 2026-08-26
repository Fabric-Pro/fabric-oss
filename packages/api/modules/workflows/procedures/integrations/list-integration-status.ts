import { ORPCError } from "@orpc/client";
import { listWorkflowIntegrationsInTenant } from "@repo/database";
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
 * List integration status procedure
 * Returns a tenant-wide, non-secret status summary for the integrations
 * catalog/status surfaces. Unlike listIntegrationsProcedure (owner-scoped,
 * used by management/test/save flows), this is intentionally tenant-wide so
 * every org member sees the same "is this connected" state — but it must
 * never leak per-row detail (credentialKeys, timestamps) since those
 * describe another member's connection, not the viewer's own.
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

export const listIntegrationStatusProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/integrations/status",
		tags: ["Workflows", "Integrations"],
		summary: "List integration status (tenant-wide)",
		description:
			"Tenant-wide, masked integration status for catalog/status surfaces. " +
			"Returns only non-secret fields (id, provider, name, isActive, " +
			"hasCredentials) for every integration visible in the current " +
			"personal or organization context, regardless of which member " +
			"created it. Not a substitute for the owner-scoped list used by " +
			"management, test-connection, or save/disconnect flows.",
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

		const integrations = await listWorkflowIntegrationsInTenant({
			userId: user.id,
			organizationId,
			provider: input.provider,
		});

		// Return only masked, non-secret status fields — no credentialKeys,
		// lastUsedAt, or createdAt, since those describe another member's
		// connection in tenant-wide (org) context.
		return {
			integrations: integrations.map(
				(integration: {
					id: string;
					provider: string;
					name: string;
					isActive: boolean;
					credentials: string;
				}) => {
					let hasCredentials = false;

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
					} catch (error) {
						// Surface decrypt/parse failures rather than swallowing —
						// a silently-false `hasCredentials` looks identical in the
						// UI to "never connected" and routes test/save flows down
						// the wrong path. Common causes: BETTER_AUTH_SECRET
						// rotation invalidating older AES-GCM auth tags, or a
						// row corrupted by partial write.
						console.error(
							"[listIntegrationStatus] decrypt failed",
							{
								integrationId: integration.id,
								provider: integration.provider,
								error:
									error instanceof Error
										? error.message
										: String(error),
							},
						);
					}

					return {
						id: integration.id,
						provider: integration.provider,
						name: integration.name,
						isActive: integration.isActive,
						hasCredentials,
					};
				},
			),
		};
	});

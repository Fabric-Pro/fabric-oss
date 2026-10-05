import { ORPCError } from "@orpc/client";
import {
	createWorkflowIntegration,
	listWorkflowIntegrations,
	updateWorkflowIntegration,
} from "@repo/database";
import {
	connectGitLab,
	credentialGitLabOrigin,
	GITLAB_DEFAULT_ORIGIN,
	getGitLabConnectionStatus,
} from "@repo/integrations/gitlab";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { authorizeGitLabTenant } from "../../../integrations/lib/gitlab-request-tenant";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Save integration procedure
 * Creates or updates an integration's credentials
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

export const saveIntegrationProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/integrations/save",
		tags: ["Workflows", "Integrations"],
		summary: "Save integration credentials",
		description: "Create or update an integration's credentials",
	})
	.input(
		z.object({
			type: IntegrationTypeEnum,
			credentials: z.record(z.string(), z.string()),
			organizationId: z.string().nullable().optional(),
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

		// Integrations that require no credentials (public APIs)
		const NO_CREDENTIALS_REQUIRED: string[] = ["NHTSA_VPIC"];
		const isCredentialless = NO_CREDENTIALS_REQUIRED.includes(input.type);

		// Providers that primarily authenticate via OAuth. When such a
		// provider hits the "no credentials" branch we point users at the
		// OAuth flow instead of asking for an API key they don't have.
		// Keep in sync with apps/web/modules/saas/workflows/components/integrations/
		// WorkflowIntegrationSettingsPageContent.tsx OAUTH_INTEGRATIONS.
		const OAUTH_SUPPORTED_PROVIDERS: string[] = [
			"ASANA",
			"GITHUB",
			"GOOGLE_DRIVE",
			"HUBSPOT",
			"INTERCOM",
			"LINEAR",
			"MICROSOFT_GRAPH",
			"NOTION",
			"SLACK",
		];
		const supportsOAuth = OAUTH_SUPPORTED_PROVIDERS.includes(input.type);

		// Filter out masked placeholder values (e.g. "••••••••") that the frontend
		// pre-fills for existing credentials. Saving these would overwrite the real key.
		// Empty strings are tracked separately to allow clearing optional fields on update.
		const MASKED_PATTERN = /^[\u2022]+$/; // Unicode bullet character •
		const cleanedCredentials: Record<string, string> = {};
		const clearedKeys: string[] = [];
		let hasRealValue = false;
		for (const [key, value] of Object.entries(input.credentials)) {
			if (MASKED_PATTERN.test(value)) {
				// Masked placeholder — skip (preserves existing value)
			} else if (value === "") {
				// Empty string — user cleared this field
				clearedKeys.push(key);
			} else {
				cleanedCredentials[key] = value;
				hasRealValue = true;
			}
		}

		// GitLab: the person's ONE GitLab connection, written by the connection
		// service. A personal access token REPLACES whatever grant was there —
		// built from scratch, so no OAuth refresh token or issuer survives it —
		// rather than being merged into the old credential.
		if (input.type === "GITLAB") {
			// The person's connection is read (it can classify) and written in
			// this tenant: WORKSPACE_UPDATE — this procedure's permission —
			// checked in the organization the request resolves to, not only
			// the session's, and no organization refused (ADR-018) rather
			// than a no-organization connection written.
			const tenant = await authorizeGitLabTenant(
				Permissions.WORKSPACE_UPDATE,
				input.organizationId,
				context,
			);
			const accessToken = cleanedCredentials.GITLAB_ACCESS_TOKEN;
			if (!accessToken) {
				const status = await getGitLabConnectionStatus(tenant);
				if (status.connected && status.integrationId) {
					return {
						success: true,
						integrationId: status.integrationId,
						message:
							"GITLAB integration unchanged (no new credentials provided)",
					};
				}
				throw new ORPCError("BAD_REQUEST", {
					message: "Enter a GitLab personal access token.",
				});
			}
			// The instance the token belongs to, from whichever address field
			// the form sent. An address that is present but refused (not
			// https, a loopback / private / metadata host, unparsable) is an
			// error — never quietly replaced by gitlab.com, which would send a
			// self-hosted token there.
			const named = credentialGitLabOrigin(cleanedCredentials);
			if (named.present && !named.ok) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Enter a valid GitLab URL: ${named.reason}.`,
				});
			}
			const origin = named.present
				? (named as { origin: string }).origin
				: GITLAB_DEFAULT_ORIGIN;
			const written = await connectGitLab(tenant, {
				accessToken,
				refreshToken: null,
				expiresAt: null,
				scopes: [],
				issuer: { kind: "pat", origin },
				// The person just entered this token.
				freshGrant: true,
			});
			if (!written.written) {
				throw new ORPCError("CONFLICT", {
					message:
						"Your GitLab connection changed while saving. Please try again.",
				});
			}
			return {
				success: true,
				integrationId: written.integrationId,
				message: "GITLAB integration saved successfully",
			};
		}

		// Check if integration already exists
		const existingIntegrations = await listWorkflowIntegrations({
			userId: user.id,
			organizationId,
			provider: input.type,
		});

		// If all values were masked placeholders (and no fields cleared), skip the save
		if (!hasRealValue && clearedKeys.length === 0 && !isCredentialless) {
			if (existingIntegrations.length > 0) {
				return {
					success: true,
					integrationId: existingIntegrations[0].id,
					message: `${input.type} integration unchanged (no new credentials provided)`,
				};
			}
			throw new ORPCError("BAD_REQUEST", {
				message: supportsOAuth
					? "This integration uses OAuth. Connect your account first — no manual credentials are needed."
					: "No valid credentials provided. Please enter your actual API key or token.",
			});
		}

		// Merge with existing credentials so masked fields are preserved
		let mergedCredentials = cleanedCredentials;
		if (existingIntegrations.length > 0) {
			const existing = existingIntegrations[0];
			try {
				const existingDecrypted = JSON.parse(
					decryptApiKey(existing.credentials),
				) as Record<string, string>;
				// Existing values are the base; non-masked new values override
				mergedCredentials = {
					...existingDecrypted,
					...cleanedCredentials,
				};
				// Remove keys that were explicitly cleared (set to empty string)
				for (const key of clearedKeys) {
					delete mergedCredentials[key];
				}
			} catch {
				// If decryption fails, use only the new credentials
				mergedCredentials = cleanedCredentials;
			}
		}

		// Encrypt credentials
		const encryptedCredentials = encryptApiKey(
			JSON.stringify(mergedCredentials),
		);

		if (existingIntegrations.length > 0) {
			// Update existing integration
			const existing = existingIntegrations[0];
			await updateWorkflowIntegration(
				existing.id,
				user.id,
				{
					credentials: encryptedCredentials,
				},
				organizationId,
			);

			return {
				success: true,
				integrationId: existing.id,
				message: `${input.type} integration updated successfully`,
			};
		}

		// Create new integration
		const integration = await createWorkflowIntegration({
			userId: user.id,
			organizationId,
			provider: input.type,
			name: input.type,
			credentials: encryptedCredentials,
		});

		return {
			success: true,
			integrationId: integration.id,
			message: `${input.type} integration saved successfully`,
		};
	});

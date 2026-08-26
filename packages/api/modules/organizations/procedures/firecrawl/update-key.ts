import { ORPCError } from "@orpc/server";
import { updateOrganizationFirecrawlKey } from "@repo/database";
import { encryptApiKey, isValidApiKeyFormat } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

export const updateOrganizationFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/firecrawl/key",
		tags: ["Organizations"],
		summary: "Update organization Firecrawl API key",
		description: "Update the organization's Firecrawl API key",
	})
	.input(
		z.object({
			organizationId: z.string(),
			apiKey: z.string().min(1, "API key is required"),
			enabled: z.boolean().default(true),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(
		async ({ context, input: { organizationId, apiKey, enabled } }) => {
			const { user } = context;
			// Verify organization membership (admin or owner only)
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership || !["admin", "owner"].includes(membership.role)) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only admins and owners can update Firecrawl settings",
				});
			}

			// Validate API key format
			if (!isValidApiKeyFormat(apiKey)) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Invalid API key format. Key must be at least 20 characters and contain no whitespace.",
				});
			}

			// Encrypt the API key before storing
			const encryptedKey = encryptApiKey(apiKey);

			// Update in database
			await updateOrganizationFirecrawlKey({
				organizationId,
				apiKey: encryptedKey,
				enabled,
			});

			// Audit-log emission. Firecrawl is treated as an
			// org-level integration whose API key + enabled flag are
			// reconfigured here. The metadata records `enabled` (boolean —
			// no value secrets) but NEVER the apiKey itself; the redactor
			// would catch it but we omit at source.
			recordAuditFromRequest(context, {
				action: "org.integration.config_updated",
				category: "org",
				organizationId,
				resource: {
					type: "integration",
					id: "firecrawl",
					name: "firecrawl",
				},
				metadata: {
					provider: "firecrawl",
					enabled,
				},
			});

			return {
				success: true,
				message: "Firecrawl API key updated successfully",
			};
		},
	);

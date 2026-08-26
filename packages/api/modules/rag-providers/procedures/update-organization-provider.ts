import { ORPCError } from "@orpc/server";
import {
	getOrganizationById,
	upsertOrganizationRagProvider,
} from "@repo/database";
import { encryptApiKey, isValidApiKeyFormat, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Update or create RAG provider configuration for an organization
 * Admin only
 */
export const updateOrganizationProvider = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_RAG_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/rag-providers/{providerName}",
		tags: ["RAG Providers"],
		summary: "Update organization RAG provider",
		description:
			"Update or create a RAG extraction provider configuration for an organization (admin only)",
	})
	.input(
		z.object({
			organizationId: z.string(),
			providerName: z.string(),
			apiKey: z.string().optional(),
			endpoint: z.string().url().optional().nullable(),
			isDefault: z.boolean().optional(),
			priority: z.number().int().min(0).optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			provider: z.object({
				id: z.string(),
				providerName: z.string(),
				maskedApiKey: z.string().nullable(),
				endpoint: z.string().nullable(),
				isDefault: z.boolean(),
				priority: z.number(),
				enabled: z.boolean(),
			}),
		}),
	)
	.handler(
		async ({
			context: { user },
			input: {
				organizationId,
				providerName,
				apiKey,
				endpoint,
				isDefault,
				priority,
				enabled,
			},
		}) => {
			// Verify organization exists
			const organization = await getOrganizationById(organizationId);

			if (!organization) {
				throw new ORPCError("NOT_FOUND", {
					message: "Organization not found",
				});
			}

			// Verify user is organization admin
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			// Check if user is admin or owner
			if (membership.role !== "admin" && membership.role !== "owner") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can manage RAG providers",
				});
			}

			// Validate provider name
			const validProviders = [
				"local-pdf",
				"local-docx",
				"local-text",
				"unstructured",
				"llamaparse",
				"azure-document-intelligence",
			];

			if (!validProviders.includes(providerName)) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Invalid provider name. Must be one of: ${validProviders.join(", ")}`,
				});
			}

			// Encrypt API key if provided
			let encryptedApiKey: string | undefined;
			if (apiKey) {
				// Validate API key format
				if (!isValidApiKeyFormat(apiKey)) {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid API key format",
					});
				}
				encryptedApiKey = encryptApiKey(apiKey);
			}

			// Update in database
			const updated = await upsertOrganizationRagProvider({
				organizationId,
				providerName,
				encryptedApiKey,
				endpoint: endpoint ?? undefined,
				isDefault,
				priority,
				enabled,
			});

			return {
				success: true,
				provider: {
					id: updated.id,
					providerName: updated.providerName,
					maskedApiKey: updated.encryptedApiKey
						? maskApiKey(updated.encryptedApiKey)
						: null,
					endpoint: updated.endpoint,
					isDefault: updated.isDefault,
					priority: updated.priority,
					enabled: updated.enabled,
				},
			};
		},
	);

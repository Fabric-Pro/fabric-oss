import { ORPCError } from "@orpc/server";
import {
	getOrganizationById,
	upsertOrganizationSearchProvider,
} from "@repo/database";
import { encryptApiKey, isValidApiKeyFormat, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const VALID_PROVIDERS = [
	"exa",
	"tavily",
	"firecrawl",
	"youtube",
	"parallel",
	"jina",
];

/**
 * Update or create search provider configuration for an organization
 */
export const updateOrganizationProvider = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_INTEGRATIONS_MANAGE))
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/search-providers/{providerName}",
		tags: ["Search Providers"],
		summary: "Update organization search provider",
		description:
			"Update or create a search provider configuration for an organization (admin only)",
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

			if (!membership || !["owner", "admin"].includes(membership.role)) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only organization admins can modify provider configurations",
				});
			}

			// Validate provider name
			if (!VALID_PROVIDERS.includes(providerName)) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Invalid provider name. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
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
			const updated = await upsertOrganizationSearchProvider({
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

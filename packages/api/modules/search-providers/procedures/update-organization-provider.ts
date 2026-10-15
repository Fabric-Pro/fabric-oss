import { ORPCError } from "@orpc/server";
import {
	getOrganizationById,
	getOrganizationSearchProvider,
	upsertOrganizationSearchProvider,
} from "@repo/database";
import { getSearchEndpointBlockReason } from "@repo/search";
import { encryptApiKey, isValidApiKeyFormat } from "@repo/utils";
import { parseCloudflareAccountId } from "@repo/utils/cloudflare-browser-rendering";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { maskStoredApiKey } from "../lib/provider-key";

const VALID_PROVIDERS = [
	"exa",
	"tavily",
	"firecrawl",
	"youtube",
	"parallel",
	"jina",
	"cloudflare",
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
			context,
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
			const { user } = context;
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

			// A stored endpoint is fetched later on paths with no caller present
			// to refuse it: check it at the write as well as on every request.
			if (endpoint) {
				const blockReason = getSearchEndpointBlockReason(endpoint);
				if (blockReason) {
					throw new ORPCError("BAD_REQUEST", {
						message: `Provider endpoint rejected: ${blockReason}`,
					});
				}
			}

			// Cloudflare Browser Rendering keeps its account ID in `endpoint`, as
			// the account-scoped API base URL. Check the endpoint the row will
			// hold after this write: the incoming one, or the stored one when
			// the update leaves it out (the upsert keeps it then).
			if (providerName === "cloudflare") {
				const effectiveEndpoint =
					endpoint ||
					(
						await getOrganizationSearchProvider({
							organizationId,
							providerName,
						})
					)?.endpoint;
				if (!parseCloudflareAccountId(effectiveEndpoint)) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Cloudflare Browser Rendering needs a valid account ID: the endpoint must be https://api.cloudflare.com/client/v4/accounts/ followed by the 32-character account ID.",
					});
				}
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

			// Non-secret facts only: never the key, its ciphertext or mask, and
			// no endpoint text in any form (a path can carry a secret).
			const auditMetadata = {
				providerName,
				keyChanged: Boolean(apiKey),
				endpointSupplied: endpoint != null,
				endpointConfigured: Boolean(updated.endpoint),
				enabled: updated.enabled,
				isDefault: updated.isDefault,
				priority: updated.priority,
			};
			recordAuditFromRequest(context, {
				action: "org.integration.config_updated",
				category: "org",
				organizationId,
				resource: {
					type: "integration",
					id: providerName,
					name: providerName,
				},
				metadata: auditMetadata,
			});

			return {
				success: true,
				provider: {
					id: updated.id,
					providerName: updated.providerName,
					maskedApiKey: maskStoredApiKey(
						updated.encryptedApiKey,
						apiKey,
					),
					endpoint: updated.endpoint,
					isDefault: updated.isDefault,
					priority: updated.priority,
					enabled: updated.enabled,
				},
			};
		},
	);

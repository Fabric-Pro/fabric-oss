import {
	getOrganizationFirecrawlConfig,
	getOrganizationSearchProviders,
	getUserFirecrawlConfig,
	getUserSearchProviders,
} from "@repo/database";
import { decryptApiKey, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Get all search provider configurations for the current user or organization
 *
 * TENANT ISOLATION:
 * - If organizationId is provided, returns org search providers
 * - Otherwise, returns user's personal search providers
 *
 * Also checks for legacy Firecrawl config for backward compatibility
 */
export const getUserProviders = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_INTEGRATIONS_READ))
	.route({
		method: "GET",
		path: "/search-providers/user",
		tags: ["Search Providers"],
		summary: "Get search providers",
		description:
			"Get all search provider configurations for the current user or organization",
	})
	.input(
		z
			.object({
				organizationId: z.string().nullable().optional(),
			})
			.optional(),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				providerName: z.string(),
				maskedApiKey: z.string().nullable(),
				endpoint: z.string().nullable(),
				isDefault: z.boolean(),
				priority: z.number().int(),
				enabled: z.boolean(),
				lastUsedAt: z.date().nullable(),
				searchesCount: z.number().int(),
				totalCost: z.number(),
			}),
		),
	)
	.handler(async ({ input, context: { user } }) => {
		const organizationId = input?.organizationId;
		const isOrgContext = !!organizationId;

		try {
			const contextType = isOrgContext ? "organization" : "personal";
			console.log(
				`[Search Providers] Fetching providers for ${contextType} context:`,
				isOrgContext ? organizationId : user.id,
			);

			// TENANT ISOLATION: Fetch providers based on context
			const providers = isOrgContext
				? await getOrganizationSearchProviders(organizationId)
				: await getUserSearchProviders(user.id);
			console.log(
				"[Search Providers] Found providers:",
				providers.length,
			);

			const result = providers.map((provider) => {
				// Decrypt and mask API key before returning
				let maskedKey: string | null = null;
				if (provider.encryptedApiKey) {
					try {
						const decryptedKey = decryptApiKey(
							provider.encryptedApiKey,
						);
						maskedKey = maskApiKey(decryptedKey);
					} catch (error) {
						console.error(
							"[Search Providers] Failed to decrypt API key:",
							error,
						);
						maskedKey = "***";
					}
				}

				return {
					id: provider.id,
					providerName: provider.providerName,
					maskedApiKey: maskedKey,
					endpoint: provider.endpoint,
					isDefault: provider.isDefault,
					priority: provider.priority,
					enabled: provider.enabled,
					lastUsedAt: provider.lastUsedAt,
					searchesCount: provider.searchesCount,
					totalCost: provider.totalCost,
				};
			});

			// Check for legacy Firecrawl config
			// This provides backward compatibility until users/orgs migrate to the new system
			const hasFirecrawlInNewSystem = result.some(
				(p) => p.providerName === "firecrawl",
			);

			if (!hasFirecrawlInNewSystem) {
				// TENANT ISOLATION: Check legacy Firecrawl in the appropriate context
				const legacyFirecrawl = isOrgContext
					? await getOrganizationFirecrawlConfig(organizationId)
					: await getUserFirecrawlConfig(user.id);

				if (
					legacyFirecrawl?.firecrawlApiKey &&
					legacyFirecrawl.firecrawlEnabled
				) {
					console.log(
						`[Search Providers] Found legacy Firecrawl config in ${contextType} context, including in response`,
					);
					let maskedKey: string | null = null;
					try {
						const decryptedKey = decryptApiKey(
							legacyFirecrawl.firecrawlApiKey,
						);
						maskedKey = maskApiKey(decryptedKey);
					} catch (error) {
						console.error(
							"[Search Providers] Failed to decrypt legacy Firecrawl key:",
							error,
						);
						maskedKey = "***";
					}

					result.push({
						id: isOrgContext
							? `legacy-firecrawl-org-${organizationId}`
							: `legacy-firecrawl-${user.id}`,
						providerName: "firecrawl",
						maskedApiKey: maskedKey,
						endpoint: null,
						isDefault: false,
						priority: 100, // Lower priority than explicitly configured providers
						enabled: true,
						lastUsedAt: legacyFirecrawl.firecrawlLastUsedAt,
						searchesCount: 0,
						totalCost: 0,
					});
				}
			}

			return result;
		} catch (error) {
			console.error(
				"[Search Providers] Error fetching providers:",
				error,
			);
			throw error;
		}
	});

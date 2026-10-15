import {
	getOrganizationSearchProviders,
	getUserFirecrawlConfig,
	getUserSearchProviders,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { maskStoredApiKey } from "../lib/provider-key";

/**
 * Get all search provider configurations for the current user or organization
 *
 * TENANT ISOLATION:
 * - If organizationId is provided, returns org search providers
 * - Otherwise, returns user's personal search providers
 *
 * Personal context also includes the user's legacy Firecrawl config for
 * backward compatibility
 */
export const getUserProviders = tenantProtectedProcedure
	// Against the organization named in the input, which is the one whose
	// providers (masked key, endpoint, usage) are returned — not the session's.
	// A null organization passes through deliberately: it reads only the
	// caller's own personal rows (userId-scoped, nothing of an organization),
	// and every organization role holds this read permission, so passing it
	// through skips no role decision. Writes on this surface require one.
	.use(requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ))
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
				const maskedKey = maskStoredApiKey(provider.encryptedApiKey);

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
			// This provides backward compatibility until users migrate to the new system
			const hasFirecrawlInNewSystem = result.some(
				(p) => p.providerName === "firecrawl",
			);

			// Only personal context has a legacy Firecrawl key; organizations
			// use unified search provider rows exclusively.
			if (!hasFirecrawlInNewSystem && !isOrgContext) {
				const legacyFirecrawl = await getUserFirecrawlConfig(user.id);

				if (
					legacyFirecrawl?.firecrawlApiKey &&
					legacyFirecrawl.firecrawlEnabled
				) {
					console.log(
						`[Search Providers] Found legacy Firecrawl config in ${contextType} context, including in response`,
					);
					const maskedKey = maskStoredApiKey(
						legacyFirecrawl.firecrawlApiKey,
					);

					result.push({
						id: `legacy-firecrawl-${user.id}`,
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

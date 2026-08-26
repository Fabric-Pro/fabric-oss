import {
	getOrganizationRagProviders,
	getUserRagProviders,
} from "@repo/database";
import { decryptApiKey, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Get RAG provider configurations for the current user or organization
 *
 * TENANT ISOLATION:
 * - If organizationId is provided, returns org RAG providers
 * - Otherwise, returns user's personal RAG providers
 */
export const getUserProviders = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_RAG_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/rag-providers/user",
		tags: ["RAG Providers"],
		summary: "Get RAG providers",
		description:
			"Get all RAG extraction provider configurations for the current user or organization",
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
				createdAt: z.date(),
				updatedAt: z.date(),
				lastUsedAt: z.date().nullable(),
				documentsProcessed: z.number().int(),
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
				`[RAG Providers] Fetching providers for ${contextType} context:`,
				isOrgContext ? organizationId : user.id,
			);

			// TENANT ISOLATION: Fetch providers based on context
			const providers = isOrgContext
				? await getOrganizationRagProviders(organizationId)
				: await getUserRagProviders(user.id);
			console.log("[RAG Providers] Found providers:", providers.length);

			// Decrypt and mask API keys before returning
			const result = providers.map((provider) => {
				let maskedKey: string | null = null;
				if (provider.encryptedApiKey) {
					try {
						const decryptedKey = decryptApiKey(
							provider.encryptedApiKey,
						);
						maskedKey = maskApiKey(decryptedKey);
					} catch (error) {
						console.error(
							"[RAG Providers] Failed to decrypt API key:",
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
					createdAt: provider.createdAt,
					updatedAt: provider.updatedAt,
					lastUsedAt: provider.lastUsedAt,
					documentsProcessed: provider.documentsProcessed,
					totalCost: provider.totalCost,
				};
			});

			console.log("[RAG Providers] Returning result:", result);
			return result;
		} catch (error) {
			console.error("[RAG Providers] Error:", error);
			throw error;
		}
	});

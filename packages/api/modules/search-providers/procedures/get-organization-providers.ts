import { ORPCError } from "@orpc/server";
import {
	getOrganizationById,
	getOrganizationSearchProviders,
} from "@repo/database";
import { decryptApiKey, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Get all search provider configurations for an organization
 */
export const getOrganizationProviders = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_INTEGRATIONS_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/search-providers",
		tags: ["Search Providers"],
		summary: "Get organization search providers",
		description:
			"Get all search provider configurations for an organization",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				providerName: z.string(),
				maskedApiKey: z.string().nullable(),
				endpoint: z.string().nullable(),
				isDefault: z.boolean(),
				priority: z.number(),
				enabled: z.boolean(),
				lastUsedAt: z.date().nullable(),
				searchesCount: z.number(),
				totalCost: z.number(),
			}),
		),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		// Verify organization exists
		const organization = await getOrganizationById(organizationId);

		if (!organization) {
			throw new ORPCError("NOT_FOUND", {
				message: "Organization not found",
			});
		}

		// Verify user is organization member
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const providers = await getOrganizationSearchProviders(organizationId);

		return providers.map((provider) => {
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
	});

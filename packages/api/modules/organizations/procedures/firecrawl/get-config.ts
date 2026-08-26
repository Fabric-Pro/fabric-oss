import { ORPCError } from "@orpc/server";
import { getOrganizationFirecrawlConfig } from "@repo/database";
import { decryptApiKey, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

export const getOrganizationFirecrawlConfigProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/firecrawl/config",
		tags: ["Organizations"],
		summary: "Get organization Firecrawl configuration",
		description: "Get the organization's Firecrawl API configuration",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.output(
		z.object({
			enabled: z.boolean(),
			configured: z.boolean(),
			apiKey: z.null(),
			maskedApiKey: z.string().nullable(),
			configuredAt: z.date().nullable(),
			lastUsedAt: z.date().nullable(),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		// Verify organization membership
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const config = await getOrganizationFirecrawlConfig(organizationId);

		if (!config) {
			return {
				enabled: false,
				configured: false,
				apiKey: null,
				maskedApiKey: null,
				configuredAt: null,
				lastUsedAt: null,
			};
		}

		// Decrypt and mask the API key for display
		let maskedKey: string | null = null;
		if (config.firecrawlApiKey) {
			try {
				const decryptedKey = decryptApiKey(config.firecrawlApiKey);
				maskedKey = maskApiKey(decryptedKey);
			} catch {
				maskedKey = null;
			}
		}

		return {
			enabled: config.firecrawlEnabled,
			configured: !!config.firecrawlApiKey,
			apiKey: null, // Never return the actual key
			maskedApiKey: maskedKey,
			configuredAt: config.firecrawlConfiguredAt,
			lastUsedAt: config.firecrawlLastUsedAt,
		};
	});

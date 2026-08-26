import { getUserFirecrawlConfig } from "@repo/database";
import { decryptApiKey, maskApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getUserFirecrawlConfigProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/firecrawl/config",
		tags: ["Users"],
		summary: "Get user Firecrawl configuration",
		description: "Get the current user's Firecrawl API configuration",
	})
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
	.handler(async ({ context: { user } }) => {
		const config = await getUserFirecrawlConfig(user.id);

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

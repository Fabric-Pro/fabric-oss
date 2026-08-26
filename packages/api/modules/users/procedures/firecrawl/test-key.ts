import { ORPCError } from "@orpc/server";
import { getUserFirecrawlConfig } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const testUserFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "POST",
		path: "/users/firecrawl/test",
		tags: ["Users"],
		summary: "Test user Firecrawl API key",
		description: "Test if the current user's Firecrawl API key is valid",
	})
	.output(
		z.object({
			valid: z.boolean(),
			message: z.string(),
			details: z
				.object({
					creditsUsed: z.number().optional(),
					creditsRemaining: z.number().optional(),
				})
				.optional(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		// Get user's Firecrawl config
		const config = await getUserFirecrawlConfig(user.id);

		if (!config?.firecrawlApiKey) {
			throw new ORPCError("NOT_FOUND", {
				message: "No Firecrawl API key configured",
			});
		}

		// Decrypt the API key
		const apiKey = decryptApiKey(config.firecrawlApiKey);

		try {
			// Test the API key by making a lightweight request to Firecrawl's scrape endpoint
			// We use a simple URL to minimize costs and API usage
			const response = await fetch(
				"https://api.firecrawl.dev/v1/scrape",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						url: "https://example.com",
						formats: ["markdown"],
						onlyMainContent: true,
					}),
				},
			);

			// 401 = Unauthorized (invalid API key)
			// 403 = Forbidden (invalid API key or insufficient permissions)
			if (response.status === 401 || response.status === 403) {
				return {
					valid: false,
					message:
						"Invalid API key. Please check your Firecrawl API key.",
				};
			}

			// 402 = Payment Required (valid key but out of credits)
			if (response.status === 402) {
				return {
					valid: true,
					message:
						"API key is valid but you're out of credits. Please add credits to your Firecrawl account.",
				};
			}

			// 429 = Rate limit exceeded (valid key but too many requests)
			if (response.status === 429) {
				return {
					valid: true,
					message:
						"API key is valid but rate limit exceeded. Try again later.",
				};
			}

			// 2xx = Success (valid key and request succeeded)
			if (response.status >= 200 && response.status < 300) {
				return {
					valid: true,
					message: "API key is valid and working correctly.",
				};
			}

			// Any other 4xx or 5xx error
			if (response.status >= 400) {
				const errorData = await response.json().catch(() => ({}));
				return {
					valid: false,
					message: `API key validation failed: ${errorData.error || response.statusText}`,
				};
			}

			// Default success case
			return {
				valid: true,
				message: "API key is valid and working correctly.",
			};
		} catch (error) {
			console.error("Firecrawl test error:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to test Firecrawl API key",
			});
		}
	});

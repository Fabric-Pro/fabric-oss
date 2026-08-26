import { ORPCError } from "@orpc/server";
import { createProvider, type TestConnectionResult } from "@repo/search";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const VALID_PROVIDERS = [
	"exa",
	"tavily",
	"firecrawl",
	"youtube",
	"jina",
	"parallel",
];

/**
 * Test connection to a search provider with given credentials
 */
export const testProviderConnection = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_INTEGRATIONS_READ))
	.route({
		method: "POST",
		path: "/search-providers/test",
		tags: ["Search Providers"],
		summary: "Test search provider connection",
		description:
			"Test connection to a search provider with the given API key",
	})
	.input(
		z.object({
			providerName: z.string(),
			apiKey: z.string(),
			endpoint: z.string().url().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			error: z.string().optional(),
			responseTime: z.number().optional(),
			info: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.handler(async ({ input: { providerName, apiKey, endpoint } }) => {
		// Validate provider name
		if (!VALID_PROVIDERS.includes(providerName)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Invalid provider name. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
			});
		}

		// Create provider instance
		const provider = createProvider(providerName, apiKey, endpoint);

		if (!provider) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to create provider instance for ${providerName}`,
			});
		}

		// Test connection
		try {
			const result: TestConnectionResult =
				await provider.testConnection();
			return {
				success: result.success,
				error: result.error,
				responseTime: result.responseTime,
				info: result.info,
			};
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Unknown error occurred",
			};
		}
	});

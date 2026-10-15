import { ORPCError } from "@orpc/server";
import {
	createProvider,
	getSearchEndpointBlockReason,
	type TestConnectionResult,
} from "@repo/search";
import { parseCloudflareAccountId } from "@repo/utils/cloudflare-browser-rendering";
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
	"cloudflare",
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

		// A custom endpoint is a URL the server will fetch on the caller's
		// behalf: refuse internal destinations before any request leaves.
		if (endpoint) {
			const blockReason = getSearchEndpointBlockReason(endpoint);
			if (blockReason) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Provider endpoint rejected: ${blockReason}`,
				});
			}
		}

		// Cloudflare's account ID arrives as the account-scoped endpoint, and
		// the test request is sent there with the token: refuse a malformed one
		// before anything is sent.
		if (
			providerName === "cloudflare" &&
			!parseCloudflareAccountId(endpoint)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Cloudflare Browser Rendering needs a valid account ID: the endpoint must be https://api.cloudflare.com/client/v4/accounts/ followed by the 32-character account ID.",
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

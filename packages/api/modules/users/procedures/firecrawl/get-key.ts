import { ORPCError } from "@orpc/server";
import { getUserFirecrawlConfig } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getUserFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/firecrawl/key",
		tags: ["Users"],
		summary: "Get user Firecrawl API key",
		description: "Get the decrypted Firecrawl API key for viewing/copying",
	})
	.output(
		z.object({
			apiKey: z.string(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		const config = await getUserFirecrawlConfig(user.id);

		if (!config?.firecrawlApiKey) {
			throw new ORPCError("NOT_FOUND", {
				message: "No Firecrawl API key configured",
			});
		}

		// Decrypt and return the API key
		const apiKey = decryptApiKey(config.firecrawlApiKey);

		return {
			apiKey,
		};
	});

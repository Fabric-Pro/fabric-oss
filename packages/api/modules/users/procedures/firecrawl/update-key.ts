import { ORPCError } from "@orpc/server";
import { updateUserFirecrawlKey } from "@repo/database";
import { encryptApiKey, isValidApiKeyFormat } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const updateUserFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "PUT",
		path: "/users/firecrawl/key",
		tags: ["Users"],
		summary: "Update user Firecrawl API key",
		description: "Update the current user's Firecrawl API key",
	})
	.input(
		z.object({
			apiKey: z.string().min(1, "API key is required"),
			enabled: z.boolean().default(true),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ context: { user }, input: { apiKey, enabled } }) => {
		// Validate API key format
		if (!isValidApiKeyFormat(apiKey)) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Invalid API key format. Key must be at least 20 characters and contain no whitespace.",
			});
		}

		// Encrypt the API key before storing
		const encryptedKey = encryptApiKey(apiKey);

		// Update in database
		await updateUserFirecrawlKey({
			userId: user.id,
			apiKey: encryptedKey,
			enabled,
		});

		return {
			success: true,
			message: "Firecrawl API key updated successfully",
		};
	});

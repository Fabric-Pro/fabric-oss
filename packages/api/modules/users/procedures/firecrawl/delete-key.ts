import { deleteUserFirecrawlKey } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const deleteUserFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/firecrawl/delete-key",
		tags: ["Users"],
		summary: "Delete user Firecrawl API key",
		description: "Delete the current user's Firecrawl API key",
	})
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		await deleteUserFirecrawlKey(user.id);

		return {
			success: true,
			message: "Firecrawl API key deleted successfully",
		};
	});

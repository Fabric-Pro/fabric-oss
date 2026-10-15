import { deleteUserFirecrawlKey } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
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
	.handler(async ({ context }) => {
		await deleteUserFirecrawlKey(context.user.id);

		recordAuditFromRequest(context, {
			action: "account.integration.disconnected",
			category: "account",
			organizationId: null,
			resource: {
				type: "integration",
				id: "firecrawl",
				name: "firecrawl",
			},
			metadata: { provider: "firecrawl" },
		});

		return {
			success: true,
			message: "Firecrawl API key deleted successfully",
		};
	});

import { ORPCError } from "@orpc/server";
import { deleteOrganizationFirecrawlKey } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

export const deleteOrganizationFirecrawlKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DELETE))
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/firecrawl/delete-key",
		tags: ["Organizations"],
		summary: "Delete organization Firecrawl API key",
		description: "Delete the organization's Firecrawl API key",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		// Verify organization membership (admin or owner only)
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership || !["admin", "owner"].includes(membership.role)) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only admins and owners can delete Firecrawl settings",
			});
		}

		await deleteOrganizationFirecrawlKey(organizationId);

		return {
			success: true,
			message: "Firecrawl API key deleted successfully",
		};
	});

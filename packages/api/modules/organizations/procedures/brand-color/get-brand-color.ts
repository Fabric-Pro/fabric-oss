import { ORPCError } from "@orpc/server";
import { getOrganizationBrandColor } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

/**
 * Get organization brand color
 *
 * AUTHORIZATION: Requires organization membership
 */
export const getOrganizationBrandColorProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/brand-color",
		tags: ["Organizations"],
		summary: "Get organization brand color",
		description: "Get the organization's brand color for dashboard theming",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.output(
		z.object({
			brandColor: z.string().nullable(),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		// Verify user is organization member
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const brandColor = await getOrganizationBrandColor(organizationId);
		return { brandColor };
	});

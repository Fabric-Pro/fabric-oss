import { ORPCError } from "@orpc/server";
import { updateOrganizationBrandColor } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

// Valid brand colors
const validBrandColors = [
	"teal",
	"blue",
	"purple",
	"pink",
	"orange",
	"green",
	"red",
	"indigo",
] as const;

/**
 * Update organization brand color
 *
 * AUTHORIZATION: Requires organization admin or owner role
 */
export const updateOrganizationBrandColorProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/brand-color",
		tags: ["Organizations"],
		summary: "Update organization brand color",
		description:
			"Update the organization's brand color for dashboard theming",
	})
	.input(
		z.object({
			organizationId: z.string(),
			brandColor: z.enum(validBrandColors).nullable(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			brandColor: z.string().nullable(),
		}),
	)
	.handler(
		async ({
			context: { user },
			input: { organizationId, brandColor },
		}) => {
			// Verify user is organization admin or owner
			const membership = await requireOrgMembership(
				user.id,
				organizationId,
				["admin", "owner"],
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You must be an admin or owner of this organization",
				});
			}

			const result = await updateOrganizationBrandColor({
				organizationId,
				brandColor,
			});

			return {
				success: true,
				brandColor: result.brandColor,
			};
		},
	);

import { ORPCError } from "@orpc/server";
import { updateOrganizationRequireTwoFactor } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Update an organization's MFA-enforcement setting.
 *
 * When enabled, members without two-factor authentication are redirected to
 * enroll before they can access the organization (SOC 2 CC6.1).
 *
 * AUTHORIZATION: Requires organization admin or owner role.
 */
export const updateOrganizationRequireTwoFactorProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_UPDATE))
		.route({
			method: "PUT",
			path: "/organizations/{organizationId}/require-two-factor",
			tags: ["Organizations"],
			summary: "Update organization MFA-enforcement setting",
			description:
				"Enable or disable organization-wide two-factor authentication enforcement (SOC 2 CC6.1).",
		})
		.input(
			z.object({
				organizationId: z.string(),
				requireTwoFactor: z.boolean(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				requireTwoFactor: z.boolean(),
			}),
		)
		.handler(
			async ({
				context: { user },
				input: { organizationId, requireTwoFactor },
			}) => {
				// Only admins/owners may change org security settings.
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

				const result = await updateOrganizationRequireTwoFactor({
					organizationId,
					requireTwoFactor,
				});

				return {
					success: true,
					requireTwoFactor: result.requireTwoFactor,
				};
			},
		);

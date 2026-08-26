import { ORPCError } from "@orpc/server";
import { updateOrganizationDelegationSetting } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Update organization delegation setting
 *
 * AUTHORIZATION: Requires organization admin or owner role
 */
export const updateOrganizationDelegationSettingProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_UPDATE))
		.route({
			method: "PUT",
			path: "/organizations/{organizationId}/delegation-settings",
			tags: ["Organizations"],
			summary: "Update organization delegation setting",
			description:
				"Update the organization's Fabric AI delegation setting",
		})
		.input(
			z.object({
				organizationId: z.string(),
				useDelegatedExecution: z.boolean(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				useDelegatedExecution: z.boolean(),
			}),
		)
		.handler(
			async ({
				context: { user },
				input: { organizationId, useDelegatedExecution },
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

				const result = await updateOrganizationDelegationSetting({
					organizationId,
					useDelegatedExecution,
				});

				return {
					success: true,
					useDelegatedExecution: result.useDelegatedExecution,
				};
			},
		);

import { ORPCError } from "@orpc/server";
import { getOrganizationDelegationSetting } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

/**
 * Get organization delegation setting
 *
 * AUTHORIZATION: Requires organization membership
 */
export const getOrganizationDelegationSettingProcedure =
	tenantProtectedProcedure
		.use(requirePermission(Permissions.ORG_READ))
		.route({
			method: "GET",
			path: "/organizations/{organizationId}/delegation-settings",
			tags: ["Organizations"],
			summary: "Get organization delegation setting",
			description:
				"Get the organization's Fabric AI delegation setting (whether to delegate execution to Fabric AI server or run in Temporal)",
		})
		.input(
			z.object({
				organizationId: z.string(),
			}),
		)
		.output(
			z.object({
				useDelegatedExecution: z.boolean(),
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

			const useDelegatedExecution =
				await getOrganizationDelegationSetting(organizationId);
			return { useDelegatedExecution };
		});

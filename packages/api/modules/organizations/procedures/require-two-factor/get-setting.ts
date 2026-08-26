import { ORPCError } from "@orpc/server";
import { getOrganizationRequireTwoFactor } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../lib/membership";

/**
 * Get an organization's MFA-enforcement setting.
 *
 * AUTHORIZATION: Requires organization membership (any role may read).
 */
export const getOrganizationRequireTwoFactorProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/require-two-factor",
		tags: ["Organizations"],
		summary: "Get organization MFA-enforcement setting",
		description:
			"Whether members must have two-factor authentication enabled to access this organization (SOC 2 CC6.1).",
	})
	.input(
		z.object({
			organizationId: z.string(),
		}),
	)
	.output(
		z.object({
			requireTwoFactor: z.boolean(),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		const membership = await verifyOrganizationMembership(
			organizationId,
			user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const requireTwoFactor =
			await getOrganizationRequireTwoFactor(organizationId);
		return { requireTwoFactor };
	});

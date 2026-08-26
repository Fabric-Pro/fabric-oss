import { ORPCError } from "@orpc/client";
import { getOrganizationMembership } from "@repo/database";
import { getTenantAiCreditAccess } from "@repo/payments";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

function canManageOrganizationBilling(role: string | undefined) {
	return role === "owner" || role === "admin";
}

export const getAiCreditStatus = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_BILLING_READ))
	.route({
		method: "GET",
		path: "/payments/ai-credit-status",
		tags: ["Payments"],
		summary: "Get AI credit status",
		description:
			"Returns the included AI credit balance and billing status for the current user or organization",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input: { organizationId }, context: { user } }) => {
		if (organizationId) {
			const membership = await getOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			const access = await getTenantAiCreditAccess({
				userId: user.id,
				organizationId,
			});

			return {
				...access,
				canManageBilling: canManageOrganizationBilling(membership.role),
			};
		}

		const access = await getTenantAiCreditAccess({
			userId: user.id,
		});

		return {
			...access,
			canManageBilling: true,
		};
	});

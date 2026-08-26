import { ORPCError } from "@orpc/client";
import { getOrganizationMembership } from "@repo/database";
import { logger } from "@repo/logs";
import {
	createPaymentMethodSetupLink as createPaymentMethodSetupLinkFn,
	getCustomerIdFromEntity,
} from "@repo/payments";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

function canManageOrganizationBilling(role: string | undefined) {
	return role === "owner" || role === "admin";
}

export const createPaymentMethodSetupLink = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_BILLING_MANAGE))
	.route({
		method: "POST",
		path: "/payments/create-payment-method-setup-link",
		tags: ["Payments"],
		summary: "Create payment method setup link",
		description:
			"Creates a Stripe Checkout session to add a credit card for a user or organization",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			redirectUrl: z.string().optional(),
		}),
	)
	.handler(
		async ({
			input: { organizationId, redirectUrl },
			context: { user },
		}) => {
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

				if (!canManageOrganizationBilling(membership.role)) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization owners or admins can manage billing",
					});
				}
			}

			try {
				const customerId = await getCustomerIdFromEntity(
					organizationId
						? { organizationId }
						: {
								userId: user.id,
							},
				);

				const checkoutLink = await createPaymentMethodSetupLinkFn({
					email: user.email,
					name: user.name ?? "",
					redirectUrl,
					customerId: customerId ?? undefined,
					...(organizationId
						? { organizationId }
						: { userId: user.id }),
				});

				if (!checkoutLink) {
					throw new ORPCError("INTERNAL_SERVER_ERROR");
				}

				return { checkoutLink };
			} catch (error) {
				logger.error(error);
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		},
	);

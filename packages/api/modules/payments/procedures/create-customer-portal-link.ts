import { ORPCError } from "@orpc/client";
import { getOrganizationMembership, getPurchaseById } from "@repo/database";
import { logger } from "@repo/logs";
import {
	createCustomerPortalLink as createCustomerPortalLinkFn,
	getCustomerIdFromEntity,
} from "@repo/payments";
import { z } from "zod";
import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const createCustomerPortalLink = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_BILLING_MANAGE))
	.use(localeMiddleware)
	.route({
		method: "POST",
		path: "/payments/create-customer-portal-link",
		tags: ["Payments"],
		summary: "Create customer portal link",
		description:
			"Creates a customer portal link for the customer or team. If a purchase is provided, the link will be created for the customer of the purchase.",
	})
	.input(
		z.object({
			purchaseId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
			redirectUrl: z.string().optional(),
		}),
	)
	.handler(
		async ({
			input: { purchaseId, organizationId, redirectUrl },
			context: { user },
		}) => {
			let customerId: string | null = null;

			if (purchaseId) {
				const purchase = await getPurchaseById(purchaseId);

				if (!purchase) {
					throw new ORPCError("FORBIDDEN");
				}

				if (purchase.organizationId) {
					const userOrganizationMembership =
						await getOrganizationMembership(
							purchase.organizationId,
							user.id,
						);
					if (
						userOrganizationMembership?.role !== "owner" &&
						userOrganizationMembership?.role !== "admin"
					) {
						throw new ORPCError("FORBIDDEN");
					}
				}

				if (purchase.userId && purchase.userId !== user.id) {
					throw new ORPCError("FORBIDDEN");
				}

				customerId = purchase.customerId;
			} else {
				if (organizationId) {
					const membership = await getOrganizationMembership(
						organizationId,
						user.id,
					);

					if (
						membership?.role !== "owner" &&
						membership?.role !== "admin"
					) {
						throw new ORPCError("FORBIDDEN");
					}
				}

				customerId = await getCustomerIdFromEntity(
					organizationId
						? { organizationId }
						: {
								userId: user.id,
							},
				);
			}

			if (!customerId) {
				throw new ORPCError("NOT_FOUND", {
					message: "No billing customer was found for this workspace",
				});
			}

			try {
				const customerPortalLink = await createCustomerPortalLinkFn({
					customerId,
					redirectUrl,
				});

				if (!customerPortalLink) {
					throw new ORPCError("INTERNAL_SERVER_ERROR");
				}

				return { customerPortalLink };
			} catch (e) {
				logger.error("Could not create customer portal link", e);
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		},
	);

import { ORPCError } from "@orpc/client";
import { getTenantAiUsageBreakdown } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationAdmin,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getAiUsageBreakdown = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_BILLING_READ))
	.route({
		method: "GET",
		path: "/payments/ai-usage-breakdown",
		tags: ["Payments"],
		summary: "Get AI usage breakdown",
		description:
			"Returns tenant-scoped AI usage totals and cost breakdowns for billing views",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			periodDays: z.number().int().min(1).max(365).optional(),
		}),
	)
	.handler(
		async ({
			input: { organizationId, periodDays },
			context: { user },
		}) => {
			if (organizationId) {
				await requireOrganizationAdmin(organizationId, user.id).catch(
					() => {
						throw new ORPCError("FORBIDDEN", {
							message:
								"Only organization owners or admins can view organization AI usage analytics",
						});
					},
				);

				return await getTenantAiUsageBreakdown({
					organizationId,
					periodDays,
				});
			}

			return await getTenantAiUsageBreakdown({
				userId: user.id,
				periodDays,
			});
		},
	);

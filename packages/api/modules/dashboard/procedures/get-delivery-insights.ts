import { ORPCError } from "@orpc/client";
import { getDeliveryInsights } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getDashboardDeliveryInsights = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.DASHBOARD_READ))
	.route({
		method: "GET",
		path: "/dashboard/delivery-insights",
		tags: ["Dashboard"],
		summary: "Get delivery insights",
		description:
			"Get timestamped feature progress, current delivery flow, and coding-run outcomes for the current user.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			days: z
				.union([z.literal(7), z.literal(30), z.literal(90)])
				.default(30),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization context is required",
			});
		}

		try {
			return await getDeliveryInsights({
				userId: context.user.id,
				organizationId,
				days: input.days,
			});
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			logger.error("[Dashboard] Delivery insights fetch failed", {
				userId: context.user.id,
				organizationId,
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
			});
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Dashboard delivery insights failed: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to load dashboard delivery insights",
			});
		}
	});

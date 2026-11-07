/**
 * Get Dashboard "My Work" Procedure
 *
 * Returns focused, user-scoped work items for the dashboard My Work panel.
 */

import { ORPCError } from "@orpc/client";
import { getMyWork } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getDashboardMyWork = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.DASHBOARD_READ))
	.route({
		method: "GET",
		path: "/dashboard/my-work",
		tags: ["Dashboard"],
		summary: "Get dashboard My Work",
		description:
			"Get actionable work and assigned features for the current user, with project-reach checks and optional delivery-stage filtering.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			organizationSlug: z.string().nullable().optional(),
			limit: z.number().min(1).max(10).default(6),
			featureStage: z
				.enum([
					"all",
					"drafting",
					"sanityCheck",
					"readyForDev",
					"implementing",
					"review",
					"blocked",
				])
				.default("all"),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { organizationId, organizationSlug, limit, featureStage } = input;

		try {
			const resolvedOrganizationId = resolveOrganizationId(
				organizationId,
				context.session,
			);

			return await getMyWork({
				userId: user.id,
				organizationId: resolvedOrganizationId ?? null,
				organizationSlug: organizationSlug ?? null,
				limit,
				featureStage,
			});
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error("[Dashboard] My Work fetch failed", {
				userId: user.id,
				organizationId: organizationId ?? null,
				error: message,
				stack,
			});
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Dashboard my-work failed: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to load dashboard my-work",
			});
		}
	});

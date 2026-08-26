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
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const getDashboardMyWork = tenantProtectedProcedure
	.use(requirePermission(Permissions.DASHBOARD_READ))
	.route({
		method: "GET",
		path: "/dashboard/my-work",
		tags: ["Dashboard"],
		summary: "Get dashboard My Work",
		description:
			"Get actionable work items for the current user (in progress, needs review, blocked, drafts).",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			organizationSlug: z.string().nullable().optional(),
			limit: z.number().min(1).max(10).default(6),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { organizationId, organizationSlug, limit } = input;

		try {
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			return await getMyWork({
				userId: user.id,
				organizationId: organizationId ?? null,
				organizationSlug: organizationSlug ?? null,
				limit,
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

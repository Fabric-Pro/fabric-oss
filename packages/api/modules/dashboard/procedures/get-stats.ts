/**
 * Get Dashboard Statistics Procedure
 *
 * Returns comprehensive dashboard statistics for user or organization
 */

import { ORPCError } from "@orpc/client";
import {
	getOrganizationDashboardStats,
	getUserDashboardStats,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const getDashboardStats = tenantProtectedProcedure
	.use(requirePermission(Permissions.DASHBOARD_READ))
	.route({
		method: "GET",
		path: "/dashboard/stats",
		tags: ["Dashboard"],
		summary: "Get dashboard statistics",
		description:
			"Get comprehensive statistics for user or organization dashboard",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			since: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { organizationId, since } = input;
		const sinceDate = since ? new Date(since) : undefined;

		try {
			// If organizationId provided, verify membership
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

				// Return organization stats - pass userId for project-level access control
				return await getOrganizationDashboardStats(
					organizationId,
					user.id,
					sinceDate,
				);
			}

			// Return user stats
			return await getUserDashboardStats(user.id, sinceDate);
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error("[Dashboard] Stats fetch failed", {
				userId: user.id,
				organizationId: organizationId ?? null,
				error: message,
				stack,
			});
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Dashboard stats failed: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to load dashboard statistics",
			});
		}
	});

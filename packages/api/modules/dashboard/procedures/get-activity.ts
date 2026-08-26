/**
 * Get Dashboard Activity Procedure
 *
 * Returns recent activity for user or organization
 */

import { ORPCError } from "@orpc/client";
import {
	getOrganizationRecentActivity,
	getUserRecentActivity,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const getDashboardActivity = tenantProtectedProcedure
	.use(requirePermission(Permissions.DASHBOARD_READ))
	.route({
		method: "GET",
		path: "/dashboard/activity",
		tags: ["Dashboard"],
		summary: "Get dashboard activity",
		description: "Get recent activity for user or organization dashboard",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(50).default(10),
			since: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { organizationId, limit, since } = input;
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

				// Return organization activity - pass userId for project-level access control
				return await getOrganizationRecentActivity(
					organizationId,
					limit,
					user.id,
					sinceDate,
				);
			}

			// Return user activity
			return await getUserRecentActivity(user.id, limit, sinceDate);
		} catch (error) {
			// Re-throw ORPCErrors (e.g. FORBIDDEN) as-is
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error("[Dashboard] Activity fetch failed", {
				userId: user.id,
				organizationId: organizationId ?? null,
				error: message,
				stack,
			});
			// In development, surface the actual error for debugging
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Dashboard activity failed: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to load dashboard activity",
			});
		}
	});

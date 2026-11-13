import { db } from "@repo/database";
import { z } from "zod";
import {
	getCachedUnreadCount,
	setCachedUnreadCount,
} from "../../../lib/notification-cache";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { bellVisibleWhere } from "../lib/bell-visible-where";
import { resolveNotificationOrganization } from "../lib/resolve-notification-organization";

export const unreadCountNotificationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.NOTIFICATIONS_READ))
	.route({
		method: "GET",
		path: "/notifications/unread-count",
		tags: ["Notifications"],
		summary: "Unread notification count for the active scope",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveNotificationOrganization(
			input.organizationId,
			context,
		);

		const cached = await getCachedUnreadCount(
			context.user.id,
			organizationId,
		);
		const visibleWhere = bellVisibleWhere({
			userId: context.user.id,
			organizationId,
		});
		const countUnreadInScope = (scopeOrganizationId: string | null) =>
			db.notification.count({
				where: {
					...visibleWhere,
					organizationId: scopeOrganizationId,
					readAt: null,
					archivedAt: null,
				},
			});

		// The cache stores only the organization-local component. The global
		// weekly digest is queried live so its database writer does not have to
		// discover and invalidate every organization-specific key for the user.
		if (cached !== null) {
			const globalDigestCount = await countUnreadInScope(null);
			return { count: cached + globalDigestCount };
		}

		const [organizationCount, globalDigestCount] = await Promise.all([
			countUnreadInScope(organizationId),
			countUnreadInScope(null),
		]);

		await setCachedUnreadCount(
			context.user.id,
			organizationId,
			organizationCount,
		);
		return { count: organizationCount + globalDigestCount };
	});

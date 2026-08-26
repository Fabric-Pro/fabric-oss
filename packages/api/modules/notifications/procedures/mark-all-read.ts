import { db } from "@repo/database";
import { z } from "zod";
import { invalidateUnreadCount } from "../../../lib/notification-cache";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const markAllReadNotificationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.NOTIFICATIONS_READ))
	.route({
		method: "POST",
		path: "/notifications/mark-all-read",
		tags: ["Notifications"],
		summary: "Mark all notifications in the active scope as read",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		const result = await db.notification.updateMany({
			where: {
				userId: context.user.id,
				organizationId,
				readAt: null,
				archivedAt: null,
			},
			data: { readAt: new Date() },
		});
		await invalidateUnreadCount(context.user.id, organizationId);
		return { updated: result.count };
	});

import { db } from "@repo/database";
import { z } from "zod";
import { invalidateUnreadCount } from "../../../lib/notification-cache";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const markReadNotificationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.NOTIFICATIONS_READ))
	.route({
		method: "POST",
		path: "/notifications/mark-read",
		tags: ["Notifications"],
		summary: "Mark notifications as read",
	})
	.input(
		z.object({
			ids: z.array(z.string()).min(1).max(100),
		}),
	)
	.handler(async ({ input, context }) => {
		// Capture distinct scopes before the update so we know which cache
		// keys to invalidate. Marked rows can span personal + multiple orgs
		// when the user is a guest in several places.
		const scopes = await db.notification.findMany({
			where: {
				id: { in: input.ids },
				userId: context.user.id,
				readAt: null,
			},
			select: { organizationId: true },
			distinct: ["organizationId"],
		});

		const result = await db.notification.updateMany({
			where: {
				id: { in: input.ids },
				userId: context.user.id,
				readAt: null,
			},
			data: { readAt: new Date() },
		});

		await Promise.all(
			scopes.map((s) =>
				invalidateUnreadCount(context.user.id, s.organizationId),
			),
		);

		return { updated: result.count };
	});

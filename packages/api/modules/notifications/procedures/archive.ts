import { db } from "@repo/database";
import { z } from "zod";
import { invalidateUnreadCount } from "../../../lib/notification-cache";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { bellVisibleWhere } from "../lib/bell-visible-where";
import { resolveNotificationOrganization } from "../lib/resolve-notification-organization";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	ids: z.array(z.string().min(1)).min(1).max(200),
});

/**
 * Archive notifications by id. The shared bell-visibility filter on
 * `updateMany` guarantees a user cannot archive notifications they do not
 * own or cannot see, even when guessing ids belonging to a different
 * recipient or tenant.
 *
 * Targeting only currently-unarchived rows (`archivedAt: null`) makes the
 * operation idempotent and gives an accurate `archived` count to the client.
 *
 * The Redis unread-count cache is invalidated even on a zero-count update,
 * because the calling client typically expects the bell badge to refresh
 * after an archive interaction.
 */
export const archiveNotificationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.NOTIFICATIONS_WRITE))
	.route({
		method: "POST",
		path: "/notifications/archive",
		tags: ["Notifications"],
		summary: "Archive notifications by id",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveNotificationOrganization(
			input.organizationId,
			context,
		);

		const result = await db.notification.updateMany({
			where: {
				...bellVisibleWhere({
					userId: context.user.id,
					organizationId,
				}),
				id: { in: input.ids },
				archivedAt: null,
			},
			data: { archivedAt: new Date() },
		});

		await invalidateUnreadCount(context.user.id, organizationId);
		return { archived: result.count };
	});

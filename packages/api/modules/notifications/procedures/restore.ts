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
 * Restore archived notifications by id. Mirrors `archive` symmetrically:
 *  - Scopes the update to bell-visible rows so cross-user / cross-tenant ids
 *    cannot be flipped back to active while global weekly digests remain
 *    restorable.
 *  - Targets only currently-archived rows (`archivedAt: { not: null }`) so
 *    the operation is idempotent.
 *  - Invalidates the unread-count cache because a restored notification can
 *    re-enter the unread bucket and the bell badge needs to react.
 */
export const restoreNotificationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.NOTIFICATIONS_WRITE))
	.route({
		method: "POST",
		path: "/notifications/restore",
		tags: ["Notifications"],
		summary: "Restore archived notifications by id",
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
				archivedAt: { not: null },
			},
			data: { archivedAt: null },
		});

		await invalidateUnreadCount(context.user.id, organizationId);
		return { restored: result.count };
	});

import { db } from "@repo/database";
import { z } from "zod";
import { invalidateUnreadCount } from "../../../lib/notification-cache";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	ids: z.array(z.string().min(1)).min(1).max(200),
});

/**
 * Restore archived notifications by id. Mirrors `archive` symmetrically:
 *  - Scopes the update to `(userId, organizationId)` so cross-user / cross-
 *    tenant ids cannot be flipped back to active.
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
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		const result = await db.notification.updateMany({
			where: {
				id: { in: input.ids },
				userId: context.user.id,
				organizationId,
				archivedAt: { not: null },
			},
			data: { archivedAt: null },
		});

		await invalidateUnreadCount(context.user.id, organizationId);
		return { restored: result.count };
	});

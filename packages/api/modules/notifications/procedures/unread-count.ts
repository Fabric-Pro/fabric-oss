import { db } from "@repo/database";
import { z } from "zod";
import {
	getCachedUnreadCount,
	setCachedUnreadCount,
} from "../../../lib/notification-cache";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "../lib/incident-notification-types";

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
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;

		const cached = await getCachedUnreadCount(
			context.user.id,
			organizationId,
		);
		if (cached !== null) {
			return { count: cached };
		}

		const count = await db.notification.count({
			where: {
				userId: context.user.id,
				organizationId,
				readAt: null,
				archivedAt: null,
				// Per-incident alert notifications don't count toward the bell;
				// the low-noise weekly digest (same type, distinct dedupe-key
				// prefix) still does.
				OR: [
					{ type: { notIn: INCIDENT_NOTIFICATION_TYPES } },
					{ dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX } },
				],
			},
		});

		await setCachedUnreadCount(context.user.id, organizationId, count);
		return { count };
	});

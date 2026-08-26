/**
 * Notifications Router
 *
 * Per-recipient inbox for the in-app notification center. Procedures are
 * scoped XOR by `(userId, organizationId)`; pass `organizationId: null`
 * for personal context.
 */

import { archiveNotificationsProcedure } from "./procedures/archive";
import { getDeliveryPreferencesProcedure } from "./procedures/get-delivery-preferences";
import { getNotificationPreferencesProcedure } from "./procedures/get-preferences";
import { listNotificationsProcedure } from "./procedures/list";
import { markAllReadNotificationsProcedure } from "./procedures/mark-all-read";
import { markReadNotificationsProcedure } from "./procedures/mark-read";
import { restoreNotificationsProcedure } from "./procedures/restore";
import { rotateWebhookSecretProcedure } from "./procedures/rotate-webhook-secret";
import { unreadCountNotificationsProcedure } from "./procedures/unread-count";
import { updateDeliveryPreferencesProcedure } from "./procedures/update-delivery-preferences";
import { updateNotificationPreferencesProcedure } from "./procedures/update-preferences";

export const notificationsRouter = {
	list: listNotificationsProcedure,
	unreadCount: unreadCountNotificationsProcedure,
	markRead: markReadNotificationsProcedure,
	markAllRead: markAllReadNotificationsProcedure,
	archive: archiveNotificationsProcedure,
	restore: restoreNotificationsProcedure,
	getPreferences: getNotificationPreferencesProcedure,
	updatePreferences: updateNotificationPreferencesProcedure,
	getDeliveryPreferences: getDeliveryPreferencesProcedure,
	updateDeliveryPreferences: updateDeliveryPreferencesProcedure,
	rotateWebhookSecret: rotateWebhookSecretProcedure,
};

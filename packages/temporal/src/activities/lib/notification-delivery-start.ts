/**
 * Start email/webhook delivery for notifications an activity wrote itself,
 * by the rule the API's notification chokepoint applies: read the recipient's
 * delivery preferences and start `notificationDeliveryWorkflow` only when an
 * external channel is on. A recipient on in-app only costs one lookup and
 * starts nothing.
 *
 * The workflow id is `notification-delivery-<notificationId>`, the id the API
 * uses, so each notification is delivered by one workflow whichever side
 * started it.
 *
 * Never throws: the notification already exists in-app, and a failure to
 * start its delivery must not fail or retry the work that wrote it.
 *
 * Lives in ./lib so the activities barrel never exposes it as an activity.
 */
import { getDeliveryPreferences } from "@repo/database";
import { notificationDeliveryChannels } from "@repo/utils/notification-delivery-channels";
import { getTemporalClient } from "../../client";
import type { NotificationDeliveryWorkflowInput } from "../../workflows/notification-delivery";
import { activityLogger } from "./activity-logger";

/** The registered workflow type. */
const NOTIFICATION_DELIVERY_WORKFLOW_TYPE = "notificationDeliveryWorkflow";

/** The general worker's queue, where the delivery activities run. */
const NOTIFICATION_DELIVERY_TASK_QUEUE = "fabric-worker";

export async function startExternalNotificationDelivery(
	notifications: ReadonlyArray<{ id: string; userId: string }>,
): Promise<void> {
	await Promise.all(notifications.map(startOne));
}

async function startOne(notification: {
	id: string;
	userId: string;
}): Promise<void> {
	try {
		const channels = notificationDeliveryChannels(
			await getDeliveryPreferences(notification.userId),
		);
		if (!channels.email && !channels.webhook) {
			return;
		}
		const input: NotificationDeliveryWorkflowInput = {
			notificationId: notification.id,
			channels,
		};
		const client = await getTemporalClient();
		await client.workflow.start(NOTIFICATION_DELIVERY_WORKFLOW_TYPE, {
			taskQueue: NOTIFICATION_DELIVERY_TASK_QUEUE,
			workflowId: `notification-delivery-${notification.id}`,
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			args: [input],
		});
	} catch (error) {
		activityLogger.warn(
			"Could not start external notification delivery; the in-app notification is unaffected",
			{
				notificationId: notification.id,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

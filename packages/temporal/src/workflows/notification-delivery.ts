/**
 * Notification external-delivery workflow.
 *
 * Started fire-and-forget by the API's `createNotification` chokepoint after
 * the in-app row is written, for recipients who have opted into email and/or
 * webhook delivery. Fans out to the enabled channels INDEPENDENTLY via
 * `Promise.allSettled`, so a failure (or exhausted retries) on one channel
 * never blocks the other (AC-5/AC-6). The in-app notification is unaffected
 * regardless — it already exists before this workflow runs.
 *
 * Only `notificationId` + which channels are enabled cross the workflow
 * boundary; the webhook URL/secret are loaded and decrypted inside the activity
 * so plaintext never enters Temporal history.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/notifications/notification-delivery";

export type NotificationDeliveryWorkflowInput = {
	notificationId: string;
	channels: {
		email: boolean;
		webhook: boolean;
	};
};

export type NotificationDeliveryWorkflowOutput = {
	email: "delivered" | "failed" | "skipped";
	webhook: "delivered" | "failed" | "skipped";
};

// Email: a few quick retries. sendEmail itself swallows provider errors and the
// activity returns instead of throwing, so retries here only cover transient
// activity-infra failures.
const { sendNotificationEmailActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "20s",
		maximumAttempts: 3,
	},
});

// Webhook: exponential backoff, capped at 3 attempts (Dev Investigation Item —
// avoid infinite retries / duplicate storms). The activity throws on non-2xx so
// these retries actually engage.
const { sendNotificationWebhookActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

function settledStatus(
	result: PromiseSettledResult<activities.DeliveryOutcome>,
): "delivered" | "failed" {
	return result.status === "fulfilled" && result.value.delivered
		? "delivered"
		: "failed";
}

export async function notificationDeliveryWorkflow(
	input: NotificationDeliveryWorkflowInput,
): Promise<NotificationDeliveryWorkflowOutput> {
	const { notificationId, channels } = input;

	const [emailResult, webhookResult] = await Promise.allSettled([
		channels.email
			? sendNotificationEmailActivity({ notificationId })
			: Promise.resolve({ delivered: false, reason: "skipped" } as const),
		channels.webhook
			? sendNotificationWebhookActivity({ notificationId })
			: Promise.resolve({ delivered: false, reason: "skipped" } as const),
	]);

	return {
		email: channels.email ? settledStatus(emailResult) : "skipped",
		webhook: channels.webhook ? settledStatus(webhookResult) : "skipped",
	};
}

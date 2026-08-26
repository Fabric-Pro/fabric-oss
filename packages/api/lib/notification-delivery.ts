/**
 * External notification delivery dispatch.
 *
 * Called fire-and-forget from the `createNotification` chokepoint right after a
 * fresh in-app row is inserted. Reads the recipient's delivery-channel
 * preferences and, when at least one external channel is enabled, starts the
 * durable `notificationDeliveryWorkflow` to fan out to email/webhook. The
 * common case — a user on in-app-only (no row, both channels off) — short-
 * circuits before touching Temporal, so default users pay no extra latency
 * beyond a single indexed point-lookup.
 *
 * Never throws to the caller: the chokepoint wraps this in `.catch(logFailure)`
 * so a dispatch problem can never break the originating request, mirroring the
 * `dispatchLifecycleEvent(..).catch(..)` discipline used elsewhere.
 */

import { getDeliveryPreferences } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "./temporal-correlation";

/** Minimal shape needed to dispatch — satisfied by a `Notification` row. */
type DeliverableNotification = {
	id: string;
	userId: string;
};

export async function dispatchExternalDelivery(
	notification: DeliverableNotification,
): Promise<void> {
	const prefs = await getDeliveryPreferences(notification.userId);

	const email = prefs.emailEnabled;
	// A webhook channel with no endpoint can't deliver — treat as off.
	const webhook = prefs.webhookEnabled && !!prefs.encryptedWebhookUrl;

	// Fast path: in-app only. No external channels → nothing to dispatch.
	if (!email && !webhook) {
		return;
	}

	const client = await getTemporalClient();
	await client.workflow.start(
		"notificationDeliveryWorkflow",
		withCorrelationMemo({
			taskQueue: "fabric-worker",
			workflowId: `notification-delivery-${notification.id}`,
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			args: [
				{
					notificationId: notification.id,
					channels: { email, webhook },
				},
			],
		}),
	);

	logger.info(
		{
			notificationId: notification.id,
			channels: { email, webhook },
		},
		"[notification-delivery] dispatched external delivery workflow",
	);
}

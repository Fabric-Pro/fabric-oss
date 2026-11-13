/**
 * Which external channels a notification goes out on, from the recipient's
 * delivery preferences. Shared by every writer that starts
 * `notificationDeliveryWorkflow`: the API's notification chokepoint and the
 * Temporal activities that write notifications themselves.
 */

/** The preference fields the rule reads; a delivery-preference row has them. */
export type NotificationDeliveryChannelPreferences = {
	emailEnabled: boolean;
	webhookEnabled: boolean;
	encryptedWebhookUrl: string | null;
};

export type NotificationDeliveryChannels = {
	email: boolean;
	webhook: boolean;
};

export function notificationDeliveryChannels(
	prefs: NotificationDeliveryChannelPreferences,
): NotificationDeliveryChannels {
	return {
		email: prefs.emailEnabled,
		// A webhook channel with no endpoint can't deliver — treat as off.
		webhook: prefs.webhookEnabled && !!prefs.encryptedWebhookUrl,
	};
}

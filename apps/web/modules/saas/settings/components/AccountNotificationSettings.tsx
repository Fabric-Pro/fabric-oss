import { SettingsList } from "@saas/shared/components/SettingsList";
import { NotificationDeliveryForm } from "./NotificationDeliveryForm";
import { NotificationPreferencesForm } from "./NotificationPreferencesForm";
import { SettingsHero } from "./SettingsHero";

/**
 * Notification preferences and delivery channels, rendered identically by the
 * personal route (`/app/settings/notifications`) and the organization one
 * (`/app/{slug}/settings/notifications`) — see Fizzy #1875 R8/R9.
 *
 * Deliberately takes no organization: these preferences belong to the ACCOUNT
 * and apply everywhere its owner is notified. The organization route gives them
 * a reachable home, it does not scope them per tenant.
 */
export function AccountNotificationSettings() {
	return (
		<>
			<SettingsHero
				title="Notifications"
				label="Preferences"
				description="Choose which notification categories appear in your Notification Center. Changes take effect immediately and only apply to new notifications."
			/>
			<SettingsList>
				<NotificationPreferencesForm />
			</SettingsList>
			<SettingsHero
				title="Delivery"
				label="Channels"
				description="Choose where notifications are delivered. In-app is always on; opt in to email or a signed webhook to receive them in the tools you already use."
			/>
			<SettingsList>
				<NotificationDeliveryForm />
			</SettingsList>
		</>
	);
}

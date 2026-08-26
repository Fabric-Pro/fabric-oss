import { NotificationDeliveryForm } from "@saas/settings/components/NotificationDeliveryForm";
import { NotificationPreferencesForm } from "@saas/settings/components/NotificationPreferencesForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";

export async function generateMetadata() {
	return {
		title: "Notification Preferences",
	};
}

export default function NotificationPreferencesPage() {
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

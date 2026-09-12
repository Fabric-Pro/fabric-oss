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
				description="Which notifications you receive, and where. Changes apply to new notifications."
			/>
			<SettingsList>
				<NotificationPreferencesForm />
				<div>
					<h2 className="app-editorial-label mb-1">Delivery</h2>
					<p className="mb-3 text-[13px] text-muted-foreground">
						In-app is always on. Add email or a signed webhook to
						get them in the tools you already use.
					</p>
					<NotificationDeliveryForm />
				</div>
			</SettingsList>
		</>
	);
}

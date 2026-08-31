import { AccountNotificationSettings } from "@saas/settings/components/AccountNotificationSettings";

export async function generateMetadata() {
	return {
		title: "Notification Preferences",
	};
}

/**
 * The organization-reachable home for ACCOUNT notification settings (Fizzy
 * #1875, R8/R9). Same component as `/app/settings/notifications` — the
 * preferences are account-global, so the organization is not passed in and no
 * per-tenant copy of them exists.
 */
export default function OrganizationAccountNotificationsPage() {
	return <AccountNotificationSettings />;
}

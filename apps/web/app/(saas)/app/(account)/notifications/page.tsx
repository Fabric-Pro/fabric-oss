import { getSession } from "@saas/auth/lib/server";
import { NotificationsPage } from "@saas/notifications/pages/NotificationsPage";
import { redirect } from "next/navigation";

export default async function PersonalNotificationsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return <NotificationsPage />;
}

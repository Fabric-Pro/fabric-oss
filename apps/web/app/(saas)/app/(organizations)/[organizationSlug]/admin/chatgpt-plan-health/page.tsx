import { ChatgptPlanHealthList } from "@saas/admin/component/chatgpt-plan-health/ChatgptPlanHealthList";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Plan health — `/app/{organizationSlug}/admin/chatgpt-plan-health`
 * (Fizzy #2770 D6). Every organization's shared ChatGPT plan account; the
 * slug only keeps the admin in their workspace, it does not scope the list.
 * Instance admins only.
 */
export const metadata = {
	title: "Plan Health",
	description:
		"Every organization's shared ChatGPT plan accounts: status, window use, resets and calibrated budgets.",
};

export default async function OrganizationChatgptPlanHealthPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	return <ChatgptPlanHealthList />;
}

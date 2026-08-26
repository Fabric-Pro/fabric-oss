import { AiAdoptionDashboard } from "@saas/admin/component/ai-adoption/AiAdoptionDashboard";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export const metadata = {
	title: "AI Adoption",
	description:
		"Platform-wide adoption and acceptance metrics for AI-generated output.",
};

export default async function AiAdoptionPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	return <AiAdoptionDashboard />;
}

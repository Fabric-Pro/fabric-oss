import { AiAdoptionDashboard } from "@saas/admin/component/ai-adoption/AiAdoptionDashboard";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Workspace-scoped AI adoption dashboard — `/app/{organizationSlug}/admin/ai-adoption`.
 *
 * Renders the same global AiAdoptionDashboard as the canonical
 * `/app/admin/ai-adoption` route. It exists so an admin reaching this page
 * from an organization workspace keeps the slug in the URL — a slug-less
 * destination would flip the workspace selector to "Personal".
 *
 * The metrics are global (instance-wide); the slug does not scope them.
 * Access control is identical to the personal route: instance admin only.
 */
export const metadata = {
	title: "AI Adoption",
	description:
		"Platform-wide adoption and acceptance metrics for AI-generated output.",
};

export default async function OrganizationAiAdoptionPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	return <AiAdoptionDashboard />;
}

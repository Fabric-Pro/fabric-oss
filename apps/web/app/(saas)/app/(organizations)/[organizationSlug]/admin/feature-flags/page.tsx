import { FeatureFlagsPanel } from "@saas/admin/component/feature-flags/FeatureFlagsPanel";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Workspace-scoped feature-flag console — `/app/{organizationSlug}/admin/feature-flags`.
 *
 * Renders the same global FeatureFlagsPanel as the canonical
 * `/app/admin/feature-flags` route. It exists so an admin reaching this page
 * from an organization workspace keeps the slug in the URL — the active
 * workspace is derived purely from that slug, so a slug-less destination would
 * flip the workspace selector to "Personal".
 *
 * Feature flags are global (instance-wide); the slug only preserves "which
 * workspace you are viewing from" and does not scope the flags. Access control
 * is therefore identical to the personal route: instance admin only.
 */
export const metadata = {
	title: "Feature Flags",
	description:
		"Admin console for the DB-backed feature-flag overrides — resolved value and source per flag.",
};

export default async function OrganizationFeatureFlagsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app");
	}

	return <FeatureFlagsPanel />;
}

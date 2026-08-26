import { MonitoringDashboard } from "@saas/admin/component/monitoring/MonitoringDashboard";
import { getSession } from "@saas/auth/lib/server";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { notFound, redirect } from "next/navigation";

/**
 * Workspace-scoped monitoring dashboard — `/app/{organizationSlug}/admin/monitoring`.
 *
 * This renders the exact same global `MonitoringDashboard` as the canonical
 * `/app/admin/monitoring` route. It exists so the in-app incident surfaces (the
 * sidebar `IncidentRailIndicator` and the dashboard `IncidentChip`) can open the
 * dashboard *without dropping the org slug from the URL*. The active workspace is
 * derived purely from that slug, so a slug-less destination would flip the
 * workspace selector to "Personal" — the bug this route fixes. Keeping the slug
 * leaves the user in their current organization workspace.
 *
 * The dashboard data is platform-wide (a system-admin reliability signal across
 * all tenants); the slug only preserves "which workspace you're viewing from",
 * it does not scope the incidents. Access control is therefore identical to the
 * personal route:
 *   - the parent org layout already requires org membership;
 *   - we re-assert the system-admin role here (defense-in-depth — the incident
 *     surfaces also self-gate to system admins before they can ever link here);
 *   - the `feature-admin-monitoring-dashboard` flag gates the page, surfacing
 *     `notFound()` when off to match the rest of the flag-gated saas routes.
 */
export const metadata = {
	title: "Monitoring",
	description:
		"Admin monitoring dashboard — active incidents, provider health, and alert thresholds.",
};

export default async function OrganizationAdminMonitoringPage() {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	if (session.user?.role !== "admin") {
		redirect("/app");
	}
	if (!isMonitoringFeatureEnabled("feature-admin-monitoring-dashboard")) {
		notFound();
	}
	return <MonitoringDashboard />;
}

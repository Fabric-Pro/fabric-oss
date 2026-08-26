import { MonitoringDashboard } from "@saas/admin/component/monitoring/MonitoringDashboard";
import { getSession } from "@saas/auth/lib/server";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { notFound, redirect } from "next/navigation";

/**
 * Admin monitoring dashboard route — `/app/admin/monitoring`.
 *
 * The parent admin layout already enforces the admin role guard (redirects
 * non-admins to `/app`), but we re-assert it here so a direct navigation
 * to this URL never leaks the page boundaries to a non-admin user even if
 * the layout cache misses for any reason.
 *
 * The page is also gated by the `feature-admin-monitoring-dashboard` flag.
 * When the flag is off we surface `notFound()` rather than redirecting,
 * since this is the canonical "feature does not exist" signal that matches
 * the rest of the saas app's flag-gated routes (cf. the parent decision in
 * `apps/web/modules/saas/shared/lib/feature-flags.ts`).
 *
 * Note on data hydration: we intentionally do NOT SSR pre-fetch the active
 * incidents list — the saas app's standard pattern is to hydrate via
 * React Query's client-side fetch because (a) it keeps the page boundary
 * small (the dashboard is fully Client Components), and (b) the same
 * query is reused by the in-app banner so React Query already caches it.
 * If the dashboard later becomes slow on first paint we can revisit with
 * `prefetchQuery` + `dehydrate`.
 */
export const metadata = {
	title: "Monitoring",
	description:
		"Admin monitoring dashboard — active incidents, provider health, and alert thresholds.",
};

export default async function AdminMonitoringPage() {
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

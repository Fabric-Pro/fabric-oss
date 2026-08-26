/**
 * Kill-switch flag for the User Activity dashboard.
 * Same falsy-string parsing as packages/observability/lib/feature-flags.ts:
 * "false" | "0" | "no" | "off" (case-insensitive, trimmed) = OFF,
 * anything else including unset = ON. Server-side only — every gated
 * surface (procedures, settings layout, page) is server code, so no
 * NEXT_PUBLIC_ twin is needed.
 */
export function isUserActivityDashboardEnabled(): boolean {
	const raw = process.env.FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD;
	if (raw === undefined) {
		return true;
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === "") {
		return true;
	}
	return !(
		normalized === "false" ||
		normalized === "0" ||
		normalized === "no" ||
		normalized === "off"
	);
}

/**
 * Server-side flag reader for the User Activity dashboard.
 * Duplicates the tiny parser in packages/api/modules/user-activity/lib/flag.ts
 * (web should not import @repo/api internals). Server components only —
 * the env var has no NEXT_PUBLIC_ twin.
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

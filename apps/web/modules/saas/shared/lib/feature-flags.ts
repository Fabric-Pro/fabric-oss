/**
 * Client / SSR-safe feature flags for the monitoring v2 surfaces.
 *
 * Mirrors the server-side reader at
 * `packages/observability/lib/feature-flags.ts`, but reads `NEXT_PUBLIC_*`
 * env vars so values are inlined into the client bundle by Next.js.
 *
 * IMPORTANT: every public read in this module must use a literal
 * `process.env.NEXT_PUBLIC_*` expression. Next.js inlines these at build
 * time only when the dotted reference is preserved verbatim — indexing
 * `process.env[someString]` short-circuits the optimization and the var
 * returns `undefined` in the client bundle (the same trap that bit the
 * collaboration flag in `DocumentEditor.tsx`).
 *
 * This file is **pure** — no React imports — so it is safe to consume
 * from Server Components, Client Components, route handlers, middleware,
 * and tests. The matching React hook lives in
 * `./use-monitoring-feature-flag.ts` (`"use client"`).
 *
 * v1 launches with ALL flags ON by default (post-App-Insights refactor —
 * these are KILL SWITCHES, not opt-in rollouts). Setting a NEXT_PUBLIC_*
 * env var to `"false"` / `"0"` / `"no"` / `"off"` disables the surface;
 * anything else (including unset) keeps it on.
 *
 * The four flags gate:
 *   - `feature-integration-health-badges`: badges + Status filter on
 *     Settings -> Integrations cards.
 *   - `feature-incident-banner`: the in-app SEV-1 / SEV-2 banner mounted
 *     in the saas shell.
 *   - `feature-admin-monitoring-dashboard`: the `/app/admin/monitoring`
 *     route + sidebar entry.
 *   - `feature-burn-rate-alerts`: client-side knowledge of whether the
 *     App Insights custom-event alert pipeline is active (used by the
 *     admin dashboard for the rules-status panel).
 *
 * When a flag-management UI (GrowthBook / LaunchDarkly / Vercel Edge
 * Config) is wired up later, swap the reader bodies and add a
 * higher-priority lookup — the typed reader API stays the same so
 * callers do not change.
 */

/** Stable identifier for each monitoring v2 surface. Kebab-case. */
export type MonitoringFeatureFlag =
	| "feature-integration-health-badges"
	| "feature-incident-banner"
	| "feature-admin-monitoring-dashboard"
	| "feature-burn-rate-alerts"
	| "feature-google-docs-context"
	| "feature-get-started"
	| "feature-job-hub"
	| "feature-inline-job-progress";

/**
 * The full list of monitoring v2 flags. Keep in sync with the
 * server-side reader; tests on both sides verify this.
 */
export const MONITORING_FEATURE_FLAGS: readonly MonitoringFeatureFlag[] = [
	"feature-integration-health-badges",
	"feature-incident-banner",
	"feature-admin-monitoring-dashboard",
	"feature-burn-rate-alerts",
	"feature-google-docs-context",
	"feature-get-started",
	"feature-job-hub",
	"feature-inline-job-progress",
];

/**
 * Read a single monitoring feature flag.
 *
 * Returns the build-time value of the matching `NEXT_PUBLIC_FABRIC_*` env
 * var. Safe to call from client or server components. On the server it
 * reads `process.env` at runtime; on the client the value was inlined at
 * build time.
 *
 * Kill-switch parsing matches the server reader: returns `false` only
 * when the env var is set to `"false"`, `"0"`, `"no"`, or `"off"`
 * (case-insensitive, trimmed). Anything else — including unset / empty
 * / `"true"` — returns `true`.
 *
 * NOTE: each branch MUST use the literal `process.env.NEXT_PUBLIC_*`
 * expression — see file header.
 */
export function isMonitoringFeatureEnabled(
	flag: MonitoringFeatureFlag,
): boolean {
	switch (flag) {
		case "feature-integration-health-badges":
			return parseFlagValue(
				process.env
					.NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES,
			);
		case "feature-incident-banner":
			return parseFlagValue(
				process.env.NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER,
			);
		case "feature-admin-monitoring-dashboard":
			return parseFlagValue(
				process.env
					.NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD,
			);
		case "feature-burn-rate-alerts":
			return parseFlagValue(
				process.env.NEXT_PUBLIC_FABRIC_FEATURE_BURN_RATE_ALERTS,
			);
		case "feature-google-docs-context":
			return parseFlagValue(
				process.env.NEXT_PUBLIC_FABRIC_FEATURE_GOOGLE_DOCS_CONTEXT,
			);
		case "feature-get-started":
			return parseFlagValue(
				process.env.NEXT_PUBLIC_FABRIC_FEATURE_GET_STARTED,
			);
		case "feature-job-hub":
			return parseFlagValue(
				process.env.NEXT_PUBLIC_FABRIC_FEATURE_JOB_HUB,
			);
		case "feature-inline-job-progress":
			return parseFlagValue(
				process.env.NEXT_PUBLIC_FABRIC_FEATURE_INLINE_JOB_PROGRESS,
			);
		default: {
			// Exhaustiveness check — a future flag added to the union
			// without a matching branch is a compile-time error.
			const _exhaustive: never = flag;
			void _exhaustive;
			return false;
		}
	}
}

/**
 * Read all monitoring feature flags at once. Useful for the admin
 * dashboard's "feature flag status" panel, or for snapshotting flag
 * state at the top of a page render so a flag flip mid-render cannot
 * cause inconsistent UI.
 */
export function getMonitoringFeatureFlags(): Record<
	MonitoringFeatureFlag,
	boolean
> {
	return {
		"feature-integration-health-badges": isMonitoringFeatureEnabled(
			"feature-integration-health-badges",
		),
		"feature-incident-banner": isMonitoringFeatureEnabled(
			"feature-incident-banner",
		),
		"feature-admin-monitoring-dashboard": isMonitoringFeatureEnabled(
			"feature-admin-monitoring-dashboard",
		),
		"feature-burn-rate-alerts": isMonitoringFeatureEnabled(
			"feature-burn-rate-alerts",
		),
		"feature-google-docs-context": isMonitoringFeatureEnabled(
			"feature-google-docs-context",
		),
		"feature-get-started": isMonitoringFeatureEnabled(
			"feature-get-started",
		),
		"feature-job-hub": isMonitoringFeatureEnabled("feature-job-hub"),
		"feature-inline-job-progress": isMonitoringFeatureEnabled(
			"feature-inline-job-progress",
		),
	};
}

/**
 * Internal helper. Falsy strings (case-insensitive, trimmed):
 * `"false"`, `"0"`, `"no"`, `"off"`. Everything else — including unset
 * / empty / `"true"` — returns `true`. Mirrors the server-side reader.
 *
 * Exported for unit tests; not part of the supported public surface.
 */
export function parseFlagValue(raw: string | undefined): boolean {
	if (raw === undefined || raw === null) {
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

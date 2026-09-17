/**
 * Server-side kill switch for the monitoring v2 alert pipeline.
 *
 * One flag lives here, `feature-burn-rate-alerts`, and it is ON by default.
 * It gates whether App Insights `trackEvent` / `trackMetric` calls (and
 * therefore the custom-event-driven KQL alert rules) actually emit. Setting
 * `FABRIC_FEATURE_BURN_RATE_ALERTS=false` is the emergency mute path that
 * disables `CircuitBreakerOpened` + `SyntheticProbeFailing` alerts without
 * redeploying Bicep. Its reader is `initAppInsights` in `./app-insights.ts`,
 * which consults it once, at initialization. The switch is per-env via the
 * env var; there is no per-org override.
 *
 * The monitoring UI surfaces (integration health badges, the incident
 * banner, the admin monitoring dashboard) have no server-side flag. They are
 * gated by the web reader in `apps/web/modules/saas/shared/lib/feature-flags.ts`
 * through their `NEXT_PUBLIC_*` variables. Their server twins were removed
 * (Fizzy #2300): nothing read them, so setting one changed nothing.
 *
 * If a flag-management library is added later, swap the reader body —
 * callers do not change because they only see the typed reader API.
 */

/** Stable identifier for each server-side monitoring switch. Kebab-case. */
export type MonitoringFeatureFlag = "feature-burn-rate-alerts";

/**
 * Map a flag identifier to the server-side env var that controls it.
 *
 * The env-var naming convention is `FABRIC_` + SCREAMING_SNAKE_CASE of the
 * flag id with `feature-` stripped. This map is the single source of truth
 * for the server-side env var name.
 */
export const MONITORING_FEATURE_ENV_VARS: Record<
	MonitoringFeatureFlag,
	string
> = {
	"feature-burn-rate-alerts": "FABRIC_FEATURE_BURN_RATE_ALERTS",
};

/**
 * Every server-side monitoring switch, in deterministic order — useful for
 * diagnostics and tests.
 */
export const MONITORING_FEATURE_FLAGS: readonly MonitoringFeatureFlag[] =
	Object.keys(MONITORING_FEATURE_ENV_VARS) as MonitoringFeatureFlag[];

/**
 * Read a monitoring switch from server-side env vars.
 *
 * Falsy values (case-insensitive): `"false"`, `"0"`, `"no"`, `"off"`.
 * Any other value (including unset, empty string, `"true"`, `"1"`) is
 * treated as enabled — these are KILL SWITCHES. Setting the env var to
 * `"false"` is the explicit disable path; anything else falls through to
 * the default-ON behavior.
 *
 * The reader is **synchronous** and does not cache — every call re-reads
 * `process.env`.
 *
 * @param flag - One of the typed `MonitoringFeatureFlag` literals.
 * @returns `false` only when the env var is set to a falsy string;
 *          `true` otherwise (default ON kill-switch semantics).
 */
export function isMonitoringFeatureEnabled(
	flag: MonitoringFeatureFlag,
): boolean {
	const envVar = MONITORING_FEATURE_ENV_VARS[flag];
	const raw = process.env[envVar];
	return parseFlagValue(raw);
}

/**
 * Internal helper. Exported for unit tests; the web reader carries its own
 * copy with the same parsing.
 *
 * Falsy values: `"false"`, `"0"`, `"no"`, `"off"` (case-insensitive,
 * trimmed). Everything else — including unset/undefined/null/empty —
 * resolves to `true`. These are KILL SWITCHES: explicit-off-or-on,
 * defaulting to ON.
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

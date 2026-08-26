/**
 * Server-side feature flags for the monitoring v2 surfaces.
 *
 * v1 launches with ALL flags ON by default (post-App-Insights refactor —
 * the monitoring stack is now production-tested and the flags act as
 * **kill switches**, not opt-in rollouts). Operators flip them OFF per-env
 * (dev -> staging -> prod) via environment variables when they need to
 * disable a specific surface (e.g. emergency mute of breaker→customEvent
 * emission). Flags are exposed at the page/section level only — there is
 * no per-org override.
 *
 * Flags exposed here gate **server-side** behavior:
 *   - `feature-burn-rate-alerts`: gates whether App Insights `trackEvent`
 *     / `trackMetric` calls (and therefore the custom-event-driven KQL
 *     alert rules) actually emit. Setting `FABRIC_FEATURE_BURN_RATE_ALERTS=false`
 *     is the emergency mute path that disables `CircuitBreakerOpened` +
 *     `SyntheticProbeFailing` alerts without redeploying Bicep.
 *   - `feature-incident-banner` / `feature-integration-health-badges` /
 *     `feature-admin-monitoring-dashboard`: server-side variants are
 *     exposed for activities + procedures that need to gate writes
 *     (e.g., the Statuspage poller writes `IntegrationIncident` rows only
 *     when the banner / badge flag is on, so we never accumulate rows
 *     while the surface is hidden).
 *
 * Client / UI components consume the parallel reader in
 * `apps/web/modules/saas/shared/lib/feature-flags.ts`, which uses the
 * matching `NEXT_PUBLIC_*` variants so values are inlined at build time.
 *
 * Rollout policy:
 *   - default ON everywhere; flags act as emergency kill switches
 *   - kill-switch flip is per-env via env vars, not per-org
 *   - if a flag-management library is added later, swap the reader body —
 *     callers do not change because they only see the typed reader API.
 */

/** Stable identifier for each monitoring v2 surface. Kebab-case. */
export type MonitoringFeatureFlag =
	| "feature-integration-health-badges"
	| "feature-incident-banner"
	| "feature-admin-monitoring-dashboard"
	| "feature-burn-rate-alerts";

/**
 * Map a flag identifier to the server-side env var that controls it.
 *
 * The env-var naming convention is `FABRIC_` + SCREAMING_SNAKE_CASE of the
 * flag id with `feature-` stripped. We strip the prefix so the env var
 * stays short — every flag in this file is already a `feature-*` flag.
 *
 * This map is the single source of truth — tests and the client-side
 * reader both reference it (or its mirror), so renaming one without the
 * other is a type error.
 */
export const MONITORING_FEATURE_ENV_VARS: Record<
	MonitoringFeatureFlag,
	string
> = {
	"feature-integration-health-badges":
		"FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES",
	"feature-incident-banner": "FABRIC_FEATURE_INCIDENT_BANNER",
	"feature-admin-monitoring-dashboard":
		"FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD",
	"feature-burn-rate-alerts": "FABRIC_FEATURE_BURN_RATE_ALERTS",
};

/**
 * The full list of monitoring v2 flags. Iterating over this array gives
 * deterministic order, useful for diagnostics endpoints and tests.
 */
export const MONITORING_FEATURE_FLAGS: readonly MonitoringFeatureFlag[] =
	Object.keys(MONITORING_FEATURE_ENV_VARS) as MonitoringFeatureFlag[];

/**
 * Read a single monitoring feature flag from server-side env vars.
 *
 * Falsy values (case-insensitive): `"false"`, `"0"`, `"no"`, `"off"`.
 * Any other value (including unset, empty string, `"true"`, `"1"`) is
 * treated as enabled — these flags are KILL SWITCHES. Setting the env
 * var to `"false"` is the explicit disable path; anything else falls
 * through to the default-ON behavior.
 *
 * The reader is **synchronous** and does not cache — every call re-reads
 * `process.env`. Worker processes that read flags inside hot loops should
 * snapshot at startup; per-request reads in API procedures are fine
 * because `process.env` access is a property lookup.
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
 * Read all monitoring feature flags at once. Useful for diagnostic
 * endpoints (`/api/admin/feature-flags`) and for snapshotting flag state
 * at the top of a request handler so a flag flip mid-request does not
 * cause split-brain behavior.
 */
export function getMonitoringFeatureFlags(): Record<
	MonitoringFeatureFlag,
	boolean
> {
	const result = {} as Record<MonitoringFeatureFlag, boolean>;
	for (const flag of MONITORING_FEATURE_FLAGS) {
		result[flag] = isMonitoringFeatureEnabled(flag);
	}
	return result;
}

/**
 * Internal helper. Exported only for unit tests + the client-side
 * reader's mirror implementation.
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

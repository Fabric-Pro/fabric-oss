/**
 * Azure Application Insights Node SDK wiring.
 *
 * Replaces the deleted self-hosted Prometheus + Alertmanager stack for
 * metric + alert evaluation. Application Insights is already deployed via
 * `deployment/azure/modules/application-insights.bicep` and the
 * connection string is injected into every Container App as
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` (managed by the Container
 * Apps Environment in `main.bicep`).
 *
 * Public surface (kept tiny on purpose — call sites should not depend on
 * any App Insights internals):
 *
 *   initAppInsights()                — idempotent SDK boot. Safe to call
 *                                       from every entry point. No-op when
 *                                       the env var is unset (local dev).
 *   getAppInsightsClient()           — returns the client instance or `null`
 *                                       when uninitialized.
 *   trackEvent(name, props?)         — emits a `customEvents` row with a
 *                                       bounded `customDimensions` payload.
 *   trackMetric(name, value, props?) — emits a `customMetrics` aggregate
 *                                       sample.
 *
 * Cardinality budget: every property name + value in `properties` MUST be
 * enumerable and bounded. Never pass raw user IDs, full URL paths, or
 * arbitrary user-supplied strings. The `customDimensions` column is
 * indexed by App Insights and unbounded cardinality there is the same
 * billing-blowup hazard the prom-client labels are.
 *
 * NEVER let an App Insights call crash the caller — every public function
 * here wraps the SDK invocation in a try/catch so an instrumentation
 * outage never breaks the hot path. App Insights is observability, not a
 * correctness gate.
 */

import { isMonitoringFeatureEnabled } from "./feature-flags";

/**
 * Internal type for the App Insights `TelemetryClient`. We import the
 * type lazily inside the init function so that consumers who never call
 * `initAppInsights()` never pay the cold-start cost of pulling in the
 * `applicationinsights` package and its transitive deps.
 *
 * `unknown` is the right shape here because we only ever shape the
 * client at the public-surface boundary; internal lookups go through
 * the typed helpers in this file.
 */
type TelemetryClient = {
	trackEvent: (telemetry: {
		name: string;
		properties?: Record<string, unknown>;
	}) => void;
	trackMetric: (telemetry: {
		name: string;
		value: number;
		properties?: Record<string, unknown>;
	}) => void;
	flush: () => void;
};

/**
 * Module-scoped client cache. `null` means "not initialized" (or the env
 * var was unset). The reader path uses this same nullable to short-
 * circuit before doing any work.
 */
let CLIENT: TelemetryClient | null = null;

/** Resolution state — true once `initAppInsights()` has been called. */
let INITIALIZED = false;

/**
 * Resolve the App Insights connection string from the standard env var
 * the Azure SDK and Container Apps managed integration both use.
 */
function readConnectionString(): string | undefined {
	const raw = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
	if (raw && raw.trim() !== "") {
		return raw.trim();
	}
	return undefined;
}

/**
 * Initialize the App Insights SDK from `APPLICATIONINSIGHTS_CONNECTION_STRING`.
 *
 * Idempotent: subsequent calls become no-ops. Safe to call from every
 * service entry point (API boot, Temporal worker boot). When the env var
 * is unset (local dev), the function still marks the module as
 * initialized but leaves `CLIENT` null so the typed helpers below short-
 * circuit.
 *
 * `feature-burn-rate-alerts` is consulted at init time as an emergency
 * mute: when explicitly disabled, the SDK is wired up to handle traces
 * automatically (via the Container Apps managed OTel agent) but
 * `trackEvent` / `trackMetric` emit nothing. This lets operators kill
 * custom-event-driven alert rules (CircuitBreakerStateChange,
 * SyntheticProbeResult) without redeploying.
 */
export function initAppInsights(): void {
	if (INITIALIZED) {
		return;
	}
	INITIALIZED = true;

	const connectionString = readConnectionString();
	if (!connectionString) {
		// Local dev / unit tests — no-op. Callers of trackEvent/Metric
		// will see `getAppInsightsClient() === null` and silently skip.
		return;
	}

	if (!isMonitoringFeatureEnabled("feature-burn-rate-alerts")) {
		// Emergency-mute path — leave CLIENT null so the typed helpers
		// emit nothing. The managed OTel agent in the Container App
		// environment still routes auto-instrumented traces to App
		// Insights, so this only disables the custom event/metric path.
		return;
	}

	try {
		// Late-bound require so unit tests + local dev paths never pull
		// the SDK + its native dependencies. Use `require` (CommonJS)
		// because the `applicationinsights` package's default export is
		// the legacy single-instance API, which is the shape we want.
		// We are not chasing the `setup()` / `start()` ergonomics here —
		// any future migration to the OpenTelemetry distro keeps the
		// `trackEvent` / `trackMetric` surface stable.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const appInsights =
			require("applicationinsights") as typeof import("applicationinsights");

		appInsights
			.setup(connectionString)
			.setAutoCollectExceptions(true)
			.setAutoCollectRequests(true)
			.setAutoCollectDependencies(true)
			.setAutoCollectPerformance(true, true)
			.setAutoCollectConsole(false)
			.setSendLiveMetrics(false)
			.setInternalLogging(false, false)
			.start();

		const defaultClient = appInsights.defaultClient as unknown as
			| TelemetryClient
			| undefined;
		CLIENT = defaultClient ?? null;
	} catch (err) {
		// Never let an init failure crash the host process — App
		// Insights is observability, not a correctness gate.
		console.warn(
			"[app-insights] init failed",
			err instanceof Error ? err.message : err,
		);
		CLIENT = null;
	}
}

/**
 * Return the active client, or `null` when App Insights is unconfigured
 * (e.g. local dev) or the feature flag is muted. Useful for advanced
 * paths that want to call SDK methods we have not wrapped here yet
 * (e.g. `trackTrace` for one-off forensics).
 *
 * Most callers should use {@link trackEvent} / {@link trackMetric} instead.
 */
export function getAppInsightsClient(): TelemetryClient | null {
	return CLIENT;
}

/**
 * Sanitize a property bag for `trackEvent` / `trackMetric`.
 *
 * App Insights accepts `customDimensions` as a string-typed map. Numbers
 * and booleans are coerced to strings for stable querying; objects are
 * dropped entirely (a serialized object is almost certainly a
 * cardinality bomb in disguise).
 */
function sanitizeProperties(
	props: Record<string, string | number | boolean> | undefined,
): Record<string, string> | undefined {
	if (!props) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(props)) {
		if (value === null || value === undefined) {
			continue;
		}
		if (typeof value === "string") {
			out[key] = value;
		} else if (typeof value === "number" || typeof value === "boolean") {
			out[key] = String(value);
		}
		// Objects/arrays are intentionally dropped — see file header.
	}
	return out;
}

/**
 * Emit a custom event to the `customEvents` table.
 *
 * Two production callers:
 *   - circuit-breaker state transitions ("CircuitBreakerStateChange")
 *   - synthetic probe result ("SyntheticProbeResult")
 *
 * Both feed the KQL alert rules in `monitoring.bicep`.
 */
export function trackEvent(
	name: string,
	properties?: Record<string, string | number | boolean>,
): void {
	const client = CLIENT;
	if (!client) {
		return;
	}
	try {
		client.trackEvent({
			name,
			properties: sanitizeProperties(properties),
		});
	} catch (err) {
		// Swallow — see file header.
		console.warn(
			"[app-insights] trackEvent failed",
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * Emit a custom metric sample to the `customMetrics` table.
 *
 * Pair this with the existing prom-client counter increments so the
 * /metrics endpoint stays useful for local dev visibility, but the
 * authoritative aggregation is done by App Insights server-side.
 */
export function trackMetric(
	name: string,
	value: number,
	properties?: Record<string, string | number | boolean>,
): void {
	const client = CLIENT;
	if (!client) {
		return;
	}
	try {
		client.trackMetric({
			name,
			value,
			properties: sanitizeProperties(properties),
		});
	} catch (err) {
		// Swallow — see file header.
		console.warn(
			"[app-insights] trackMetric failed",
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * Test-only hook. Drops the cached client + resets the initialized flag
 * so the next `initAppInsights()` call performs a fresh setup. Not part
 * of the public API surface — guarded by the leading `__`.
 */
export function __resetAppInsightsForTests(): void {
	CLIENT = null;
	INITIALIZED = false;
}

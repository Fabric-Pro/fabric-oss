/**
 * Azure Application Insights Node SDK wiring.
 *
 * Replaces the deleted self-hosted Prometheus + Alertmanager stack for
 * metric + alert evaluation. Production normally exports through the process's
 * existing OpenTelemetry pipeline and its collector. A direct Application
 * Insights connection string remains supported through an isolated manual-only
 * client for backwards compatibility.
 *
 * Public surface (kept tiny on purpose — call sites should not depend on
 * any App Insights internals):
 *
 *   initAppInsights()                — idempotent SDK boot. Safe to call
 *                                       from every entry point. No-op when
 *                                       neither transport is configured.
 *   getAppInsightsClient()           — returns the client instance or `null`
 *                                       when uninitialized.
 *   trackEvent(name, props?)         — emits an App Insights event directly,
 *                                       or a structured OTel log via collector.
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

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { metrics } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
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
	initialize: () => void;
	trackEvent: (telemetry: {
		name: string;
		properties?: Record<string, unknown>;
	}) => void;
	trackMetric: (telemetry: {
		name: string;
		value: number;
		properties?: Record<string, unknown>;
	}) => void;
	flush: () => Promise<void>;
	shutdown: () => Promise<void>;
};

type TelemetryClientFactory = (
	connectionString: string,
	options: { useGlobalProviders: false },
) => TelemetryClient;

/**
 * Module-scoped client cache. `null` means "not initialized" (or the env
 * var was unset). The reader path uses this same nullable to short-
 * circuit before doing any work.
 */
let CLIENT: TelemetryClient | null = null;

type CustomTelemetryTransport = "disabled" | "direct" | "otel";
let TRANSPORT: CustomTelemetryTransport = "disabled";

/** Test seam for the late-bound CommonJS Application Insights package. */
let TEST_CLIENT_FACTORY: TelemetryClientFactory | undefined;

type PackageRequire = (specifier: string) => unknown;

/** ESM-safe require rooted at the emitted bundle or source module. */
const bundleRequire = createRequire(import.meta.url);
let requireFromObservability: PackageRequire | undefined;

/**
 * Resolve the service-bundle fallback lazily. Next/Vercel deployments carry an
 * app-local SDK dependency and should never need the workspace package at
 * runtime; bundled services can use their direct `@repo/observability`
 * dependency as the node_modules resolution boundary.
 */
function loadFromObservabilityPackage(specifier: string): unknown {
	requireFromObservability ??= createRequire(
		bundleRequire.resolve("@repo/observability"),
	);
	return requireFromObservability(specifier);
}

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

const INSTRUMENTATION_KEY_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Application Insights connection strings require a UUID instrumentation key. */
function isValidConnectionString(connectionString: string): boolean {
	let instrumentationKey: string | undefined;
	for (const part of connectionString.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) {
			continue;
		}
		if (
			part.slice(0, separator).trim().toLowerCase() ===
			"instrumentationkey"
		) {
			instrumentationKey = part.slice(separator + 1).trim();
		}
	}
	return (
		instrumentationKey !== undefined &&
		INSTRUMENTATION_KEY_PATTERN.test(instrumentationKey)
	);
}

/** Keep this in sync with initObservability's endpoint/kill-switch policy. */
function isOtelConfigured(): boolean {
	if (process.env.OTEL_ENABLED === "false") {
		return false;
	}
	return (
		process.env.OTEL_ENABLED === "true" ||
		!!process.env.OTEL_EXPORTER_OTLP_ENDPOINT
	);
}

function createDirectClient(connectionString: string): TelemetryClient {
	if (TEST_CLIENT_FACTORY) {
		return TEST_CLIENT_FACTORY(connectionString, {
			useGlobalProviders: false,
		});
	}
	// Late-bound so collector-only deployments and local tests do not load the
	// Azure Monitor distro or its exporter graph.
	const appInsights = loadApplicationInsights();
	return new appInsights.TelemetryClient(connectionString, {
		// AI 3.15 otherwise installs global providers and competes with the
		// process-wide NodeSDK. This provider is manual-only and isolated.
		useGlobalProviders: false,
	}) as unknown as TelemetryClient;
}

function loadApplicationInsights(
	testBundleRequire?: PackageRequire,
	testObservabilityRequire?: PackageRequire,
): typeof import("applicationinsights") {
	try {
		// Keep this literal call visible to Next's output-file tracer. In web
		// deployments it resolves from apps/web's direct SDK dependency.
		return (
			testBundleRequire
				? testBundleRequire("applicationinsights")
				: bundleRequire("applicationinsights")
		) as typeof import("applicationinsights");
	} catch (err) {
		if (
			typeof err !== "object" ||
			err === null ||
			!("code" in err) ||
			err.code !== "MODULE_NOT_FOUND"
		) {
			throw err;
		}
	}

	return (testObservabilityRequire ?? loadFromObservabilityPackage)(
		"applicationinsights",
	) as typeof import("applicationinsights");
}

/**
 * Initialize custom telemetry against a direct App Insights client or OTel.
 *
 * Idempotent: subsequent calls become no-ops. Safe to call from every
 * service entry point (API boot, Temporal worker boot). With a connection
 * string, AI 3.15 gets isolated providers for manual calls only. Otherwise the
 * already-configured global OTel logger and meter carry telemetry to the
 * collector. With neither transport configured, calls remain no-ops.
 *
 * `feature-burn-rate-alerts` is consulted at init time as an emergency
 * mute: when explicitly disabled, the service's general OTel pipeline keeps
 * flowing through its collector but `trackEvent` / `trackMetric` emit
 * nothing. This lets operators kill
 * custom-event-driven alert rules (CircuitBreakerStateChange,
 * SyntheticProbeResult) without redeploying.
 */
export function initAppInsights(): void {
	if (INITIALIZED) {
		return;
	}
	INITIALIZED = true;

	if (!isMonitoringFeatureEnabled("feature-burn-rate-alerts")) {
		// Emergency-mute path — leave both custom transports disabled. The
		// service's general OTel pipeline continues through its collector, so
		// this only disables the burn-rate custom event/metric path.
		return;
	}

	const connectionString = readConnectionString();
	if (connectionString && !isValidConnectionString(connectionString)) {
		console.warn(
			"[app-insights] invalid connection string; direct exporter disabled",
		);
	} else if (connectionString) {
		try {
			CLIENT = createDirectClient(connectionString);
			CLIENT.initialize();
			TRANSPORT = "direct";
			return;
		} catch (err) {
			// Fall through to the process's existing OTel pipeline when it is
			// configured. A broken optional direct exporter must not mute alerts.
			console.warn(
				"[app-insights] init failed",
				err instanceof Error ? err.message : err,
			);
			CLIENT = null;
		}
	}

	if (isOtelConfigured()) {
		TRANSPORT = "otel";
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

function sanitizeOtelAttributes(
	props: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (!props) {
		return out;
	}
	for (const [key, value] of Object.entries(props)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Emit a custom event through the selected exclusive transport.
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
	if (TRANSPORT === "disabled") {
		return;
	}
	try {
		const eventId = randomUUID();
		if (TRANSPORT === "direct") {
			CLIENT?.trackEvent({
				name,
				properties: {
					...sanitizeProperties(properties),
					"event.id": eventId,
				},
			});
			return;
		}

		// Resolve lazily per emission. API bootstrap can call initAppInsights()
		// before initObservability() registers the real global provider.
		logs.getLogger("fabric-custom-events").emit({
			severityNumber: SeverityNumber.INFO,
			severityText: "INFO",
			body: `Custom event: ${name}`,
			attributes: {
				...sanitizeOtelAttributes(properties),
				"event.name": name,
				"event.id": eventId,
				"service.name": process.env.OTEL_SERVICE_NAME || "fabric",
			},
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
 * Emit a custom metric sample through the selected exclusive transport.
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
	if (TRANSPORT === "disabled") {
		return;
	}
	try {
		if (TRANSPORT === "direct") {
			CLIENT?.trackMetric({
				name,
				value,
				properties: sanitizeProperties(properties),
			});
			return;
		}
		metrics
			.getMeter("fabric-custom-metrics")
			.createHistogram(name)
			.record(value, sanitizeOtelAttributes(properties));
	} catch (err) {
		// Swallow — see file header.
		console.warn(
			"[app-insights] trackMetric failed",
			err instanceof Error ? err.message : err,
		);
	}
}

/** Flush and release an isolated direct client without failing shutdown. */
export async function shutdownAppInsights(): Promise<void> {
	const client = CLIENT;
	CLIENT = null;
	TRANSPORT = "disabled";
	INITIALIZED = false;
	if (!client) {
		return;
	}
	try {
		await client.flush();
	} catch (err) {
		console.warn(
			"[app-insights] flush failed",
			err instanceof Error ? err.message : err,
		);
	}
	try {
		await client.shutdown();
	} catch (err) {
		console.warn(
			"[app-insights] shutdown failed",
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
	TRANSPORT = "disabled";
	INITIALIZED = false;
	TEST_CLIENT_FACTORY = undefined;
	requireFromObservability = undefined;
}

/** Install a deterministic manual-client factory without loading the SDK. */
export function __setAppInsightsClientFactoryForTests(
	factory: TelemetryClientFactory,
): void {
	TEST_CLIENT_FACTORY = factory;
}

/** Load the compatibility SDK without constructing providers or exporters. */
export function __loadApplicationInsightsForTests(
	testBundleRequire?: PackageRequire,
	testObservabilityRequire?: PackageRequire,
): unknown {
	return loadApplicationInsights(testBundleRequire, testObservabilityRequire);
}

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
 *
 * `trackTrace`/`trackException` and the `context` cloud-role tag are
 * verified against the installed 3.15 shim:
 *   - trackTrace: node_modules/applicationinsights/out/src/shim/telemetryClient.d.ts:47
 *   - trackException: node_modules/applicationinsights/out/src/shim/telemetryClient.d.ts:52
 *   - trackException's own `severity` field: node_modules/applicationinsights/
 *     out/src/declarations/contracts/telemetryTypes/exceptionTelemetry.d.ts:17-20
 *   - context: node_modules/applicationinsights/out/src/shim/telemetryClient.d.ts:12
 *   - context.keys/tags shape: node_modules/applicationinsights/out/src/shim/context.d.ts:3-6
 *   - cloudRole key + the SDK's own usage example:
 *     node_modules/applicationinsights/out/src/shared/util/contextTagKeys.d.ts:79-81
 *   - severity strings ("Warning"/"Error"/"Critical"):
 *     node_modules/applicationinsights/out/src/declarations/generated/models/index.d.ts:296-302
 *     (`KnownSeverityLevel`, re-exported from the package root at out/src/index.d.ts:3)
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
	trackTrace: (telemetry: {
		message: string;
		severity?: string;
		properties?: Record<string, unknown>;
	}) => void;
	trackException: (telemetry: {
		exception: Error;
		severity?: string;
		properties?: Record<string, unknown>;
	}) => void;
	context: {
		tags: Record<string, string>;
		keys: { cloudRole: string };
	};
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

/**
 * True once `ensureDirectClient()` has resolved once, successfully or not.
 * Distinct from `CLIENT === null` (which also means "not initialized yet")
 * so a failed/absent connection string is not re-validated and re-warned on
 * every subsequent `trackLog`/`trackLogException` call.
 */
let CLIENT_INIT_ATTEMPTED = false;

/** Resolution state — true once `initAppInsightsLogs()` has been called. */
let LOGS_INITIALIZED = false;

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
 * Lazily create (or return the cached) isolated direct client, independent
 * of `feature-burn-rate-alerts` — that flag gates only whether
 * `trackEvent`/`trackMetric` EMIT anything, never whether a client exists.
 * `initAppInsights()` and `initAppInsightsLogs()` both call this, so a
 * process that boots only one of them (e.g. the web app calling only the
 * latter) still gets a real, shared client.
 *
 * Idempotent and memoized: once a connection-string attempt has resolved
 * (to a client, or to nothing), later calls return the cached outcome
 * without re-validating or re-warning. Returns `null` — silently for an
 * absent connection string, with a warning for an invalid or
 * failed-to-construct one — exactly as `initAppInsights()` always has.
 */
function ensureDirectClient(): TelemetryClient | null {
	if (CLIENT) {
		return CLIENT;
	}
	if (CLIENT_INIT_ATTEMPTED) {
		return null;
	}
	CLIENT_INIT_ATTEMPTED = true;

	const connectionString = readConnectionString();
	if (!connectionString) {
		return null;
	}
	if (!isValidConnectionString(connectionString)) {
		console.warn(
			"[app-insights] invalid connection string; direct exporter disabled",
		);
		return null;
	}
	try {
		const client = createDirectClient(connectionString);
		client.initialize();
		CLIENT = client;
		return CLIENT;
	} catch (err) {
		console.warn(
			"[app-insights] init failed",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
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
 * SyntheticProbeResult) without redeploying. It does NOT gate log
 * forwarding — see `initAppInsightsLogs()`.
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

	const client = ensureDirectClient();
	if (client) {
		TRANSPORT = "direct";
		return;
	}

	if (isOtelConfigured()) {
		TRANSPORT = "otel";
	}
}

/**
 * Initialize log forwarding to App Insights — independent of
 * `feature-burn-rate-alerts` and of `initAppInsights()`. A service that
 * never boots the burn-rate custom-event path (the web app) still wants its
 * `logger.warn`/`error`/`fatal` calls to reach App Insights.
 *
 * Idempotent and a no-op without a valid connection string, exactly like
 * `initAppInsights()`. Sets the App Insights cloud-role-name tag so traces
 * and exceptions from this process are attributable in the portal (see the
 * SDK's own usage example cited on `TelemetryClient` above).
 */
export function initAppInsightsLogs({
	cloudRoleName,
}: {
	cloudRoleName: string;
}): void {
	if (LOGS_INITIALIZED) {
		return;
	}
	LOGS_INITIALIZED = true;
	try {
		const client = ensureDirectClient();
		if (client) {
			client.context.tags[client.context.keys.cloudRole] = cloudRoleName;
		}
	} catch (err) {
		// Swallow — see file header.
		console.warn(
			"[app-insights] initAppInsightsLogs failed",
			err instanceof Error ? err.message : err,
		);
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
	props: Record<string, unknown> | undefined,
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

// ============================================================================
// Log forwarding (independent of `feature-burn-rate-alerts`)
// ============================================================================

/** Matches consola's warn/error/fatal `LogType` — the levels `@repo/logs`
 *  forwards to a sink. */
export type LogSeverity = "warn" | "error" | "fatal";

/** App Insights' own severity strings — see the citation on `TelemetryClient`. */
const SEVERITY_BY_LOG_LEVEL: Record<LogSeverity, string> = {
	warn: "Warning",
	error: "Error",
	fatal: "Critical",
};

const SAMPLING_WINDOW_MS = 60_000;
const DEFAULT_SAMPLING_LIMIT = 20;

type SamplingBucket = {
	windowStart: number;
	tokens: number;
	suppressed: number;
	severity: LogSeverity;
};

/** Per-key token bucket, one entry per distinct sampling key per process. */
const SAMPLING_BUCKETS = new Map<string, SamplingBucket>();
let SAMPLING_LIMIT = DEFAULT_SAMPLING_LIMIT;

/** Bounded discriminators worth their own sampling bucket even under the
 *  same `event` — a fixed, small-cardinality set (route names, oRPC error
 *  codes, HTTP statuses, the client-report `kind` enum), never arbitrary
 *  free text. Without these, every `rpc.error` record from every procedure
 *  shares ONE 20/min budget, and one noisy 403 on one route starves 5xx
 *  alerting for every other route. */
const SAMPLING_KEY_DISCRIMINANT_FIELDS = [
	"procedure",
	"code",
	"status",
	"kind",
] as const;

/**
 * The record's sampling identity: `properties.event` when the caller set
 * one (the structured discriminator most call sites already pass — see
 * `packages/api/orpc/rpc-error-logging.ts`), combined with whichever of
 * `SAMPLING_KEY_DISCRIMINANT_FIELDS` are present, so distinct routes/codes/
 * statuses under the same event get separate budgets. Without an `event`,
 * falls back to the severity plus a normalized message prefix, so near-
 * identical unstructured lines (a stack trace's leading words, say) still
 * bucket together.
 */
function samplingKey(
	severity: LogSeverity,
	message: string,
	properties: Record<string, unknown> | undefined,
): string {
	const event = properties?.event;
	if (typeof event !== "string" || event.length === 0) {
		const prefix = message.slice(0, 60).trim().toLowerCase();
		return `${severity}:${prefix}`;
	}
	const parts = [event];
	for (const field of SAMPLING_KEY_DISCRIMINANT_FIELDS) {
		const value = properties?.[field];
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			parts.push(String(value));
		}
	}
	return parts.join(":");
}

/**
 * Token-bucket sampling, 20/min per key by default. Returns `true` when this
 * record should actually be forwarded. When a key's window rolls over (the
 * first record for that key after >= 60s) and the PREVIOUS window suppressed
 * anything, emits one "suppressed N similar records" trace for it before
 * evaluating the new window — never a running total, never per-suppression.
 */
function shouldForward(key: string, severity: LogSeverity): boolean {
	const now = Date.now();
	let bucket = SAMPLING_BUCKETS.get(key);
	if (!bucket || now - bucket.windowStart >= SAMPLING_WINDOW_MS) {
		if (bucket && bucket.suppressed > 0) {
			emitSuppressedTrace(key, bucket.suppressed, bucket.severity);
		}
		bucket = {
			windowStart: now,
			tokens: SAMPLING_LIMIT,
			suppressed: 0,
			severity,
		};
		SAMPLING_BUCKETS.set(key, bucket);
	}
	bucket.severity = severity;
	if (bucket.tokens > 0) {
		bucket.tokens--;
		return true;
	}
	bucket.suppressed++;
	return false;
}

/** The one-line summary emitted when a sampling window rolls over. Bypasses
 *  `shouldForward` itself — a summary of suppressions is never suppressed. */
function emitSuppressedTrace(
	key: string,
	suppressed: number,
	severity: LogSeverity,
): void {
	const client = CLIENT;
	if (!client) {
		return;
	}
	try {
		client.trackTrace({
			message: `Suppressed ${suppressed} similar records for key "${key}"`,
			severity: SEVERITY_BY_LOG_LEVEL[severity],
			properties: { event: "app-insights.log-sampling-suppressed" },
		});
	} catch {
		// Swallow — see file header.
	}
}

/**
 * Forward one log record to App Insights as a `trackTrace`. No-op when no
 * direct client is configured (absent/invalid connection string) — this is
 * the log-forwarding half of the pipeline `@repo/logs` attaches via
 * `addLogSink`; it never throws into the logger it is attached to.
 */
export function trackLog(
	severity: LogSeverity,
	message: string,
	properties?: Record<string, unknown>,
): void {
	try {
		const client = ensureDirectClient();
		if (!client) {
			return;
		}
		const key = samplingKey(severity, message, properties);
		if (!shouldForward(key, severity)) {
			return;
		}
		client.trackTrace({
			message,
			severity: SEVERITY_BY_LOG_LEVEL[severity],
			properties: sanitizeProperties(properties),
		});
	} catch (err) {
		// Swallow — see file header.
		console.warn(
			"[app-insights] trackLog failed",
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * Forward an exception to App Insights as a `trackException`. Sampled under
 * the same per-key token bucket as `trackLog`, keyed the same way (bounded
 * discriminators plus `properties.event` when set, else severity + message
 * prefix) so a hot-path exception and its own log line about the same event
 * share one budget rather than each getting 20/min independently.
 *
 * `severity` defaults to `"error"` — the level almost every caller already
 * has (`@repo/logs`'s `LogSinkRecord.level` for an entry that carries an
 * `error`), and matters because a `fatal`-level exception should read as
 * Critical in the portal, not Error. `ExceptionTelemetry.severity` is a real
 * field on the installed shim: node_modules/applicationinsights/out/src/
 * declarations/contracts/telemetryTypes/exceptionTelemetry.d.ts:17-20.
 */
export function trackLogException(
	error: Error,
	properties?: Record<string, unknown>,
	severity: LogSeverity = "error",
): void {
	try {
		const client = ensureDirectClient();
		if (!client) {
			return;
		}
		const key = samplingKey(severity, error.message, properties);
		if (!shouldForward(key, severity)) {
			return;
		}
		client.trackException({
			exception: error,
			severity: SEVERITY_BY_LOG_LEVEL[severity],
			properties: sanitizeProperties(properties),
		});
	} catch (err) {
		// Swallow — see file header.
		console.warn(
			"[app-insights] trackLogException failed",
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * Flush pending log/trace telemetry without shutting the client down.
 * Vercel Fluid Compute freezes the process between requests, so batched
 * telemetry must be flushed inside `after()` on every request — see
 * `apps/web/app/api/[[...rest]]/route.ts`. Unlike `shutdownAppInsights()`,
 * this keeps the client alive for the next request.
 */
export async function flushAppInsights(): Promise<void> {
	const client = CLIENT;
	if (!client) {
		return;
	}
	try {
		// A key that goes quiet (no new record after its window rolled over)
		// never gets another `shouldForward` call to lazily emit its
		// summary — the only other place that happens. Every scheduled flush
		// (Vercel's `after()`, this process's own periodic flush) is also a
		// chance to catch up on any bucket sitting on an elapsed window.
		const now = Date.now();
		for (const [key, bucket] of SAMPLING_BUCKETS) {
			if (
				bucket.suppressed > 0 &&
				now - bucket.windowStart >= SAMPLING_WINDOW_MS
			) {
				emitSuppressedTrace(key, bucket.suppressed, bucket.severity);
				bucket.suppressed = 0;
			}
		}
		await client.flush();
	} catch (err) {
		console.warn(
			"[app-insights] flush failed",
			err instanceof Error ? err.message : err,
		);
	}
}

/** Flush and release an isolated direct client without failing shutdown. */
export async function shutdownAppInsights(): Promise<void> {
	const client = CLIENT;
	CLIENT = null;
	CLIENT_INIT_ATTEMPTED = false;
	LOGS_INITIALIZED = false;
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
	CLIENT_INIT_ATTEMPTED = false;
	LOGS_INITIALIZED = false;
	TRANSPORT = "disabled";
	INITIALIZED = false;
	TEST_CLIENT_FACTORY = undefined;
	requireFromObservability = undefined;
	SAMPLING_BUCKETS.clear();
	SAMPLING_LIMIT = DEFAULT_SAMPLING_LIMIT;
}

/** Test-only: shrink the per-key sampling budget so a test does not need to
 *  fire 20+ records (or wait 60s for a window to roll) to exercise it. */
export function __setAppInsightsSamplingLimitForTests(limit: number): void {
	SAMPLING_LIMIT = limit;
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

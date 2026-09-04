/**
 * Centralized Observability Initialization
 *
 * Single entry point for all observability configuration.
 * Import and call initObservability() once at application startup.
 *
 * Features:
 * - OpenTelemetry traces, metrics, and logs
 * - Console log interception for OTLP export
 * - Auto-instrumentation for HTTP, DNS, etc.
 * - Custom instrumentation modules for LLM, Database, RAG
 *
 * Environment Variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT - OTLP gRPC endpoint (e.g., http://localhost:4317)
 *   OTEL_SERVICE_NAME - Service name for telemetry
 *   OTEL_ENABLED - Set to "false" to disable (defaults to true if endpoint set)
 *   NODE_ENV - Environment (development/production)
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import {
	DiagConsoleLogger,
	DiagLogLevel,
	diag,
	metrics,
	trace,
} from "@opentelemetry/api";
import type { SeverityNumber as SeverityNumberType } from "@opentelemetry/api-logs";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import type { ResourceDetector } from "@opentelemetry/resources";
import {
	envDetector,
	processDetector,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import type { LoggerProvider as LoggerProviderType } from "@opentelemetry/sdk-logs";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
	AggregationType,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { NodeSDK as NodeSDKType } from "@opentelemetry/sdk-node";
// Use named imports for ESM/Turbopack compatibility
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
// Re-export API for use in instrumentation modules

export interface ObservabilityConfig {
	serviceName: string;
	serviceVersion?: string;
	environment?: string;
	/** Custom OTLP endpoint (overrides OTEL_EXPORTER_OTLP_ENDPOINT) */
	otlpEndpoint?: string;
	/** Metric export interval in milliseconds (default: 30000) */
	metricExportInterval?: number;
	/** Enable verbose auto-instrumentation (default: false in dev) */
	verboseInstrumentation?: boolean;
	/** Enable debug logging for troubleshooting OTEL issues */
	debug?: boolean;
	/** Log batch size (smaller = faster visibility, default: 512 prod, 10 dev) */
	logBatchSize?: number;
	/** Log export delay in ms (default: 5000 prod, 1000 dev) */
	logExportDelay?: number;
}

// Singleton state
let sdk: NodeSDKType | null = null;
let loggerProvider: LoggerProviderType | null = null;
let isInitialized = false;

// Store original console methods
const originalConsole = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

/**
 * Check if observability is enabled based on environment
 */
function isObservabilityEnabled(): boolean {
	const explicitSetting = process.env.OTEL_ENABLED;
	if (explicitSetting === "false") {
		return false;
	}
	if (explicitSetting === "true") {
		return true;
	}

	// Auto-enable if endpoint is configured
	return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/**
 * Check if an endpoint is a local development endpoint
 */
function isLocalEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		const host = url.hostname.toLowerCase();
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host.endsWith(".local") ||
			host.startsWith("aspire-dashboard") ||
			// Container names in Docker Compose / Aspire local environment
			host === "otel-collector" ||
			host === "jaeger"
		);
	} catch {
		// If URL parsing fails, be conservative and don't downgrade
		return false;
	}
}

/**
 * Get OTLP endpoint from config or environment
 * Default port 4317 is the standard gRPC port
 *
 * Note: For local development with Aspire Dashboard, we normalize https:// to http://
 * because Aspire uses self-signed certs and grpc-js doesn't respect NODE_TLS_REJECT_UNAUTHORIZED.
 * The OTEL library automatically uses insecure credentials for http:// URLs.
 */
function getOtlpEndpoint(config?: ObservabilityConfig): string {
	let endpoint =
		config?.otlpEndpoint ||
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
		"http://localhost:4317";

	// Only downgrade https:// to http:// for local development endpoints
	// to avoid self-signed cert issues with Aspire Dashboard.
	// Production endpoints with TLS should not be downgraded.
	if (endpoint.startsWith("https://") && isLocalEndpoint(endpoint)) {
		endpoint = endpoint.replace("https://", "http://");
	}

	return endpoint;
}

/**
 * Map Node's `os.arch()` values onto the OTel `host.arch` semantic convention.
 * Mirrors the mapping `hostDetector` applies, so dropping that detector doesn't
 * change the attribute's shape for anything already querying it.
 */
function normalizeArch(nodeArch: string): string {
	switch (nodeArch) {
		case "arm":
			return "arm32";
		case "ppc":
			return "ppc32";
		case "x64":
			return "amd64";
		default:
			return nodeArch;
	}
}

/**
 * Pick the resource detectors the SDK runs at startup.
 *
 * The SDK's default set is [envDetector, processDetector, hostDetector]. We drop
 * `hostDetector` because its `host.id` lookup reads `/etc/machine-id` and
 * `/var/lib/dbus/machine-id` — neither of which exists in a slim container
 * image. The detector swallows the failure itself, but resource detection runs
 * *after* `registerInstrumentations()`, so `@opentelemetry/instrumentation-fs`
 * (on whenever verbose instrumentation is enabled) has already patched
 * `fs.promises.readFile` and records the ENOENT as a span exception. Exported to
 * App Insights those land as genuine exceptions: one staging hour measured them
 * at ~56% of all exception volume across the agent containers, burying real
 * failures in every triage pass.
 *
 * The host ID of an ephemeral container replica has no diagnostic value anyway;
 * `host.name` and `host.arch` are set explicitly on the resource instead.
 *
 * Returning `undefined` lets the SDK fall back to its own env-var handling, so
 * `OTEL_NODE_RESOURCE_DETECTORS` still works as an escape hatch (e.g. set it to
 * `all` on a VM host where `host.id` is both present and meaningful).
 */
function getResourceDetectors(): ResourceDetector[] | undefined {
	if (process.env.OTEL_NODE_RESOURCE_DETECTORS) {
		return undefined;
	}
	return [envDetector, processDetector];
}

/** gRPC status code grpc-js reports when it cannot reach the collector at all. */
const GRPC_STATUS_UNAVAILABLE = 14;

/**
 * Socket-level codes that all mean "the collector's socket went away".
 *
 * `ENOTFOUND` is deliberately absent: a name that never resolved is a
 * misconfigured endpoint rather than a collector that shut down first, and that
 * is worth an error-level line with its stack.
 */
const UNREACHABLE_SYSCALL_CODES = ["ECONNREFUSED", "ECONNRESET", "EPIPE"];

/**
 * gRPC renders its status into the message as "14 UNAVAILABLE: ...", and Node
 * renders a socket failure as "<syscall> <CODE> <address>". Both are matched in
 * that shape rather than as bare substrings, so an unrelated failure whose text
 * merely happens to contain the word UNAVAILABLE or a code name — a TypeError
 * reading a property of that name, say — keeps its error-level line.
 */
const GRPC_UNAVAILABLE_STATUS = /(?:^|\s)(?:14 )?UNAVAILABLE:/;
const SOCKET_FAILURE = new RegExp(
	`\\b(?:connect|read|write|shutdown) (?:${UNREACHABLE_SYSCALL_CODES.join("|")})\\b`,
);

function messageLooksUnreachable(message: string): boolean {
	return (
		GRPC_UNAVAILABLE_STATUS.test(message) || SOCKET_FAILURE.test(message)
	);
}

/**
 * Decide whether a shutdown failure is just "the collector went away first".
 *
 * Both the structured fields and the message text are checked: the OTLP gRPC
 * exporter usually surfaces the failure as a plain `Error` whose message
 * carries the status ("14 UNAVAILABLE: No connection established. Last error:
 * Error: connect ECONNREFUSED ..."), so `code` alone misses the common case.
 *
 * `depth` bounds the cause/aggregate walk — an error chain that loops back on
 * itself would otherwise recurse forever inside a shutdown hook.
 */
function isCollectorUnreachable(error: unknown, depth = 0): boolean {
	if (depth > 5) {
		return false;
	}
	if (typeof error === "string") {
		return messageLooksUnreachable(error);
	}
	if (!error || typeof error !== "object") {
		return false;
	}

	const candidate = error as {
		code?: unknown;
		message?: unknown;
		cause?: unknown;
		errors?: unknown;
	};

	if (candidate.code === GRPC_STATUS_UNAVAILABLE) {
		return true;
	}
	if (
		typeof candidate.code === "string" &&
		UNREACHABLE_SYSCALL_CODES.includes(candidate.code)
	) {
		return true;
	}
	if (
		typeof candidate.message === "string" &&
		messageLooksUnreachable(candidate.message)
	) {
		return true;
	}
	// Every member has to qualify, and an empty list qualifies nothing: an
	// aggregate mixing a dead collector with a real processor failure is still a
	// real failure and has to keep its error-level line.
	if (
		Array.isArray(candidate.errors) &&
		candidate.errors.length > 0 &&
		candidate.errors.every((nested) =>
			isCollectorUnreachable(nested, depth + 1),
		)
	) {
		return true;
	}
	return (
		candidate.cause !== undefined &&
		isCollectorUnreachable(candidate.cause, depth + 1)
	);
}

/**
 * Report a failed shutdown flush at a level that matches what it means.
 *
 * A container runtime tears the local OTLP collector down alongside the
 * application container, so a final flush that arrives after it has gone is
 * expected and unactionable — it was logged at error level on stderr, which put
 * a recurring `ECONNREFUSED` line in front of every production log triage pass
 * for something nobody can fix. Any other shutdown failure is still a genuine
 * error and keeps the error-level line and its stack.
 */
function reportShutdownFailure(error: unknown): void {
	if (isCollectorUnreachable(error)) {
		const detail = error instanceof Error ? error.message : String(error);
		originalConsole.log(
			`[Observability] Collector unreachable at shutdown, final flush skipped: ${detail}`,
		);
		return;
	}
	originalConsole.error("[Observability] Shutdown error:", error);
}

/**
 * Wind down the logger provider and the SDK, reporting whatever fails.
 *
 * The two settle independently rather than in sequence: a collector that has
 * already gone rejects the first shutdown, and awaiting them one after the
 * other both cancelled the second flush outright and stacked two exporter
 * timeouts back to back — long enough to matter against a container's
 * termination grace period.
 */
async function flushAndShutdown(): Promise<void> {
	const outcomes = await Promise.allSettled([
		loggerProvider?.shutdown() ?? Promise.resolve(),
		sdk?.shutdown() ?? Promise.resolve(),
	]);

	for (const outcome of outcomes) {
		if (outcome.status === "rejected") {
			reportShutdownFailure(outcome.reason);
		}
	}
}

/**
 * Set up console interception to forward logs to OTLP
 *
 * IMPORTANT: This function includes protection against infinite loops caused by
 * OTEL's internal debug logging. When OTEL_DEBUG=true, the DiagConsoleLogger
 * writes debug messages to console, which would otherwise trigger our interception
 * and create an infinite loop.
 */
function setupConsoleInterception(serviceName: string): void {
	const logger = logs.getLogger(serviceName);

	// Flag to prevent recursive interception during log emission
	let isEmitting = false;

	// Patterns that indicate OTEL internal logs (should not be sent back to OTLP)
	const otelInternalPatterns = [
		"OTLPExportDelegate",
		"@opentelemetry",
		"Instrumentation suppressed",
		"grpc-js",
		"DiagConsoleLogger",
	];

	const severityMap: Record<string, SeverityNumberType> = {
		debug: SeverityNumber.DEBUG,
		log: SeverityNumber.INFO,
		info: SeverityNumber.INFO,
		warn: SeverityNumber.WARN,
		error: SeverityNumber.ERROR,
	};

	for (const [method, severity] of Object.entries(severityMap)) {
		const original =
			originalConsole[method as keyof typeof originalConsole];
		(console as any)[method] = (...args: unknown[]): void => {
			// Always write to stdout/stderr
			original(...args);

			// Prevent recursive interception
			if (isEmitting) {
				return;
			}

			// Skip OTEL internal logs to prevent infinite loops
			const firstArg = args[0];
			if (typeof firstArg === "string") {
				for (const pattern of otelInternalPatterns) {
					if (firstArg.includes(pattern)) {
						return;
					}
				}
			}

			// Also emit to OTLP
			try {
				isEmitting = true;
				const body = args
					.map((arg) =>
						typeof arg === "object"
							? JSON.stringify(arg)
							: String(arg),
					)
					.join(" ");

				logger.emit({
					severityNumber: severity,
					severityText: method.toUpperCase(),
					body,
					timestamp: Date.now(),
				});
			} finally {
				isEmitting = false;
			}
		};
	}
}

/**
 * Initialize OpenTelemetry observability
 *
 * Call this once at application startup before any other code runs.
 *
 * @example
 * ```typescript
 * import { initObservability } from '@repo/observability';
 *
 * initObservability({ serviceName: 'my-service' });
 * ```
 */
export function initObservability(config: ObservabilityConfig): void {
	if (isInitialized) {
		originalConsole.warn(
			"[Observability] Already initialized, skipping duplicate initialization",
		);
		return;
	}

	if (!isObservabilityEnabled()) {
		originalConsole.log(
			"[Observability] Disabled (set OTEL_ENABLED=true or OTEL_EXPORTER_OTLP_ENDPOINT to enable)",
		);
		return;
	}

	const serviceName =
		config.serviceName ||
		process.env.OTEL_SERVICE_NAME ||
		"unknown-service";
	const serviceVersion = config.serviceVersion || "1.0.0";
	const environment =
		config.environment || process.env.NODE_ENV || "development";
	const endpoint = getOtlpEndpoint(config);
	const metricExportInterval = config.metricExportInterval || 30000;
	const isProduction = environment === "production";
	const verboseInstrumentation =
		config.verboseInstrumentation ?? isProduction;

	// Debug logging for troubleshooting OTEL issues
	const enableDebug = config.debug || process.env.OTEL_DEBUG === "true";
	if (enableDebug) {
		diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
	}

	// Batch configuration - smaller batches in dev for faster visibility
	const logBatchSize = config.logBatchSize ?? (isProduction ? 512 : 10);
	const logExportDelay =
		config.logExportDelay ?? (isProduction ? 5000 : 1000);

	// `@opentelemetry/instrumentation-runtime-node` (pulled in via
	// getNodeAutoInstrumentations) reports v8js.memory.heap.* as an observable
	// gauge *per V8 heap space* — ~11 series per metric name, 4 metric names, per
	// process. Across the agent containers that measured 12.93 GB / 7 days of Log
	// Analytics ingest (~76% of ALL workspace ingestion, ~7x the entire container
	// console-log volume) for data nothing queries. Container-level memory is
	// already covered by Azure Monitor's own container app metrics.
	//
	// Drop the instrument rather than disabling the whole instrumentation, so the
	// genuinely actionable runtime signals — nodejs.eventloop.* and
	// v8js.gc.duration — keep flowing. Set OTEL_V8_HEAP_METRICS=true to restore
	// them temporarily (e.g. while chasing a suspected memory leak).
	const v8HeapMetricsEnabled = process.env.OTEL_V8_HEAP_METRICS === "true";

	// Generate unique instance ID for multi-instance deployments
	const instanceId = process.env.HOSTNAME || crypto.randomUUID();

	originalConsole.log(
		`[Observability] Initializing ${serviceName} (${environment})`,
	);
	originalConsole.log(`[Observability] OTLP endpoint: ${endpoint}`);
	originalConsole.log(`[Observability] Instance ID: ${instanceId}`);

	// Create resource with service info and instance ID.
	// host.name / host.arch are set here rather than left to `hostDetector` —
	// see getResourceDetectors() for why that detector is dropped.
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: serviceVersion,
		"deployment.environment": environment,
		"service.instance.id": instanceId,
		// os.hostname() rather than $HOSTNAME: hostDetector's detected value
		// previously won the resource merge, so this keeps host.name byte-identical
		// to what shipped before and can't split existing telemetry groupings.
		"host.name": os.hostname(),
		"host.arch": normalizeArch(os.arch()),
		"process.pid": process.pid,
	});

	// Create log exporter - URL is normalized to http:// in getOtlpEndpoint()
	// so OTEL automatically uses insecure credentials
	const logExporter = new OTLPLogExporter({
		url: endpoint,
	});

	loggerProvider = new LoggerProvider({
		resource,
		processors: [
			new BatchLogRecordProcessor(logExporter, {
				maxExportBatchSize: logBatchSize,
				scheduledDelayMillis: logExportDelay,
			}),
		],
	});
	logs.setGlobalLoggerProvider(loggerProvider);

	// Intercept console methods
	setupConsoleInterception(serviceName);

	// Create and start SDK with gRPC exporters
	// URL is normalized to http:// so OTEL uses insecure credentials automatically
	sdk = new NodeSDK({
		resource,
		resourceDetectors: getResourceDetectors(),
		traceExporter: new OTLPTraceExporter({
			url: endpoint,
		}),
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: endpoint,
			}),
			exportIntervalMillis: metricExportInterval,
		}),
		views: v8HeapMetricsEnabled
			? []
			: [
					{
						instrumentName: "v8js.memory.heap.*",
						aggregation: { type: AggregationType.DROP },
					},
				],
		instrumentations: [
			getNodeAutoInstrumentations({
				// Disable verbose instrumentations in development
				"@opentelemetry/instrumentation-fs": {
					enabled: verboseInstrumentation,
				},
				"@opentelemetry/instrumentation-dns": {
					enabled: verboseInstrumentation,
				},
			}),
		],
	});

	sdk.start();
	isInitialized = true;

	// Handle graceful shutdown
	const shutdown = async () => {
		originalConsole.log("[Observability] Shutting down...");
		await flushAndShutdown();
		originalConsole.log("[Observability] Shutdown complete");
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	originalConsole.log("[Observability] Initialized successfully");
}

/**
 * Check if observability has been initialized
 */
export function isObservabilityInitialized(): boolean {
	return isInitialized;
}

/**
 * Get the current tracer for creating custom spans
 */
export function getTracer(name?: string) {
	return trace.getTracer(name || "fabric");
}

/**
 * Get the current meter for creating custom metrics
 */
export function getMeter(name?: string) {
	return metrics.getMeter(name || "fabric");
}

/**
 * Get the current logger for creating custom logs
 */
export function getLogger(name?: string) {
	return logs.getLogger(name || "fabric");
}

/**
 * Shutdown observability gracefully
 */
export async function shutdownObservability(): Promise<void> {
	if (!isInitialized) {
		return;
	}

	await flushAndShutdown();
	// Cleared even when a flush failed: the providers are torn down either way,
	// and leaving the flag set only invites a second shutdown that can no longer
	// export anything.
	isInitialized = false;
}

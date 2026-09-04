/**
 * OpenTelemetry Configuration for Temporal Worker
 *
 * Configures OTLP exporters to send traces, metrics, AND LOGS to the Aspire Dashboard
 * running in Azure Container Apps Environment.
 *
 * Environment Variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT - OTLP endpoint (e.g., http://aspire-dashboard:18889)
 *   OTEL_SERVICE_NAME - Service name (defaults to "temporal-worker")
 *   OTEL_ENABLED - Set to "false" to disable telemetry (defaults to "true")
 */

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import {
	type Resource,
	resourceFromAttributes,
} from "@opentelemetry/resources";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
} from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
	makeWorkflowExporter,
	OpenTelemetryActivityInboundInterceptor,
} from "@temporalio/interceptors-opentelemetry";
import {
	Runtime,
	type RuntimeOptions,
	type WorkerOptions,
} from "@temporalio/worker";

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "temporal-worker";
const OTEL_ENABLED = process.env.OTEL_ENABLED !== "false";

let sdk: NodeSDK | null = null;
let traceExporter: OTLPTraceExporter | null = null;
let resource: Resource | undefined;
let loggerProvider: LoggerProvider | null = null;

// Store original console methods
const originalConsole = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

/**
 * Initialize OpenTelemetry SDK with OTLP exporters for traces, metrics, and logs
 * Call this before starting the Temporal worker
 */
export function initTelemetry(): void {
	if (!OTEL_ENABLED) {
		originalConsole.log(
			"[Telemetry] OpenTelemetry disabled (OTEL_ENABLED=false)",
		);
		return;
	}

	if (!OTEL_ENDPOINT) {
		originalConsole.log(
			"[Telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set, skipping telemetry initialization",
		);
		return;
	}

	originalConsole.log(
		`[Telemetry] Initializing OpenTelemetry with endpoint: ${OTEL_ENDPOINT}`,
	);

	resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: SERVICE_NAME,
		[ATTR_SERVICE_VERSION]: process.env.npm_package_version || "1.0.0",
		"deployment.environment": process.env.NODE_ENV || "development",
	});

	// gRPC exporters use the base URL without path suffixes
	traceExporter = new OTLPTraceExporter({
		url: OTEL_ENDPOINT,
	});

	const metricExporter = new OTLPMetricExporter({
		url: OTEL_ENDPOINT,
	});

	// Set up log exporter for Aspire Dashboard console logs (gRPC)
	const logExporter = new OTLPLogExporter({
		url: OTEL_ENDPOINT,
	});

	loggerProvider = new LoggerProvider({
		resource,
		processors: [new BatchLogRecordProcessor(logExporter)],
	});

	// Register the logger provider globally
	logs.setGlobalLoggerProvider(loggerProvider);

	// Intercept console methods to forward to OTLP
	setupConsoleInterception();

	sdk = new NodeSDK({
		resource,
		traceExporter,
		// Type assertion needed due to OpenTelemetry version mismatch between sdk-metrics and sdk-node
		metricReader: new PeriodicExportingMetricReader({
			exporter: metricExporter,
			exportIntervalMillis: 60000, // Export metrics every 60 seconds
		}) as any,
	});

	sdk.start();
	originalConsole.log(
		"[Telemetry] OpenTelemetry SDK started with logs export",
	);
}

/**
 * Options for exporting the metrics the SDK's native core emits: task-slot
 * usage, sticky-cache size, workflow-task schedule-to-start latency, activity
 * latency and the rest of the `temporal_*` series. None of them exist until
 * the runtime is installed with an exporter — `initTelemetry()` only covers
 * the metrics this process records itself through the Node OpenTelemetry SDK.
 *
 * Pure so the env → options mapping is unit-testable without instantiating
 * the native runtime. Returns null when telemetry is off or no collector is
 * configured; the SDK then creates its default runtime with no exporter.
 */
export interface RuntimeMetricsEnv {
	OTEL_ENABLED?: string;
	OTEL_EXPORTER_OTLP_ENDPOINT?: string;
	// Index signature so `process.env` (index-signature only) is assignable.
	[key: string]: string | undefined;
}

export function buildRuntimeMetricsOptions(
	env: RuntimeMetricsEnv = process.env,
): RuntimeOptions | null {
	if (env.OTEL_ENABLED === "false" || !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
		return null;
	}
	return {
		telemetryOptions: {
			metrics: {
				otel: {
					// The same gRPC collector endpoint the Node SDK exporters use,
					// so core metrics join the stream the collector already forwards.
					url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
					// The SDK default is 1 s. Match the 60 s reader in
					// initTelemetry(): every export is billed ingestion once the
					// collector forwards it to Azure Monitor.
					metricsExportInterval: "60s",
				},
			},
		},
	};
}

/**
 * Install the Temporal runtime with core metrics export.
 *
 * Must run before the first native call (`NativeConnection.connect`,
 * `Worker.create`): the SDK creates a default runtime lazily on that call and
 * `Runtime.install` throws once one exists. Deliberately not wrapped in
 * try/catch: an install failure means either that ordering was violated or
 * the native runtime rejected its configuration, and both should fail the
 * boot loudly rather than let the worker run with every core metric silently
 * missing.
 */
export function installTemporalRuntime(): void {
	const options = buildRuntimeMetricsOptions(process.env);
	if (!options) {
		originalConsole.log(
			"[Telemetry] Temporal core metrics export disabled (OTEL_ENABLED=false or no OTLP endpoint)",
		);
		return;
	}
	Runtime.install(options);
	originalConsole.log(
		`[Telemetry] Temporal core metrics exporting to ${OTEL_ENDPOINT}`,
	);
}

/**
 * Set up console interception to forward logs to OTLP
 * This makes console.log/info/warn/error appear in Aspire Dashboard
 */
function setupConsoleInterception(): void {
	const logger = logs.getLogger(SERVICE_NAME);

	const severityMap: Record<string, SeverityNumber> = {
		debug: SeverityNumber.DEBUG,
		log: SeverityNumber.INFO,
		info: SeverityNumber.INFO,
		warn: SeverityNumber.WARN,
		error: SeverityNumber.ERROR,
	};

	for (const [method, severity] of Object.entries(severityMap)) {
		const original =
			originalConsole[method as keyof typeof originalConsole];
		(console as any)[method] = (...args: any[]) => {
			// Always write to stdout/stderr for Azure Log Analytics
			original(...args);

			// Also emit to OTLP for Aspire Dashboard
			const body = args
				.map((arg) =>
					typeof arg === "object" ? JSON.stringify(arg) : String(arg),
				)
				.join(" ");

			logger.emit({
				severityNumber: severity,
				severityText: method.toUpperCase(),
				body,
				timestamp: Date.now(),
			});
		};
	}
}

/**
 * Shutdown OpenTelemetry SDK gracefully
 * Call this when shutting down the worker
 */
export async function shutdownTelemetry(): Promise<void> {
	if (loggerProvider) {
		originalConsole.log("[Telemetry] Shutting down logger provider...");
		await loggerProvider.shutdown();
	}
	if (sdk) {
		originalConsole.log("[Telemetry] Shutting down OpenTelemetry SDK...");
		await sdk.shutdown();
		originalConsole.log("[Telemetry] OpenTelemetry SDK shutdown complete");
	}
}

/**
 * Get Temporal worker interceptors for OpenTelemetry tracing
 * These interceptors automatically trace workflow and activity executions
 */
export function getTelemetryInterceptors(): Partial<WorkerOptions> {
	if (!OTEL_ENABLED || !OTEL_ENDPOINT || !traceExporter || !resource) {
		return {};
	}

	const workflowExporter = makeWorkflowExporter(
		traceExporter as any,
		resource as any,
	);

	return {
		interceptors: {
			activityInbound: [
				(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx),
			],
		},
		sinks: {
			exporter: workflowExporter,
		},
	};
}

/**
 * Check if telemetry is enabled and configured
 */
export function isTelemetryEnabled(): boolean {
	return OTEL_ENABLED && !!OTEL_ENDPOINT;
}

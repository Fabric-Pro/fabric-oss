// Use named imports for ESM/Turbopack compatibility

import type { SeverityNumber as SeverityNumberType } from "@opentelemetry/api-logs";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LoggerProvider as LoggerProviderType } from "@opentelemetry/sdk-logs";
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

/**
 * OpenTelemetry Configuration for MCP Operations
 * Exports traces, metrics, and logs to Jaeger/Aspire Dashboard or any OTLP-compatible backend
 */

const isProduction = process.env.NODE_ENV === "production";
// Enable OTEL if explicitly set to true, or if endpoint is provided (auto-enable for cloud)
// Disable if explicitly set to false
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const isTracingEnabled =
	process.env.OTEL_ENABLED === "true" ||
	(process.env.OTEL_ENABLED !== "false" && !!OTLP_ENDPOINT);

// Default endpoint for local development (gRPC port 4317)
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4317";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "fabric-mcp";

// Store original console methods
const originalConsole = {
	log: console.log.bind(console),
	info: console.info.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	debug: console.debug.bind(console),
};

let loggerProvider: LoggerProviderType | null = null;

/**
 * Set up console interception to forward logs to OTLP
 * This makes console.log/info/warn/error appear in Aspire Dashboard
 */
function setupConsoleInterception(): void {
	const logger = logs.getLogger(SERVICE_NAME);

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
 * Initialize OpenTelemetry SDK with traces, metrics, and logs
 */
export function initializeTracing() {
	if (!isTracingEnabled) {
		originalConsole.log(
			"OpenTelemetry tracing is disabled. Set OTEL_ENABLED=true to enable.",
		);
		return null;
	}

	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: SERVICE_NAME,
		[ATTR_SERVICE_VERSION]: process.env.APP_VERSION || "1.0.0",
		environment: process.env.NODE_ENV || "development",
	});

	const endpoint = OTLP_ENDPOINT || DEFAULT_OTLP_ENDPOINT;

	// Set up log exporter for Aspire Dashboard console logs (gRPC - no path suffix)
	const logExporter = new OTLPLogExporter({
		url: endpoint,
	});

	loggerProvider = new LoggerProvider({
		resource,
		processors: [new BatchLogRecordProcessor(logExporter)],
	});

	// Register the logger provider globally
	logs.setGlobalLoggerProvider(loggerProvider);

	// Intercept console methods to forward to OTLP
	setupConsoleInterception();

	const sdk = new NodeSDK({
		resource,
		traceExporter: new OTLPTraceExporter({
			url: endpoint,
		}),
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: endpoint,
			}),
			exportIntervalMillis: 60000, // Export metrics every 60 seconds
		}),
		instrumentations: [
			getNodeAutoInstrumentations({
				// Disable instrumentations that are too verbose in development
				"@opentelemetry/instrumentation-fs": {
					enabled: isProduction,
				},
				"@opentelemetry/instrumentation-dns": {
					enabled: isProduction,
				},
			}),
		],
	});

	sdk.start();

	// Handle shutdown gracefully
	process.on("SIGTERM", () => {
		const shutdownPromises: Promise<void>[] = [];
		if (loggerProvider) {
			shutdownPromises.push(loggerProvider.shutdown());
		}
		shutdownPromises.push(sdk.shutdown());

		Promise.all(shutdownPromises)
			.then(() =>
				originalConsole.log("OpenTelemetry SDK shut down successfully"),
			)
			.catch((error) =>
				originalConsole.error(
					"Error shutting down OpenTelemetry SDK",
					error,
				),
			)
			.finally(() => process.exit(0));
	});

	originalConsole.log(
		`OpenTelemetry initialized (traces, metrics, logs). Exporting to: ${endpoint}`,
	);

	return sdk;
}

/**
 * Trace decorator for async functions
 * Usage:
 * @trace("operation-name")
 * async function myFunction() { ... }
 */
export function trace(operationName: string) {
	return (
		_target: any,
		_propertyKey: string,
		descriptor: PropertyDescriptor,
	) => {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: any[]) {
			if (!isTracingEnabled) {
				return originalMethod.apply(this, args);
			}

			const { trace, context } = await import("@opentelemetry/api");
			const tracer = trace.getTracer("fabric-mcp");
			const span = tracer.startSpan(operationName);

			try {
				const result = await context.with(
					trace.setSpan(context.active(), span),
					async () => await originalMethod.apply(this, args),
				);
				span.setStatus({ code: 1 }); // OK
				return result;
			} catch (error) {
				span.setStatus({
					code: 2, // ERROR
					message:
						error instanceof Error ? error.message : String(error),
				});
				throw error;
			} finally {
				span.end();
			}
		};

		return descriptor;
	};
}

/**
 * Manual span creation utility
 */
export async function withSpan<T>(
	operationName: string,
	fn: () => Promise<T>,
	attributes?: Record<string, string | number | boolean>,
): Promise<T> {
	if (!isTracingEnabled) {
		return fn();
	}

	const { trace, context } = await import("@opentelemetry/api");
	const tracer = trace.getTracer("fabric-mcp");
	const span = tracer.startSpan(operationName);

	if (attributes) {
		span.setAttributes(attributes);
	}

	try {
		const result = await context.with(
			trace.setSpan(context.active(), span),
			fn,
		);
		span.setStatus({ code: 1 }); // OK
		return result;
	} catch (error) {
		span.setStatus({
			code: 2, // ERROR
			message: error instanceof Error ? error.message : String(error),
		});
		if (error instanceof Error) {
			span.recordException(error);
		}
		throw error;
	} finally {
		span.end();
	}
}

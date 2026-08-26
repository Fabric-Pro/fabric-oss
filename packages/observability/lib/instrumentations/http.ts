/**
 * HTTP/API Instrumentation
 *
 * Provides tracing and metrics for HTTP operations including:
 * - API endpoint latency
 * - Request/response tracking
 * - Error rates
 * - Status code distribution
 *
 * Note: Basic HTTP instrumentation is handled by @opentelemetry/auto-instrumentations-node.
 * This module provides additional custom instrumentation for application-specific needs.
 *
 * @example
 * ```typescript
 * import { httpInstrumentation } from '@repo/observability';
 *
 * // Trace an API call
 * const result = await httpInstrumentation.traceApiCall({
 *   method: 'POST',
 *   path: '/api/chat',
 *   service: 'chat-service',
 * }, async (span) => {
 *   return await fetch('/api/chat', { method: 'POST', ... });
 * });
 * ```
 */

import {
	type Attributes,
	metrics,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

// Semantic conventions
const HTTP_METHOD = "http.request.method";
const _HTTP_ROUTE = "http.route";
const HTTP_STATUS_CODE = "http.response.status_code";
const HTTP_TARGET = "url.path";

// Get tracer and meter
const tracer = trace.getTracer("fabric-http");
const meter = metrics.getMeter("fabric-http");

// Metrics
const httpRequestCounter = meter.createCounter("http.server.requests", {
	description: "Total number of HTTP requests",
	unit: "1",
});

const httpRequestDuration = meter.createHistogram("http.server.duration", {
	description: "Duration of HTTP requests",
	unit: "ms",
});

const httpClientRequestCounter = meter.createCounter("http.client.requests", {
	description: "Total number of outgoing HTTP requests",
	unit: "1",
});

const httpClientDuration = meter.createHistogram("http.client.duration", {
	description: "Duration of outgoing HTTP requests",
	unit: "ms",
});

const httpErrorCounter = meter.createCounter("http.errors", {
	description: "Total number of HTTP errors",
	unit: "1",
});

export interface ApiCallOptions {
	/** HTTP method */
	method: string;
	/** API path/route */
	path: string;
	/** Target service name */
	service?: string;
	/** Additional attributes */
	attributes?: Attributes;
}

export interface HttpSpan extends Span {
	/** Set the response status code */
	setStatusCode(statusCode: number): void;
	/** Set response size in bytes */
	setResponseSize(bytes: number): void;
}

/**
 * HTTP instrumentation utilities
 */
export const httpInstrumentation = {
	/**
	 * Trace an outgoing API call
	 */
	async traceApiCall<T>(
		options: ApiCallOptions,
		fn: (span: HttpSpan) => Promise<T>,
	): Promise<T> {
		const startTime = Date.now();

		const attributes: Attributes = {
			[HTTP_METHOD]: options.method,
			[HTTP_TARGET]: options.path,
			...options.attributes,
		};

		if (options.service) {
			attributes["peer.service"] = options.service;
		}

		return tracer.startActiveSpan(
			`HTTP ${options.method} ${options.path}`,
			{ attributes },
			async (span) => {
				let statusCode = 0;

				// Extend span with helper methods
				const httpSpan = span as HttpSpan;
				httpSpan.setStatusCode = (code: number) => {
					statusCode = code;
					span.setAttribute(HTTP_STATUS_CODE, code);
				};
				httpSpan.setResponseSize = (bytes: number) => {
					span.setAttribute("http.response.body.size", bytes);
				};

				try {
					const result = await fn(httpSpan);

					const status = statusCode >= 400 ? "error" : "success";
					httpClientRequestCounter.add(1, {
						method: options.method,
						path: options.path,
						status,
						status_code: String(statusCode || "unknown"),
					});

					if (statusCode >= 400) {
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: `HTTP ${statusCode}`,
						});
					} else {
						span.setStatus({ code: SpanStatusCode.OK });
					}

					return result;
				} catch (error) {
					httpClientRequestCounter.add(1, {
						method: options.method,
						path: options.path,
						status: "error",
						status_code: "network_error",
					});
					httpErrorCounter.add(1, {
						method: options.method,
						path: options.path,
						error_type:
							error instanceof Error
								? error.name
								: "UnknownError",
					});

					span.setStatus({
						code: SpanStatusCode.ERROR,
						message:
							error instanceof Error
								? error.message
								: String(error),
					});
					if (error instanceof Error) {
						span.recordException(error);
					}
					throw error;
				} finally {
					const duration = Date.now() - startTime;
					httpClientDuration.record(duration, {
						method: options.method,
						path: options.path,
					});
					span.end();
				}
			},
		);
	},

	/**
	 * Record an incoming HTTP request (for server-side metrics)
	 * Use this in middleware or request handlers
	 */
	recordServerRequest(options: {
		method: string;
		route: string;
		statusCode: number;
		durationMs: number;
	}): void {
		const status = options.statusCode >= 400 ? "error" : "success";

		httpRequestCounter.add(1, {
			method: options.method,
			route: options.route,
			status,
			status_code: String(options.statusCode),
		});

		httpRequestDuration.record(options.durationMs, {
			method: options.method,
			route: options.route,
		});

		if (options.statusCode >= 400) {
			httpErrorCounter.add(1, {
				method: options.method,
				route: options.route,
				status_code: String(options.statusCode),
			});
		}
	},

	/**
	 * Create Express/Next.js middleware for automatic request instrumentation
	 */
	createMiddleware() {
		return (
			req: { method: string; url?: string; path?: string },
			res: {
				statusCode: number;
				on: (event: string, callback: () => void) => void;
			},
			next: () => void,
		): void => {
			const startTime = Date.now();
			const path = req.path || req.url || "/";

			res.on("finish", () => {
				const duration = Date.now() - startTime;
				httpInstrumentation.recordServerRequest({
					method: req.method,
					route: path,
					statusCode: res.statusCode,
					durationMs: duration,
				});
			});

			next();
		};
	},

	/**
	 * Trace an internal service call
	 */
	async traceServiceCall<T>(
		serviceName: string,
		operationName: string,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		return tracer.startActiveSpan(
			`service.${serviceName}.${operationName}`,
			{
				attributes: {
					"service.name": serviceName,
					"service.operation": operationName,
				},
			},
			async (span) => {
				try {
					const result = await fn(span);
					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message:
							error instanceof Error
								? error.message
								: String(error),
					});
					if (error instanceof Error) {
						span.recordException(error);
					}
					throw error;
				} finally {
					span.end();
				}
			},
		);
	},
};

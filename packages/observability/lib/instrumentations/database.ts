/**
 * Database Instrumentation (Prisma)
 *
 * Provides tracing and metrics for database operations including:
 * - Query execution tracing
 * - Query duration metrics
 * - Slow query detection
 * - Error tracking
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 * import { createInstrumentedPrisma } from '@repo/observability';
 *
 * const prisma = createInstrumentedPrisma(new PrismaClient());
 * ```
 */

import {
	type Attributes,
	metrics,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

// Semantic conventions for database operations
const DB_SYSTEM = "db.system";
const _DB_NAME = "db.name";
const DB_OPERATION = "db.operation";
const _DB_STATEMENT = "db.statement";

// Get tracer and meter
const tracer = trace.getTracer("fabric-database");
const meter = metrics.getMeter("fabric-database");

// Metrics
const dbQueryCounter = meter.createCounter("db.queries", {
	description: "Total number of database queries",
	unit: "1",
});

const dbQueryDuration = meter.createHistogram("db.query.duration", {
	description: "Duration of database queries",
	unit: "ms",
});

const dbErrorCounter = meter.createCounter("db.errors", {
	description: "Total number of database errors",
	unit: "1",
});

const dbSlowQueryCounter = meter.createCounter("db.slow_queries", {
	description: "Number of slow queries (>1000ms)",
	unit: "1",
});

const dbConnectionGauge = meter.createUpDownCounter("db.connections", {
	description: "Number of active database connections",
	unit: "1",
});

// Slow query threshold in milliseconds
const SLOW_QUERY_THRESHOLD_MS = 1000;

export interface DatabaseTraceOptions {
	/** Operation name (e.g., 'findMany', 'create', 'update') */
	operation: string;
	/** Model/table name */
	model?: string;
	/** Additional attributes */
	attributes?: Attributes;
	/** Log the query statement (be careful with sensitive data) */
	logStatement?: boolean;
}

/**
 * Database instrumentation utilities
 */
export const databaseInstrumentation = {
	/**
	 * Trace a database operation
	 */
	async trace<T>(
		options: DatabaseTraceOptions,
		fn: (span: Span) => Promise<T>,
	): Promise<T> {
		const startTime = Date.now();
		const spanName = options.model
			? `db.${options.model}.${options.operation}`
			: `db.${options.operation}`;

		const attributes: Attributes = {
			[DB_SYSTEM]: "postgresql",
			[DB_OPERATION]: options.operation,
			...options.attributes,
		};

		if (options.model) {
			attributes["db.sql.table"] = options.model;
		}

		return tracer.startActiveSpan(
			spanName,
			{ attributes },
			async (span) => {
				try {
					const result = await fn(span);

					// Record success metrics
					dbQueryCounter.add(1, {
						operation: options.operation,
						model: options.model || "unknown",
						status: "success",
					});

					span.setStatus({ code: SpanStatusCode.OK });
					return result;
				} catch (error) {
					// Record error metrics
					dbQueryCounter.add(1, {
						operation: options.operation,
						model: options.model || "unknown",
						status: "error",
					});
					dbErrorCounter.add(1, {
						operation: options.operation,
						model: options.model || "unknown",
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

					// Record duration
					dbQueryDuration.record(duration, {
						operation: options.operation,
						model: options.model || "unknown",
					});

					// Track slow queries
					if (duration > SLOW_QUERY_THRESHOLD_MS) {
						dbSlowQueryCounter.add(1, {
							operation: options.operation,
							model: options.model || "unknown",
						});
						span.setAttribute("db.slow_query", true);
						span.setAttribute("db.duration_ms", duration);
					}

					span.end();
				}
			},
		);
	},

	/**
	 * Record a connection event
	 */
	recordConnection(action: "connect" | "disconnect"): void {
		dbConnectionGauge.add(action === "connect" ? 1 : -1);
	},

	/**
	 * Create Prisma middleware for automatic instrumentation
	 *
	 * @example
	 * ```typescript
	 * const prisma = new PrismaClient();
	 * prisma.$use(createPrismaMiddleware());
	 * ```
	 */
	createPrismaMiddleware() {
		return async (
			params: {
				model?: string;
				action: string;
				args: unknown;
				dataPath: string[];
				runInTransaction: boolean;
			},
			next: (params: unknown) => Promise<unknown>,
		): Promise<unknown> => {
			const startTime = Date.now();
			const spanName = params.model
				? `prisma.${params.model}.${params.action}`
				: `prisma.${params.action}`;

			return tracer.startActiveSpan(
				spanName,
				{
					attributes: {
						[DB_SYSTEM]: "postgresql",
						[DB_OPERATION]: params.action,
						"db.sql.table": params.model || "unknown",
						"prisma.run_in_transaction": params.runInTransaction,
					},
				},
				async (span) => {
					try {
						const result = await next(params);

						dbQueryCounter.add(1, {
							operation: params.action,
							model: params.model || "unknown",
							status: "success",
						});

						span.setStatus({ code: SpanStatusCode.OK });
						return result;
					} catch (error) {
						dbQueryCounter.add(1, {
							operation: params.action,
							model: params.model || "unknown",
							status: "error",
						});
						dbErrorCounter.add(1, {
							operation: params.action,
							model: params.model || "unknown",
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

						dbQueryDuration.record(duration, {
							operation: params.action,
							model: params.model || "unknown",
						});

						if (duration > SLOW_QUERY_THRESHOLD_MS) {
							dbSlowQueryCounter.add(1, {
								operation: params.action,
								model: params.model || "unknown",
							});
							span.setAttribute("db.slow_query", true);
						}

						span.setAttribute("db.duration_ms", duration);
						span.end();
					}
				},
			);
		};
	},
};

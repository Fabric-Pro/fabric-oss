/**
 * Enhanced Activity Logger for Temporal
 *
 * Provides structured logging with workflow context, timing, and correlation IDs.
 * Activities can use this to log with full context about which workflow/run they're part of.
 */

import { logger } from "@repo/logs";
import { activityInfo } from "@temporalio/activity";

/**
 * Activity context extracted from Temporal
 */
interface ActivityContext {
	workflowId: string;
	runId: string;
	activityId: string;
	activityType: string;
	attempt: number;
	workflowType: string;
	activityStartToCloseTimeoutMs?: string;
	activityScheduleToCloseTimeoutMs?: string;
	taskQueue: string;
	/**
	 * Best-effort correlation ID. Activities do not have direct access to
	 * workflow memo (Temporal SDK limitation — memo is workflow-scoped),
	 * so the default identity is the workflow `runId`. Workflows that want
	 * per-request correlation should read `workflowInfo().memo.correlationId`
	 * and pass it explicitly as part of the activity input arg.
	 */
	correlationId: string;
}

/**
 * Get current activity context from Temporal
 */
function getActivityContext(): ActivityContext | null {
	try {
		const info = activityInfo();
		return {
			workflowId: info.workflowExecution.workflowId,
			runId: info.workflowExecution.runId,
			activityId: info.activityId,
			activityType: info.activityType,
			attempt: info.attempt,
			workflowType: info.workflowType,
			activityStartToCloseTimeoutMs:
				info.startToCloseTimeoutMs?.toString(),
			activityScheduleToCloseTimeoutMs:
				info.scheduleToCloseTimeoutMs?.toString(),
			taskQueue: info.taskQueue,
			// runId is a stable correlation identity for workflow-originated
			// log lines: every retry / replay of an attempt carries the same
			// runId, so log lines join cleanly against audit-log rows that
			// also use runId (see audit-log-retention activity).
			correlationId: info.workflowExecution.runId,
		};
	} catch (_error) {
		// Not in an activity context (e.g., during testing)
		return null;
	}
}

/**
 * Enhanced logger with Temporal activity context
 *
 * Automatically includes workflowId, runId, activityId, and attempt number in all logs.
 * This enables correlation between workflow logs and activity logs.
 */
export const activityLogger = {
	/**
	 * Log with activity context
	 */
	info(message: string, meta?: Record<string, unknown>): void {
		const context = getActivityContext();
		const enrichedMeta = {
			...meta,
			...(context && {
				workflowId: context.workflowId,
				runId: context.runId,
				activityId: context.activityId,
				activityType: context.activityType,
				attempt: context.attempt,
				workflowType: context.workflowType,
				correlationId: context.correlationId,
			}),
		};
		logger.info(`[Activity] ${message}`, enrichedMeta);
	},

	/**
	 * Log error with activity context
	 */
	error(
		message: string,
		error?: unknown,
		meta?: Record<string, unknown>,
	): void {
		const context = getActivityContext();
		const enrichedMeta = {
			...meta,
			...(context && {
				workflowId: context.workflowId,
				runId: context.runId,
				activityId: context.activityId,
				activityType: context.activityType,
				attempt: context.attempt,
				workflowType: context.workflowType,
				correlationId: context.correlationId,
			}),
			error: error instanceof Error ? error.message : String(error),
			...(error instanceof Error && { stack: error.stack }),
		};
		logger.error(`[Activity] ${message}`, enrichedMeta);
	},

	/**
	 * Log warning with activity context
	 */
	warn(message: string, meta?: Record<string, unknown>): void {
		const context = getActivityContext();
		const enrichedMeta = {
			...meta,
			...(context && {
				workflowId: context.workflowId,
				runId: context.runId,
				activityId: context.activityId,
				activityType: context.activityType,
				attempt: context.attempt,
				workflowType: context.workflowType,
				correlationId: context.correlationId,
			}),
		};
		logger.warn(`[Activity] ${message}`, enrichedMeta);
	},

	/**
	 * Log debug with activity context
	 */
	debug(message: string, meta?: Record<string, unknown>): void {
		const context = getActivityContext();
		const enrichedMeta = {
			...meta,
			...(context && {
				workflowId: context.workflowId,
				runId: context.runId,
				activityId: context.activityId,
				activityType: context.activityType,
				attempt: context.attempt,
				workflowType: context.workflowType,
				correlationId: context.correlationId,
			}),
		};
		logger.debug(`[Activity] ${message}`, enrichedMeta);
	},

	/**
	 * Time an operation and log duration
	 */
	async time<T>(
		operation: string,
		fn: () => Promise<T>,
		meta?: Record<string, unknown>,
	): Promise<T> {
		const startTime = Date.now();
		const _context = getActivityContext();

		this.info(`Starting: ${operation}`, meta);

		try {
			const result = await fn();
			const duration = Date.now() - startTime;
			this.info(`Completed: ${operation}`, {
				...meta,
				durationMs: duration,
				durationSeconds: (duration / 1000).toFixed(2),
			});
			return result;
		} catch (error) {
			const duration = Date.now() - startTime;
			this.error(`Failed: ${operation}`, error, {
				...meta,
				durationMs: duration,
				durationSeconds: (duration / 1000).toFixed(2),
			});
			throw error;
		}
	},

	/**
	 * Get current activity context (useful for passing to other functions)
	 */
	getContext(): ActivityContext | null {
		return getActivityContext();
	},
};

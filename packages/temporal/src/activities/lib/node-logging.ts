/**
 * Node Logging Utilities
 *
 * Provides consistent logging pattern for workflow node execution.
 * Based on Vercel workflow-builder-template step-handler.ts pattern.
 * @see https://github.com/vercel-labs/workflow-builder-template
 */

import { redactSensitiveData } from "./redact-sensitive-data";

export interface NodeContext {
	executionId: string;
	nodeId: string;
	nodeName?: string;
	nodeType: string;
}

export interface LogInfo {
	startTime: number;
	nodeId: string;
	nodeType: string;
}

/**
 * Log the start of a node execution
 */
export async function logNodeStart(context: NodeContext): Promise<LogInfo> {
	console.log("[NodeLogging] Starting node:", {
		executionId: context.executionId,
		nodeId: context.nodeId,
		nodeType: context.nodeType,
		nodeName: context.nodeName,
	});

	return {
		startTime: Date.now(),
		nodeId: context.nodeId,
		nodeType: context.nodeType,
	};
}

/**
 * Log successful completion of a node execution
 */
export async function logNodeComplete(
	context: NodeContext,
	logInfo: LogInfo,
	output: unknown,
): Promise<void> {
	const duration = Date.now() - logInfo.startTime;
	const redactedOutput = redactSensitiveData(output);

	console.log("[NodeLogging] Node completed:", {
		executionId: context.executionId,
		nodeId: context.nodeId,
		nodeType: context.nodeType,
		duration: `${duration}ms`,
		outputPreview:
			typeof redactedOutput === "object"
				? JSON.stringify(redactedOutput).slice(0, 200)
				: String(redactedOutput).slice(0, 200),
	});
}

/**
 * Log error in node execution
 */
export async function logNodeError(
	context: NodeContext,
	logInfo: LogInfo,
	error: unknown,
): Promise<void> {
	const duration = Date.now() - logInfo.startTime;
	const errorMessage = error instanceof Error ? error.message : String(error);

	console.error("[NodeLogging] Node failed:", {
		executionId: context.executionId,
		nodeId: context.nodeId,
		nodeType: context.nodeType,
		duration: `${duration}ms`,
		error: errorMessage,
	});
}

/**
 * Wrap node execution logic with logging
 *
 * This pattern ensures consistent logging for all node types.
 *
 * @example
 * const result = await withNodeLogging(context, async () => {
 *   // Node execution logic here
 *   return { success: true, output: { data: "result" } };
 * });
 */
export async function withNodeLogging<T>(
	context: NodeContext,
	nodeLogic: () => Promise<T>,
): Promise<T> {
	const logInfo = await logNodeStart(context);

	try {
		const result = await nodeLogic();

		// Check if result indicates success or failure
		const resultObj = result as {
			success?: boolean;
			output?: unknown;
			error?: string;
		};
		if (resultObj.success === false) {
			await logNodeError(
				context,
				logInfo,
				resultObj.error || "Unknown error",
			);
		} else {
			await logNodeComplete(context, logInfo, resultObj.output || result);
		}

		return result;
	} catch (error) {
		await logNodeError(context, logInfo, error);
		throw error;
	}
}

/**
 * Format duration for display
 */
export function formatNodeDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(2)}s`;
	}
	const minutes = Math.floor(ms / 60000);
	const seconds = ((ms % 60000) / 1000).toFixed(0);
	return `${minutes}m ${seconds}s`;
}

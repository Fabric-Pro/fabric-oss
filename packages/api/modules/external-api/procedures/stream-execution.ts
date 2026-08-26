/**
 * Stream Execution (SSE)
 *
 * Provides a Server-Sent Events stream for real-time execution progress.
 * Uses hybrid Redis pub/sub + Temporal query polling for rich events.
 */

import { db } from "@repo/database";
import type { Context } from "hono";
import { formatSSE } from "../lib/event-types";
import { createExecutionEventStream } from "../lib/execution-stream";
import type { ExternalApiVariables } from "../types";

/**
 * Create an SSE stream handler for an execution.
 */
export function createExecutionStreamHandler() {
	return async (c: Context<{ Variables: ExternalApiVariables }>) => {
		const ctx = c.get("externalApiContext");
		const executionId = c.req.param("executionId");

		if (!executionId) {
			return c.json({ error: "executionId is required" }, 400);
		}

		const tenantFilter = ctx.organizationId
			? { organizationId: ctx.organizationId }
			: { userId: ctx.userId, organizationId: null };

		// Verify access to this execution
		const execution = await db.agentDeploymentExecution.findFirst({
			where: {
				id: executionId,
				...tenantFilter,
			},
			select: {
				id: true,
				executionId: true,
				status: true,
				workflowId: true,
			},
		});

		if (!execution) {
			return c.json({ error: "Execution not found" }, 404);
		}

		// If already in a terminal state, return the result directly
		if (
			["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
				execution.status,
			)
		) {
			const result = await db.agentDeploymentExecution.findFirst({
				where: { id: executionId },
				select: {
					status: true,
					output: true,
					error: true,
					duration: true,
					inputTokens: true,
					outputTokens: true,
				},
			});

			let event: string;
			let data: Record<string, unknown>;

			if (result?.status === "COMPLETED") {
				event = "execution.completed";
				data = {
					output: result.output,
					tokenUsage: {
						inputTokens: result.inputTokens ?? 0,
						outputTokens: result.outputTokens ?? 0,
					},
					durationMs: result.duration ?? 0,
				};
			} else if (
				result?.status === "CANCELLED" ||
				result?.status === "TIMED_OUT"
			) {
				event = "execution.cancelled";
				data = {
					reason:
						result.error ??
						(result.status === "TIMED_OUT"
							? "Execution timed out"
							: "Execution cancelled"),
					durationMs: result.duration ?? 0,
				};
			} else {
				event = "execution.failed";
				data = {
					error: result?.error ?? "Unknown error",
					durationMs: result?.duration ?? 0,
				};
			}

			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(
						encoder.encode(
							formatSSE({
								event,
								data,
							} as Parameters<typeof formatSSE>[0]),
						),
					);
					controller.close();
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		}

		// For in-progress executions, use hybrid event stream
		const workflowId =
			execution.workflowId || `deployment-exec-${executionId}`;

		// Use the workflow's UUID executionId for Redis channel matching
		const redisExecutionId = execution.executionId || executionId;
		const eventStream = createExecutionEventStream(
			redisExecutionId,
			workflowId,
		);

		return new Response(eventStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	};
}

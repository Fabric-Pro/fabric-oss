/**
 * Hybrid Execution Event Stream
 *
 * Combines Redis pub/sub (real-time tokens, tool calls) with
 * Temporal query polling (phase transitions, status) for a unified SSE stream.
 */

import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";
import type { ExecutionStreamEvent } from "./event-types";
import { formatSSE } from "./event-types";

const TEMPORAL_POLL_INTERVAL_MS = 200;
const MAX_STREAM_DURATION_MS = 10 * 60 * 1000; // 10 minutes

interface StreamOptions {
	maxDurationMs?: number;
}

/**
 * Build a Redis URL from environment variables.
 * Prefers Aspire-injected CACHE_HOST/CACHE_PORT (dynamic port) over static
 * REDIS_URL which may reference a stale port after container restarts.
 */
function getRedisUrl(): string | null {
	// Prefer Aspire-injected vars (dynamic port assigned at container start)
	const cacheHost = process.env.CACHE_HOST;
	if (cacheHost) {
		const cachePort = process.env.CACHE_PORT || "6379";
		const password =
			process.env.CACHE_PASSWORD || process.env.REDIS_PASSWORD;
		if (password) {
			return `redis://:${encodeURIComponent(password)}@${cacheHost}:${cachePort}`;
		}
		return `redis://${cacheHost}:${cachePort}`;
	}

	const rawUrl = process.env.REDIS_URL;
	if (rawUrl) {
		try {
			const parsed = new URL(rawUrl);
			if (parsed.password) {
				return rawUrl;
			}
			const password =
				process.env.REDIS_PASSWORD || process.env.CACHE_PASSWORD;
			if (password) {
				parsed.password = password;
				return parsed.toString();
			}
			return rawUrl;
		} catch {
			return rawUrl;
		}
	}

	return null;
}

/**
 * Create an SSE ReadableStream that merges Redis pub/sub events
 * with Temporal query events for the given execution.
 */
export function createExecutionEventStream(
	executionId: string,
	workflowId: string,
	options: StreamOptions = {},
): ReadableStream<Uint8Array> {
	const maxDuration = options.maxDurationMs ?? MAX_STREAM_DURATION_MS;
	const encoder = new TextEncoder();

	// Shared state accessible from both start() and cancel()
	let cleanupFn: (() => void) | null = null;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const startTime = Date.now();
			let redisSubscriber: import("ioredis").default | null = null;
			let pollTimer: ReturnType<typeof setTimeout> | null = null;
			let closed = false;
			let eventCursor = 0;

			// Track seen tool call IDs for deduplication
			const seenToolCallIds = new Set<string>();

			const teardown = () => {
				if (pollTimer) {
					clearTimeout(pollTimer);
					pollTimer = null;
				}

				if (redisSubscriber) {
					redisSubscriber.unsubscribe().catch(() => {});
					redisSubscriber.disconnect();
					redisSubscriber = null;
				}
			};

			const send = (event: ExecutionStreamEvent): boolean => {
				if (closed) {
					return false;
				}
				try {
					controller.enqueue(encoder.encode(formatSSE(event)));
					return true;
				} catch {
					closed = true;
					teardown();
					return false;
				}
			};

			const cleanup = () => {
				if (closed) {
					return;
				}
				closed = true;
				teardown();

				try {
					controller.close();
				} catch {
					// Already closed
				}
			};

			// Expose cleanup for cancel() handler
			cleanupFn = cleanup;

			// =====================================================================
			// Redis Subscriber (real-time: text deltas, tool calls)
			// =====================================================================
			const redisUrl = getRedisUrl();
			logger.info("[ExecutionStream] Redis URL resolution", {
				hasRedisUrl: !!redisUrl,
				hasEnvRedisUrl: !!process.env.REDIS_URL,
				hasCacheHost: !!process.env.CACHE_HOST,
				executionId,
			});
			if (redisUrl) {
				try {
					const Redis = (await import("ioredis")).default;
					redisSubscriber = new Redis(redisUrl, {
						maxRetriesPerRequest: 1,
						// Without this, ioredis disables TCP keepalive and an idle
						// connection is reaped upstream, surfacing as ECONNRESET on the
						// next write instead of a clean reconnect.
						keepAlive: REDIS_KEEPALIVE_MS,
						connectTimeout: 3000,
						lazyConnect: true,
						enableOfflineQueue: false,
					});

					// Attach the error listener BEFORE connect(). ioredis emits
					// `error` during the connection attempt, and an `error` event
					// with no listener is re-raised by Node as "[ioredis] Unhandled
					// error event" at process level.
					redisSubscriber.on("error", (err) => {
						logger.warn(
							"[ExecutionStream] Redis subscriber error",
							{
								error: err.message,
								executionId,
							},
						);
						// Redis error — continue with Temporal-only polling
						if (redisSubscriber) {
							redisSubscriber.disconnect();
							redisSubscriber = null;
						}
					});

					await redisSubscriber.connect();

					const channel = `execution:${executionId}`;
					await redisSubscriber.subscribe(channel);

					redisSubscriber.on(
						"message",
						(_ch: string, message: string) => {
							if (closed) {
								return;
							}
							try {
								const event = JSON.parse(
									message,
								) as ExecutionStreamEvent;

								// Deduplicate tool_call_completed events
								if (
									event.event ===
									"execution.tool_call_completed"
								) {
									const tcData = event.data as {
										toolCallId?: string;
									};
									if (tcData.toolCallId) {
										if (
											seenToolCallIds.has(
												tcData.toolCallId,
											)
										) {
											return;
										}
										seenToolCallIds.add(tcData.toolCallId);
									}
								}

								send(event);
							} catch {
								// Invalid message, skip
							}
						},
					);

					logger.info(
						"[ExecutionStream] Redis subscriber connected",
						{
							executionId,
							channel,
						},
					);
				} catch (err) {
					logger.warn(
						"[ExecutionStream] Redis unavailable, using Temporal-only mode",
						{
							error:
								err instanceof Error
									? err.message
									: String(err),
						},
					);
					// Disconnect before dropping the reference — nulling alone
					// leaks the instance and its reconnect timers. The error
					// listener above may already have done both.
					if (redisSubscriber) {
						try {
							redisSubscriber.disconnect();
						} catch {
							// already torn down
						}
						redisSubscriber = null;
					}
				}
			} else {
				logger.info(
					"[ExecutionStream] No Redis URL available, using Temporal-only mode",
					{ executionId },
				);
			}

			// =====================================================================
			// Temporal Query Poller (phase transitions, status events)
			// =====================================================================
			const temporalClient = await getTemporalClient();

			const scheduleNextPoll = () => {
				if (!closed) {
					pollTimer = setTimeout(
						pollTemporalEvents,
						TEMPORAL_POLL_INTERVAL_MS,
					);
				}
			};

			const pollTemporalEvents = async () => {
				if (closed) {
					return;
				}

				// Check stream duration
				if (Date.now() - startTime > maxDuration) {
					send({
						event: "execution.failed",
						data: {
							error: "Stream timeout. Use polling endpoint to check final status.",
							durationMs: Date.now() - startTime,
						},
					});
					cleanup();
					return;
				}

				try {
					const handle =
						temporalClient.workflow.getHandle(workflowId);

					// Check if workflow is still running
					const description = await handle.describe();
					const workflowStatus = description.status?.name;

					// Try to get events from the executionEvents query
					try {
						const events = await handle.query<
							Array<{
								event: string;
								data: Record<string, unknown>;
								timestamp: string;
							}>,
							[number]
						>("executionEvents", eventCursor);

						if (events && events.length > 0) {
							for (const evt of events) {
								// Deduplicate tool_call_completed events from both sources
								if (
									evt.event ===
									"execution.tool_call_completed"
								) {
									const tcData = evt.data as {
										toolCallId?: string;
									};
									if (tcData.toolCallId) {
										if (
											seenToolCallIds.has(
												tcData.toolCallId,
											)
										) {
											eventCursor++;
											continue;
										}
										seenToolCallIds.add(tcData.toolCallId);
									}
								}

								// Include timestamp from Temporal event in the data
								send({
									event: evt.event,
									data: {
										...evt.data,
										timestamp: evt.timestamp,
									},
								} as ExecutionStreamEvent);
								eventCursor++;
							}

							// Check for terminal events
							const lastEvent = events[events.length - 1];
							if (
								lastEvent.event === "execution.completed" ||
								lastEvent.event === "execution.failed" ||
								lastEvent.event === "execution.cancelled"
							) {
								cleanup();
								return;
							}
						}
					} catch {
						// Query not available yet (workflow just started), continue polling
					}

					// Also check workflow status for completion
					if (
						workflowStatus === "COMPLETED" ||
						workflowStatus === "FAILED" ||
						workflowStatus === "CANCELLED" ||
						workflowStatus === "TERMINATED" ||
						workflowStatus === "TIMED_OUT"
					) {
						// Workflow finished but we may not have received all events yet.
						// Do one more poll to query final events, then cleanup.
						pollTimer = setTimeout(async () => {
							if (closed) {
								return;
							}
							let emittedTerminal = false;
							try {
								const finalHandle =
									temporalClient.workflow.getHandle(
										workflowId,
									);
								const finalEvents = await finalHandle.query<
									Array<{
										event: string;
										data: Record<string, unknown>;
										timestamp: string;
									}>,
									[number]
								>("executionEvents", eventCursor);

								if (finalEvents && finalEvents.length > 0) {
									for (const evt of finalEvents) {
										send({
											event: evt.event,
											data: {
												...evt.data,
												timestamp: evt.timestamp,
											},
										} as ExecutionStreamEvent);
										eventCursor++;

										if (
											evt.event ===
												"execution.completed" ||
											evt.event === "execution.failed" ||
											evt.event === "execution.cancelled"
										) {
											emittedTerminal = true;
										}
									}
								}
							} catch {
								// Query failed — fall through to synthetic emit
							}

							// Guarantee clients always receive a terminal event
							if (!emittedTerminal) {
								const durationMs = Date.now() - startTime;
								if (workflowStatus === "COMPLETED") {
									send({
										event: "execution.completed",
										data: {
											result: null,
											durationMs,
											synthetic: true,
										},
									});
								} else if (workflowStatus === "CANCELLED") {
									send({
										event: "execution.cancelled",
										data: {
											reason: `Workflow ${workflowStatus}`,
											synthetic: true,
										},
									});
								} else {
									send({
										event: "execution.failed",
										data: {
											error: `Workflow ${workflowStatus}`,
											durationMs,
											synthetic: true,
										},
									});
								}
							}
							cleanup();
						}, TEMPORAL_POLL_INTERVAL_MS);
						return;
					}
				} catch (err) {
					// Workflow not found or query error
					logger.debug("[ExecutionStream] Temporal poll error", {
						error: err instanceof Error ? err.message : String(err),
					});
				}

				// Schedule next poll after this one completes
				scheduleNextPoll();
			};

			// Initial poll immediately
			pollTemporalEvents();
		},

		cancel() {
			// Stream was cancelled by the client — tear down resources
			cleanupFn?.();
		},
	});
}

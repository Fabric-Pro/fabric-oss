/**
 * Weave Execution Stream (SSE)
 *
 * Server-Sent Events endpoint for real-time execution progress.
 * Uses Redis pub/sub for tool calls and step updates published
 * by the orchestrator during weave execution.
 */

import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import {
	orchestratorPendingApprovalQuery,
	orchestratorProgressQuery,
} from "@repo/temporal/workflows";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";

interface WeaveStreamEvent {
	event: string;
	data: Record<string, unknown>;
}

function formatSSE(event: WeaveStreamEvent, eventId: number): string {
	return `id: ${eventId}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Build a Redis URL from environment variables.
 */
function getRedisUrl(): string | null {
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
			if (!parsed.password) {
				const password =
					process.env.REDIS_PASSWORD || process.env.CACHE_PASSWORD;
				if (password) {
					parsed.password = password;
					return parsed.toString();
				}
			}
			return rawUrl;
		} catch {
			return rawUrl;
		}
	}

	return null;
}

const POLL_INTERVAL_MS = 1500;
// Must be >= the weave execution mode workflowTimeoutMs (30 minutes)
const MAX_STREAM_DURATION_MS = 35 * 60 * 1000;

/**
 * Create an SSE ReadableStream for a weave execution.
 * Combines Redis pub/sub events with Temporal workflow query polling.
 */
/**
 * SECURITY NOTE: This function queries execution by ID only (no tenant filter).
 * The caller (apps/web/app/api/weave/stream/route.ts) MUST validate tenant
 * access with XOR pattern BEFORE calling this function.
 */
export function createWeaveExecutionStream(
	executionId: string,
	workflowId: string,
	lastEventId?: string,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let cleanupFn: (() => void) | null = null;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const startTime = Date.now();
			let redisSubscriber: import("ioredis").default | null = null;
			let pollTimer: ReturnType<typeof setTimeout> | null = null;
			let closed = false;
			let lastProgressHash = "";
			let streamEventSeq = 0;

			let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

			const teardown = () => {
				if (pollTimer) {
					clearTimeout(pollTimer);
					pollTimer = null;
				}
				if (keepaliveTimer) {
					clearInterval(keepaliveTimer);
					keepaliveTimer = null;
				}
				if (redisSubscriber) {
					redisSubscriber.unsubscribe().catch(() => {});
					redisSubscriber.disconnect();
					redisSubscriber = null;
				}
			};

			const send = (event: WeaveStreamEvent): boolean => {
				if (closed) {
					return false;
				}
				try {
					streamEventSeq++;
					controller.enqueue(
						encoder.encode(formatSSE(event, streamEventSeq)),
					);
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

			cleanupFn = cleanup;

			// Send initial connection event
			send({
				event: "weave.connected",
				data: {
					executionId,
					workflowId,
					timestamp: Date.now(),
					reconnect: !!lastEventId,
				},
			});

			// On reconnect: replay current execution state from DB so the
			// client catches up on anything missed during the disconnect gap
			if (lastEventId) {
				try {
					const current = await db.weaveExecution.findUnique({
						where: { id: executionId },
						select: {
							status: true,
							currentStep: true,
							checkboxes: true,
							error: true,
							artifacts: true,
						},
					});
					if (current) {
						send({
							event: "weave.progress",
							data: {
								status: current.status,
								currentStep: current.currentStep,
								checkboxes: current.checkboxes,
								timestamp: Date.now(),
								replayed: true,
							},
						});
					}
				} catch {
					// Best-effort replay
				}
			}

			// Send SSE comments as keepalives every 25s to prevent
			// proxy/load-balancer idle timeouts during long weave executions
			keepaliveTimer = setInterval(() => {
				if (closed) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					// Stream closed
				}
			}, 25_000);

			// === Redis Subscriber (real-time tool calls and step events) ===
			const redisUrl = getRedisUrl();
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
					redisSubscriber.on("error", () => {
						if (redisSubscriber) {
							redisSubscriber.disconnect();
							redisSubscriber = null;
						}
					});

					await redisSubscriber.connect();
					const channel = `execution:${workflowId}`;
					await redisSubscriber.subscribe(channel);

					redisSubscriber.on(
						"message",
						(_ch: string, message: string) => {
							if (closed) {
								return;
							}
							try {
								const event = JSON.parse(message) as {
									event: string;
									data: Record<string, unknown>;
								};
								send({
									event: `weave.${event.event.replace("execution.", "")}`,
									data: event.data,
								});
							} catch {
								// Invalid message
							}
						},
					);
				} catch {
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
			}

			// === Temporal Query Poller (workflow status, progress, checkpoints) ===
			let temporalClient: Awaited<
				ReturnType<typeof getTemporalClient>
			> | null = null;
			try {
				temporalClient = await getTemporalClient();
			} catch {
				// Temporal unavailable
			}

			const scheduleNextPoll = () => {
				if (!closed) {
					pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
				}
			};

			const poll = async () => {
				if (closed) {
					return;
				}

				if (Date.now() - startTime > MAX_STREAM_DURATION_MS) {
					send({
						event: "weave.timeout",
						data: { message: "Stream timeout" },
					});
					cleanup();
					return;
				}

				try {
					// Query DB for current execution status
					const execution = await db.weaveExecution.findUnique({
						where: { id: executionId },
						select: {
							status: true,
							currentStep: true,
							error: true,
							checkboxes: true,
							artifacts: true,
						},
					});

					if (!execution) {
						send({
							event: "weave.error",
							data: { error: "Execution not found" },
						});
						cleanup();
						return;
					}

					// Query Temporal for live workflow progress
					let workflowProgress: Record<string, unknown> | null = null;
					let checkpoint: Record<string, unknown> | null = null;

					if (
						temporalClient &&
						(execution.status === "RUNNING" ||
							execution.status === "CHECKPOINT" ||
							execution.status === "PAUSED")
					) {
						try {
							const handle =
								temporalClient.workflow.getHandle(workflowId);
							workflowProgress = (await handle.query(
								orchestratorProgressQuery,
							)) as unknown as Record<string, unknown> | null;

							if (execution.status === "CHECKPOINT") {
								checkpoint = (await handle.query(
									orchestratorPendingApprovalQuery,
								)) as unknown as Record<string, unknown> | null;
							}
						} catch {
							// Workflow may not be queryable yet
						}
					}

					// Build a hash to avoid sending duplicate data
					const progressHash = JSON.stringify({
						status: execution.status,
						currentStep: execution.currentStep,
						wp: workflowProgress
							? {
									s: workflowProgress.status,
									cs: workflowProgress.currentStep,
									ca: workflowProgress.currentAgent,
								}
							: null,
					});

					if (progressHash !== lastProgressHash) {
						lastProgressHash = progressHash;

						send({
							event: "weave.progress",
							data: {
								status: execution.status,
								currentStep: execution.currentStep,
								checkboxes: execution.checkboxes,
								...(workflowProgress
									? {
											workflowStatus:
												workflowProgress.status,
											currentAgent:
												workflowProgress.currentAgent,
											totalSteps:
												workflowProgress.totalSteps,
										}
									: {}),
								...(checkpoint ? { checkpoint } : {}),
								timestamp: Date.now(),
							},
						});
					}

					// Terminal states
					if (execution.status === "COMPLETED") {
						send({
							event: "weave.completed",
							data: {
								artifacts: execution.artifacts,
								durationMs: Date.now() - startTime,
							},
						});
						cleanup();
						return;
					}

					if (
						execution.status === "FAILED" ||
						execution.status === "CANCELLED"
					) {
						send({
							event:
								execution.status === "FAILED"
									? "weave.failed"
									: "weave.cancelled",
							data: {
								error: execution.error,
								durationMs: Date.now() - startTime,
							},
						});
						cleanup();
						return;
					}
				} catch {
					// Poll error — continue
				}

				scheduleNextPoll();
			};

			// Start polling immediately
			poll();
		},

		cancel() {
			cleanupFn?.();
		},
	});
}

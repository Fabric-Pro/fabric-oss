import {
	markExecutionReplayUnavailable,
	registerExecutionOutputDrain,
} from "./execution-output-drain";
/**
 * Redis Publisher for Execution Events
 *
 * Singleton Redis publisher that sends real-time events from Temporal activities.
 * - Lazy connect: only establishes connection on first publish
 * - Fire-and-forget: if Redis is down, activity continues normally
 * - One shared connection across all activities in the worker
 * - Channel naming: `execution:{executionId}`
 */

import {
	appendConversationTurnEventFromWorker,
	ChatEventReplayError,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { ChatEventCursor } from "@repo/utils/chat-event-cursor";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";
import { Context } from "@temporalio/activity";
import { getRedisUrl, isPlaintextRedisRefused } from "./redis-url";

let redisClient: import("ioredis").default | null = null;
let connectionPromise: Promise<import("ioredis").default | null> | null = null;
/** Timestamp (ms) of last connection failure; 0 means no failure recorded */
let lastFailureTime = 0;
/** Backoff before retrying after a connection failure */
const RETRY_BACKOFF_MS = 30_000; // 30 seconds

/**
 * Get or create the singleton Redis publisher client.
 * Returns null if Redis is unavailable.
 */
async function connectRedis(): Promise<import("ioredis").default | null> {
	const redisUrl = getRedisUrl();
	if (!redisUrl) {
		logger.debug(
			"[RedisPublisher] REDIS_URL not set, skipping Redis events",
		);
		lastFailureTime = Date.now();
		return null;
	}

	// Transport fail-closed (SOC 2 CC6.7, `isPlaintextRedisRefused`): fails
	// closed by declining to connect (events/cache degrade, loudly logged)
	// rather than silently shipping data over an unencrypted channel.
	if (isPlaintextRedisRefused(redisUrl)) {
		logger.error(
			"[RedisPublisher] Refusing plaintext redis:// connection in production (SOC 2 CC6.7). Use rediss:// (TLS), or set FABRIC_ALLOW_INSECURE_REDIS=true to override.",
		);
		lastFailureTime = Date.now();
		return null;
	}

	let client: import("ioredis").default | null = null;
	try {
		const Redis = (await import("ioredis")).default;
		client = new Redis(redisUrl, {
			maxRetriesPerRequest: 1,
			// Without this, ioredis disables TCP keepalive and an idle
			// connection is reaped upstream, surfacing as ECONNRESET on the
			// next write instead of a clean reconnect.
			keepAlive: REDIS_KEEPALIVE_MS,
			connectTimeout: 3000,
			commandTimeout: 3000,
			lazyConnect: true,
			enableOfflineQueue: false,
		});

		// Attach before connect() so errors during the connection attempt are
		// handled (not logged as "[ioredis] Unhandled error event").
		// Also covers post-connect errors (drops, reconnects).
		client.on("error", (err) => {
			logger.warn("[RedisPublisher] Redis connection error", {
				error: err.message,
			});
		});

		client.on("close", () => {
			logger.debug("[RedisPublisher] Redis connection closed");
			redisClient = null;
			connectionPromise = null;
		});

		await client.connect();

		redisClient = client;
		lastFailureTime = 0;
		logger.info("[RedisPublisher] Connected to Redis");
		return client;
	} catch (err) {
		// Error already surfaced by the error event handler above
		logger.warn(
			"[RedisPublisher] Failed to connect to Redis, events will be skipped",
			{
				error: err instanceof Error ? err.message : String(err),
			},
		);
		// Disconnect so ioredis doesn't leak background reconnect timers
		try {
			client?.disconnect();
		} catch {}
		lastFailureTime = Date.now();
		connectionPromise = null;
		return null;
	}
}

async function getRedisPublisher(): Promise<import("ioredis").default | null> {
	if (redisClient) {
		return redisClient;
	}
	// If a recent failure occurred, back off before retrying
	if (
		lastFailureTime > 0 &&
		Date.now() - lastFailureTime < RETRY_BACKOFF_MS
	) {
		return null;
	}
	// Concurrent callers share the same connection promise
	if (connectionPromise) {
		return connectionPromise;
	}

	connectionPromise = connectRedis();
	return connectionPromise;
}

/**
 * Execution event payload published via Redis.
 */
export interface ChatExecutionToolCall {
	id: string;
	name: string;
	serverName?: string;
	args?: unknown;
	result?: unknown;
	status:
		| "pending"
		| "running"
		| "complete"
		| "error"
		| import("../workflows/orchestrator/types/workflow-io.types").OrchestratorStepResult["toolCalls"][number]["status"];
	durationMs?: number;
	error?: string;
	mcpAppResourceUri?: string;
	mcpAppConfigId?: string;
}

/** Payloads forwarded by the chat SSE route. The publisher checks literal event names. */
export interface ChatExecutionEventData {
	"execution.replay_unavailable": { message: string };
	"execution.text_delta": { text: string };
	"execution.iteration_start": { iteration: number; retryAttempt?: number };
	"execution.tool_start": {
		stepId?: string;
		toolCall: ChatExecutionToolCall;
	};
	"execution.tool_input": {
		stepId?: string;
		toolCall: ChatExecutionToolCall;
	};
	"execution.tool_complete": {
		stepId?: string;
		toolCall: ChatExecutionToolCall;
	};
	"execution.limit_signal": import("@repo/ai/limits").LimitSignal;
	"execution.context_compacted": {
		iteration: number;
		compactedTurns: number;
		summaryChars: number;
		historyLengthBefore: number;
	};
	"execution.mcp_default_tool_invoked": Record<string, unknown>;
	"execution.mcp_default_tool_failed": Record<string, unknown>;
}
export type ChatExecutionEvent = {
	[K in keyof ChatExecutionEventData]: {
		event: K;
		data: ChatExecutionEventData[K];
	};
}[keyof ChatExecutionEventData] & {
	eventCursor?: ChatEventCursor;
	replayUnavailable?: boolean;
};
export interface ExecutionEvent<Name extends string = string> {
	event: Name;
	data: Name extends keyof ChatExecutionEventData
		? ChatExecutionEventData[Name]
		: Record<string, unknown>;
}

/**
 * Publish an execution event via Redis pub/sub.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * @param executionId - The execution ID (used as channel name)
 * @param event - The event to publish
 */
const replayQueues = new WeakMap<Context, Promise<void>>();
const replayQueueSizes = new WeakMap<Context, number>();
const MAX_PENDING_REPLAY_EVENTS = 32;
const replayOrdinals = new WeakMap<Context, number>();
const replayFailures = new Map<
	string,
	{ expiresAt: number; nextMarkerAttemptAt: number }
>();
const replayEventNames = new Set([
	"execution.text_delta",
	"execution.iteration_start",
	"execution.tool_start",
	"execution.tool_input",
	"execution.tool_complete",
	"execution.limit_signal",
	"execution.context_compacted",
]);

export function publishExecutionEvent<const Name extends string>(
	executionId: string,
	event: ExecutionEvent<Name>,
): Promise<void> {
	let context: Context | undefined;
	try {
		context = Context.current();
	} catch {
		/* Also used outside activities. */
	}
	const info = context?.info;
	const workflow = info?.workflowExecution;
	if (
		!context ||
		!info ||
		!workflow ||
		workflow.workflowId !== executionId ||
		!executionId.startsWith("orch-") ||
		!replayEventNames.has(event.event)
	) {
		return publishEvent(executionId, event);
	}
	const owner = context;
	if (info.attempt > 1 && !replayFailures.has(workflow.runId)) {
		replayFailures.set(workflow.runId, {
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			nextMarkerAttemptAt: 0,
		});
	}
	if (replayFailures.has(workflow.runId)) {
		markExecutionReplayUnavailable(owner);
	}
	registerExecutionOutputDrain(owner, async () => {
		flushText(owner);
		await replayQueues.get(owner);
	});
	if (
		event.event === "execution.text_delta" &&
		"text" in event.data &&
		typeof event.data.text === "string"
	) {
		let pending = pendingTexts.get(context);
		if (!pending) {
			let resolve = () => {};
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			pending = {
				executionId,
				text: "",
				promise,
				resolve,
				timer: setTimeout(() => flushText(owner), 50),
			};
			pendingTexts.set(context, pending);
		}
		pending.text += event.data.text;
		if (pending.text.length >= 8192) {
			flushText(context);
		}
		return pending.promise;
	}
	flushText(context);
	return queueReplayEvent(context, executionId, event);
}

const pendingTexts = new WeakMap<
	Context,
	{
		executionId: string;
		text: string;
		promise: Promise<void>;
		resolve: () => void;
		timer: ReturnType<typeof setTimeout>;
	}
>();

function flushText(context: Context) {
	const pending = pendingTexts.get(context);
	if (!pending) {
		return;
	}
	pendingTexts.delete(context);
	clearTimeout(pending.timer);
	void queueReplayEvent(context, pending.executionId, {
		event: "execution.text_delta",
		data: { text: pending.text },
	}).then(pending.resolve, pending.resolve);
}

function queueReplayEvent<const Name extends string>(
	context: Context,
	executionId: string,
	event: ExecutionEvent<Name>,
): Promise<void> {
	const info = context.info;
	const workflow = info.workflowExecution;
	if (!workflow) {
		return publishEvent(executionId, event);
	}
	const queueSize = replayQueueSizes.get(context) ?? 0;
	if (queueSize >= MAX_PENDING_REPLAY_EVENTS) {
		markExecutionReplayUnavailable(context);
		replayFailures.set(workflow.runId, {
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			nextMarkerAttemptAt: 0,
		});
		return Promise.resolve();
	}
	replayQueueSizes.set(context, queueSize + 1);
	const ordinal = replayOrdinals.get(context) ?? 0;
	if (ordinal === 0) {
		for (const [runId, failure] of replayFailures) {
			if (failure.expiresAt <= Date.now()) {
				replayFailures.delete(runId);
			}
		}
	}
	replayOrdinals.set(context, ordinal + 1);
	const previous = replayQueues.get(context) ?? Promise.resolve();
	const next = previous
		.then(async () => {
			let metadata: Record<string, unknown>;
			const markUnavailable = () =>
				appendConversationTurnEventFromWorker({
					executionId,
					runId: workflow.runId,
					sourceKey: "replay-unavailable",
					event: "execution.replay_unavailable",
					data: {
						message:
							"Replay output is incomplete. The workflow may still be running; refresh to check its final result.",
					},
				});
			try {
				const failure = replayFailures.get(workflow.runId);
				if (failure) {
					markExecutionReplayUnavailable(context);
					if (failure.nextMarkerAttemptAt <= Date.now()) {
						failure.nextMarkerAttemptAt =
							Date.now() + RETRY_BACKOFF_MS;
						await markUnavailable();
					}
					await publishEvent(executionId, {
						...event,
						replayUnavailable: true,
					});
					return;
				}
				const eventCursor = await appendReplayEvent({
					executionId,
					runId: workflow.runId,
					sourceKey: `${info.activityId}:${info.attempt}:${ordinal}`,
					event: event.event,
					data: event.data,
				});
				metadata = eventCursor ? { eventCursor } : {};
			} catch {
				markExecutionReplayUnavailable(context);
				replayFailures.set(workflow.runId, {
					expiresAt: Date.now() + 24 * 60 * 60 * 1000,
					nextMarkerAttemptAt: Date.now() + RETRY_BACKOFF_MS,
				});
				await markUnavailable().catch(() => {});
				// Never announce a resumable sequence before its transaction commits.
				// Legacy observers may still use the live payload; replay clients are
				// told explicitly that this window cannot offer complete recovery.
				logger.warn(
					"[RedisPublisher] Chat replay persistence unavailable",
				);
				metadata = { replayUnavailable: true };
			}
			await publishEvent(executionId, { ...event, ...metadata });
		})
		.finally(() => {
			replayQueueSizes.set(
				context,
				(replayQueueSizes.get(context) ?? 1) - 1,
			);
		});
	replayQueues.set(context, next);
	return next;
}

async function appendReplayEvent(
	input: Parameters<typeof appendConversationTurnEventFromWorker>[0],
) {
	try {
		return await appendConversationTurnEventFromWorker(input);
	} catch (error) {
		if (error instanceof ChatEventReplayError) {
			throw error;
		}
		// The source key makes an uncertain commit safe to retry once. A cache
		// limit or malformed event is definitive and must not be retried.
		return appendConversationTurnEventFromWorker(input);
	}
}

async function publishEvent<const Name extends string>(
	executionId: string,
	event: ExecutionEvent<Name> & {
		eventCursor?: ChatEventCursor;
		replayUnavailable?: boolean;
	},
): Promise<void> {
	try {
		const client = await getRedisPublisher();
		if (!client) {
			logger.debug("[RedisPublisher] No client, skipping", {
				event: event.event,
			});
			return;
		}

		const channel = `execution:${executionId}`;
		const payload = JSON.stringify(event);
		const subscribers = await client.publish(channel, payload);
		logger.info("[RedisPublisher] Published", {
			channel,
			event: event.event,
			subscribers,
		});
	} catch (err) {
		logger.warn("[RedisPublisher] Publish failed", {
			event: event.event,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Expose the lazily-created ioredis client for shared use (e.g. redis-cache.ts).
 * Returns the singleton client if already connected, initiates a connection
 * otherwise. Returns null when Redis is unavailable or misconfigured.
 *
 * The caller must not hold a reference across worker restarts — always call
 * this function at the point of use so the lazy-reconnect logic applies.
 */
export async function getRedisClient(): Promise<
	import("ioredis").default | null
> {
	return getRedisPublisher();
}

/**
 * Gracefully disconnect the Redis publisher.
 * Called during worker shutdown.
 */
export async function disconnectRedisPublisher(): Promise<void> {
	if (redisClient) {
		try {
			await redisClient.quit();
		} catch {
			// Ignore disconnect errors
		}
		redisClient = null;
		connectionPromise = null;
	}
}

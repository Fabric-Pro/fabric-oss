/**
 * Durable AG-UI agent runs: the Redis side of the contract between the web
 * runtime that starts and watches a run
 * (`apps/web/modules/saas/agents/runtime/ag-ui-agent-engine.ts`) and the
 * worker activity that runs it (`activities/ag-ui-agent-run.ts`). The workflow
 * side is `agui-run-contract.ts`, re-exported here so the web imports one
 * module.
 *
 * A run is one Temporal workflow, `agUiAgentRunWorkflow`, with the id
 * `agui-run-<runId>`: a retried AG-UI run id finds its workflow already
 * started and attaches instead of running the agent twice. Its activity runs
 * the LangGraph agent and appends every AG-UI event it emits to a Redis
 * stream; the web side replays and tails that stream, so a closed tab never
 * ends a run and a reopened one reattaches.
 *
 * Redis keys (one Redis, reached by the web app and the worker alike through
 * `REDIS_URL` / `CACHE_HOST`):
 *
 * | Key                       | Type   | Holds                                         | Expires |
 * |---------------------------|--------|-----------------------------------------------|---------|
 * | `agui:run:<runId>:input`  | string | the run's `RunAgentInput` and AI token (JSON) | `AGUI_RUN_INPUT_TTL_SECONDS`, or when the activity takes it |
 * | `agui:run:<runId>:events` | stream | one entry per AG-UI event, field `event`      | `AGUI_RUN_EVENT_RETENTION_SECONDS`, renewed on each append |
 * | `agui:thread:<threadId>`  | hash   | owner, organization, latest run, workflow     | `AGUI_RUN_EVENT_RETENTION_SECONDS`, renewed on each run |
 *
 * The input travels by reference because it carries the whole document in its
 * state, which can exceed Temporal's 2 MB payload limit. The input record also
 * holds the AI token the CopilotKit route minted for the request: the worker
 * holds no token-signing secret (it could mint a token for anyone), and the
 * token must never enter the workflow's input or history. The activity takes
 * the record with an atomic read-and-delete, so the token sits in Redis only
 * until pickup. The worker reads its own `AGENT_API_KEY`.
 *
 * Every run's stream ends with exactly one terminal event (`RUN_FINISHED` or
 * `RUN_ERROR`), as the agent sent it or as the activity synthesized it on a
 * failure or a cancellation.
 */

import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { logger } from "@repo/logs";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";
import type { ChainableCommander, default as Redis } from "ioredis";
import {
	AGUI_RUN_EVENT_RETENTION_SECONDS,
	AGUI_RUN_INPUT_TTL_SECONDS,
} from "./agui-run-contract";
import { getRedisUrl, isPlaintextRedisRefused } from "./redis-url";

export * from "./agui-run-contract";

/**
 * Approximate cap on one run's stream (`XADD … MAXLEN ~`). A long document
 * rewrite emits a few thousand events (token deltas, predictive state); the
 * cap only stops a runaway agent from growing a key without bound.
 */
export const AGUI_RUN_STREAM_MAX_EVENTS = 50_000;

/** Read from the start of a run's stream. */
export const STREAM_START = "0";

const STREAM_FIELD = "event";

function inputKey(runId: string): string {
	return `agui:run:${runId}:input`;
}

function eventsKey(runId: string): string {
	return `agui:run:${runId}:events`;
}

function threadKey(threadId: string): string {
	return `agui:thread:${threadId}`;
}

/** Which run a thread last ran, and whose thread it is. */
export interface AgUiThreadRecord {
	userId: string;
	organizationId: string;
	latestRunId: string;
	workflowId: string;
}

export interface StoredRunEvent {
	/** The stream entry id; read on from it with `readEvents`. */
	id: string;
	event: BaseEvent;
}

export function isTerminalRunEvent(event: BaseEvent): boolean {
	return (
		event.type === EventType.RUN_FINISHED ||
		event.type === EventType.RUN_ERROR
	);
}

/** What a run's input record holds: its input, and the request's AI token. */
export interface AgUiRunInputRecord {
	input: RunAgentInput;
	/** The bearer token the agent's `X-AI-Token` header carries. */
	aiToken: string;
}

/** The run store both sides use; `openAgUiRunStore` is the Redis one. */
export interface AgUiRunStore {
	/** Park a run's input record; returns the reference the workflow carries. */
	writeInput(runId: string, record: AgUiRunInputRecord): Promise<string>;
	/**
	 * Read a run's input record and delete it in one step, or null when it is
	 * gone (expired, or already taken).
	 */
	takeInput(inputRef: string): Promise<AgUiRunInputRecord | null>;
	appendEvent(runId: string, event: BaseEvent): Promise<void>;
	/**
	 * Events after `afterId` (`STREAM_START` for all). With `blockMs`, waits
	 * up to that long for the first one when there is none yet.
	 */
	readEvents(
		runId: string,
		afterId: string,
		blockMs?: number,
	): Promise<StoredRunEvent[]>;
	/** The run's newest event, or null before its first. */
	readLastEvent(runId: string): Promise<StoredRunEvent | null>;
	writeThread(threadId: string, record: AgUiThreadRecord): Promise<void>;
	readThread(threadId: string): Promise<AgUiThreadRecord | null>;
	close(): Promise<void>;
}

const EVENT_TYPES = new Set<string>(Object.values(EventType));

function isBaseEvent(value: unknown): value is BaseEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string" &&
		EVENT_TYPES.has(value.type)
	);
}

function isRunAgentInput(value: unknown): value is RunAgentInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"threadId" in value &&
		typeof value.threadId === "string" &&
		"runId" in value &&
		typeof value.runId === "string" &&
		"messages" in value &&
		Array.isArray(value.messages) &&
		"tools" in value &&
		Array.isArray(value.tools) &&
		"context" in value &&
		Array.isArray(value.context)
	);
}

function isRunInputRecord(value: unknown): value is AgUiRunInputRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"aiToken" in value &&
		typeof value.aiToken === "string" &&
		value.aiToken.length > 0 &&
		"input" in value &&
		isRunAgentInput(value.input)
	);
}

/** Stream entries as ioredis returns them: `[id, [field, value, …]]`. */
function toStoredEvents(
	entries: Array<[id: string, fields: string[]]>,
): StoredRunEvent[] {
	const events: StoredRunEvent[] = [];
	for (const [id, fields] of entries) {
		const raw = fields[fields.indexOf(STREAM_FIELD) + 1];
		const parsed: unknown = raw === undefined ? null : JSON.parse(raw);
		if (isBaseEvent(parsed)) {
			events.push({ id, event: parsed });
		}
	}
	return events;
}

/**
 * Run a MULTI and return each command's reply; any command's error rejects
 * (ioredis resolves them per command).
 */
async function execAll(transaction: ChainableCommander): Promise<unknown[]> {
	const results = await transaction.exec();
	if (!results) {
		throw new Error("Redis transaction was discarded");
	}
	return results.map(([error, reply]) => {
		if (error) {
			throw error;
		}
		return reply;
	});
}

/** The Redis-backed store over one dedicated connection. */
export class RedisAgUiRunStore implements AgUiRunStore {
	constructor(private readonly redis: Redis) {}

	async writeInput(
		runId: string,
		record: AgUiRunInputRecord,
	): Promise<string> {
		const key = inputKey(runId);
		// NX: a retried run never replaces the input its workflow may be
		// reading.
		await this.redis.set(
			key,
			JSON.stringify(record),
			"EX",
			AGUI_RUN_INPUT_TTL_SECONDS,
			"NX",
		);
		return key;
	}

	async takeInput(inputRef: string): Promise<AgUiRunInputRecord | null> {
		// GET and DEL in one MULTI rather than GETDEL: same atomic
		// read-and-delete, and it does not need Redis 6.2 (the Azure Cache
		// for Redis tier this deploys to may run 6.0).
		const [raw] = await execAll(
			this.redis.multi().get(inputRef).del(inputRef),
		);
		if (typeof raw !== "string") {
			return null;
		}
		const parsed: unknown = JSON.parse(raw);
		return isRunInputRecord(parsed) ? parsed : null;
	}

	async appendEvent(runId: string, event: BaseEvent): Promise<void> {
		const key = eventsKey(runId);
		await execAll(
			this.redis
				.multi()
				.xadd(
					key,
					"MAXLEN",
					"~",
					AGUI_RUN_STREAM_MAX_EVENTS,
					"*",
					STREAM_FIELD,
					JSON.stringify(event),
				)
				.expire(key, AGUI_RUN_EVENT_RETENTION_SECONDS),
		);
	}

	async readEvents(
		runId: string,
		afterId: string,
		blockMs?: number,
	): Promise<StoredRunEvent[]> {
		const key = eventsKey(runId);
		if (blockMs === undefined) {
			const entries = await this.redis.xrange(
				key,
				afterId === STREAM_START ? "-" : `(${afterId}`,
				"+",
			);
			return toStoredEvents(entries);
		}
		const result = await this.redis.xread(
			"BLOCK",
			Math.max(1, Math.round(blockMs)),
			"STREAMS",
			key,
			afterId,
		);
		return result
			? toStoredEvents(result.flatMap(([, entries]) => entries))
			: [];
	}

	async readLastEvent(runId: string): Promise<StoredRunEvent | null> {
		const entries = await this.redis.xrevrange(
			eventsKey(runId),
			"+",
			"-",
			"COUNT",
			1,
		);
		return toStoredEvents(entries)[0] ?? null;
	}

	async writeThread(
		threadId: string,
		record: AgUiThreadRecord,
	): Promise<void> {
		const key = threadKey(threadId);
		await execAll(
			this.redis
				.multi()
				.hset(key, { ...record })
				.expire(key, AGUI_RUN_EVENT_RETENTION_SECONDS),
		);
	}

	async readThread(threadId: string): Promise<AgUiThreadRecord | null> {
		const fields = await this.redis.hgetall(threadKey(threadId));
		const { userId, organizationId, latestRunId, workflowId } = fields;
		return userId && organizationId && latestRunId && workflowId
			? { userId, organizationId, latestRunId, workflowId }
			: null;
	}

	async close(): Promise<void> {
		await this.redis.quit();
	}
}

/**
 * A run store on a fresh Redis connection, for one run or one watch: a
 * blocking stream read holds its connection, so none is shared. Throws when
 * no Redis is configured, or a plaintext one in production — a durable run
 * cannot be served without its stream.
 */
export async function openAgUiRunStore(): Promise<AgUiRunStore> {
	const redisUrl = getRedisUrl();
	if (!redisUrl) {
		throw new Error(
			"Durable agent runs need Redis: set REDIS_URL (or CACHE_HOST).",
		);
	}
	if (isPlaintextRedisRefused(redisUrl)) {
		throw new Error(
			"Refusing plaintext redis:// for durable agent runs in production (SOC 2 CC6.7). Use rediss://.",
		);
	}
	const { default: IORedis } = await import("ioredis");
	const redis = new IORedis(redisUrl, {
		maxRetriesPerRequest: 1,
		// Without this, ioredis disables TCP keepalive and an idle
		// connection is reaped upstream (see REDIS_KEEPALIVE_MS).
		keepAlive: REDIS_KEEPALIVE_MS,
		connectTimeout: 3000,
		lazyConnect: true,
	});
	// Attached before connect() so a failed attempt is not an unhandled
	// "error" event; the failing command still rejects to its caller.
	redis.on("error", (error: Error) => {
		logger.warn("[AgUiRunStore] Redis connection error", {
			error: error.message,
		});
	});
	try {
		await redis.connect();
	} catch (error) {
		// Stop ioredis's background reconnect timers for the dead client.
		redis.disconnect();
		throw error;
	}
	return new RedisAgUiRunStore(redis);
}

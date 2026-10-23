/**
 * Realtime emit helpers for the events a Temporal activity publishes: the
 * conversation channel's `message_appended`, and the project channel's
 * `context_change`, `activity` and `document_change`.
 *
 * Lives in `@repo/utils` (and NOT in `@repo/api`) so that
 * `@repo/temporal` can static-import it without inverting the workspace
 * dependency graph (`@repo/api` already depends on `@repo/temporal`).
 *
 * # Env dependency (documented exception to the "utils is pure" rule)
 *
 * This is the ONE module in `@repo/utils` that reads from `process.env`.
 * The exception is intentional: the Upstash Realtime client construction
 * is inherently env-coupled (URL + token), and lifting client
 * construction to a caller would require ALL callers (temporal worker,
 * oRPC server, SSE route) to duplicate the same boilerplate. Centralising
 * it here trades one well-documented env touch for ~3 copies of the
 * same lookup + factory.
 *
 * Variables consulted (both must be set for realtime to be enabled —
 * matches the api-side `getProjectRealtime` factory exactly):
 *   - `UPSTASH_REDIS_REST_URL`
 *   - `UPSTASH_REDIS_REST_TOKEN`
 *
 * When either is missing, `getRealtimeClient()` returns `null` and every
 * emit helper falls back to the web relay below, or becomes a no-op when
 * that is not configured either. This keeps local dev + CI green without
 * Redis credentials.
 *
 * # Fallback: relay through the web app
 *
 * The Azure worker container apps get `REDIS_URL` but not the Upstash REST
 * variables, so on their own no worker event would reach an open page
 * (Fizzy #2946). They do get `AGENT_SERVICE_SECRET` and the web app's base
 * URL, which the Weave coding-run bridge already calls the web with. So a
 * process without Upstash but with `AGENT_SERVICE_SECRET` and a base URL
 * (`FABRIC_INTERNAL_URL`, `RUNTIME_API_URL`, `APP_URL`, `NEXT_PUBLIC_APP_URL`,
 * first set wins: the bridge's chain in
 * `packages/temporal/src/activities/weave/shuttle-execution.ts`, minus its
 * localhost default) POSTs each event to the web's
 * `/api/internal/realtime-emit` with the secret in `X-Agent-Service-Token`.
 * The route checks the body against `realtimeRelayRequestSchema` (built from
 * the schemas below) and publishes with the web's own client, the one its
 * SSE routes subscribe through. It never calls these emitters, so a relayed
 * event cannot be relayed again.
 *
 * - Upstash configured: direct publish, as before; the relay is not used.
 * - Upstash absent, relay configured: one POST per emit, bounded by
 *   `RELAY_TIMEOUT_MS`.
 * - Neither: no-op.
 *
 * A caller that hands in its own client never relays, `null` included. The
 * API's wrappers for all four events pass theirs, so a web process (local
 * dev, a preview) emits nothing without Upstash rather than POSTing to
 * itself or to whatever app URL it was given; only the worker, which calls
 * these emitters with the default client, relays. Repeated relay failures
 * are logged once per kind at warn, then at debug.
 *
 * # Error handling
 *
 * No emit helper here ever throws. A Redis outage, or a relay call that is
 * refused, fails or times out, degrades to "next polling refresh", not "the
 * operation result is lost" — the persistence write already landed before
 * the helper was called. A failure is logged by event name and status only,
 * never with the payload or the secret.
 *
 * # Schema scope
 *
 * Only the events a Temporal activity emits live here: `message_appended`;
 * `context_change` and `activity`, which the synced-file deletion workflow
 * publishes after it deleted a row (Fizzy #2636); and `document_change`,
 * which Proposal generation publishes as its sections land (Fizzy #2801).
 * The project-channel three moved here from `packages/api/lib/realtime.ts`,
 * which re-exports the emitters and builds its SSE schema from the same zod
 * objects, so the two sides cannot drift. The rest of
 * `projectRealtimeSchema` (presence_update, lock_update) stays in
 * `packages/api/lib/realtime.ts`, whose `emitContextChange`, `emitActivity`
 * and `emitDocumentChange` wrappers call the emitters here with the API's
 * own client, so an API caller publishes everything through one instance. The two `Realtime` instances (API and Temporal worker) co-exist; they share the same underlying Redis
 * backend so events written by one and read by another (e.g. SSE route
 * subscribes via the api-side instance, emits come from the utils-side
 * instance) work fine — Redis is a shared message bus, the Realtime
 * client is only a typed wrapper.
 */

import { Realtime } from "@upstash/realtime";
import { Redis } from "@upstash/redis";
import { z } from "zod";

/**
 * Conversation-channel event schema. Currently only `message_appended` —
 * other events (e.g. `message_streamed`) may be added here later.
 *
 * Mirrors the shape declared in `packages/api/lib/realtime.ts`'s
 * `projectRealtimeSchema.message_appended`; the two schemas talk to the
 * same Redis channel and MUST stay in sync. (Consider lifting both to a
 * shared module if a third writer ever appears.)
 */
export const conversationMessageAppendedSchema = z.object({
	conversationId: z.string(),
	messageId: z.string(),
	appendedAt: z.string(),
});

export type MessageAppendedPayload = z.infer<
	typeof conversationMessageAppendedSchema
>;

/**
 * Channel name for the per-conversation realtime stream. Keyed by
 * conversationId — NOT projectId — because not every operation-result
 * message can be attributed to a project (e.g. Sidekick chats and
 * personal-assistant chats live outside any project tenant). The SSE
 * route at `/api/conversations/{id}/realtime` enforces ownership before
 * subscribing.
 */
export function getConversationChannelName(conversationId: string): string {
	return `conversation:${conversationId}`;
}

/**
 * A project's Context changed: a source added, updated or deleted. The
 * SSE-side schema in `packages/api/lib/realtime.ts` uses this same object.
 */
export const contextChangeSchema = z.object({
	projectId: z.string(),
	contextId: z.string(),
	action: z.enum(["added", "updated", "deleted"]),
	userId: z.string(),
	userName: z.string(),
	contextType: z.string().optional(),
	contextName: z.string().optional(),
});

export type ContextChangePayload = z.infer<typeof contextChangeSchema>;

/**
 * A project activity-feed event. The SSE-side schema in
 * `packages/api/lib/realtime.ts` uses this same object.
 */
export const activitySchema = z.object({
	projectId: z.string(),
	userId: z.string(),
	userName: z.string(),
	activityType: z.string(),
	resourceType: z.string().optional(),
	resourceId: z.string().optional(),
	resourceName: z.string().optional(),
	timestamp: z.string(),
});

export type ActivityPayload = z.infer<typeof activitySchema>;

/**
 * A project document was created, updated or deleted. The SSE-side schema in
 * `packages/api/lib/realtime.ts` uses this same object. The web client only
 * refetches on it, so a worker's nudge while a document generates looks
 * like any other document update.
 */
export const documentChangeSchema = z.object({
	projectId: z.string(),
	documentId: z.string(),
	action: z.enum(["created", "updated", "deleted"]),
	userId: z.string(),
	userName: z.string(),
	documentType: z.string().optional(),
	documentTitle: z.string().optional(),
});

export type DocumentChangePayload = z.infer<typeof documentChangeSchema>;

/** Channel name for a project's realtime stream. */
export function getProjectChannelName(projectId: string): string {
	return `project:${projectId}`;
}

const realtimeEmitSchema = {
	message_appended: conversationMessageAppendedSchema,
	context_change: contextChangeSchema,
	activity: activitySchema,
	document_change: documentChangeSchema,
};

/** One event of `realtimeEmitSchema` with its payload, as `emit` takes them. */
type RelayedEventArgs =
	| [event: "message_appended", data: MessageAppendedPayload]
	| [event: "context_change", data: ContextChangePayload]
	| [event: "activity", data: ActivityPayload]
	| [event: "document_change", data: DocumentChangePayload];

const relayChannelId = z.string().min(1);

/**
 * The body the web relay accepts (see the header): one event of
 * `realtimeEmitSchema`, its channel and that channel's id, with `data`
 * checked against the same schema a direct publish uses. One entry per
 * `realtimeEmitSchema` event. The id must be the payload's own project or
 * conversation, so a relayed event lands on the channel a direct publish
 * would have used.
 */
export const realtimeRelayRequestSchema = z
	.discriminatedUnion("event", [
		z.object({
			channel: z.literal("conversation"),
			id: relayChannelId,
			event: z.literal("message_appended"),
			data: conversationMessageAppendedSchema,
		}),
		z.object({
			channel: z.literal("project"),
			id: relayChannelId,
			event: z.literal("context_change"),
			data: contextChangeSchema,
		}),
		z.object({
			channel: z.literal("project"),
			id: relayChannelId,
			event: z.literal("activity"),
			data: activitySchema,
		}),
		z.object({
			channel: z.literal("project"),
			id: relayChannelId,
			event: z.literal("document_change"),
			data: documentChangeSchema,
		}),
	])
	.refine(
		(request) =>
			request.id ===
			(request.event === "message_appended"
				? request.data.conversationId
				: request.data.projectId),
		{ message: "id must be the payload's own channel id", path: ["id"] },
	);

export type RealtimeRelayRequest = z.infer<typeof realtimeRelayRequestSchema>;

/** The web route the relay POSTs to. */
const REALTIME_RELAY_PATH = "/api/internal/realtime-emit";

/**
 * How long one relay POST may take. An activity awaits each emit, so a slow
 * or unreachable web app costs it a few seconds at most, never a hang.
 */
const RELAY_TIMEOUT_MS = 3_000;

/** Where the relay POSTs and with what, or null when either is unset. */
function getRelayConfig(): { url: string; secret: string } | null {
	const secret = process.env.AGENT_SERVICE_SECRET;
	const baseUrl =
		process.env.FABRIC_INTERNAL_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.APP_URL ||
		process.env.NEXT_PUBLIC_APP_URL;
	if (!secret || !baseUrl) {
		return null;
	}
	return {
		url: `${baseUrl.replace(/\/+$/, "")}${REALTIME_RELAY_PATH}`,
		secret,
	};
}

// The kinds of relay failure this process has already warned about.
let reportedRelayFailures = new Set<string>();

/**
 * Log a relay failure: the first of each kind (an HTTP status, `network`,
 * `timeout`) at warn, repeats at debug, so a worker whose web keeps
 * answering 503 says so once rather than on every emit.
 */
function reportRelayFailure(kind: string, message: string): void {
	if (reportedRelayFailures.has(kind)) {
		console.debug(message);
		return;
	}
	reportedRelayFailures.add(kind);
	console.warn(
		`${message}; further ${kind} failures are logged at debug level`,
	);
}

/**
 * POST one event to the web relay. Never throws: a refusal, a network error
 * or the timeout is logged by event name and status only.
 */
async function relayEmit(
	relay: { url: string; secret: string },
	...[event, data]: RelayedEventArgs
): Promise<void> {
	const target =
		event === "message_appended"
			? { channel: "conversation", id: data.conversationId }
			: { channel: "project", id: data.projectId };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
	try {
		const response = await fetch(relay.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": relay.secret,
			},
			body: JSON.stringify({ ...target, event, data }),
			signal: controller.signal,
		});
		if (!response.ok) {
			reportRelayFailure(
				`HTTP ${response.status}`,
				`[realtime-emit] The web relay refused ${event} (${response.status})`,
			);
		}
		await response.body?.cancel().catch(() => undefined);
	} catch (error) {
		reportRelayFailure(
			controller.signal.aborted ? "timeout" : "network",
			`[realtime-emit] Failed to relay ${event}: ${
				error instanceof Error ? error.message : "unknown error"
			}`,
		);
	} finally {
		clearTimeout(timeout);
	}
}

interface RelayClient {
	channel(name: string): {
		emit(...args: RelayedEventArgs): Promise<void>;
	};
}

/**
 * A client shaped like the Upstash one whose emit goes through the web
 * relay, or null when the relay is not configured. The channel name itself
 * is not sent: the body carries the payload's own channel kind and id, and
 * the route rebuilds the name from them, as the emitters here build it.
 */
function getRelayClient(): RelayClient | null {
	const relay = getRelayConfig();
	if (!relay) {
		return null;
	}
	const channel = {
		emit: (...args: RelayedEventArgs) => relayEmit(relay, ...args),
	};
	return { channel: () => channel };
}

type RealtimeEmitOptions = {
	schema: typeof realtimeEmitSchema;
	redis: Redis;
};

// Lazy-initialised + memoised across the process lifetime. Matches the
// pattern in `packages/api/lib/realtime.ts:getProjectRealtime`.
let redisClient: Redis | null = null;
let realtimeInstance: Realtime<RealtimeEmitOptions> | null = null;
let initializationAttempted = false;

function getRedisClient(): Redis | null {
	if (redisClient) {
		return redisClient;
	}

	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!url || !token) {
		return null;
	}

	try {
		redisClient = new Redis({ url, token });
		return redisClient;
	} catch (error) {
		console.error("[realtime-emit] Failed to initialise Redis:", error);
		return null;
	}
}

/**
 * Returns a memoised `Realtime` client for the events emitted here, or
 * `null` if Upstash env vars are not configured. Safe to call from any
 * process (Temporal worker, Next.js server route, oRPC handler) — it
 * produces at most one Redis + one Realtime instance per process.
 */
export function getRealtimeClient(): Realtime<RealtimeEmitOptions> | null {
	if (realtimeInstance) {
		return realtimeInstance;
	}

	if (initializationAttempted) {
		return null;
	}

	initializationAttempted = true;

	const redis = getRedisClient();
	if (!redis) {
		return null;
	}

	try {
		realtimeInstance = new Realtime<RealtimeEmitOptions>({
			schema: realtimeEmitSchema,
			redis,
		});
		return realtimeInstance;
	} catch (error) {
		console.error("[realtime-emit] Failed to initialise Realtime:", error);
		return null;
	}
}

/**
 * The client an emit uses when its caller hands in none: this module's
 * Upstash client, else the web relay (see the header), else null.
 */
function getDefaultClient():
	| Realtime<RealtimeEmitOptions>
	| RelayClient
	| null {
	return getRealtimeClient() ?? getRelayClient();
}

/**
 * The part of a client `emitConversationMessageAppended` uses: this
 * module's client, the relay, or (through `RelayedEventRealtime`) the API's.
 */
export interface ConversationEventRealtime {
	channel(name: string): {
		emit(
			event: "message_appended",
			data: MessageAppendedPayload,
		): Promise<void>;
	};
}

/**
 * Emit a `message_appended` event onto the conversation's channel.
 * Called by the operation-result code paths (Temporal activity + oRPC
 * handler) AFTER the row is persisted. `realtime` defaults to this
 * module's client, or the web relay without one (the worker); the API
 * passes its own, so the web never relays; `null` emits nothing.
 *
 * Never throws — a Redis outage degrades realtime delivery to the next
 * polling refresh, not "the operation result is lost".
 */
export async function emitConversationMessageAppended(
	payload: MessageAppendedPayload,
	realtime: ConversationEventRealtime | null = getDefaultClient(),
): Promise<void> {
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getConversationChannelName(payload.conversationId),
		);
		await channel.emit("message_appended", payload);
	} catch (error) {
		console.error(
			"[realtime-emit] Failed to emit message_appended:",
			error,
		);
	}
}

/**
 * The part of a `Realtime` client the project-channel emitters use. Both
 * this module's client and the API's richer `getProjectRealtime()` client
 * satisfy it, so an API caller can hand its own instance in and keep every
 * event it emits on one client.
 */
export interface ProjectEventRealtime {
	channel(name: string): {
		emit(
			event: "context_change",
			data: ContextChangePayload,
		): Promise<void>;
		emit(event: "activity", data: ActivityPayload): Promise<void>;
		emit(
			event: "document_change",
			data: DocumentChangePayload,
		): Promise<void>;
	};
}

/**
 * The part of a `Realtime` client that publishes every event the web relay
 * accepts. The API's `getProjectRealtime()` client satisfies it, which is how
 * the relay route publishes a `realtimeRelayRequestSchema` event.
 */
export interface RelayedEventRealtime {
	channel(name: string): {
		emit(
			event: "message_appended",
			data: MessageAppendedPayload,
		): Promise<void>;
		emit(
			event: "context_change",
			data: ContextChangePayload,
		): Promise<void>;
		emit(event: "activity", data: ActivityPayload): Promise<void>;
		emit(
			event: "document_change",
			data: DocumentChangePayload,
		): Promise<void>;
	};
}

/**
 * Emit a `context_change` event onto the project's channel. Never throws.
 * `realtime` defaults to this module's client, or the web relay without
 * one; `null` emits nothing.
 */
export async function emitContextChange(
	payload: ContextChangePayload,
	realtime: ProjectEventRealtime | null = getDefaultClient(),
): Promise<void> {
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getProjectChannelName(payload.projectId),
		);
		await channel.emit("context_change", payload);
	} catch (error) {
		console.error("[realtime-emit] Failed to emit context_change:", error);
	}
}

/**
 * Emit an `activity` event onto the project's channel. Never throws.
 * `realtime` defaults to this module's client, or the web relay without
 * one; `null` emits nothing.
 */
export async function emitActivity(
	payload: ActivityPayload,
	realtime: ProjectEventRealtime | null = getDefaultClient(),
): Promise<void> {
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getProjectChannelName(payload.projectId),
		);
		await channel.emit("activity", payload);
	} catch (error) {
		console.error("[realtime-emit] Failed to emit activity:", error);
	}
}

/**
 * Emit a `document_change` event onto the project's channel. Never throws.
 * `realtime` defaults to this module's client, or the web relay without
 * one; `null` emits nothing.
 */
export async function emitDocumentChange(
	payload: DocumentChangePayload,
	realtime: ProjectEventRealtime | null = getDefaultClient(),
): Promise<void> {
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getProjectChannelName(payload.projectId),
		);
		await channel.emit("document_change", payload);
	} catch (error) {
		console.error("[realtime-emit] Failed to emit document_change:", error);
	}
}

/**
 * Test-only escape hatch: reset the memoised clients. Should never be
 * called in production code; exported so unit tests that want to assert
 * lazy-init semantics can do so via `vi.resetModules()` OR this helper.
 *
 * @internal
 */
export function __resetRealtimeClientForTest(): void {
	redisClient = null;
	realtimeInstance = null;
	initializationAttempted = false;
	reportedRelayFailures = new Set();
}

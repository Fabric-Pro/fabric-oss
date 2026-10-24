/**
 * Upstash Realtime Configuration for Project Collaboration
 *
 * Provides real-time presence, document changes, and activity notifications
 * using Upstash Realtime (HTTP-based, powered by Redis Streams).
 *
 * @see https://upstash.com/blog/realtime-cursors-next-16
 */

import {
	type ActivityPayload,
	activitySchema,
	type ContextChangePayload,
	contextChangeSchema,
	conversationMessageAppendedSchema,
	type DocumentChangePayload,
	documentChangeSchema,
	getConversationChannelName,
	getProjectChannelName,
	type MessageAppendedPayload,
	type RealtimeRelayRequest,
	type RelayedEventRealtime,
	emitActivity as sharedEmitActivity,
	emitContextChange as sharedEmitContextChange,
	emitConversationMessageAppended as sharedEmitConversationMessageAppended,
	emitDocumentChange as sharedEmitDocumentChange,
} from "@repo/utils/realtime-emit";
import { Realtime } from "@upstash/realtime";
import { Redis } from "@upstash/redis";
import { z } from "zod";

// Conversation-channel emit helpers live in `@repo/utils` (since
// `@repo/temporal` static-imports them and cannot depend on `@repo/api`).
// The channel-name helpers are re-exported here; `emitConversationMessageAppended`
// is wrapped (below) to hand the shared emitter this module's client, so an
// API caller never takes the worker's relay path (Fizzy #2946).
//
// `emitContextChange` and `emitActivity` are implemented there too since the
// synced-file deletion workflow publishes its deletes itself (Fizzy #2636),
// and `emitDocumentChange` since Proposal generation nudges the page as its
// sections land (Fizzy #2801); the schema below uses their zod objects, so
// emitter and subscriber agree. The API keeps its own wrappers for those
// three (below), which hand the shared emitters this module's client, so an
// API caller never splits its events across two clients.
export type {
	ActivityPayload,
	ContextChangePayload,
	DocumentChangePayload,
} from "@repo/utils/realtime-emit";
export {
	getConversationChannelName,
	getProjectChannelName,
} from "@repo/utils/realtime-emit";

/**
 * Event schema for project collaboration
 *
 * All events are scoped to a project channel: `project:{projectId}`
 */
const projectRealtimeSchema = {
	/**
	 * Operation-result chat message appended to an AgentConversation. Uses the
	 * SHARED `conversationMessageAppendedSchema`
	 * symbol from `@repo/utils/realtime-emit` — the SSE-side `Realtime`
	 * instance (this richer schema) and the emit-side `Realtime`
	 * instance (utils-only schema) MUST agree on the payload shape, so
	 * they reference the same z.object value rather than two literal
	 * copies that could drift.
	 *
	 * Channel: `conversation:{conversationId}` — distinct from the
	 * project-scoped channel because operation-result messages may
	 * appear in conversations that aren't tied to a specific project
	 * (e.g. Sidekick).
	 */
	message_appended: conversationMessageAppendedSchema,

	/**
	 * Presence updates: who's viewing the project
	 */
	presence_update: z.object({
		projectId: z.string(),
		userId: z.string(),
		userName: z.string(),
		userImage: z.string().optional(),
		action: z.enum(["join", "leave", "heartbeat"]),
		activeTab: z.string().optional(),
		editingDocId: z.string().optional(),
	}),

	/**
	 * Document changes: created, updated, deleted. The SHARED schema from
	 * `@repo/utils/realtime-emit`, whose emitter a Temporal activity uses.
	 */
	document_change: documentChangeSchema,

	/**
	 * Context changes: added, updated, deleted. The SHARED schema from
	 * `@repo/utils/realtime-emit`, whose emitter a Temporal activity uses.
	 */
	context_change: contextChangeSchema,

	/**
	 * Document locking for edit conflict prevention
	 */
	lock_update: z.object({
		projectId: z.string(),
		documentId: z.string(),
		lockedBy: z.string().nullable(),
		lockedByName: z.string().optional(),
		lockedAt: z.string().optional(),
	}),

	/**
	 * Activity feed events. The SHARED schema from
	 * `@repo/utils/realtime-emit`, whose emitter a Temporal activity uses.
	 */
	activity: activitySchema,
};

/**
 * Inferred types for each event payload
 *
 * NOTE: `MessageAppendedPayload` is re-exported from `@repo/utils/realtime-emit`
 * at the top of this file (kept there because it must be reachable from
 * `@repo/temporal` without depending on `@repo/api`).
 */
export type PresenceUpdatePayload = z.infer<
	typeof projectRealtimeSchema.presence_update
>;
export type LockUpdatePayload = z.infer<
	typeof projectRealtimeSchema.lock_update
>;

/**
 * @upstash/realtime gracefully closes each SSE stream at
 * (maxDurationSecs - 2s), measured from inside its handler. The
 * library default (300) equals the Vercel function limit, so the
 * graceful close — whose clock excludes cold start and routing time
 * before handle() runs — races the platform hard kill and can lose,
 * surfacing as "Task timed out after 300 seconds" (issue #2254).
 * 270 closes streams at ~268s, ~30s of headroom. EventSource hooks
 * auto-reconnect and reset their retry budgets on every successful
 * open, so periodic ~4.5-min expiry cycles are free.
 */
export const REALTIME_STREAM_MAX_DURATION_SECS = 270;

/**
 * Realtime options type
 */
type RealtimeOptions = {
	schema: typeof projectRealtimeSchema;
	redis: Redis;
	maxDurationSecs: number;
};

// Lazy initialization for Redis and Realtime
let redisClient: Redis | null = null;
let realtimeInstance: Realtime<RealtimeOptions> | null = null;
let initializationAttempted = false;

/**
 * Get or create Redis client
 */
function getRedisClient(): Redis | null {
	if (redisClient) {
		return redisClient;
	}

	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!url || !token) {
		if (process.env.NODE_ENV === "development") {
			console.log(
				"[Realtime] Redis not configured, realtime features disabled",
			);
		}
		return null;
	}

	try {
		redisClient = new Redis({ url, token });
		return redisClient;
	} catch (error) {
		console.error("[Realtime] Failed to initialize Redis:", error);
		return null;
	}
}

/**
 * Get the Upstash Realtime instance
 *
 * Returns null if Redis is not configured
 */
export function getProjectRealtime(): Realtime<RealtimeOptions> | null {
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
		realtimeInstance = new Realtime<RealtimeOptions>({
			schema: projectRealtimeSchema,
			redis,
			maxDurationSecs: REALTIME_STREAM_MAX_DURATION_SECS,
		});

		if (process.env.NODE_ENV === "development") {
			console.log("[Realtime] Initialized Upstash Realtime");
		}

		return realtimeInstance;
	} catch (error) {
		console.error("[Realtime] Failed to initialize:", error);
		return null;
	}
}

// `getConversationChannelName` and `getProjectChannelName` are re-exported
// from `@repo/utils/realtime-emit` at the top of this file. See the comment
// block there for the rationale (Temporal worker cannot reach @repo/api).

/**
 * Emit a `message_appended` event, through this module's Realtime client.
 * Never throws. Passing the client keeps the API off the shared emitter's
 * default, which relays through the web without Upstash: a web process
 * must not POST its own events to itself, or to another app URL.
 */
export function emitConversationMessageAppended(
	payload: MessageAppendedPayload,
): Promise<void> {
	// Typed through the shared interface, for the zod-copy reason
	// `publishRelayedEvent` gives.
	const client: RelayedEventRealtime | null = getProjectRealtime();
	return sharedEmitConversationMessageAppended(payload, client);
}

/**
 * Emit a context change event, through this module's Realtime client (the
 * one `emitDocumentChange` and the others use). Never throws.
 */
export function emitContextChange(
	payload: ContextChangePayload,
): Promise<void> {
	return sharedEmitContextChange(payload, getProjectRealtime());
}

/**
 * Emit an activity feed event, through this module's Realtime client.
 * Never throws.
 */
export function emitActivity(payload: ActivityPayload): Promise<void> {
	return sharedEmitActivity(payload, getProjectRealtime());
}

/**
 * Publish one event a worker relayed to the web
 * (`apps/web/app/api/internal/realtime-emit`; the relay is described in
 * `@repo/utils/realtime-emit`) on this module's client, the one the SSE
 * routes subscribe through. Returns false when realtime is not configured
 * here. Unlike the emit helpers it lets a failed publish throw, so the route
 * can answer with an error, and it never relays the event on.
 */
export async function publishRelayedEvent(
	relayed: RealtimeRelayRequest,
): Promise<boolean> {
	const realtime = getProjectRealtime();
	if (!realtime) {
		return false;
	}

	// Typed through the shared interface, as the shared emitters take this
	// client: the shared schemas come from another zod copy than the one this
	// module's `Realtime` type resolves event names with. One case per
	// event, since `emit` takes one event name at a time.
	const client: RelayedEventRealtime = realtime;
	switch (relayed.event) {
		case "message_appended":
			await client
				.channel(getConversationChannelName(relayed.id))
				.emit("message_appended", relayed.data);
			break;
		case "context_change":
			await client
				.channel(getProjectChannelName(relayed.id))
				.emit("context_change", relayed.data);
			break;
		case "activity":
			await client
				.channel(getProjectChannelName(relayed.id))
				.emit("activity", relayed.data);
			break;
		case "document_change":
			await client
				.channel(getProjectChannelName(relayed.id))
				.emit("document_change", relayed.data);
			break;
	}
	return true;
}

/**
 * Emit a presence update event
 */
export async function emitPresenceUpdate(
	payload: PresenceUpdatePayload,
): Promise<void> {
	const realtime = getProjectRealtime();
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getProjectChannelName(payload.projectId),
		);
		await channel.emit("presence_update", payload);
	} catch (error) {
		console.error("[Realtime] Failed to emit presence_update:", error);
	}
}

/**
 * Emit a document change event, through this module's Realtime client.
 * Never throws.
 */
export function emitDocumentChange(
	payload: DocumentChangePayload,
): Promise<void> {
	return sharedEmitDocumentChange(payload, getProjectRealtime());
}

/**
 * Emit a lock update event
 */
export async function emitLockUpdate(
	payload: LockUpdatePayload,
): Promise<void> {
	const realtime = getProjectRealtime();
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getProjectChannelName(payload.projectId),
		);
		await channel.emit("lock_update", payload);
	} catch (error) {
		console.error("[Realtime] Failed to emit lock_update:", error);
	}
}

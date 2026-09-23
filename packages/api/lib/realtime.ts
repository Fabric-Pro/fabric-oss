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
	getProjectChannelName,
	emitActivity as sharedEmitActivity,
	emitContextChange as sharedEmitContextChange,
} from "@repo/utils/realtime-emit";
import { Realtime } from "@upstash/realtime";
import { Redis } from "@upstash/redis";
import { z } from "zod";

// Conversation-channel emit helpers live in `@repo/utils` (since
// `@repo/temporal` static-imports them and cannot depend on `@repo/api`).
// We re-export them here so existing callers that import from
// `@repo/api/lib/realtime` keep working without changes.
//
// `emitContextChange` and `emitActivity` are implemented there too since the
// synced-file deletion workflow publishes its deletes itself (Fizzy #2636);
// the schema below uses their zod objects, so emitter and subscriber agree.
// The API keeps its own wrappers for those two (below), which hand the shared
// emitters this module's client, so an API caller never splits its events
// across two clients.
export type {
	ActivityPayload,
	ContextChangePayload,
} from "@repo/utils/realtime-emit";
export {
	emitConversationMessageAppended,
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
	 * Document changes: created, updated, deleted
	 */
	document_change: z.object({
		projectId: z.string(),
		documentId: z.string(),
		action: z.enum(["created", "updated", "deleted"]),
		userId: z.string(),
		userName: z.string(),
		documentType: z.string().optional(),
		documentTitle: z.string().optional(),
	}),

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
export type DocumentChangePayload = z.infer<
	typeof projectRealtimeSchema.document_change
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

// `getConversationChannelName`, `getProjectChannelName` and
// `emitConversationMessageAppended` are re-exported from
// `@repo/utils/realtime-emit` at the top of this file. See the comment block
// there for the rationale (Temporal worker cannot reach @repo/api).

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
 * Emit a document change event
 */
export async function emitDocumentChange(
	payload: DocumentChangePayload,
): Promise<void> {
	const realtime = getProjectRealtime();
	if (!realtime) {
		return;
	}

	try {
		const channel = realtime.channel(
			getProjectChannelName(payload.projectId),
		);
		await channel.emit("document_change", payload);
	} catch (error) {
		console.error("[Realtime] Failed to emit document_change:", error);
	}
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

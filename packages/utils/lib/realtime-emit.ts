/**
 * Realtime emit helpers for the events a Temporal activity publishes: the
 * conversation channel's `message_appended`, and the project channel's
 * `context_change` and `activity`.
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
 * emit helper becomes a no-op. This keeps local dev + CI green without
 * Redis credentials.
 *
 * # Error handling
 *
 * No emit helper here ever throws. A Redis outage degrades to "next
 * polling refresh", not "the operation result is lost" — the persistence
 * write already landed before the helper was called.
 *
 * # Schema scope
 *
 * Only the events a Temporal activity emits live here: `message_appended`,
 * and `context_change` and `activity`, which the synced-file deletion
 * workflow publishes after it deleted a row (Fizzy #2636) — moved here from
 * `packages/api/lib/realtime.ts`, which re-exports the emitters and builds
 * its SSE schema from the same zod objects, so the two sides cannot drift.
 * The rest of `projectRealtimeSchema` (presence, document_change,
 * lock_update, etc.) stays in `packages/api/lib/realtime.ts`, whose
 * `emitContextChange`/`emitActivity` wrappers call the emitters here with the
 * API's own client, so an API caller publishes everything through one
 * instance. The two `Realtime` instances (API and Temporal worker) co-exist; they share the same underlying Redis
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

/** Channel name for a project's realtime stream. */
export function getProjectChannelName(projectId: string): string {
	return `project:${projectId}`;
}

const realtimeEmitSchema = {
	message_appended: conversationMessageAppendedSchema,
	context_change: contextChangeSchema,
	activity: activitySchema,
};

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
 * Emit a `message_appended` event onto the conversation's channel.
 * Called by the operation-result code paths (Temporal activity + oRPC
 * handler) AFTER the row is persisted.
 *
 * Never throws — a Redis outage degrades realtime delivery to the next
 * polling refresh, not "the operation result is lost".
 */
export async function emitConversationMessageAppended(
	payload: MessageAppendedPayload,
): Promise<void> {
	const realtime = getRealtimeClient();
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
	};
}

/**
 * Emit a `context_change` event onto the project's channel. Never throws.
 * `realtime` defaults to this module's client; `null` emits nothing.
 */
export async function emitContextChange(
	payload: ContextChangePayload,
	realtime: ProjectEventRealtime | null = getRealtimeClient(),
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
 * `realtime` defaults to this module's client; `null` emits nothing.
 */
export async function emitActivity(
	payload: ActivityPayload,
	realtime: ProjectEventRealtime | null = getRealtimeClient(),
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
}

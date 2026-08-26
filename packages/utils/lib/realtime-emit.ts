/**
 * Conversation-channel realtime emit helpers.
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
 * When either is missing, `getRealtimeClient()` returns `null` and
 * `emitConversationMessageAppended()` becomes a no-op. This keeps local
 * dev + CI green without Redis credentials.
 *
 * # Error handling
 *
 * `emitConversationMessageAppended` NEVER throws. A Redis outage degrades
 * to "next polling refresh", not "the operation result is lost" — the
 * persistence write already landed before this helper was called.
 *
 * # Schema scope
 *
 * Only `message_appended` lives here. The richer
 * `projectRealtimeSchema` (presence, document_change, lock_update, etc.)
 * stays in `packages/api/lib/realtime.ts` because it carries project-
 * domain knowledge that does not belong in `@repo/utils`. The two
 * `Realtime` instances co-exist; they share the same underlying Redis
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

const conversationRealtimeSchema = {
	message_appended: conversationMessageAppendedSchema,
};

type ConversationRealtimeOptions = {
	schema: typeof conversationRealtimeSchema;
	redis: Redis;
};

// Lazy-initialised + memoised across the process lifetime. Matches the
// pattern in `packages/api/lib/realtime.ts:getProjectRealtime`.
let redisClient: Redis | null = null;
let realtimeInstance: Realtime<ConversationRealtimeOptions> | null = null;
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
 * Returns a memoised `Realtime` client for the conversation channel
 * schema, or `null` if Upstash env vars are not configured. Safe to
 * call from any process (Temporal worker, Next.js server route, oRPC
 * handler) — it produces at most one Redis + one Realtime instance per
 * process.
 */
export function getRealtimeClient(): Realtime<ConversationRealtimeOptions> | null {
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
		realtimeInstance = new Realtime<ConversationRealtimeOptions>({
			schema: conversationRealtimeSchema,
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

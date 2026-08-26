/**
 * Shared schemas + helpers for the document-assistant procedures.
 *
 * Co-located here so the seven sibling procedure files all reach for the
 * same `DocumentRefSchema`, the same byte-truncation marker, and the same
 * inferred output types. Re-exports `MessageSchema` and `maybeStripReasoning`
 * from `../update-conversation.ts` — the existing CRUD already established
 * those as the canonical shape and a duplicate would let
 * the two surfaces drift.
 */

import { config as appConfig } from "@repo/config";
import { logger } from "@repo/logs";
import { getSignedUrl } from "@repo/storage";
import { z } from "zod";

export {
	MessageSchema,
	maybeStripReasoning,
} from "../update-conversation";

import type { MessageAttachment } from "../update-conversation";

/**
 * Persisted message body cap from spec §3.1 FR-4. Counted on the UTF-8
 * byte length of `content`, not the JS string length, because the cap is
 * about DB storage not character count.
 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Conversation-turn cap from spec §3.1 FR-3 / §4.4. The 201st append
 * spills into a continuation `AgentConversation` row.
 */
export const MAX_CONVERSATION_TURNS = 200;

/**
 * Soft cap on new conversations per `(user, documentRef)` per rolling 24-hour
 * window from spec §3.3 FR-11. Reads + 50 share a doc per day.
 */
export const NEW_CONVERSATIONS_PER_DAY_CAP = 50;

/**
 * Friendly user-facing copy emitted when the 50/day soft cap fires. Spec
 * §3.3 FR-11 quotes this string verbatim; the e2e covers it.
 */
export const NEW_CONVERSATIONS_PER_DAY_MESSAGE =
	"You've started 50 conversations on this document today — try again tomorrow or continue the most recent thread.";

/**
 * Feature-flag CONFLICT copy used by every write path when the org has
 * `documentAssistantHistoryEnabled = false`. Spec §3.11 FR-27, AC-15.
 */
export const HISTORY_DISABLED_MESSAGE =
	"Document assistant history is disabled for this organization";

/**
 * Visibility-locked CONFLICT copy used by `setVisibilityForDocument`. Spec
 * §3.5 FR-18.
 */
export const VISIBILITY_LOCKED_MESSAGE =
	"Visibility is locked after the first message";

export const DocumentRefKindSchema = z.enum(["PROJECT_DOCUMENT", "USER_STORY"]);

export const DocumentAssistantVisibilitySchema = z.enum(["SHARED", "PRIVATE"]);

/**
 * The standard tenant + document descriptor that every list / get / write
 * procedure accepts as its first input layer. `organizationId` follows the
 * project-wide convention: `string` for org context, explicit `null` for
 * personal context, `undefined` for "use session default".
 */
export const DocumentRefSchema = z.object({
	documentRefKind: DocumentRefKindSchema,
	documentRefId: z.string().min(1),
	projectId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

/**
 * The summary shape returned by `listForDocument`. Kept thin — list rows
 * never carry the full `messages` blob, just the preview/metrics the
 * History drawer needs to render a row. Spec §5.1.
 */
export const DocumentAssistantConversationSummarySchema = z.object({
	id: z.string(),
	conversationId: z.string(),
	title: z.string().nullable(),
	messageCount: z.number().int().nonnegative(),
	firstPromptPreview: z.string().nullable(),
	authorId: z.string(),
	authorName: z.string().nullable(),
	authorAvatarUrl: z.string().nullable(),
	visibility: DocumentAssistantVisibilitySchema,
	visibilityLockedAt: z.string().nullable(),
	archivedAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	parentConversationId: z.string().nullable(),
});

/**
 * Default expiry for attachment download URLs returned by the read
 * procedures. Five minutes mirrors `ai/documents/get-download-url.ts`
 * and is enough for the drawer's viewer pane to load every preview
 * synchronously while keeping leaked URLs effectively useless.
 *
 * If a user lingers on a single conversation longer than this window,
 * the next bucket invalidation / list refetch / drawer reopen mints a
 * fresh set — see `useDocumentAssistantHistoryRealtimeSync`.
 */
const ATTACHMENT_URL_TTL_SECONDS = 300;

/**
 * Walk a persisted messages array and replace each attachment's
 * `previewUrl` with a freshly-signed time-limited GET URL derived from
 * the stored `s3Path`. Signing failures degrade gracefully — the
 * `previewUrl` is just omitted so the viewer can fall back to a plain
 * filename chip rather than blow up the whole read.
 *
 * The signer + bucket mirror the chat-document download path because
 * the upload pipeline that produced these `s3Path`s targets the same
 * bucket (`config.storage.bucketNames.chatDocuments`).
 */
export async function resignMessageAttachments(
	messages: unknown[],
): Promise<unknown[]> {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}
	const bucket = appConfig.storage.bucketNames.chatDocuments;
	const out = await Promise.all(
		messages.map(async (raw) => {
			if (!raw || typeof raw !== "object") {
				return raw;
			}
			const msg = raw as Record<string, unknown>;
			const attachments = msg.attachments;
			if (!Array.isArray(attachments) || attachments.length === 0) {
				return raw;
			}
			const signed = await Promise.all(
				attachments.map(async (att) => {
					if (!att || typeof att !== "object") {
						return att;
					}
					const a = att as MessageAttachment &
						Record<string, unknown>;
					if (typeof a.s3Path !== "string" || a.s3Path.length === 0) {
						return att;
					}
					try {
						const url = await getSignedUrl(a.s3Path, {
							bucket,
							expiresIn: ATTACHMENT_URL_TTL_SECONDS,
						});
						return { ...a, previewUrl: url };
					} catch (err) {
						logger.warn(
							{ err, s3Path: a.s3Path, name: a.name },
							"[document-assistant] failed to sign attachment URL — falling back to filename-only chip",
						);
						return { ...a, previewUrl: undefined };
					}
				}),
			);
			return { ...msg, attachments: signed };
		}),
	);
	return out;
}

/**
 * Byte-aware truncation. We never mutate `toolCalls`; only the human-
 * readable `content` is clipped. Marker copy is exact per spec §3.1 FR-4
 * so the History drawer can match on it if it ever wants to render the
 * truncated state differently.
 */
export function truncateMessageBodyIfNeeded<
	T extends { content: string; toolCalls?: unknown },
>(message: T): T {
	const encoded = Buffer.byteLength(message.content, "utf8");
	if (encoded <= MAX_MESSAGE_BYTES) {
		return message;
	}
	// We slice on bytes by encoding to a buffer, cutting, then decoding back.
	// Slicing JS string indices would risk landing inside a multi-byte char.
	const buf = Buffer.from(message.content, "utf8");
	// Reserve enough room for the marker so the truncated body + marker fits
	// under MAX_MESSAGE_BYTES. Marker is ASCII so its byte-length equals its
	// JS length.
	const marker = `…[truncated by Fabric — ${encoded} bytes]`;
	const reserved = Buffer.byteLength(marker, "utf8");
	// If the marker alone exceeds the cap (cannot happen for the literal
	// above, but defensively), fall back to a shorter marker so we always
	// land at ≤ MAX_MESSAGE_BYTES.
	const target = Math.max(0, MAX_MESSAGE_BYTES - reserved);
	const sliced = buf.subarray(0, target).toString("utf8");
	return {
		...message,
		content: `${sliced}${marker}`,
	};
}

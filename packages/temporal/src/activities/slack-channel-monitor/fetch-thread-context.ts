/**
 * Slack Channel Monitor — fetch full thread context.
 *
 * Calls Slack's `conversations.replies` API directly and returns the parent
 * message plus replies. We bypass the shared `executeSlackTool("get_thread_replies")`
 * helper because it filters the parent out — we need it.
 *
 * For a top-level message that has no replies, Slack still returns the
 * parent (one entry) when `ts === thread_ts` is set to the message's own ts.
 */

import type {
	AttachmentWarning,
	PendingAttachmentRef,
	SlackThreadFile,
} from "@repo/integrations";
import { SUPPORTED_ATTACHMENT_MIMES } from "@repo/integrations";
import { getSlackCredentials } from "@repo/integrations/slack";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";

// =============================================================================
// Types
// =============================================================================

export interface FetchSlackThreadContextInput {
	userId: string;
	organizationId?: string;
	/** Slack workspace id ("T…"). Accepted for future per-workspace dispatch. */
	slackTeamId: string;
	channelId: string;
	threadRootTs: string;
}

export interface SlackThreadMessage {
	ts: string;
	sender: string;
	content: string;
	/** ISO-format derived from `ts` (Slack `ts` is unix seconds). */
	createdAt: string;
	threadTs?: string;
	/**
	 * Image files attached to this Slack message, already filtered to the v1
	 * MIME allowlist (`SUPPORTED_ATTACHMENT_MIMES`). Unsupported types are
	 * dropped here AND surfaced separately in the activity output's
	 * `attachmentWarnings` array so the proposal-inbox UI can render the
	 * `⚠ M` chip. See spec § 4.1 / FR-1 / FR-2.
	 */
	files?: SlackThreadFile[];
}

export interface FetchSlackThreadContextOutput {
	messages: SlackThreadMessage[];
	/** Slack returned `has_more: true` — we did not paginate further. */
	truncated: boolean;
	/**
	 * Flattened image-attachment refs from every message in the thread. The
	 * orchestrator `attachPendingMediaToStory` consumes this at apply time.
	 * Sidecar — NOT threaded into the LLM prompt (FR-4).
	 */
	pendingAttachments: PendingAttachmentRef[];
	/**
	 * Per-file skips emitted during the MIME filter at fetch time. The
	 * apply-time orchestrator appends more warnings later (size cap, download
	 * failures, etc.); this carries only the `unsupported_mime` cases.
	 */
	attachmentWarnings: AttachmentWarning[];
}

interface SlackRepliesFile {
	id: string;
	name?: string;
	title?: string;
	mimetype?: string;
	url_private?: string;
	size?: number;
}

interface SlackRepliesMessage {
	ts: string;
	thread_ts?: string;
	text?: string;
	user?: string;
	bot_id?: string;
	subtype?: string;
	files?: SlackRepliesFile[];
}

interface ConversationsRepliesResponse {
	ok: boolean;
	error?: string;
	messages?: SlackRepliesMessage[];
	has_more?: boolean;
}

// =============================================================================
// Direct Slack API call with rate-limit handling
// =============================================================================

async function callConversationsReplies(params: {
	accessToken: string;
	channelId: string;
	threadTs: string;
	limit: number;
}): Promise<ConversationsRepliesResponse> {
	const body = new URLSearchParams();
	body.set("channel", params.channelId);
	body.set("ts", params.threadTs);
	body.set("limit", String(params.limit));

	for (let attempt = 0; attempt < 5; attempt++) {
		const response = await fetch(
			"https://slack.com/api/conversations.replies",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${params.accessToken}`,
					"Content-Type":
						"application/x-www-form-urlencoded; charset=utf-8",
				},
				body: body.toString(),
			},
		);

		if (response.status === 429) {
			const retryAfterRaw = response.headers.get("retry-after");
			const retryAfterSec = retryAfterRaw
				? Number.parseInt(retryAfterRaw, 10) || 10
				: 10;
			logger.warn(
				"[SlackChannelMonitor] Rate-limited on conversations.replies",
				{
					channelId: params.channelId,
					threadTs: params.threadTs,
					retryAfterSec,
					attempt,
				},
			);
			Context.current().heartbeat(`rate-limit-wait:${retryAfterSec}s`);
			await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
			continue;
		}

		if (!response.ok) {
			throw new Error(
				`Slack conversations.replies failed: ${response.status}`,
			);
		}
		const data = (await response.json()) as ConversationsRepliesResponse;
		if (!data.ok) {
			throw new Error(
				`Slack conversations.replies error: ${data.error ?? "unknown"}`,
			);
		}
		return data;
	}
	throw new Error(
		"Slack conversations.replies retried 5 times without success",
	);
}

// =============================================================================
// Activity
// =============================================================================

export async function fetchSlackThreadContextActivity(
	input: FetchSlackThreadContextInput,
): Promise<FetchSlackThreadContextOutput> {
	const { userId, organizationId, channelId, threadRootTs } = input;

	logger.info("[SlackChannelMonitor] Fetching thread context", {
		channelId,
		threadRootTs,
	});

	const creds = await getSlackCredentials(userId, organizationId);

	const data = await callConversationsReplies({
		accessToken: creds.accessToken,
		channelId,
		threadTs: threadRootTs,
		limit: 200,
	});

	const raw = data.messages ?? [];

	// Allowlist as a Set for fast membership checks. SUPPORTED_ATTACHMENT_MIMES
	// is a const tuple — widen here so `.has(mimetype)` is callable with any
	// string Slack hands us.
	const allowedMimes = new Set<string>(SUPPORTED_ATTACHMENT_MIMES);
	const pendingAttachments: PendingAttachmentRef[] = [];
	const attachmentWarnings: AttachmentWarning[] = [];

	const messages: SlackThreadMessage[] = raw.map((m) => {
		const keptFiles: SlackThreadFile[] = [];
		for (const f of m.files ?? []) {
			if (
				!f.id ||
				!f.mimetype ||
				!f.url_private ||
				typeof f.size !== "number"
			) {
				// Required fields missing — Slack response shape is malformed
				// for this entry; skip without a warning (this is a wire-shape
				// issue, not a user-visible policy decision).
				continue;
			}
			if (!allowedMimes.has(f.mimetype)) {
				attachmentWarnings.push({
					source: "slack",
					refId: f.id,
					reason: "unsupported_mime",
					detail: f.mimetype,
				});
				continue;
			}
			const file: SlackThreadFile = {
				id: f.id,
				name: f.name ?? f.title ?? f.id,
				mimetype: f.mimetype,
				urlPrivate: f.url_private,
				size: f.size,
				...(f.title !== undefined ? { title: f.title } : {}),
			};
			keptFiles.push(file);
			pendingAttachments.push({
				source: "slack",
				file,
				messageTs: m.ts,
			});
		}

		return {
			ts: m.ts,
			sender: m.user ?? m.bot_id ?? "unknown",
			content: m.text ?? "",
			createdAt: new Date(Number.parseFloat(m.ts) * 1000).toISOString(),
			threadTs: m.thread_ts,
			...(keptFiles.length > 0 ? { files: keptFiles } : {}),
		};
	});

	// Defense in depth: if Slack returns nothing for a valid ts (rare —
	// usually means message was deleted between webhook and fetch), surface
	// a synthetic entry so downstream formatters always have at least one.
	if (messages.length === 0) {
		const parentIso = new Date(
			Number.parseFloat(threadRootTs) * 1000,
		).toISOString();
		return {
			messages: [
				{
					ts: threadRootTs,
					sender: "unknown",
					content:
						"(thread root not retrievable — see Slack permalink)",
					createdAt: parentIso,
					threadTs: threadRootTs,
				},
			],
			truncated: false,
			pendingAttachments,
			attachmentWarnings,
		};
	}

	return {
		messages,
		truncated: !!data.has_more,
		pendingAttachments,
		attachmentWarnings,
	};
}

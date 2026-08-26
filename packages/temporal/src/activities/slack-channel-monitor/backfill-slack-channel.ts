/**
 * Slack Channel Monitor — one-shot backfill activity.
 *
 * Pages through `conversations.history` from a starting `oldestTs`, claims
 * each root message via the seen-message INSERT-as-lock, and runs the
 * existing `analyzeSlackThreadActivity` per claimed root.
 *
 * Heartbeats the current cursor (the most-recent page's `oldest` value) every
 * page so on retry we can resume from `Context.current().info.heartbeatDetails`
 * instead of restarting from `oldestTs`.
 *
 * Rate-limit handling: `conversations.history` is tier-3 (50+ req/min). On a
 * 429 we read the `Retry-After` header (or default to 10s) and sleep before
 * retrying. The activity heartbeat keeps the worker alive across the sleep.
 *
 * On completion: set `backfillCompleteAt = now()` and `lastMessageTs` to the
 * lex-max ts observed. Slack `ts` is a zero-padded "seconds.microseconds"
 * string that sorts lexicographically by chronological order, so string
 * comparison suffices.
 */

import {
	markSlackChannelBackfillComplete,
	recordSlackChannelFailure,
} from "@repo/database";
import { getSlackCredentials } from "@repo/integrations/slack";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import { CancelledFailure } from "@temporalio/common";
import {
	JOB_SOURCE,
	JOB_STEPS,
	jobComplete,
	jobEnsure,
	jobFail,
	jobHeartbeat,
	jobStep,
	seedJobSteps,
} from "../lib/job-progress";
import { analyzeSlackThreadActivity } from "./analyze-slack-thread";

// =============================================================================
// Types
// =============================================================================

export interface BackfillSlackChannelInput {
	projectId: string;
	linkedChannelId: string;
	slackTeamId: string;
	channelId: string;
	channelDisplayName?: string;
	channelWebUrl?: string;
	userId: string;
	organizationId?: string;
	/** Slack `ts` to start from (exclusive). null/undefined = entire channel. */
	oldestTs?: string | null;
	/** Page size for conversations.history. Default 200 (Slack max). */
	limit?: number;
	/** Max total root messages to process this run. Default 5_000. */
	maxMessages?: number;
}

export interface BackfillSlackChannelOutput {
	rootsScanned: number;
	rootsClaimed: number;
	proposalsCreated: number;
	rootsSkippedAlreadySeen: number;
	rootsSkippedFiltered: number;
	maxTsObserved: string | null;
	completed: boolean;
}

interface SlackHistoryMessage {
	ts: string;
	type?: string;
	subtype?: string;
	text?: string;
	user?: string;
	bot_id?: string;
	thread_ts?: string;
	reply_count?: number;
}

interface HeartbeatState {
	/**
	 * Slack's opaque pagination cursor (`response_metadata.next_cursor`).
	 * When set, the next page is fetched with `cursor` and Slack ignores
	 * `oldest`. Resume after a retry uses this verbatim.
	 */
	cursor: string | null;
	/**
	 * Original `oldest` lower-bound (Slack `ts` string) — only used for the
	 * first page. Once a cursor exists, this is no longer sent.
	 */
	oldest: string | null;
	maxTs: string | null;
	rootsScanned: number;
	rootsClaimed: number;
	proposalsCreated: number;
	rootsSkippedAlreadySeen: number;
	rootsSkippedFiltered: number;
}

// =============================================================================
// Filtering helpers
// =============================================================================

function shouldSkipMessage(msg: SlackHistoryMessage): boolean {
	const subtype = msg.subtype ?? null;
	if (
		subtype === "message_changed" ||
		subtype === "message_deleted" ||
		subtype === "bot_message" ||
		subtype === "channel_join" ||
		subtype === "channel_leave"
	) {
		return true;
	}
	if (msg.bot_id) {
		return true;
	}
	if (!msg.text || msg.text.trim().length === 0) {
		return true;
	}
	// Only process root messages: top-level (no thread_ts) OR thread parents
	// (thread_ts === ts). Replies (thread_ts !== ts) are reached via the
	// thread fetch in the analyze activity.
	if (msg.thread_ts && msg.thread_ts !== msg.ts) {
		return true;
	}
	return false;
}

// =============================================================================
// Slack API call with rate-limit handling
// =============================================================================

interface ConversationsHistoryResponse {
	ok: boolean;
	error?: string;
	messages?: SlackHistoryMessage[];
	has_more?: boolean;
	response_metadata?: { next_cursor?: string };
}

async function callConversationsHistory(params: {
	accessToken: string;
	channelId: string;
	oldest?: string;
	cursor?: string;
	limit: number;
}): Promise<ConversationsHistoryResponse> {
	const body = new URLSearchParams();
	body.set("channel", params.channelId);
	body.set("limit", String(params.limit));
	if (params.oldest) {
		body.set("oldest", params.oldest);
	}
	if (params.cursor) {
		body.set("cursor", params.cursor);
	}

	for (let attempt = 0; attempt < 5; attempt++) {
		const response = await fetch(
			"https://slack.com/api/conversations.history",
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
				"[SlackChannelMonitor] Rate-limited on conversations.history",
				{ channelId: params.channelId, retryAfterSec, attempt },
			);
			// Heartbeat before the sleep so the worker doesn't time out.
			Context.current().heartbeat(`rate-limit-wait:${retryAfterSec}s`);
			await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
			continue;
		}

		if (!response.ok) {
			throw new Error(
				`Slack conversations.history failed: ${response.status}`,
			);
		}
		const data = (await response.json()) as ConversationsHistoryResponse;
		if (!data.ok) {
			throw new Error(
				`Slack conversations.history error: ${data.error ?? "unknown"}`,
			);
		}
		return data;
	}
	throw new Error(
		"Slack conversations.history retried 5 times without success",
	);
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Backfill one channel, reporting the outcome to the Job Hub.
 *
 * The failure hook lives in this wrapper rather than inside the run below,
 * because the run has several throw sites and Temporal retries it: without a
 * close on the failing path the row stays RUNNING until the watchdog stamps it
 * "Timed out — no progress reported", which invents a reason and hides the real
 * one. Rethrows so Temporal's own retry/failure handling is unchanged.
 */
/**
 * Marks a row as "failed, but this activity may retry". The retry reopens the
 * same row instead of opening another.
 */
const BACKFILL_RETRY_ERROR_CLASS = "ActivityFailed";

export async function backfillSlackChannelActivity(
	input: BackfillSlackChannelInput,
): Promise<BackfillSlackChannelOutput> {
	try {
		return await runSlackChannelBackfill(input);
	} catch (error) {
		// A cancellation is not an outcome: Temporal is shutting this attempt
		// down and may run it elsewhere, so closing the row would report a
		// failure for work that is still going.
		if (isCancellation(error)) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		// `ActivityFailed` is what lets the next retry reopen THIS row rather
		// than open another — without it a 3-attempt retry leaves three cards
		// for one run, or a stale "Failed" beside the attempt that recovered.
		await jobFail(message, {
			sourceId: input.linkedChannelId,
			errorClass: BACKFILL_RETRY_ERROR_CLASS,
		});
		// Mirror it onto the linked-channel row too. The panel alone is not
		// enough: a user who just pressed "Monitor now" looks at the channel
		// row, and without this it reads as perfectly healthy.
		//
		// try/catch rather than `.catch()`: this must not be able to replace
		// the error being rethrown, and a rejected promise is not the only way
		// that can happen.
		try {
			await recordSlackChannelFailure(input.linkedChannelId, message);
		} catch {
			// Best-effort — the real failure below is what matters.
		}
		throw error;
	}
}

/** Cancellation, in either shape Temporal surfaces it. */
function isCancellation(error: unknown): boolean {
	if (error instanceof CancelledFailure) {
		return true;
	}
	const name = (error as { name?: string } | null)?.name;
	return name === "CancelledFailure" || name === "AbortError";
}

async function runSlackChannelBackfill(
	input: BackfillSlackChannelInput,
): Promise<BackfillSlackChannelOutput> {
	const {
		projectId,
		linkedChannelId,
		slackTeamId,
		channelId,
		channelDisplayName,
		channelWebUrl,
		userId,
		organizationId,
		oldestTs,
		limit = 200,
		maxMessages = 5_000,
	} = input;

	logger.info("[SlackChannelMonitor] Backfill start", {
		projectId,
		linkedChannelId,
		channelId,
		oldestTs,
	});

	// Job Hub: "Monitor now" / first-enable backfill is a one-shot run, so its
	// row opens up front — unlike the live monitor, the user explicitly asked
	// for this and expects to see it even if the channel turns out to be empty.
	await jobEnsure({
		kind: "SLACK_BACKFILL",
		title: `Slack · #${channelDisplayName}`,
		projectId,
		userId,
		organizationId,
		sourceType: JOB_SOURCE.slackLinkedChannel,
		sourceId: linkedChannelId,
		steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
		reopenFailedWithClass: BACKFILL_RETRY_ERROR_CLASS,
	});
	await jobStep("fetch", "running", { sourceId: linkedChannelId });

	// Resume from heartbeatDetails if present (activity retry).
	const ctx = Context.current();
	const heartbeatDetails = ctx.info.heartbeatDetails as
		| HeartbeatState
		| undefined;
	const state: HeartbeatState = heartbeatDetails ?? {
		cursor: null,
		oldest: oldestTs ?? null,
		maxTs: null,
		rootsScanned: 0,
		rootsClaimed: 0,
		proposalsCreated: 0,
		rootsSkippedAlreadySeen: 0,
		rootsSkippedFiltered: 0,
	};

	const creds = await getSlackCredentials(userId, organizationId);

	// If we have a cursor we're mid-pagination — Slack treats `cursor` as
	// authoritative and ignores `oldest`. Otherwise apply `oldest` for the
	// first page only.
	let pageCursor: string | undefined = state.cursor ?? undefined;
	let pageOldest: string | undefined = pageCursor
		? undefined
		: (state.oldest ?? undefined);
	let hasMore = true;
	let pageNumber = 0;

	while (hasMore && state.rootsScanned < maxMessages) {
		pageNumber++;
		ctx.heartbeat(state);
		// Keep the job row alive too: a large channel can page for longer than
		// the watchdog's staleness window while skipping already-seen roots,
		// which produces no other job write.
		await jobHeartbeat(linkedChannelId);

		const data = await callConversationsHistory({
			accessToken: creds.accessToken,
			channelId,
			oldest: pageOldest,
			cursor: pageCursor,
			limit,
		});

		const messages = data.messages ?? [];
		logger.info("[SlackChannelMonitor] Backfill page fetched", {
			channelId,
			pageNumber,
			pageSize: messages.length,
			hasMore: data.has_more ?? false,
		});

		for (const msg of messages) {
			state.rootsScanned++;
			if (shouldSkipMessage(msg)) {
				state.rootsSkippedFiltered++;
				continue;
			}
			const threadRootTs = msg.thread_ts ?? msg.ts;

			// Track the lexicographic max ts observed.
			if (!state.maxTs || msg.ts > state.maxTs) {
				state.maxTs = msg.ts;
			}

			try {
				const result = await analyzeSlackThreadActivity({
					projectId,
					userId,
					organizationId,
					channelId,
					threadRootTs,
					linkedChannelId,
					slackTeamId,
					channelDisplayName,
					channelWebUrl,
				});
				if (result.skippedReason === "already_seen") {
					state.rootsSkippedAlreadySeen++;
				} else if (result.pendingProposalId) {
					state.rootsClaimed++;
					state.proposalsCreated++;
				} else {
					// Claimed but no proposal — still counts as claimed (LLM said no content).
					state.rootsClaimed++;
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : String(err);
				logger.error(
					"[SlackChannelMonitor] Backfill thread analyze failed",
					{
						channelId,
						threadRootTs,
						error: errorMessage,
					},
				);
				// Swallow per-thread failures — backfill should keep going.
				// The seen-message lock prevents retry storms on the same thread.
			}

			if (state.rootsScanned >= maxMessages) {
				break;
			}
		}

		// Save cursor for resume-on-retry. Distinct from `oldest`: cursor
		// is Slack's opaque pagination token, oldest was the lower-bound
		// for the FIRST page only.
		pageCursor = data.response_metadata?.next_cursor ?? undefined;
		state.cursor = pageCursor ?? null;
		hasMore = !!data.has_more && !!pageCursor;
		ctx.heartbeat(state);

		// Once we've moved past the first page, `oldest` is no longer
		// relevant — pagination is driven by `cursor`.
		pageOldest = undefined;
	}

	// Persist the final cursor on the linked channel row. When the backfill
	// saw no new messages we fall back to the input `oldestTs` so a seeded
	// cursor (e.g. a "from-now" link) isn't clobbered with NULL.
	const persistedCursor = state.maxTs ?? oldestTs ?? null;
	await markSlackChannelBackfillComplete(linkedChannelId, persistedCursor);

	logger.info("[SlackChannelMonitor] Backfill complete", {
		projectId,
		linkedChannelId,
		channelId,
		rootsScanned: state.rootsScanned,
		rootsClaimed: state.rootsClaimed,
		proposalsCreated: state.proposalsCreated,
		maxTs: state.maxTs,
	});

	// Job Hub: report the run's totals, not the per-thread increments the nested
	// analyze calls wrote — the backfill's own counters are the accurate ones
	// (they include roots skipped before analysis was ever attempted).
	await jobStep("fetch", "completed", { sourceId: linkedChannelId });
	await jobStep("analyze", "completed", { sourceId: linkedChannelId });
	await jobStep("propose", "completed", { sourceId: linkedChannelId });
	await jobComplete({
		sourceId: linkedChannelId,
		counts: {
			messagesScanned: state.rootsScanned,
			// The nested analyze calls adopt this same row and write
			// `groupsFlushed`, which renders with the same label — overwrite it
			// with the backfill's own total rather than adding a second,
			// duplicate "N threads analyzed" line to the card.
			groupsFlushed: state.rootsClaimed,
			proposalsCreated: state.proposalsCreated,
			skippedAlreadySeen: state.rootsSkippedAlreadySeen,
		},
	});

	return {
		rootsScanned: state.rootsScanned,
		rootsClaimed: state.rootsClaimed,
		proposalsCreated: state.proposalsCreated,
		rootsSkippedAlreadySeen: state.rootsSkippedAlreadySeen,
		rootsSkippedFiltered: state.rootsSkippedFiltered,
		maxTsObserved: state.maxTs,
		completed: state.rootsScanned < maxMessages,
	};
}

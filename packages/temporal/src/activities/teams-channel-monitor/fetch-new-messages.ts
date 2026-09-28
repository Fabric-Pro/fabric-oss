/**
 * Teams Channel Monitor — thread-aware fetch activity.
 *
 * Pulls top-level channel messages expanded with their replies, filters to
 * "mature" threads (idle for at least `quietWindowMinutes`), keeps threads that
 * were never analyzed plus already-analyzed threads that received a reply
 * after their last analysis, and returns a normalised `FetchedThread[]` along
 * with the new cursor for the channel.
 */

import { getSeenThreadWatermarks } from "@repo/database";
import type {
	AttachmentWarning,
	PendingAttachmentRef,
} from "@repo/integrations";
import type { MicrosoftGraphFromKind } from "@repo/integrations/microsoft";
import {
	executeMicrosoftTeamsTool,
	truncateContent,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { isReplyNewerThanWatermark } from "./reply-watermark";

// =============================================================================
// Types
// =============================================================================

export interface FetchNewChannelThreadsInput {
	projectId: string;
	linkedChannelId: string;
	teamId: string;
	channelId: string;
	userId: string;
	organizationId?: string;
	/** Cursor — only consider threads whose lastModifiedDateTime > sinceIso. */
	sinceIso: string | null;
	/**
	 * Persisted Graph @odata.nextLink to resume backward-scan from a prior
	 * tick. When set, the first page fetched is from this token instead of
	 * the channel's top — this is how busy channels with large backlogs
	 * avoid starving: progress persists across ticks.
	 */
	scanPageToken?: string | null;
	/** Only analyze threads idle for at least this many minutes. Default 60. */
	quietWindowMinutes?: number;
	/** Per-tick cap on threads to fetch across all pages. Default 200. */
	maxThreads?: number;
}

export interface FetchedThreadReply {
	messageId: string;
	author: string;
	createdAt: string;
	content: string;
	webLink?: string;
	/**
	 * Image-attachment refs extracted from this reply's HTML body. Each ref
	 * carries the parent `messageId` so the apply-time orchestrator can
	 * reconstruct the Graph download URL. Populated by the upstream
	 * `list_channel_threads` tool via `extractHostedContentRefsFromHtml`.
	 * Empty when the reply has no inline `<img>` tags (FR-8).
	 */
	pendingAttachments?: PendingAttachmentRef[];
	/**
	 * Author kind for this reply, surfaced by `list_channel_threads`
	 * (app-authored-thread skip). Optional so a Temporal activity input
	 * recorded before this field existed — an in-flight execution's history,
	 * or a fetch activity that hasn't rolled out yet — still deserializes;
	 * absent means "unknown" and the analyze activity treats "unknown" as
	 * "assume human" (fail open), never as a reason to skip.
	 */
	fromKind?: MicrosoftGraphFromKind;
}

export interface FetchedThread {
	rootMessageId: string;
	rootCreatedAt: string;
	rootAuthor: string;
	/** HTML-stripped, truncated to ~2000 chars. */
	rootContent: string;
	rootWebLink?: string;
	replies: FetchedThreadReply[];
	/** ISO string — max(createdDateTime across root + replies). Used for cursor. */
	threadLastActivity: string;
	/**
	 * Thread-level flattening of `pendingAttachments` across root + every
	 * reply. The Teams analyzer activity reads from here when populating
	 * `PendingBacklogProposal.sourceMetadata.attachments`. Sidecar — NOT
	 * threaded into the LLM prompt (FR-9 / spec § 4.4).
	 */
	pendingAttachments?: PendingAttachmentRef[];
	/**
	 * Author kind for the root message. See `FetchedThreadReply.fromKind` —
	 * same optionality and fail-open contract.
	 */
	rootFromKind?: MicrosoftGraphFromKind;
	/**
	 * False when Graph's `$expand=replies` truncated this thread's own reply
	 * list (a replies OData nextLink annotation came back instead of every reply) —
	 * `replies` above then holds only the replies Graph included on this
	 * page, not the whole thread. Optional for the same reason as
	 * `rootFromKind`: an older fetch result (in-flight execution history, or
	 * a fetch activity that hasn't rolled out yet) won't carry it. The
	 * app-authored-thread skip requires this to be strictly `true` before it
	 * will draw any conclusion from `replies` — missing or `false` fails
	 * open.
	 */
	repliesComplete?: boolean;
	/**
	 * Set when this thread was analyzed before and is back because at least one
	 * reply was created after that analysis: the ISO watermark of the previous
	 * analysis (the thread's `threadLastActivity` then, or the seen row's
	 * insert time for rows written before the watermark existed). Replies created strictly after it are new; the root
	 * and older replies were already reviewed and are context only. The
	 * analyze activity passes it back as the compare-and-swap
	 * `expectedPrevious` when it records its own watermark.
	 *
	 * Optional so an activity input recorded before this field existed — an
	 * in-flight execution's history — still deserializes. Absent means a first
	 * analysis.
	 */
	previouslyAnalyzedThrough?: string;
}

export interface FetchNewChannelThreadsOutput {
	success: boolean;
	threads: FetchedThread[];
	newCursor: {
		lastMessageCreatedAt: string | null;
		lastMessageId: string | null;
	};
	rawThreadCount: number;
	/**
	 * True when Graph had no more pages AND we didn't hit the maxThreads cap.
	 * When false the caller MUST NOT advance the channel cursor — older
	 * unfetched threads would be permanently skipped.
	 */
	fetchedAllPages: boolean;
	/**
	 * Updated resume-token for backward-scan. Set to a string when the
	 * per-tick scan budget ran out with zero unseen threads; the workflow
	 * should persist it so the next tick continues from that point. Set to
	 * `null` when the scan completed (found unseen OR Graph exhausted) —
	 * the workflow should clear any stored token.
	 */
	updatedScanPageToken: string | null;
	/**
	 * Sidecar warnings collected at fetch time. Currently empty (the Teams
	 * fetch path has no fetch-time skip reason — the parser is silent on
	 * malformed HTML and dedups silently per decisions § 12). Reserved for
	 * future fetch-time skip reasons and mirrors the Slack activity's
	 * output shape so downstream readers treat both providers uniformly.
	 */
	attachmentWarnings: AttachmentWarning[];
	error?: string;
}

// =============================================================================
// Internal helpers
// =============================================================================

interface RawThread {
	id: string;
	createdDateTime?: string;
	lastModifiedDateTime?: string;
	webUrl?: string;
	from: string;
	/**
	 * Author kind surfaced by the Microsoft `list_channel_threads` tool.
	 * Optional — older tool responses (pre-feature) omit it, and the mapping
	 * below carries that absence through as "unknown" rather than defaulting
	 * it to a human author.
	 */
	fromKind?: MicrosoftGraphFromKind;
	bodyContent: string;
	replies: Array<{
		id: string;
		createdDateTime?: string;
		lastModifiedDateTime?: string;
		webUrl?: string;
		from: string;
		fromKind?: MicrosoftGraphFromKind;
		bodyContent: string;
		/**
		 * Image-attachment refs extracted from the reply HTML by
		 * `extractHostedContentRefsFromHtml`, supplied by the Microsoft
		 * `list_channel_threads` tool. Optional — older tool responses
		 * (pre-feature) and replies with no inline images omit it.
		 */
		pendingAttachments?: PendingAttachmentRef[];
	}>;
	/**
	 * Thread-level flattening surfaced directly by the Microsoft tool. The
	 * activity defers to this rather than re-parsing — the tool layer is
	 * the canonical source of truth (FR-6 / FR-8).
	 */
	pendingAttachments?: PendingAttachmentRef[];
	/**
	 * Surfaced by the Microsoft `list_channel_threads` tool: false when
	 * Graph's `$expand=replies` truncated this thread's own reply list.
	 * Optional — older tool responses (pre-feature) omit it, and the mapping
	 * below carries that absence through as "unknown/incomplete" rather than
	 * assuming the reply list is whole.
	 */
	repliesComplete?: boolean;
}

/**
 * The `createdAt` a reply will carry on its `FetchedThreadReply` (see the
 * projection in step 5): Graph's `createdDateTime`, or the thread's
 * `threadLastActivity` in the malformed case where it is missing. The revisit
 * check below runs on this same value so the fetch and analyze activities
 * judge "new" identically — and since `threadLastActivity` is computed from
 * valid timestamps only, a reply with no timestamp is never new on its own.
 */
function projectedReplyCreatedAt(
	reply: RawThread["replies"][number],
	threadLastActivity: string,
): string {
	return reply.createdDateTime ?? threadLastActivity;
}

/**
 * True when at least one reply is new against `watermarkMs` under the shared
 * rule in `isReplyNewerThanWatermark` (strictly later; unparseable is not new).
 */
function hasReplyAfter(
	thread: RawThread,
	threadLastActivity: string,
	watermarkMs: number,
): boolean {
	return (thread.replies ?? []).some((reply) =>
		isReplyNewerThanWatermark(
			projectedReplyCreatedAt(reply, threadLastActivity),
			watermarkMs,
		),
	);
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Pull mature threads (root + replies) newer than the channel cursor.
 *
 * Algorithm:
 * 1. Graph: `GET /teams/{teamId}/channels/{channelId}/messages?$expand=replies`
 *    via the `list_channel_threads` tool. No server-side filter is applied —
 *    the cursor comparison in step 4 happens here, client-side.
 * 2. `threadLastActivity = max(root.createdDateTime, ...replies.createdDateTime)`.
 * 3. Keep only threads where `(now - threadLastActivity) >= quietWindowMinutes`.
 * 4. Look up the seen-row watermark of every mature root on the page
 *    (`analyzedThroughAt`, or `createdAt` for a legacy NULL row — see
 *    `getSeenThreadWatermarks`). An unseen root is kept (first analysis)
 *    only if its `threadLastActivity > sinceIso` (cursor). A seen root skips
 *    the cursor — a lagging pre-filter set from fetched snapshots, including
 *    ones whose analysis lost the watermark compare-and-swap — and is kept as
 *    a revisit (carrying `previouslyAnalyzedThrough`) iff at least one reply
 *    is strictly newer than its watermark; otherwise it is dropped.
 * 5. Map to `FetchedThread` (HTML-stripped content, preserved webLinks).
 * 6. Cursor = max(threadLastActivity across kept threads), fall back to sinceIso.
 */
export async function fetchNewChannelThreadsActivity(
	input: FetchNewChannelThreadsInput,
): Promise<FetchNewChannelThreadsOutput> {
	const {
		linkedChannelId,
		teamId,
		channelId,
		userId,
		organizationId,
		sinceIso,
		scanPageToken: inputScanToken,
		quietWindowMinutes = 60,
		maxThreads = 200,
	} = input;

	logger.info("[TeamsChannelMonitor] Fetching new channel threads", {
		linkedChannelId,
		teamId,
		channelId,
		sinceIso,
		hasScanToken: !!inputScanToken,
		quietWindowMinutes,
		maxThreads,
	});

	try {
		const now = Date.now();
		const quietWindowMs = quietWindowMinutes * 60 * 1000;
		const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;

		// Outer pagination loop. We keep calling list_channel_threads with the
		// returned nextPageToken until EITHER:
		//   - we have enough unseen mature threads for the activity cap
		//   - Graph has no more pages (fetchedAllPages=true)
		//   - we hit the activity-level safety ceiling (prevents runaway scans)
		// This is what fixes starvation on busy channels: the activity scans
		// PAST already-seen threads instead of stopping at the first all-seen
		// page.
		const ACTIVITY_PAGE_LIMIT = 10; // up to 10 tool calls per tick (≤ 10k threads)
		// Threads to analyze this tick: never-analyzed threads AND revisits
		// (already-analyzed threads with a reply newer than their watermark).
		// Both count toward `maxThreads` and the scan-token decision alike.
		const unseenCollected: Array<{
			thread: RawThread;
			threadLastActivity: string;
			previouslyAnalyzedThrough?: string;
		}> = [];
		let rawThreadCount = 0;
		let outerCallCount = 0;
		// Resume from a persisted scan token when provided so we keep making
		// forward progress through the backlog instead of rescanning the top.
		let pageToken: string | undefined = inputScanToken ?? undefined;
		let fetchedAllPages = false;

		while (outerCallCount < ACTIVITY_PAGE_LIMIT) {
			heartbeat(`list_channel_threads: page-pass ${outerCallCount + 1}`);
			const graphResult = (await executeMicrosoftTeamsTool(
				"list_channel_threads",
				{
					teamId,
					channelId,
					top: maxThreads,
					...(pageToken ? { nextPageToken: pageToken } : {}),
				},
				userId,
				organizationId,
			)) as {
				threads?: RawThread[];
				count?: number;
				fetchedAllPages?: boolean;
				nextPageToken?: string;
				error?: string;
			};

			if (graphResult.error) {
				// On a Graph error when resuming from a persisted scan token,
				// clear it so the next tick starts from the top instead of
				// looping on the same failed token indefinitely.
				return {
					success: false,
					threads: [],
					newCursor: {
						lastMessageCreatedAt: sinceIso ?? null,
						lastMessageId: null,
					},
					rawThreadCount,
					fetchedAllPages: false,
					updatedScanPageToken: null,
					attachmentWarnings: [],
					error: graphResult.error,
				};
			}

			outerCallCount++;
			const raw = graphResult.threads ?? [];
			rawThreadCount += raw.length;
			pageToken = graphResult.nextPageToken;

			// Step 2 + 3: compute threadLastActivity and apply the quiet window.
			// The cursor check is only RECORDED here (`pastCursor`); step 4
			// applies it to unseen roots only.
			const matureRaw: Array<{
				thread: RawThread;
				threadLastActivity: string;
				pastCursor: boolean;
			}> = [];
			for (const thread of raw) {
				const allTimestamps: number[] = [];
				if (thread.createdDateTime) {
					const t = new Date(thread.createdDateTime).getTime();
					if (!Number.isNaN(t)) {
						allTimestamps.push(t);
					}
				}
				for (const reply of thread.replies ?? []) {
					if (reply.createdDateTime) {
						const t = new Date(reply.createdDateTime).getTime();
						if (!Number.isNaN(t)) {
							allTimestamps.push(t);
						}
					}
				}
				if (allTimestamps.length === 0) {
					continue;
				}
				const lastActivityMs = Math.max(...allTimestamps);
				if (now - lastActivityMs < quietWindowMs) {
					continue;
				}
				matureRaw.push({
					thread,
					threadLastActivity: new Date(lastActivityMs).toISOString(),
					pastCursor: !(sinceMs > 0 && lastActivityMs <= sinceMs),
				});
			}

			// Step 4: decide per thread, one watermark query per page.
			//
			// An UNSEEN root must pass the channel cursor, exactly as before
			// this change.
			//
			// A SEEN root bypasses the cursor and is judged by its own
			// watermark alone. The cursor is a lagging pre-filter set from
			// fetched snapshots — including the snapshot of an analysis that
			// lost the watermark compare-and-swap to an overlapping run. That
			// loser's threadLastActivity can still become the cursor, so a
			// reply the winner never saw would sit at or behind the cursor
			// and never be looked at again. Only the per-thread watermark
			// records what was actually analyzed. Conversely, dropping every
			// seen root outright (the behaviour before revisits) lost any
			// reply posted after a thread's first analysis — it was neither
			// analyzed nor captured.
			if (matureRaw.length > 0) {
				const candidateRootIds = matureRaw.map((m) => m.thread.id);
				const watermarks = await getSeenThreadWatermarks(
					linkedChannelId,
					candidateRootIds,
				);
				for (const { pastCursor, ...m } of matureRaw) {
					const watermark = watermarks.get(m.thread.id);
					if (watermark === undefined) {
						if (!pastCursor) {
							continue;
						}
						unseenCollected.push(m);
					} else if (
						hasReplyAfter(
							m.thread,
							m.threadLastActivity,
							watermark.getTime(),
						)
					) {
						unseenCollected.push({
							...m,
							previouslyAnalyzedThrough: watermark.toISOString(),
						});
					} else {
						continue;
					}
					if (unseenCollected.length >= maxThreads) {
						break;
					}
				}
			}

			// Stop if we have enough OR Graph has no more pages.
			if (unseenCollected.length >= maxThreads) {
				break;
			}
			if (!pageToken) {
				fetchedAllPages = true;
				break;
			}
		}

		// Truncate to maxThreads in case the last page push overshot.
		const unseenRaw = unseenCollected.slice(0, maxThreads);

		// Decide what to persist as scanPageToken for next tick (a revisit
		// counts exactly as an unseen thread here):
		//   - found any unseen/revisit → clear token (next tick scans from top)
		//   - exhausted all pages → clear token (start fresh next tick)
		//   - hit scan ceiling with 0 unseen AND pageToken exists → persist it
		//     so next tick resumes from that point
		const updatedScanPageToken =
			unseenRaw.length > 0 || fetchedAllPages
				? null
				: (pageToken ?? null);

		if (unseenRaw.length === 0) {
			return {
				success: true,
				threads: [],
				newCursor: {
					lastMessageCreatedAt: sinceIso ?? null,
					lastMessageId: null,
				},
				rawThreadCount,
				fetchedAllPages,
				updatedScanPageToken,
				attachmentWarnings: [],
			};
		}

		// Step 5: project to FetchedThread shape. Preserve attachment refs
		// surfaced by the Microsoft tool so the apply-time orchestrator can
		// rehost images into R2 at proposal approval (chat-thread image-
		// attachments feature, FR-8). Empty-/undefined-input arrays produce
		// empty output arrays — existing callers that don't use the field
		// are unaffected.
		const threads: FetchedThread[] = unseenRaw.map(
			({ thread, threadLastActivity, previouslyAnalyzedThrough }) => ({
				rootMessageId: thread.id,
				rootCreatedAt: thread.createdDateTime ?? threadLastActivity,
				rootAuthor: thread.from,
				rootFromKind: thread.fromKind,
				repliesComplete: thread.repliesComplete,
				rootContent: truncateContent(thread.bodyContent, 2000),
				rootWebLink: thread.webUrl,
				replies: (thread.replies ?? []).map((r) => ({
					messageId: r.id,
					author: r.from,
					fromKind: r.fromKind,
					createdAt: projectedReplyCreatedAt(r, threadLastActivity),
					content: truncateContent(r.bodyContent, 2000),
					webLink: r.webUrl,
					pendingAttachments: r.pendingAttachments ?? [],
				})),
				threadLastActivity,
				pendingAttachments: thread.pendingAttachments ?? [],
				// Only set on a revisit, so a first analysis serializes exactly
				// as it did before this field existed.
				...(previouslyAnalyzedThrough
					? { previouslyAnalyzedThrough }
					: {}),
			}),
		);

		// Step 6: cursor = max threadLastActivity among the kept threads.
		const cursorMs = Math.max(
			...threads.map((t) => new Date(t.threadLastActivity).getTime()),
		);
		const latestThread = threads.reduce((acc, t) =>
			new Date(t.threadLastActivity).getTime() >
			new Date(acc.threadLastActivity).getTime()
				? t
				: acc,
		);
		const newCursor = {
			lastMessageCreatedAt: new Date(cursorMs).toISOString(),
			lastMessageId: latestThread.rootMessageId,
		};

		return {
			success: true,
			threads,
			newCursor,
			rawThreadCount,
			fetchedAllPages,
			updatedScanPageToken,
			attachmentWarnings: [],
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[TeamsChannelMonitor] Failed to fetch channel threads", {
			error: errorMessage,
			linkedChannelId,
			teamId,
			channelId,
		});
		return {
			success: false,
			threads: [],
			newCursor: {
				lastMessageCreatedAt: sinceIso ?? null,
				lastMessageId: null,
			},
			rawThreadCount: 0,
			fetchedAllPages: false,
			// Clear the scan token on unexpected errors so the next tick
			// restarts cleanly from the top rather than re-attempting the
			// same failing resume point.
			updatedScanPageToken: null,
			attachmentWarnings: [],
			error: errorMessage,
		};
	}
}

/**
 * Teams Channel Monitor — thread-aware fetch activity.
 *
 * Pulls top-level channel messages expanded with their replies, filters to
 * "mature" threads (idle for at least `quietWindowMinutes`), drops threads
 * whose root message has already been seen, and returns a normalised
 * `FetchedThread[]` along with the new cursor for the channel.
 */

import { getSeenMessageIds } from "@repo/database";
import type {
	AttachmentWarning,
	PendingAttachmentRef,
} from "@repo/integrations";
import {
	executeMicrosoftTeamsTool,
	truncateContent,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

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
	bodyContent: string;
	replies: Array<{
		id: string;
		createdDateTime?: string;
		lastModifiedDateTime?: string;
		webUrl?: string;
		from: string;
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
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Pull mature threads (root + replies) newer than the channel cursor.
 *
 * Algorithm:
 * 1. Graph: `GET /teams/{teamId}/channels/{channelId}/messages?$expand=replies`
 *    with `$filter=lastModifiedDateTime gt {sinceIso}` when cursor exists.
 * 2. `threadLastActivity = max(root.createdDateTime, ...replies.createdDateTime)`.
 * 3. Keep only threads where `(now - threadLastActivity) >= quietWindowMinutes`.
 * 4. Drop threads whose rootId is already in the seen-message table.
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
		const unseenCollected: Array<{
			thread: RawThread;
			threadLastActivity: string;
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

			// Step 2 + 3: compute threadLastActivity, apply cursor + quiet-window.
			const matureRaw: Array<{
				thread: RawThread;
				threadLastActivity: string;
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
				if (sinceMs > 0 && lastActivityMs <= sinceMs) {
					continue;
				}
				if (now - lastActivityMs < quietWindowMs) {
					continue;
				}
				matureRaw.push({
					thread,
					threadLastActivity: new Date(lastActivityMs).toISOString(),
				});
			}

			// Step 4: belt-and-suspenders dedup via the seen-message table.
			if (matureRaw.length > 0) {
				const candidateRootIds = matureRaw.map((m) => m.thread.id);
				const seenSet = await getSeenMessageIds(
					linkedChannelId,
					candidateRootIds,
				);
				for (const m of matureRaw) {
					if (!seenSet.has(m.thread.id)) {
						unseenCollected.push(m);
						if (unseenCollected.length >= maxThreads) {
							break;
						}
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

		// Decide what to persist as scanPageToken for next tick:
		//   - found any unseen → clear token (next tick scans from top as normal)
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
			({ thread, threadLastActivity }) => ({
				rootMessageId: thread.id,
				rootCreatedAt: thread.createdDateTime ?? threadLastActivity,
				rootAuthor: thread.from,
				rootContent: truncateContent(thread.bodyContent, 2000),
				rootWebLink: thread.webUrl,
				replies: (thread.replies ?? []).map((r) => ({
					messageId: r.id,
					author: r.from,
					createdAt: r.createdDateTime ?? threadLastActivity,
					content: truncateContent(r.bodyContent, 2000),
					webLink: r.webUrl,
					pendingAttachments: r.pendingAttachments ?? [],
				})),
				threadLastActivity,
				pendingAttachments: thread.pendingAttachments ?? [],
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

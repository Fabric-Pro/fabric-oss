/**
 * Teams Chat Monitor — message-aware fetch activity.
 *
 * Pulls flat chat messages, filters to ones idle for at least
 * `quietWindowMinutes`, drops messages already seen, and bundles consecutive
 * unseen messages into a single synthetic "thread" for LLM analysis. The
 * thread shape mirrors the channel monitor's `FetchedThread` so downstream
 * analysis can reuse the same formatter / LLM helpers.
 *
 * Chats have no native reply hierarchy in Microsoft Graph — each message is
 * a peer. The bundle root = oldest unseen message; replies = remaining
 * unseen messages chronologically.
 */

import { getSeenChatMessageIds } from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	truncateContent,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

// =============================================================================
// Types
// =============================================================================

export interface FetchNewChatThreadsInput {
	projectId: string;
	linkedChatId: string;
	chatId: string;
	userId: string;
	organizationId?: string;
	/** Cursor — only consider messages whose createdDateTime > sinceIso. */
	sinceIso: string | null;
	/** Persisted Graph @odata.nextLink to resume backward-scan from a prior tick. */
	scanPageToken?: string | null;
	/** Only emit a bundle when its newest message is at least this many minutes old. Default 60. */
	quietWindowMinutes?: number;
	/** Per-tick cap on messages to fetch across all pages. Default 200. */
	maxMessages?: number;
}

export interface FetchedChatMessage {
	messageId: string;
	author: string;
	createdAt: string;
	/** HTML-stripped, truncated to ~2000 chars. */
	content: string;
	webLink?: string;
}

/**
 * Channel-monitor-compatible thread shape so the analysis activity can
 * format both sources with the same helper. For chats: the "root" is the
 * oldest unseen message in the bundle, replies are the remaining unseen
 * messages chronologically.
 */
export interface FetchedChatThread {
	rootMessageId: string;
	rootCreatedAt: string;
	rootAuthor: string;
	rootContent: string;
	rootWebLink?: string;
	replies: FetchedChatMessage[];
	/** ISO string — max(createdDateTime across root + replies). Used for cursor. */
	threadLastActivity: string;
	/** All message IDs in this bundle — used by the analyze activity to mark them seen. */
	messageIds: string[];
}

export interface FetchNewChatThreadsOutput {
	success: boolean;
	threads: FetchedChatThread[];
	newCursor: {
		lastMessageCreatedAt: string | null;
		lastMessageId: string | null;
	};
	rawMessageCount: number;
	fetchedAllPages: boolean;
	updatedScanPageToken: string | null;
	error?: string;
}

// =============================================================================
// Internal types
// =============================================================================

interface RawChatMessage {
	id: string;
	createdDateTime?: string;
	lastModifiedDateTime?: string;
	webUrl?: string;
	from: string;
	bodyContent: string;
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Pull mature chat messages newer than the chat cursor and bundle them.
 *
 * Algorithm:
 * 1. Graph: `GET /me/chats/{chatId}/messages?$top=N`, paginate via @odata.nextLink.
 * 2. Filter to messages where `createdDateTime > sinceIso` AND
 *    `(now - createdDateTime) >= quietWindowMinutes` (last activity is idle).
 * 3. Drop messages whose ID is already in the seen-message dedup table.
 * 4. Sort chronologically; bundle into a single FetchedChatThread:
 *    - root = oldest unseen
 *    - replies = remaining unseen in order
 * 5. Cursor = max(createdDateTime across emitted bundle).
 *
 * If no unseen mature messages exist after a tick's worth of pages, return
 * an empty result with the resume token persisted (so the next tick continues
 * scanning past the same already-seen window).
 */
export async function fetchNewChatThreadsActivity(
	input: FetchNewChatThreadsInput,
): Promise<FetchNewChatThreadsOutput> {
	const {
		linkedChatId,
		chatId,
		userId,
		organizationId,
		sinceIso,
		scanPageToken: inputScanToken,
		quietWindowMinutes = 60,
		maxMessages = 200,
	} = input;

	// debug, not info: this fires on every poll tick for every linked chat and
	// records the request shape, which is diagnostic detail rather than an
	// operational event. The failure path below still logs at error level.
	logger.debug("[TeamsChatMonitor] Fetching new chat messages", {
		linkedChatId,
		chatId,
		sinceIso,
		hasScanToken: !!inputScanToken,
		quietWindowMinutes,
		maxMessages,
	});

	try {
		const now = Date.now();
		const quietWindowMs = quietWindowMinutes * 60 * 1000;
		const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;

		const ACTIVITY_PAGE_LIMIT = 10;
		const unseenCollected: Array<{
			message: RawChatMessage;
			createdAtMs: number;
		}> = [];
		let rawMessageCount = 0;
		let outerCallCount = 0;
		let pageToken: string | undefined = inputScanToken ?? undefined;
		let fetchedAllPages = false;

		while (outerCallCount < ACTIVITY_PAGE_LIMIT) {
			heartbeat(
				`list_chat_messages_for_monitor: page-pass ${outerCallCount + 1}`,
			);
			const graphResult = (await executeMicrosoftTeamsTool(
				"list_chat_messages_for_monitor",
				{
					chatId,
					top: maxMessages,
					...(pageToken ? { nextPageToken: pageToken } : {}),
				},
				userId,
				organizationId,
			)) as {
				messages?: RawChatMessage[];
				count?: number;
				fetchedAllPages?: boolean;
				nextPageToken?: string;
				error?: string;
			};

			if (graphResult.error) {
				return {
					success: false,
					threads: [],
					newCursor: {
						lastMessageCreatedAt: sinceIso ?? null,
						lastMessageId: null,
					},
					rawMessageCount,
					fetchedAllPages: false,
					updatedScanPageToken: null,
					error: graphResult.error,
				};
			}

			outerCallCount++;
			const raw = graphResult.messages ?? [];
			rawMessageCount += raw.length;
			pageToken = graphResult.nextPageToken;

			// Filter: cursor + quiet-window
			const matureRaw: Array<{
				message: RawChatMessage;
				createdAtMs: number;
			}> = [];
			for (const message of raw) {
				if (!message.createdDateTime) {
					continue;
				}
				const createdAtMs = new Date(message.createdDateTime).getTime();
				if (Number.isNaN(createdAtMs)) {
					continue;
				}
				if (sinceMs > 0 && createdAtMs <= sinceMs) {
					continue;
				}
				if (now - createdAtMs < quietWindowMs) {
					continue;
				}
				matureRaw.push({ message, createdAtMs });
			}

			// Dedup against seen-message table
			if (matureRaw.length > 0) {
				const candidateIds = matureRaw.map((m) => m.message.id);
				const seenSet = await getSeenChatMessageIds(
					linkedChatId,
					candidateIds,
				);
				for (const m of matureRaw) {
					if (!seenSet.has(m.message.id)) {
						unseenCollected.push(m);
						if (unseenCollected.length >= maxMessages) {
							break;
						}
					}
				}
			}

			if (unseenCollected.length >= maxMessages) {
				break;
			}
			if (!pageToken) {
				fetchedAllPages = true;
				break;
			}
		}

		// Decide what to persist as scanPageToken for next tick.
		const updatedScanPageToken =
			unseenCollected.length > 0 || fetchedAllPages
				? null
				: (pageToken ?? null);

		if (unseenCollected.length === 0) {
			return {
				success: true,
				threads: [],
				newCursor: {
					lastMessageCreatedAt: sinceIso ?? null,
					lastMessageId: null,
				},
				rawMessageCount,
				fetchedAllPages,
				updatedScanPageToken,
			};
		}

		// Sort chronologically (oldest first) and bundle into a single thread.
		unseenCollected.sort((a, b) => a.createdAtMs - b.createdAtMs);
		const root = unseenCollected[0];
		const tail = unseenCollected.slice(1);

		const replies: FetchedChatMessage[] = tail.map(({ message }) => ({
			messageId: message.id,
			author: message.from,
			createdAt: message.createdDateTime ?? new Date().toISOString(),
			content: truncateContent(message.bodyContent, 2000),
			webLink: message.webUrl,
		}));

		const lastActivityMs = Math.max(
			...unseenCollected.map((m) => m.createdAtMs),
		);
		const lastActivityIso = new Date(lastActivityMs).toISOString();
		const lastActivityMessage = unseenCollected.find(
			(m) => m.createdAtMs === lastActivityMs,
		)?.message;

		const thread: FetchedChatThread = {
			rootMessageId: root.message.id,
			rootCreatedAt:
				root.message.createdDateTime ??
				new Date(root.createdAtMs).toISOString(),
			rootAuthor: root.message.from,
			rootContent: truncateContent(root.message.bodyContent, 2000),
			rootWebLink: root.message.webUrl,
			replies,
			threadLastActivity: lastActivityIso,
			messageIds: unseenCollected.map((m) => m.message.id),
		};

		return {
			success: true,
			threads: [thread],
			newCursor: {
				lastMessageCreatedAt: lastActivityIso,
				lastMessageId: lastActivityMessage?.id ?? root.message.id,
			},
			rawMessageCount,
			fetchedAllPages,
			updatedScanPageToken,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[TeamsChatMonitor] Failed to fetch chat messages", {
			error: errorMessage,
			linkedChatId,
			chatId,
		});
		return {
			success: false,
			threads: [],
			newCursor: {
				lastMessageCreatedAt: sinceIso ?? null,
				lastMessageId: null,
			},
			rawMessageCount: 0,
			fetchedAllPages: false,
			updatedScanPageToken: null,
			error: errorMessage,
		};
	}
}

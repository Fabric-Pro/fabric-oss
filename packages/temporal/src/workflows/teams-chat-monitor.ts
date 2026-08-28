/**
 * Teams Chat Monitor Workflow
 *
 * Scheduled workflow that polls linked Microsoft Teams group chats for new
 * messages, runs a per-bundle LLM extraction pass, and persists
 * `PendingBacklogProposal` rows for reviewer approval.
 *
 * Mirrors `teams-channel-monitor.ts` 1:1 — signal cancellation, progress
 * query, `continueAsNew` when the server suggests it, and the `ai-chat`
 * task queue. Only the per-source data shape differs (chats have no native
 * thread hierarchy, so each tick bundles new messages into a single
 * synthetic "thread" per chat).
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 * No `@repo/database` / `@repo/ai` / helper-package imports.
 */

import {
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type * as teamsChatMonitorActivities from "../activities/teams-chat-monitor";

// =============================================================================
// Types
// =============================================================================

export interface TeamsChatMonitorInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** `0` or negative ⇒ one-shot (single tick and exit). */
	intervalMinutes: number;
	/** Minutes a message must be idle before it's bundled for analysis. Default 60. */
	quietWindowMinutes?: number;
}

export interface TeamsChatMonitorProgress {
	lastRunAt: string | null;
	chatsChecked: number;
	bundlesAnalyzed: number;
	proposalsCreated: number;
	emptyBundles: number;
	failedChats: number;
	tickCount: number;
	isRunning: boolean;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelTeamsChatMonitorSignal = defineSignal(
	"cancelTeamsChatMonitor",
);
export const teamsChatMonitorProgressQuery =
	defineQuery<TeamsChatMonitorProgress>("teamsChatMonitorProgress");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof teamsChatMonitorActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

// =============================================================================
// Workflow
// =============================================================================

export async function teamsChatMonitorWorkflow(
	input: TeamsChatMonitorInput,
): Promise<void> {
	const {
		projectId,
		userId,
		organizationId,
		intervalMinutes,
		quietWindowMinutes,
	} = input;

	let cancelled = false;
	let tickCount = 0;
	let progress: TeamsChatMonitorProgress = {
		lastRunAt: null,
		chatsChecked: 0,
		bundlesAnalyzed: 0,
		proposalsCreated: 0,
		emptyBundles: 0,
		failedChats: 0,
		tickCount: 0,
		isRunning: false,
	};

	setHandler(cancelTeamsChatMonitorSignal, () => {
		cancelled = true;
	});

	setHandler(teamsChatMonitorProgressQuery, () => progress);

	const isOneShot = intervalMinutes <= 0;

	while (!cancelled) {
		if (!isOneShot) {
			const wasCancelled = await condition(
				() => cancelled,
				intervalMinutes * 60 * 1000,
			);
			if (wasCancelled) {
				break;
			}
		}

		progress = { ...progress, isRunning: true };

		const linkedChats = await activities.getLinkedChatsForMonitorActivity({
			projectId,
		});

		if (linkedChats.length === 0) {
			progress = {
				...progress,
				isRunning: false,
				chatsChecked: 0,
			};
			if (isOneShot) {
				break;
			}
			continue;
		}

		let chatsChecked = 0;
		let bundlesAnalyzed = 0;
		let proposalsCreated = 0;
		let emptyBundles = 0;
		let failedChats = 0;

		for (const chat of linkedChats) {
			if (cancelled) {
				break;
			}

			chatsChecked++;

			try {
				const fetchResult =
					await activities.fetchNewChatThreadsActivity({
						projectId,
						linkedChatId: chat.id,
						chatId: chat.chatId,
						userId,
						organizationId,
						sinceIso: chat.lastMessageCreatedAt,
						scanPageToken: chat.scanPageToken,
						quietWindowMinutes: quietWindowMinutes ?? 60,
					});

				if (!fetchResult.success) {
					try {
						await activities.recordTeamsChatFailureActivity({
							linkedChatId: chat.id,
							errorMessage: fetchResult.error ?? "fetch failed",
						});
					} catch {
						// Non-fatal.
					}
					try {
						await activities.setTeamsChatScanPageTokenActivity({
							linkedChatId: chat.id,
							token: fetchResult.updatedScanPageToken,
						});
					} catch {
						// Non-fatal.
					}
					failedChats++;
					continue;
				}

				try {
					await activities.setTeamsChatScanPageTokenActivity({
						linkedChatId: chat.id,
						token: fetchResult.updatedScanPageToken,
					});
				} catch {
					// Non-fatal.
				}

				if (fetchResult.threads.length === 0) {
					continue;
				}

				const chatTopic = chat.chatTopic ?? "chat";

				let minThreadLastActivity: string | null = null;
				let minThreadRootId: string | null = null;
				for (const thread of fetchResult.threads) {
					if (cancelled) {
						break;
					}
					const analyzeResult =
						await activities.analyzeChatThreadActivity({
							projectId,
							userId,
							organizationId,
							linkedChatId: chat.id,
							thread,
							chatTopic,
							chatWebUrl: chat.chatWebUrl ?? undefined,
						});

					bundlesAnalyzed++;
					if (
						analyzeResult.success &&
						analyzeResult.pendingProposalId
					) {
						proposalsCreated++;
					} else if (
						analyzeResult.success &&
						analyzeResult.changeCount === 0
					) {
						emptyBundles++;
					}

					if (
						!minThreadLastActivity ||
						thread.threadLastActivity < minThreadLastActivity
					) {
						minThreadLastActivity = thread.threadLastActivity;
						minThreadRootId = thread.rootMessageId;
					}
				}

				if (fetchResult.fetchedAllPages && minThreadLastActivity) {
					await activities.updateTeamsChatCursorActivity({
						linkedChatId: chat.id,
						lastMessageCreatedAt: minThreadLastActivity,
						lastMessageId: minThreadRootId,
					});
				} else if (
					// A tick that succeeded but found nothing must still clear
					// the failure banner — see the note in
					// teams-channel-monitor.ts (Fizzy #2311).
					patched(
						"teams-chat-monitor-clear-failure-on-quiet-tick-2026-08",
					)
				) {
					await activities.clearTeamsChatFailureActivity({
						linkedChatId: chat.id,
					});
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : String(err);
				try {
					await activities.recordTeamsChatFailureActivity({
						linkedChatId: chat.id,
						errorMessage,
					});
				} catch {
					// Non-fatal.
				}
				failedChats++;
				// Do NOT rethrow — move to the next chat.
			}
		}

		try {
			await activities.updateTeamsChatMonitorLastRunActivity({
				projectId,
			});
		} catch {
			// Non-fatal.
		}

		tickCount++;
		progress = {
			lastRunAt: new Date().toISOString(),
			chatsChecked,
			bundlesAnalyzed,
			proposalsCreated,
			emptyBundles,
			failedChats,
			tickCount,
			isRunning: false,
		};

		if (isOneShot) {
			break;
		}

		const info = workflowInfo();
		const shouldContinueAsNew = patched(
			"teams-chat-monitor-continue-2026-04",
		)
			? info.continueAsNewSuggested
			: info.historyLength >= 5000;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof teamsChatMonitorWorkflow>(input);
		}
	}
}

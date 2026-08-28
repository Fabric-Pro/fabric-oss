/**
 * Teams Channel Monitor Workflow
 *
 * Scheduled workflow that polls linked Microsoft Teams channels for mature
 * threads, runs a per-thread LLM extraction pass, and persists
 * `PendingBacklogProposal` rows for reviewer approval.
 *
 * Structure mirrors `meeting-transcript-sync.ts` — signal cancellation,
 * progress query, `continueAsNew` when the server suggests it, and a `ai-chat`
 * task queue for LLM-worker scaling.
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
import type * as teamsChannelMonitorActivities from "../activities/teams-channel-monitor";

// =============================================================================
// Types
// =============================================================================

export interface TeamsChannelMonitorInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** `0` or negative ⇒ one-shot (single tick and exit). */
	intervalMinutes: number;
	/** Minutes a thread must be idle before analysis. Default 60. */
	quietWindowMinutes?: number;
}

export interface TeamsChannelMonitorProgress {
	lastRunAt: string | null;
	channelsChecked: number;
	threadsAnalyzed: number;
	proposalsCreated: number;
	emptyThreads: number;
	failedChannels: number;
	tickCount: number;
	isRunning: boolean;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelTeamsChannelMonitorSignal = defineSignal(
	"cancelTeamsChannelMonitor",
);
export const teamsChannelMonitorProgressQuery =
	defineQuery<TeamsChannelMonitorProgress>("teamsChannelMonitorProgress");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof teamsChannelMonitorActivities>({
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

export async function teamsChannelMonitorWorkflow(
	input: TeamsChannelMonitorInput,
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
	let progress: TeamsChannelMonitorProgress = {
		lastRunAt: null,
		channelsChecked: 0,
		threadsAnalyzed: 0,
		proposalsCreated: 0,
		emptyThreads: 0,
		failedChannels: 0,
		tickCount: 0,
		isRunning: false,
	};

	setHandler(cancelTeamsChannelMonitorSignal, () => {
		cancelled = true;
	});

	setHandler(teamsChannelMonitorProgressQuery, () => progress);

	const isOneShot = intervalMinutes <= 0;

	// Main loop — mirrors meeting-transcript-sync's cadence.
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

		// Step 1: re-read linked channels each tick so add/remove propagates.
		const linkedChannels =
			await activities.getLinkedChannelsForMonitorActivity({ projectId });

		if (linkedChannels.length === 0) {
			progress = {
				...progress,
				isRunning: false,
				channelsChecked: 0,
			};
			if (isOneShot) {
				break;
			}
			continue;
		}

		let channelsChecked = 0;
		let threadsAnalyzed = 0;
		let proposalsCreated = 0;
		let emptyThreads = 0;
		let failedChannels = 0;

		// Step 2: per-channel fetch + analyze, isolated try/catch per channel.
		for (const channel of linkedChannels) {
			if (cancelled) {
				break;
			}

			channelsChecked++;

			try {
				const fetchResult =
					await activities.fetchNewChannelThreadsActivity({
						projectId,
						linkedChannelId: channel.id,
						teamId: channel.teamId,
						channelId: channel.channelId,
						userId,
						organizationId,
						sinceIso: channel.lastMessageCreatedAt,
						scanPageToken: channel.scanPageToken,
						quietWindowMinutes: quietWindowMinutes ?? 60,
					});

				if (!fetchResult.success) {
					try {
						await activities.recordTeamsChannelFailureActivity({
							linkedChannelId: channel.id,
							errorMessage: fetchResult.error ?? "fetch failed",
						});
					} catch {
						// Non-fatal.
					}
					// Persist the activity-reported scan token state (null on
					// error) so we don't loop on a bad resume point.
					try {
						await activities.setTeamsChannelScanPageTokenActivity({
							linkedChannelId: channel.id,
							token: fetchResult.updatedScanPageToken,
						});
					} catch {
						// Non-fatal.
					}
					failedChannels++;
					continue;
				}

				// Persist scan token before the (optional) analyze phase, so
				// the resume state is captured even if analysis throws later.
				try {
					await activities.setTeamsChannelScanPageTokenActivity({
						linkedChannelId: channel.id,
						token: fetchResult.updatedScanPageToken,
					});
				} catch {
					// Non-fatal.
				}

				if (fetchResult.threads.length === 0) {
					continue;
				}

				const channelDisplayName =
					channel.channelName ?? channel.teamName ?? "channel";

				// Step 3: sequential per-thread analysis — one LLM call each.
				// No per-thread try/catch: activity errors propagate up to the
				// per-channel catch so failures stay visible.
				let minThreadLastActivity: string | null = null;
				let minThreadRootId: string | null = null;
				for (const thread of fetchResult.threads) {
					if (cancelled) {
						break;
					}
					const analyzeResult =
						await activities.analyzeChannelThreadActivity({
							projectId,
							userId,
							organizationId,
							linkedChannelId: channel.id,
							// Forward the Microsoft Graph identifiers so the
							// apply-time orchestrator can build the
							// hostedContents download URL (bug_001).
							teamId: channel.teamId,
							channelId: channel.channelId,
							thread,
							channelDisplayName,
							channelWebUrl: channel.channelWebUrl ?? undefined,
						});

					threadsAnalyzed++;
					if (
						analyzeResult.success &&
						analyzeResult.pendingProposalId
					) {
						proposalsCreated++;
					} else if (
						analyzeResult.success &&
						analyzeResult.changeCount === 0
					) {
						emptyThreads++;
					}

					if (
						!minThreadLastActivity ||
						thread.threadLastActivity < minThreadLastActivity
					) {
						minThreadLastActivity = thread.threadLastActivity;
						minThreadRootId = thread.rootMessageId;
					}
				}

				// Step 3b: advance channel cursor ONLY if we exhausted all
				// Graph pages this tick. When fetchedAllPages is false we hit
				// the maxThreads cap with more pages available — advancing the
				// cursor would permanently skip older unfetched threads whose
				// lastActivity falls between sinceIso and our new cursor. The
				// dedup table prevents re-analyzing the threads we did process
				// on the next tick.
				if (fetchResult.fetchedAllPages && minThreadLastActivity) {
					await activities.updateTeamsChannelCursorActivity({
						linkedChannelId: channel.id,
						lastMessageCreatedAt: minThreadLastActivity,
						lastMessageId: minThreadRootId,
					});
				} else if (
					// The cursor update above is what clears failure state, so a
					// tick that succeeded but found nothing used to leave the
					// error banner and the "re-link this channel" prompt in
					// place forever — recovery is a property of the tick
					// succeeding, not of the cursor moving (Fizzy #2311).
					// Gated so in-flight executions started before this activity
					// existed replay deterministically.
					patched("teams-monitor-clear-failure-on-quiet-tick-2026-08")
				) {
					await activities.clearTeamsChannelFailureActivity({
						linkedChannelId: channel.id,
					});
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : String(err);
				try {
					await activities.recordTeamsChannelFailureActivity({
						linkedChannelId: channel.id,
						errorMessage,
					});
				} catch {
					// Non-fatal.
				}
				failedChannels++;
				// Do NOT rethrow — move to the next channel.
			}
		}

		// Step 4: stamp project-level last run timestamp (non-fatal).
		try {
			await activities.updateTeamsChannelMonitorLastRunActivity({
				projectId,
			});
		} catch {
			// Non-fatal.
		}

		tickCount++;
		progress = {
			lastRunAt: new Date().toISOString(),
			channelsChecked,
			threadsAnalyzed,
			proposalsCreated,
			emptyThreads,
			failedChannels,
			tickCount,
			isRunning: false,
		};

		if (isOneShot) {
			break;
		}

		// continueAsNew when the server suggests it (~4K events / ~4MB).
		// Gated by patched() so in-flight executions started under the prior
		// `historyLength >= 5000` threshold replay deterministically — the
		// suggested flag trips at ~4K events, earlier than the old threshold,
		// which would otherwise trigger continueAsNew at a history task where
		// no such event exists.
		const info = workflowInfo();
		const shouldContinueAsNew = patched(
			"teams-monitor-can-suggested-2026-04",
		)
			? info.continueAsNewSuggested
			: info.historyLength >= 5000;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof teamsChannelMonitorWorkflow>(input);
		}
	}
}

/**
 * Meeting Transcript Auto-Sync Workflow
 *
 * Periodically checks linked Teams meetings for new transcripts and syncs them
 * as project context for RAG retrieval. Uses continueAsNew to prevent history buildup.
 *
 * Pattern follows the standard scheduled sync workflow shape (signals, queries, continueAsNew).
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
import type * as meetingTranscriptSyncActivities from "../activities/meeting-transcript-sync";

// =============================================================================
// Types
// =============================================================================

export interface MeetingTranscriptSyncInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	intervalMinutes: number;
	// Calendar lookback for the sync (default 30 days, clamped to 180 in the
	// activity). Used by one-shot backfills; recurring syncs leave it unset.
	daysBack?: number;
}

export interface MeetingTranscriptSyncProgress {
	lastSyncAt: string | null;
	meetingsChecked: number;
	transcriptsSynced: number;
	transcriptsSkipped: number;
	transcriptsFailed: number;
	syncCount: number;
	isRunning: boolean;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelMeetingTranscriptSyncSignal = defineSignal(
	"cancelMeetingTranscriptSync",
);
export const meetingTranscriptSyncProgressQuery =
	defineQuery<MeetingTranscriptSyncProgress>("meetingTranscriptSyncProgress");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof meetingTranscriptSyncActivities>({
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

export async function meetingTranscriptSyncWorkflow(
	input: MeetingTranscriptSyncInput,
): Promise<void> {
	const { projectId, userId, organizationId, intervalMinutes, daysBack } =
		input;

	let cancelled = false;
	let syncCount = 0;
	let progress: MeetingTranscriptSyncProgress = {
		lastSyncAt: null,
		meetingsChecked: 0,
		transcriptsSynced: 0,
		transcriptsSkipped: 0,
		transcriptsFailed: 0,
		syncCount: 0,
		isRunning: false,
	};

	setHandler(cancelMeetingTranscriptSyncSignal, () => {
		cancelled = true;
	});

	setHandler(meetingTranscriptSyncProgressQuery, () => progress);

	const isOneShot = intervalMinutes <= 0;

	// Main loop
	while (!cancelled) {
		// Wait for the configured interval, but wake immediately if cancelled
		if (!isOneShot) {
			// condition() returns true if predicate became true, false if timed out
			const wasCancelled = await condition(
				() => cancelled,
				intervalMinutes * 60 * 1000,
			);
			if (wasCancelled) {
				break;
			}
		}

		progress = { ...progress, isRunning: true };

		// Step 1: Get linked meeting join URLs for this project
		const linkedMeetings =
			await activities.getLinkedMeetingJoinUrlsActivity({
				projectId,
			});

		if (linkedMeetings.length === 0) {
			// No linked meetings, skip this cycle
			progress = {
				...progress,
				isRunning: false,
				meetingsChecked: 0,
			};
			continue;
		}

		// Build a map of joinUrl -> linkedMeeting for quick lookup
		const joinUrlToLinkedMeeting = new Map<
			string,
			{ id: string; joinUrl: string; subject: string | null }
		>();
		const linkedJoinUrls: string[] = [];
		for (const lm of linkedMeetings) {
			joinUrlToLinkedMeeting.set(lm.joinUrl.toLowerCase(), lm);
			linkedJoinUrls.push(lm.joinUrl);
		}

		// Step 2: List recent calendar meetings filtered to linked URLs
		//
		// A calendar that cannot be read now fails the activity rather than
		// returning an empty list, because the two used to be indistinguishable
		// and an outage read as a clean, empty cycle. Catching it here keeps that
		// signal without the cure being worse than the disease: an unguarded
		// throw would exhaust the retry policy and terminate this workflow, and
		// since it is the long-lived loop that carries a project's scheduled
		// sync, a few hours of Graph trouble would end that sync until someone
		// noticed and re-enabled it.
		//
		// Skipping to the next cycle deliberately steps over Step 4 as well:
		// leaving the last-run timestamp untouched is precisely what makes the
		// outage visible on the project's settings page, where it previously
		// reported a fresh sync throughout.
		let meetingInstances: meetingTranscriptSyncActivities.MeetingInstance[];
		try {
			meetingInstances =
				await activities.listRecentMeetingInstancesForLinkedUrls({
					userId,
					organizationId,
					linkedJoinUrls,
					daysBack,
					projectId,
				});
		} catch (error) {
			// A one-shot has no next cycle to recover in, and its failure belongs
			// to the person who asked for it.
			if (isOneShot) {
				throw error;
			}
			progress = { ...progress, isRunning: false };
			continue;
		}

		let transcriptsSynced = 0;
		let transcriptsSkipped = 0;
		let transcriptsFailed = 0;

		// Step 3: For each matching meeting instance, fetch and store transcripts
		for (const meeting of meetingInstances) {
			if (cancelled) {
				break;
			}

			// Resolve the linked meeting record
			const linkedMeeting = joinUrlToLinkedMeeting.get(
				meeting.joinUrl.toLowerCase(),
			);
			if (!linkedMeeting) {
				continue;
			}

			try {
				const result = await activities.fetchAndStoreMeetingTranscript({
					projectId,
					linkedMeetingId: linkedMeeting.id,
					userId,
					organizationId,
					joinUrl: meeting.joinUrl,
					meetingSubject:
						meeting.subject ||
						linkedMeeting.subject ||
						"Untitled Meeting",
					meetingDate: meeting.startTime,
				});

				if (result.success) {
					transcriptsSynced += result.transcriptsFetched;
				} else if (
					result.error?.includes("No transcripts available") ||
					result.error?.includes("Could not resolve meeting")
				) {
					transcriptsSkipped++;
				} else {
					transcriptsFailed++;
				}
			} catch {
				transcriptsFailed++;
			}
		}

		// Step 4: Update last run timestamp
		try {
			await activities.updateMeetingTranscriptSyncLastRunActivity({
				projectId,
			});
		} catch {
			// Non-fatal
		}

		syncCount++;
		progress = {
			lastSyncAt: new Date().toISOString(),
			meetingsChecked: meetingInstances.length,
			transcriptsSynced,
			transcriptsSkipped,
			transcriptsFailed,
			syncCount,
			isRunning: false,
		};

		// One-shot mode: exit after single sync cycle
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
			"meeting-transcript-can-suggested-2026-04",
		)
			? info.continueAsNewSuggested
			: info.historyLength >= 5000;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof meetingTranscriptSyncWorkflow>(input);
		}
	}
}

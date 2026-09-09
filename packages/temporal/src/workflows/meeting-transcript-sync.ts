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
	/**
	 * The account this sync falls back to: whoever last enabled or reconnected
	 * it. Since #2354 each meeting is read under the account that linked it,
	 * and this covers only the rows that carry no linker. Kept in the input
	 * because executions started before that change still read everything
	 * under it, and removing it would break their replay.
	 */
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
// Grouping
// =============================================================================

type LinkedMeetingRef = meetingTranscriptSyncActivities.LinkedMeetingJoinUrl;

export interface MeetingSyncGroup {
	/** The account this group's calendar read and transcript fetches run under. */
	syncUserId: string;
	meetings: LinkedMeetingRef[];
}

/**
 * Split a project's linked meetings into one group per account they sync under.
 *
 * Until #2354 a project read ONE calendar — the account frozen into this
 * workflow's arguments when sync was enabled. Every linked meeting was looked
 * for there, so a meeting somebody else linked was simply never found: Graph
 * answers "no meetings" rather than an error, so nothing failed, nothing was
 * logged, and the project went on reporting a healthy sync while collecting
 * only what one person could see.
 *
 * Grouping by linker is what makes "I link mine, you link yours" work. Rows
 * predating the column carry no linker and fall back to the project-level
 * account, which is exactly who used to read them.
 *
 * Insertion order is preserved so the activity sequence is stable across a
 * replay.
 */
export function groupLinkedMeetingsBySyncingUser(
	linkedMeetings: LinkedMeetingRef[],
	fallbackUserId: string,
): MeetingSyncGroup[] {
	const groups = new Map<string, LinkedMeetingRef[]>();

	for (const linkedMeeting of linkedMeetings) {
		const syncUserId = linkedMeeting.userId ?? fallbackUserId;
		const existing = groups.get(syncUserId);
		if (existing) {
			existing.push(linkedMeeting);
		} else {
			groups.set(syncUserId, [linkedMeeting]);
		}
	}

	return Array.from(groups, ([syncUserId, meetings]) => ({
		syncUserId,
		meetings,
	}));
}

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

		// One calendar read per account that linked something, instead of one
		// per project (#2354). Gated so executions started before this shipped
		// replay their single-read history deterministically; they keep reading
		// everything under the frozen account until they continueAsNew.
		const perLinkerSync = patched("meeting-sync-per-linker-2026-09");
		const groups = perLinkerSync
			? groupLinkedMeetingsBySyncingUser(linkedMeetings, userId)
			: [{ syncUserId: userId, meetings: linkedMeetings }];

		let meetingsChecked = 0;
		let transcriptsSynced = 0;
		let transcriptsSkipped = 0;
		let transcriptsFailed = 0;
		// How many accounts we actually reached. Zero means this cycle saw
		// nothing at all, which is the only case that may not be reported as a
		// completed sync.
		let calendarsRead = 0;
		let firstCalendarError: unknown;

		for (const group of groups) {
			// Build a map of joinUrl -> linkedMeeting for quick lookup
			const joinUrlToLinkedMeeting = new Map<string, LinkedMeetingRef>();
			const linkedJoinUrls: string[] = [];
			for (const lm of group.meetings) {
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
			// One account's trouble must not take the others down with it, so the
			// cycle moves on to the next group and only a cycle that reached
			// nobody is treated as a failed one.
			let meetingInstances: meetingTranscriptSyncActivities.MeetingInstance[];
			try {
				meetingInstances =
					await activities.listRecentMeetingInstancesForLinkedUrls({
						userId: group.syncUserId,
						organizationId,
						linkedJoinUrls,
						daysBack,
						projectId,
						// Omitted on the pre-#2354 path, whose single read
						// genuinely answers for the whole project.
						...(perLinkerSync
							? {
									linkedMeetingIds: group.meetings.map(
										(m) => m.id,
									),
								}
							: {}),
					});
			} catch (error) {
				if (firstCalendarError === undefined) {
					firstCalendarError = error;
				}
				continue;
			}

			calendarsRead++;
			meetingsChecked += meetingInstances.length;

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
					const result =
						await activities.fetchAndStoreMeetingTranscript({
							projectId,
							linkedMeetingId: linkedMeeting.id,
							userId: group.syncUserId,
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

			// Checked at the end so the single-group path generates exactly the
			// command sequence it did before this change.
			if (cancelled) {
				break;
			}
		}

		if (calendarsRead === 0) {
			// A one-shot has no next cycle to recover in, and its failure belongs
			// to the person who asked for it.
			if (isOneShot) {
				throw firstCalendarError instanceof Error
					? firstCalendarError
					: new Error(
							"Could not read any calendar for this project.",
						);
			}
			// Leaving the last-run timestamp untouched is precisely what makes
			// the outage visible on the project's settings page, where it
			// previously reported a fresh sync throughout.
			progress = { ...progress, isRunning: false };
			continue;
		}

		// Step 4: Update last run timestamp.
		//
		// Reached whenever at least one account was readable. Which meetings
		// stalled is carried per row by the failure state the activity records,
		// not by this one project-wide timestamp — a project where one linker
		// of four has left is still syncing, and freezing its last-run would
		// describe the whole project as down.
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
			meetingsChecked,
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

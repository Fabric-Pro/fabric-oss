/**
 * Slack Huddle Notes Ingestion Workflow
 *
 * Periodically polls linked Slack channels for huddle AI-notes canvases and
 * stores them as passive `SLACK_HUDDLE_NOTES` project context for RAG retrieval.
 * Mirrors the meeting-transcript-sync control flow (interval condition() loop,
 * one-shot mode, continueAsNew gated by a fresh patched() id) — NOT the
 * event-driven channel-monitor flush loop.
 *
 * Determinism (temporal.md): the workflow imports only @temporalio/workflow and
 * TYPE-ONLY from the activity module; all side-effects (Date.now / IO / random)
 * live in activities. The `new Date().toISOString()` used for progress is
 * replay-safe (the SDK patches Date in the sandbox) and never drives a
 * control-flow branch.
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
import type * as slackHuddleIngestActivities from "../activities/slack-channel-monitor/ingest-huddle-notes";

// =============================================================================
// Types
// =============================================================================

export interface SlackHuddleIngestInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** <= 0 means one-shot (used by "Run now"). */
	intervalMinutes: number;
	/** Forward-only lower bound (ms since epoch). */
	enabledAtMs?: number;
}

export interface SlackHuddleIngestProgress {
	lastSyncAt: string | null;
	channelsChecked: number;
	canvasesDetected: number;
	notesIngested: number;
	notesUpdated: number;
	notesSkipped: number;
	notesFailed: number;
	syncCount: number;
	isRunning: boolean;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSlackHuddleIngestSignal = defineSignal(
	"cancelSlackHuddleIngest",
);
export const slackHuddleIngestProgressQuery =
	defineQuery<SlackHuddleIngestProgress>("slackHuddleIngestProgress");

// =============================================================================
// Activity Proxies (config mirrors Teams transcript sync)
// =============================================================================

const activities = proxyActivities<typeof slackHuddleIngestActivities>({
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

export async function slackHuddleIngestWorkflow(
	input: SlackHuddleIngestInput,
): Promise<void> {
	const { projectId, userId, organizationId, intervalMinutes, enabledAtMs } =
		input;

	let cancelled = false;
	let syncCount = 0;
	let progress: SlackHuddleIngestProgress = {
		lastSyncAt: null,
		channelsChecked: 0,
		canvasesDetected: 0,
		notesIngested: 0,
		notesUpdated: 0,
		notesSkipped: 0,
		notesFailed: 0,
		syncCount: 0,
		isRunning: false,
	};

	setHandler(cancelSlackHuddleIngestSignal, () => {
		cancelled = true;
	});
	setHandler(slackHuddleIngestProgressQuery, () => progress);

	const isOneShot = intervalMinutes <= 0;

	while (!cancelled) {
		// Sleep the interval, wake immediately on cancel. One-shot skips the wait.
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

		// Step 1: linked channels (huddle ingest rides the same linked channels).
		const channels = await activities.getLinkedHuddleChannelsActivity({
			projectId,
		});

		if (channels.length === 0) {
			progress = { ...progress, isRunning: false, channelsChecked: 0 };
			if (isOneShot) {
				break;
			}
			continue;
		}

		let canvasesDetected = 0;
		let notesIngested = 0;
		let notesUpdated = 0;
		let notesSkipped = 0;
		let notesFailed = 0;

		// Step 2: per-channel ingestion, fault-isolated (one failure never aborts
		// the loop or the other channels).
		for (const channel of channels) {
			if (cancelled) {
				break;
			}
			try {
				const r = await activities.ingestHuddleNotesForChannelActivity({
					projectId,
					linkedChannelId: channel.id,
					channelId: channel.channelId,
					slackTeamId: channel.slackTeamId,
					channelName: channel.channelName,
					userId,
					organizationId,
					enabledAtMs,
				});
				canvasesDetected += r.canvasesDetected;
				notesIngested += r.ingested;
				notesUpdated += r.updated;
				notesSkipped += r.skipped;
				notesFailed += r.failed;
			} catch {
				notesFailed += 1;
			}
		}

		// Step 3: stamp last-run (non-fatal).
		try {
			await activities.updateSlackHuddleIngestLastRunActivity({
				projectId,
			});
		} catch {
			// Non-fatal
		}

		syncCount++;
		progress = {
			lastSyncAt: new Date().toISOString(),
			channelsChecked: channels.length,
			canvasesDetected,
			notesIngested,
			notesUpdated,
			notesSkipped,
			notesFailed,
			syncCount,
			isRunning: false,
		};

		if (isOneShot) {
			break;
		}

		// continueAsNew when the server suggests it (~4K events). Fresh patch id —
		// NOT Teams' or the channel-monitor's.
		const info = workflowInfo();
		const shouldContinueAsNew = patched(
			"slack-huddle-ingest-can-suggested-2026-06",
		)
			? info.continueAsNewSuggested
			: info.historyLength >= 5000;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof slackHuddleIngestWorkflow>(input);
		}
	}
}

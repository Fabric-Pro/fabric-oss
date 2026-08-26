/**
 * Slack Channel Monitor — per-channel cursor and project-level state activities.
 *
 * Thin wrappers around the `@repo/database` query helpers in
 * `packages/database/prisma/queries/projects/slack-channel-monitor.ts`.
 *
 * Mirrors `update-teams-channel-cursor.ts` from the Teams monitor.
 */

import {
	getLinkedSlackChannelsForMonitor,
	getSlackLinkedChannelJobContext,
	recordSlackChannelFailure,
	updateSlackChannelCursor,
	updateSlackChannelMonitorLastRun,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	JOB_SOURCE,
	JOB_STEPS,
	jobCompleteAll,
	jobEnsure,
	jobFail,
	jobIncrement,
	jobStep,
	seedJobSteps,
} from "../lib/job-progress";

/**
 * Job Hub: record a channel failure against its job row, opening one if the
 * flush errored before anything was analyzed — a flush that only failed must be
 * visible in the panel, not silently absent.
 */
async function recordChannelFailureJob(
	linkedChannelId: string,
	errorMessage: string,
): Promise<void> {
	try {
		const context = await getSlackLinkedChannelJobContext(linkedChannelId);
		if (!context) {
			return;
		}
		const displayName =
			context.channelName ?? context.teamName ?? "channel";
		await jobEnsure({
			kind: "SLACK_CHANNEL_MONITOR",
			title: `Slack · #${displayName}`,
			projectId: context.projectId,
			userId: context.userId,
			organizationId: context.organizationId,
			sourceType: JOB_SOURCE.slackLinkedChannel,
			sourceId: linkedChannelId,
			steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
		});
		await jobIncrement({ failures: 1 }, linkedChannelId);
		await jobStep("analyze", "failed", {
			sourceId: linkedChannelId,
			error: errorMessage,
		});
		// Close the row as FAILED here, not just mark the step. The flush-end
		// activity closes every row still RUNNING, so a row left open would be
		// stamped COMPLETED — a failed channel would render with a green badge
		// and no reason, which is the exact misreport the Job Hub exists to
		// remove. Closing now also makes the compare-and-set in
		// `completeBackgroundJobs` skip it.
		await jobFail(errorMessage, { sourceId: linkedChannelId });
	} catch {
		// Best-effort telemetry — never mask the real failure being recorded.
	}
}

// =============================================================================
// Types
// =============================================================================

export interface UpdateSlackChannelCursorInput {
	linkedChannelId: string;
	lastMessageTs: string | null;
}

export interface RecordSlackChannelFailureInput {
	linkedChannelId: string;
	errorMessage: string;
}

export interface RecordSlackChannelFailureForKeyInput {
	projectId: string;
	channelId: string;
	errorMessage: string;
}

export interface UpdateSlackChannelMonitorLastRunInput {
	projectId: string;
}

// =============================================================================
// Activities
// =============================================================================

export async function updateSlackChannelCursorActivity(
	input: UpdateSlackChannelCursorInput,
): Promise<void> {
	await updateSlackChannelCursor(input.linkedChannelId, {
		lastMessageTs: input.lastMessageTs,
	});
}

/**
 * Increment `consecutiveFailures` on a specific linked-channel row by id.
 * Used by the backfill activity once it's resolved the row.
 */
export async function recordSlackChannelFailureActivity(
	input: RecordSlackChannelFailureInput,
): Promise<void> {
	await recordChannelFailureJob(input.linkedChannelId, input.errorMessage);

	try {
		await recordSlackChannelFailure(
			input.linkedChannelId,
			input.errorMessage,
		);
	} catch (error) {
		logger.error("[SlackChannelMonitor] Failed to record channel failure", {
			error: error instanceof Error ? error.message : String(error),
			linkedChannelId: input.linkedChannelId,
		});
		// Non-fatal — swallow so the workflow keeps working.
	}
}

/**
 * Resolve the linked-channel row by `(projectId, channelId)` and increment its
 * failure counter. Used by the workflow's per-group catch which only knows the
 * Slack channelId, not the linked-channel row id.
 */
export async function recordSlackChannelFailureForKeyActivity(
	input: RecordSlackChannelFailureForKeyInput,
): Promise<void> {
	try {
		const channels = await getLinkedSlackChannelsForMonitor(
			input.projectId,
		);
		const match = channels.find((c) => c.channelId === input.channelId);
		if (!match) {
			logger.warn(
				"[SlackChannelMonitor] No linked channel for failure record",
				{
					projectId: input.projectId,
					channelId: input.channelId,
				},
			);
			return;
		}
		await recordChannelFailureJob(match.id, input.errorMessage);
		await recordSlackChannelFailure(match.id, input.errorMessage);
	} catch (error) {
		logger.error(
			"[SlackChannelMonitor] recordSlackChannelFailureForKey failed",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId: input.projectId,
				channelId: input.channelId,
			},
		);
		// Non-fatal.
	}
}

export async function updateSlackChannelMonitorLastRunActivity(
	input: UpdateSlackChannelMonitorLastRunInput,
): Promise<void> {
	// Job Hub: the workflow calls this at the end of every flush, so it is the
	// natural close point — one call closes all the per-channel rows the flush
	// opened. A flush that analyzed nothing opened none, and this is a no-op.
	await jobCompleteAll();

	try {
		await updateSlackChannelMonitorLastRun(input.projectId);
	} catch (error) {
		logger.error(
			"[SlackChannelMonitor] Failed to update monitor last-run timestamp",
			{
				error: error instanceof Error ? error.message : String(error),
				projectId: input.projectId,
			},
		);
		throw error;
	}
}

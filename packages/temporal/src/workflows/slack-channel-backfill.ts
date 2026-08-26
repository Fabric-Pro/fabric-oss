/**
 * Slack Channel Backfill Workflow
 *
 * Thin per-channel wrapper around `backfillSlackChannelActivity`. Invoked by:
 *
 *   - `enable-slack-channel-monitor.ts` — once per linked channel on first
 *     enable, to seed `lastMessageTs` and `backfillCompleteAt`.
 *   - `trigger-monitor-now.ts` — once per linked channel for a manual catch-up
 *     scan from the cursor (or a user-supplied lookback window).
 *
 * The wrapper exists so the call sites can use a stable workflow ID and depend
 * on workflow-level guarantees (heartbeat-resume across worker restarts, per-
 * channel isolation) without coupling the procedures to the activity's
 * lower-level input shape.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as slackChannelMonitorActivities from "../activities/slack-channel-monitor";

const { backfillSlackChannelActivity } = proxyActivities<
	typeof slackChannelMonitorActivities
>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 3,
		initialInterval: "10 seconds",
		backoffCoefficient: 2,
	},
});

export interface SlackChannelBackfillInput {
	projectId: string;
	linkedChannelId: string;
	slackTeamId: string;
	channelId: string;
	channelName?: string;
	channelWebUrl?: string;
	userId: string;
	organizationId?: string;

	// Trigger-now semantics. If `fromLastMessageTs` is set, resume from that
	// cursor. Otherwise, if `defaultBackfillHours` is set, compute an oldestTs
	// from (currentTimeMillis - hours). Otherwise, scan the whole channel
	// (activity-level cap of ~5k messages enforced).
	fromLastMessageTs?: string;
	defaultBackfillHours?: number;

	// Telemetry tag (e.g. "enable", "manual-trigger") — not used by the
	// activity, kept here so it shows up in workflow inputs for debugging.
	source?: "enable" | "manual-trigger";

	// Page size cap (default = activity default = 200).
	limit?: number;
	// Total message cap (default = activity default = 5000).
	maxMessages?: number;
}

export interface SlackChannelBackfillOutput {
	rootsScanned: number;
	rootsClaimed: number;
	proposalsCreated: number;
	rootsSkippedAlreadySeen: number;
	rootsSkippedFiltered: number;
	maxTsObserved: string | null;
	completed: boolean;
}

export async function slackChannelBackfillWorkflow(
	input: SlackChannelBackfillInput,
): Promise<SlackChannelBackfillOutput> {
	const oldestTs = resolveOldestTs(input);

	return backfillSlackChannelActivity({
		projectId: input.projectId,
		linkedChannelId: input.linkedChannelId,
		slackTeamId: input.slackTeamId,
		channelId: input.channelId,
		channelDisplayName: input.channelName,
		channelWebUrl: input.channelWebUrl,
		userId: input.userId,
		organizationId: input.organizationId,
		oldestTs,
		limit: input.limit,
		maxMessages: input.maxMessages,
	});
}

function resolveOldestTs(input: SlackChannelBackfillInput): string | undefined {
	if (input.fromLastMessageTs) {
		return input.fromLastMessageTs;
	}
	if (
		typeof input.defaultBackfillHours === "number" &&
		input.defaultBackfillHours > 0
	) {
		// Date.now() is deterministic inside Temporal workflows (mocked by
		// the SDK to use workflow-time). Slack `ts` is "<seconds>.<microseconds>".
		const seconds = Math.floor(
			(Date.now() - input.defaultBackfillHours * 3600 * 1000) / 1000,
		);
		return `${seconds}.000000`;
	}
	return undefined;
}

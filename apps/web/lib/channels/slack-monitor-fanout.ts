/**
 * Slack channel-monitor fanout.
 *
 * Called from the inbound Slack webhook handler after dedup. Signals the
 * per-project `slackChannelMonitorWorkflow` for every `ProjectLinkedSlackChannel`
 * row matching the incoming (slackTeamId, channelId) tuple and having
 * `monitorEnabled = true`. Monitor failures must never block the agent-trigger
 * dispatch path — callers wrap this in their own try/catch.
 *
 * Filtering responsibility:
 *   - Drops `subtype` edits/deletes and bot messages (belt-and-suspenders with
 *     the adapter-level `shouldProcessEvent` filter and the workflow's own
 *     signal-handler filter).
 *   - Caller is expected to have already deduped at the `channelEventReceipt`
 *     table — this helper does no dedup of its own.
 */

import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";

const SLACK_MONITOR_WORKFLOW_PREFIX = "slack-channel-monitor:";

/**
 * Slack message subtypes we never want to signal the monitor for. Edits and
 * deletes are out of scope (v1 plan); bot_message prevents agent-reply loops
 * from being ingested back into the monitor.
 */
const SKIP_SUBTYPES = new Set([
	"message_changed",
	"message_deleted",
	"bot_message",
]);

export interface SlackMonitorFanoutInput {
	/** Slack workspace id (team_id) from the inbound event envelope. */
	slackTeamId: string;
	/** Slack channel id from the inbound event. */
	channelId: string;
	/** Stable per-channel event id (Slack `event_id`) — already deduped upstream. */
	externalEventId: string;
	/**
	 * Slack `ts` string (zero-padded `seconds.microseconds`). Preferred for the
	 * seen-message dedup table because it sorts lexicographically.
	 * The caller may pass the ISO `occurredAt` as a fallback when the adapter
	 * doesn't surface the raw ts.
	 */
	ts: string;
	text: string;
	sender: { id: string; name?: string };
	threadId?: string;
	subtype?: string;
	botId?: string;
}

interface SlackMonitorSignalPayload {
	channelId: string;
	externalEventId: string;
	ts: string;
	threadTs?: string;
	text: string;
	sender: { id: string; name?: string };
	subtype?: string;
	botId?: string;
	occurredAt: string;
}

function shouldSkip(input: SlackMonitorFanoutInput): boolean {
	if (input.subtype && SKIP_SUBTYPES.has(input.subtype)) {
		return true;
	}
	if (input.botId) {
		return true;
	}
	return false;
}

function workflowIdForProject(
	projectId: string,
	override: string | null | undefined,
): string {
	if (override && override.length > 0) {
		return override;
	}
	return `${SLACK_MONITOR_WORKFLOW_PREFIX}${projectId}`;
}

/**
 * Fan out a Slack inbound message to every project monitoring this channel.
 *
 * Best-effort signaling: a missing workflow (WorkflowNotFoundError) is logged
 * and skipped — the workflow may have been disabled mid-flight. Other errors
 * surface to the caller's try/catch.
 */
export async function fanoutSlackMonitorEvent(
	input: SlackMonitorFanoutInput,
): Promise<{ signaled: number; skipped: number }> {
	if (shouldSkip(input)) {
		return { signaled: 0, skipped: 1 };
	}

	// Look up every project monitoring this channel. The schema places a
	// composite index on (channelId, slackTeamId) for exactly this lookup.
	const linkedRows = await db.projectLinkedSlackChannel.findMany({
		where: {
			slackTeamId: input.slackTeamId,
			channelId: input.channelId,
			monitorEnabled: true,
		},
		select: {
			projectId: true,
			project: { select: { slackChannelMonitorWorkflowId: true } },
		},
	});

	if (linkedRows.length === 0) {
		return { signaled: 0, skipped: 0 };
	}

	const occurredAt = (() => {
		// `ts` is Slack's `seconds.microseconds` — convert to ISO if numeric;
		// otherwise pass through (caller may have already passed an ISO string).
		const num = Number.parseFloat(input.ts);
		if (Number.isFinite(num) && num > 0) {
			return new Date(num * 1000).toISOString();
		}
		return input.ts;
	})();

	const payload: SlackMonitorSignalPayload = {
		channelId: input.channelId,
		externalEventId: input.externalEventId,
		ts: input.ts,
		threadTs:
			input.threadId && input.threadId.length > 0
				? input.threadId
				: undefined,
		text: input.text,
		sender: input.sender,
		subtype: input.subtype,
		botId: input.botId,
		occurredAt,
	};

	const client = await getTemporalClient();

	const results = await Promise.allSettled(
		linkedRows.map(async (row) => {
			const workflowId = workflowIdForProject(
				row.projectId,
				row.project.slackChannelMonitorWorkflowId,
			);
			const handle = client.workflow.getHandle(workflowId);
			await handle.signal("slackMessageReceived", payload);
			return { projectId: row.projectId, workflowId };
		}),
	);

	let signaled = 0;
	let skipped = 0;
	const fatalErrors: unknown[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (result.status === "fulfilled") {
			signaled += 1;
			continue;
		}
		// Workflow may have been disabled / completed / cancelled. Log and
		// skip so a single dead handle doesn't block fanout to others.
		const err = result.reason;
		const row = linkedRows[i];
		const workflowId = workflowIdForProject(
			row.projectId,
			row.project.slackChannelMonitorWorkflowId,
		);
		const name =
			err && typeof err === "object" && "name" in err
				? String((err as { name?: unknown }).name)
				: "";
		const isNotFound =
			name === "WorkflowNotFoundError" ||
			(err instanceof Error && /not found/i.test(err.message));
		if (isNotFound) {
			skipped += 1;
			console.warn("[channels:slack] monitor workflow not found", {
				workflowId,
				projectId: row.projectId,
			});
			continue;
		}
		console.error(
			"[channels:slack] monitor signal failed",
			{ workflowId, projectId: row.projectId },
			err,
		);
		fatalErrors.push(err);
	}

	// Surface the first non-NotFound failure so the caller's try/catch can
	// decide whether to retry the webhook. Trigger dispatch is unaffected
	// because the caller wraps us in its own try/catch.
	if (fatalErrors.length > 0) {
		throw fatalErrors[0];
	}

	return { signaled, skipped };
}

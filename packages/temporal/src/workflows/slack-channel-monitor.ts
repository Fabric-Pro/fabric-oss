/**
 * Slack Channel Monitor Workflow
 *
 * Long-running, signal-driven workflow that ingests messages from linked Slack
 * channels, runs them through the same `analyzeContextAndPropose` pipeline as
 * Teams, and persists `PendingBacklogProposal` rows for reviewer approval.
 *
 * Unlike `teamsChannelMonitorWorkflow` (which polls Graph on a fixed cadence),
 * this workflow is **event-driven** — the Slack Events webhook receiver in the
 * web app calls `signal("slackMessageReceived", payload)` for every dedupe'd
 * message bound for a monitored channel. The workflow batches signals via a
 * sliding debounce window, flushes per (channelId, threadKey) group, and hands
 * each batch to `analyzeSlackThreadActivity` which uses the seen-message
 * INSERT as the lock to dedupe concurrent live + backfill paths.
 *
 * Structure mirrors `teams-channel-monitor.ts` — `cancel` signal, progress
 * query, `continueAsNew` gated by `patched()`. Task queue: `"ai-chat"`.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules. No
 * `@repo/database` / `@repo/ai` / helper-package imports.
 */

import {
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	patched,
	proxyActivities,
	setHandler,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";
import type * as slackChannelMonitorActivities from "../activities/slack-channel-monitor";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

// =============================================================================
// Types
// =============================================================================

/**
 * Payload pushed in by the Slack Events webhook fanout (Track 3). One signal
 * per dedup'd inbound message. The workflow groups by `(channelId, threadKey)`
 * — replies are coalesced onto their thread root.
 */
export interface SlackMessageReceivedPayload {
	channelId: string;
	/** Slack-assigned event_id — used only for logging / tracing. */
	externalEventId: string;
	/** Slack `ts` of the message (zero-padded "seconds.microseconds"). */
	ts: string;
	/** Parent `thread_ts` when this message is a thread reply. */
	threadTs?: string | null;
	text: string;
	sender: string;
	/** Slack `subtype` field — used to filter edits/deletes/bot messages. */
	subtype?: string | null;
	/** Slack `bot_id` (xxxBxxxx). The own-bot filter compares against this. */
	botId?: string | null;
	/** ISO timestamp at which the webhook receiver observed this event. */
	occurredAt: string;
}

export interface SlackChannelMonitorInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** Debounce window in milliseconds. Defaults from Project row, fallback 30s. */
	debounceMs?: number;
	/** Hard cap on debounce extension to bound staleness. Defaults 5 min. */
	maxHoldMs?: number;
	/**
	 * Queue carried across `continueAsNew` boundaries so unflushed signals
	 * survive. Empty on initial start.
	 */
	pendingQueue?: SlackMessageReceivedPayload[];
}

export interface SlackChannelMonitorProgress {
	lastFlushAt: string | null;
	queueDepth: number;
	totalSignalsReceived: number;
	totalGroupsFlushed: number;
	totalProposalsCreated: number;
	totalSkippedAlreadySeen: number;
	totalFailures: number;
	totalSignalsDropped: number;
	isFlushing: boolean;
	cancelled: boolean;
}

/**
 * Hard cap on the in-memory signal queue. A chatty channel during a
 * maxHold window or worker outage can otherwise accumulate unboundedly,
 * and `continueAsNew` carries the queue across boundaries via the payload
 * which has a 2MB Temporal limit. When the cap is hit the oldest entry is
 * dropped so the newest signal still lands.
 */
const MAX_QUEUE_SIZE = 1000;

// =============================================================================
// Signals & Queries
// =============================================================================

export const slackMessageReceivedSignal = defineSignal<
	[SlackMessageReceivedPayload]
>("slackMessageReceived");
export const cancelSlackChannelMonitorSignal = defineSignal(
	"cancelSlackChannelMonitor",
);
export const slackChannelMonitorProgressQuery =
	defineQuery<SlackChannelMonitorProgress>("slackChannelMonitorProgress");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof slackChannelMonitorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
		nonRetryableErrorTypes: [
			"ValidationError",
			"TenantViolation",
			...AI_NON_RETRYABLE_ERROR_TYPES,
		],
	},
});

// =============================================================================
// Filtering (defense-in-depth; webhook fanout also filters)
// =============================================================================

/**
 * Returns true when the payload should be dropped before queueing — covers
 * edits, deletes, bot messages, and empty-text bodies (no attachments info
 * surfaces here, so anything without text is treated as un-analyzable).
 */
function shouldDropPayload(payload: SlackMessageReceivedPayload): boolean {
	const subtype = payload.subtype ?? null;
	if (
		subtype === "message_changed" ||
		subtype === "message_deleted" ||
		subtype === "bot_message"
	) {
		return true;
	}
	if (payload.botId) {
		// Webhook fanout already filters the workspace's own bot; treat any
		// bot_id-tagged event as a feedback-loop risk and drop conservatively.
		return true;
	}
	if (!payload.text || payload.text.trim().length === 0) {
		return true;
	}
	return false;
}

// =============================================================================
// Workflow
// =============================================================================

export async function slackChannelMonitorWorkflow(
	input: SlackChannelMonitorInput,
): Promise<void> {
	const {
		projectId,
		userId,
		organizationId,
		debounceMs = 30_000,
		maxHoldMs = 300_000,
		pendingQueue = [],
	} = input;

	// In-memory signal queue. Mutated only by the signal handler (deterministic
	// — signal handlers run on the workflow thread).
	const queue: SlackMessageReceivedPayload[] = [...pendingQueue];

	let cancelled = false;
	let totalSignalsReceived = pendingQueue.length;
	let totalGroupsFlushed = 0;
	let totalProposalsCreated = 0;
	let totalSkippedAlreadySeen = 0;
	let totalFailures = 0;
	let totalSignalsDropped = 0;
	let lastFlushAt: string | null = null;
	let isFlushing = false;

	// Tracks the wall-clock time of the most recent signal arrival inside a
	// debounce window. Used to "extend" the sleep when a new signal lands
	// before the window expires. Stored as a workflow timestamp via
	// `Date.now()` which Temporal proxies to deterministic time.
	let lastSignalAtMs = 0;
	let windowStartedAtMs = 0;

	setHandler(slackMessageReceivedSignal, (payload) => {
		totalSignalsReceived++;
		if (shouldDropPayload(payload)) {
			return;
		}
		if (queue.length >= MAX_QUEUE_SIZE) {
			// Drop oldest. The newest signal is the more useful one to keep
			// (chatty channels with stale tail entries are the failure mode).
			queue.shift();
			totalSignalsDropped++;
		}
		queue.push(payload);
		lastSignalAtMs = Date.now();
		if (windowStartedAtMs === 0) {
			windowStartedAtMs = lastSignalAtMs;
		}
	});

	setHandler(cancelSlackChannelMonitorSignal, () => {
		cancelled = true;
	});

	setHandler(slackChannelMonitorProgressQuery, () => ({
		lastFlushAt,
		queueDepth: queue.length,
		totalSignalsReceived,
		totalGroupsFlushed,
		totalProposalsCreated,
		totalSkippedAlreadySeen,
		totalFailures,
		totalSignalsDropped,
		isFlushing,
		cancelled,
	}));

	while (!cancelled) {
		// Step 1: wait for the queue to become non-empty (or for cancel).
		await condition(() => queue.length > 0 || cancelled);

		if (cancelled && queue.length === 0) {
			break;
		}

		// Reset the debounce-extension trackers at the start of a fresh window.
		if (windowStartedAtMs === 0) {
			windowStartedAtMs = Date.now();
			lastSignalAtMs = windowStartedAtMs;
		}

		// Step 2: sleep the debounce window. On every wake, check whether
		// a newer signal landed and extend the window — but never beyond
		// `maxHoldMs` from the original window start.
		let flushReady = false;
		while (!flushReady) {
			if (cancelled) {
				break;
			}
			const now = Date.now();
			const windowAge = now - windowStartedAtMs;
			if (windowAge >= maxHoldMs) {
				// Hard cap — flush regardless of recent signals.
				flushReady = true;
				break;
			}
			const remainingHold = maxHoldMs - windowAge;
			const sinceLastSignal = now - lastSignalAtMs;
			const remainingDebounce = Math.max(0, debounceMs - sinceLastSignal);
			if (remainingDebounce === 0) {
				// Debounce satisfied — flush.
				flushReady = true;
				break;
			}
			// Sleep for the shorter of the two remaining intervals.
			const sleepMs = Math.min(remainingDebounce, remainingHold);
			await sleep(sleepMs);
			// Loop iterates: if a signal arrived during sleep, lastSignalAtMs
			// is updated by the handler and the next iteration will extend.
		}

		// Step 3: drain the queue and group by (channelId, threadKey).
		isFlushing = true;
		const drained = queue.splice(0, queue.length);
		windowStartedAtMs = 0;
		lastSignalAtMs = 0;

		// Group payloads by (channelId, threadKey). threadKey collapses thread
		// replies onto their root so we make a single analyze call per thread.
		const groups = new Map<string, SlackMessageReceivedPayload[]>();
		for (const payload of drained) {
			const threadKey = payload.threadTs ?? payload.ts;
			const key = `${payload.channelId}::${threadKey}`;
			const existing = groups.get(key);
			if (existing) {
				existing.push(payload);
			} else {
				groups.set(key, [payload]);
			}
		}

		// Step 4: per-group analyze. Each call is its own activity invocation
		// so failures are isolated. The activity uses INSERT-as-lock on the
		// seen-message table to dedupe concurrent live + backfill paths.
		//
		// Note: we do NOT short-circuit on `cancelled` inside this loop —
		// the plan says "cancel drains the queue once, then exits". Letting
		// the in-flight groups complete preserves analyses for messages that
		// already passed the dedup boundary.
		for (const [, payloads] of groups) {
			totalGroupsFlushed++;

			// Use the earliest-ts payload in the group as the root reference.
			// In a thread, the root is the one whose `threadTs` is undefined
			// OR whose `ts === threadTs`. Fall back to lex-min `ts` otherwise.
			const root =
				payloads.find((p) => !p.threadTs || p.threadTs === p.ts) ??
				payloads.reduce((acc, p) => (p.ts < acc.ts ? p : acc));
			const threadRootTs = root.threadTs ?? root.ts;
			const channelId = root.channelId;

			try {
				const result = await activities.analyzeSlackThreadActivity({
					projectId,
					userId,
					organizationId,
					channelId,
					threadRootTs,
					// Pass through the signal-payload sender hint so the
					// activity can label the formatted thread when Slack's
					// `conversations.replies` call fails partway.
					triggerSender: root.sender,
					triggerSubtype: root.subtype ?? undefined,
					// Debugging context for logs / audit only.
					triggerEventIds: payloads.map((p) => p.externalEventId),
				});

				if (result.success && result.pendingProposalId) {
					totalProposalsCreated++;
				} else if (
					result.success &&
					result.skippedReason === "already_seen"
				) {
					totalSkippedAlreadySeen++;
				}
			} catch (err) {
				totalFailures++;
				const errorMessage =
					err instanceof Error ? err.message : String(err);
				// Failure-recording activity has its own retry policy; let
				// it propagate rather than swallowing nested errors. Per-
				// group analyze failures stay isolated (no rethrow below).
				await activities.recordSlackChannelFailureForKeyActivity({
					projectId,
					channelId,
					errorMessage,
				});
			}
		}

		// Stamp project-level last-run timestamp (non-fatal).
		try {
			await activities.updateSlackChannelMonitorLastRunActivity({
				projectId,
			});
		} catch {
			// Non-fatal.
		}

		lastFlushAt = new Date().toISOString();
		isFlushing = false;

		// Step 5: continueAsNew when the server suggests it. Gated by
		// `patched()` so in-flight executions started before this gate replay
		// deterministically. Pass the (now-empty, but possibly populated by
		// signals that arrived after drain) queue across the boundary.
		const info = workflowInfo();
		const shouldContinueAsNew = patched(
			"slack-monitor-can-suggested-2026-05",
		)
			? info.continueAsNewSuggested
			: info.historyLength >= 5000;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof slackChannelMonitorWorkflow>({
				projectId,
				userId,
				organizationId,
				debounceMs,
				maxHoldMs,
				pendingQueue: queue.slice(),
			});
		}
	}
}

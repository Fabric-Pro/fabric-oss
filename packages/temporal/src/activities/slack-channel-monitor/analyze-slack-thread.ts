/**
 * Slack Channel Monitor — per-thread LLM analysis activity.
 *
 * Mirrors `analyze-channel-messages.ts` (Teams) closely:
 *  1. Resolve the linked-channel row (provides slackTeamId + names).
 *  2. Fetch the full thread via `conversations.replies` (separate activity).
 *  3. Format the thread into the snapshot the analyzer and capture both read.
 *  4. Capture the conversation as a durable bundle row (Fizzy #2228).
 *  5. Claim the thread root via INSERT-as-lock on the seen-message table.
 *     If the row already exists, return early with `skippedReason: 'already_seen'`
 *     and NEVER call the LLM — this is how concurrent live + backfill paths
 *     dedupe on the same thread.
 *  6. Load the flat project backlog (60s TTL cache, shared with Teams).
 *  7. Call `analyzeContextAndPropose()` — same LLM helper Teams uses.
 *  8. On a non-empty proposal, persist `PendingBacklogProposal` with
 *     `source: SLACK_CHANNEL`, then update the seen-message row with the
 *     proposal id.
 *
 * Steps 2 and 5 used to be the other way round. The claim is what makes a
 * re-analyzed thread a no-op, and a no-op that skipped capture is how a
 * monitored channel's content went missing — so capture had to precede the
 * claim, and it needs the fetched text, which moved the fetch out of the lock
 * with it. See the note at the call site.
 *
 * Activity policy is set on the workflow side via `proxyActivities`. Errors
 * propagate so Temporal retries (default 3 attempts) and the workflow's
 * per-group catch records `consecutiveFailures` + `lastErrorMessage`.
 */

import {
	attachProposalToSeenSlackMessage,
	claimSlackMessageForAnalysis,
	createPendingBacklogProposal,
	db,
	getLinkedSlackChannelsForMonitor,
} from "@repo/database";
import type {
	AttachmentWarning,
	PendingAttachmentRef,
} from "@repo/integrations";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { captureChannelConversationBundle } from "../../lib/capture-conversation-bundle";
import {
	analyzeContextAndPropose,
	type ChangeProposal,
} from "../backlog-context/analyze-context";
import { getCachedProjectBacklog } from "../backlog-context/project-backlog-cache";
import {
	JOB_SOURCE,
	JOB_STEPS,
	jobEnsure,
	jobIncrement,
	jobStep,
	seedJobSteps,
} from "../lib/job-progress";
import {
	fetchSlackThreadContextActivity,
	type SlackThreadMessage,
} from "./fetch-thread-context";

// =============================================================================
// Types
// =============================================================================

export interface AnalyzeSlackThreadInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** Slack channel id (Cxxxx or Gxxxx). */
	channelId: string;
	/**
	 * Slack `thread_ts` of the thread root. For single-message "threads"
	 * (no replies) callers pass the message's own `ts`.
	 */
	threadRootTs: string;
	/**
	 * Pre-resolved linked-channel id. When omitted, the activity looks up
	 * the row via `(projectId, channelId)`. Pass-through avoids one round
	 * trip in the hot path (workflow signal flush).
	 */
	linkedChannelId?: string;
	/**
	 * Pre-resolved workspace id. When provided alongside `linkedChannelId`,
	 * `channelDisplayName`, and `channelWebUrl`, the activity skips the
	 * linked-channel DB lookup entirely (backfill path passes all four).
	 */
	slackTeamId?: string;
	/** Pre-resolved channel display name for context formatting. */
	channelDisplayName?: string;
	/** Optional Slack archive URL for the channel (used in sourceMetadata). */
	channelWebUrl?: string;
	/** Optional sender of the triggering message (logging only). */
	triggerSender?: string;
	/** Optional subtype of the triggering message (logging only). */
	triggerSubtype?: string;
	/** Slack event_ids that triggered this analyze call (logging only). */
	triggerEventIds?: string[];
}

export interface AnalyzeSlackThreadOutput {
	success: boolean;
	pendingProposalId?: string;
	changeCount: number;
	/** Set when the analyze was a deliberate no-op. */
	skippedReason?:
		| "already_seen"
		| "no_relevant_content"
		| "no_linked_channel";
	error?: string;
	/**
	 * Sidecar from `fetchSlackThreadContextActivity` — image refs extracted
	 * from the thread, filtered to `SUPPORTED_ATTACHMENT_MIMES`. Persisted
	 * onto `PendingBacklogProposal.sourceMetadata.attachments` and consumed
	 * at approval time by `attachPendingMediaToStory`. NOT threaded into the
	 * analyzer LLM prompt (spec FR-4).
	 */
	pendingAttachments: PendingAttachmentRef[];
	/**
	 * Sidecar warnings collected at fetch time (e.g. `unsupported_mime` for
	 * SVG files). The apply-time orchestrator appends more later. Persisted
	 * onto `PendingBacklogProposal.sourceMetadata.attachmentWarnings`.
	 */
	attachmentWarnings: AttachmentWarning[];
}

// =============================================================================
// Constants
// =============================================================================

const THREAD_ANALYSIS_USER_PROMPT = `The context below is a Slack channel discussion (one thread with all replies). Analyze it and propose backlog changes — features or bugs — that the discussion implies.

A single thread typically yields zero or one proposal. Only split into multiple if the thread clearly covers distinct, unrelated needs. Ignore social chatter, status updates, and off-topic tangents.

Keep each proposal concise: a short title and brief reasoning citing the discussion. Description and acceptance criteria can be minimal — they will be refined later.`;

// =============================================================================
// Formatter
// =============================================================================

/**
 * Render a Slack thread (root + replies) as a single conversational block.
 * Shape mirrors `formatTeamsThreadForBacklog` so the analysis LLM sees a
 * consistent format across providers.
 */
export function formatSlackThreadForBacklog(
	messages: SlackThreadMessage[],
	channelDisplayName: string,
	threadRootTs: string,
): string {
	if (messages.length === 0) {
		return `## Thread in #${channelDisplayName} — (no messages fetched, ts=${threadRootTs})`;
	}
	const root = messages[0];
	const lines: string[] = [];
	lines.push(
		`## Thread in #${channelDisplayName} — started ${root.createdAt} by ${root.sender}`,
	);
	lines.push("");
	lines.push(`**${root.sender}**: ${root.content}`);
	for (let i = 1; i < messages.length; i++) {
		const reply = messages[i];
		lines.push(
			`  ↳ **${reply.sender}** (${reply.createdAt}): ${reply.content}`,
		);
	}
	return lines.join("\n");
}

// =============================================================================
// Internal: resolve linked channel row
// =============================================================================

async function resolveLinkedChannel(params: {
	projectId: string;
	channelId: string;
	linkedChannelId?: string;
	slackTeamId?: string;
	channelDisplayName?: string;
	channelWebUrl?: string;
}): Promise<{
	linkedChannelId: string;
	slackTeamId: string;
	channelDisplayName: string;
	channelName: string | null;
	channelWebUrl: string | null;
} | null> {
	if (
		params.linkedChannelId &&
		params.slackTeamId &&
		params.channelDisplayName !== undefined &&
		params.channelWebUrl !== undefined
	) {
		// Fully pre-resolved by caller (backfill path) — no DB round trip.
		return {
			linkedChannelId: params.linkedChannelId,
			slackTeamId: params.slackTeamId,
			channelDisplayName: params.channelDisplayName,
			channelName: params.channelDisplayName,
			channelWebUrl: params.channelWebUrl,
		};
	}
	if (
		params.linkedChannelId &&
		params.channelDisplayName !== undefined &&
		params.channelWebUrl !== undefined
	) {
		// Partially pre-resolved — only need slackTeamId.
		const row = await db.projectLinkedSlackChannel.findUnique({
			where: { id: params.linkedChannelId },
			select: {
				id: true,
				slackTeamId: true,
				channelName: true,
				channelWebUrl: true,
			},
		});
		if (!row) {
			return null;
		}
		return {
			linkedChannelId: row.id,
			slackTeamId: row.slackTeamId,
			channelDisplayName: params.channelDisplayName,
			channelName: row.channelName,
			channelWebUrl: row.channelWebUrl,
		};
	}
	// Workflow-driven path: look up by (projectId, channelId).
	const channels = await getLinkedSlackChannelsForMonitor(params.projectId);
	const match = channels.find((c) => c.channelId === params.channelId);
	if (!match) {
		return null;
	}
	return {
		linkedChannelId: match.id,
		slackTeamId: match.slackTeamId,
		channelDisplayName:
			params.channelDisplayName ??
			match.channelName ??
			match.teamName ??
			"channel",
		channelName: match.channelName,
		channelWebUrl: match.channelWebUrl ?? params.channelWebUrl ?? null,
	};
}

// =============================================================================
// Activity
// =============================================================================

export async function analyzeSlackThreadActivity(
	input: AnalyzeSlackThreadInput,
): Promise<AnalyzeSlackThreadOutput> {
	const {
		projectId,
		userId,
		organizationId,
		channelId,
		threadRootTs,
		triggerEventIds,
	} = input;

	logger.info("[SlackChannelMonitor] Analyzing thread", {
		projectId,
		channelId,
		threadRootTs,
		triggerEventIds,
	});

	// Step 1: resolve the linked-channel row (provides slackTeamId + names).
	const linked = await resolveLinkedChannel({
		projectId,
		channelId,
		linkedChannelId: input.linkedChannelId,
		slackTeamId: input.slackTeamId,
		channelDisplayName: input.channelDisplayName,
		channelWebUrl: input.channelWebUrl,
	});
	if (!linked) {
		logger.warn(
			"[SlackChannelMonitor] No linked Slack channel for project — skipping",
			{ projectId, channelId },
		);
		return {
			success: true,
			changeCount: 0,
			skippedReason: "no_linked_channel",
			pendingAttachments: [],
			attachmentWarnings: [],
		};
	}

	// Job Hub: the first thread of a flush opens this channel's job row.
	// Opening here — not at flush start — keeps signal-less flushes from
	// filling the panel with empty runs.
	await jobEnsure({
		kind: "SLACK_CHANNEL_MONITOR",
		title: `Slack · #${linked.channelDisplayName}`,
		projectId,
		userId,
		organizationId,
		sourceType: JOB_SOURCE.slackLinkedChannel,
		sourceId: linked.linkedChannelId,
		steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
	});
	await jobStep("fetch", "completed", { sourceId: linked.linkedChannelId });
	await jobStep("analyze", "running", { sourceId: linked.linkedChannelId });

	try {
		// Step 2: fetch the full thread via conversations.replies.
		//
		// This USED to sit after the claim below. Capture has to run before the
		// claim — the claim is what makes a re-analyzed thread a no-op, and a
		// no-op that skips capture is how content went missing — and capture
		// needs the fetched text, so the fetch moved out of the lock with it
		// (Fizzy #2228).
		//
		// The cost is real and accepted: two workers racing one thread now both
		// fetch before either wins the claim, so Slack sees a duplicate read and
		// the two may hold different snapshots. The per-message claim inside
		// capture is what makes that safe — they end up with disjoint claim sets
		// whatever each of them fetched. The claim-as-lock below keeps protecting
		// exactly what it was written to protect: the analyzer and proposal work,
		// never the capture.
		heartbeat("fetching thread context");
		const thread = await fetchSlackThreadContextActivity({
			userId,
			organizationId,
			slackTeamId: linked.slackTeamId,
			channelId,
			threadRootTs,
		});

		// Step 3: form the snapshot.
		const formatted = formatSlackThreadForBacklog(
			thread.messages,
			linked.channelDisplayName,
			threadRootTs,
		);

		// Step 4: capture the conversation, ahead of the claim and therefore
		// ahead of every branch that returns without proposing anything.
		//
		// Not wrapped in its own try/catch: a failure inside the capture
		// transaction rolls its message claims back, so the Temporal retry
		// re-claims the same messages and writes the bundle it was going to
		// write. Swallowing it would leave claims committed with no bundle, and
		// the retry would then compute an empty claim set.
		heartbeat("capturing conversation bundle");
		await captureChannelConversationBundle({
			channel: { provider: "SLACK", channelId },
			projectId,
			userId,
			organizationId,
			channelDisplayName: linked.channelDisplayName,
			providerThreadId: threadRootTs,
			messages: thread.messages.map((message) => ({
				providerMessageId: message.ts,
				author: message.sender,
				createdAt: message.createdAt,
				content: message.content,
			})),
		});

		// Step 5: INSERT-as-lock claim BEFORE the LLM call. Concurrent live +
		// backfill paths race here — only the inserter proceeds.
		heartbeat("claiming thread root");
		const claimed = await claimSlackMessageForAnalysis(
			linked.linkedChannelId,
			threadRootTs,
		);
		if (!claimed) {
			logger.info(
				"[SlackChannelMonitor] Thread already claimed — skipping",
				{ projectId, channelId, threadRootTs },
			);
			await jobIncrement(
				{ groupsFlushed: 1, skippedAlreadySeen: 1 },
				linked.linkedChannelId,
			);
			await jobStep("analyze", "completed", {
				sourceId: linked.linkedChannelId,
			});
			return {
				success: true,
				changeCount: 0,
				skippedReason: "already_seen",
				pendingAttachments: thread.pendingAttachments,
				attachmentWarnings: thread.attachmentWarnings,
			};
		}

		// Step 6: load the flat project backlog (TTL-cached).
		heartbeat("fetching project backlog");
		const existingBacklog = await getCachedProjectBacklog(projectId);

		heartbeat("calling analyzeContextAndPropose");
		const proposal: ChangeProposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext: {
				slackMessages: formatted,
			},
			existingBacklog,
			userPrompt: THREAD_ANALYSIS_USER_PROMPT,
			// Bug 1429: the channel-monitor feature-proposal flow only supports
			// feature/bug. `epic` is not a valid proposal type here, so forbid
			// the analyzer from emitting it (the apply/approve paths normalize
			// any already-stored epic proposal to feature).
			allowEpics: false,
			// Capture-as-is: the ANALYZER only creates new work items — it never
			// suggests updating/merging off the truncated backlog listing in its
			// prompt, which is what made its update suggestions unreliable.
			allowUpdates: false,
			// Enrichment is decided afterwards by the semantic routing pass, which
			// applies the project's own opt-in.
			allowRouting: true,
		});

		if (proposal.changes.length === 0) {
			// Seen-marker is already in place from the claim. Nothing more to do.
			logger.info(
				"[SlackChannelMonitor] Thread had no relevant content",
				{
					projectId,
					channelId,
					threadRootTs,
				},
			);
			await jobIncrement(
				{ groupsFlushed: 1, emptyThreads: 1 },
				linked.linkedChannelId,
			);
			await jobStep("analyze", "completed", {
				sourceId: linked.linkedChannelId,
			});
			return {
				success: true,
				changeCount: 0,
				skippedReason: "no_relevant_content",
				pendingAttachments: thread.pendingAttachments,
				attachmentWarnings: thread.attachmentWarnings,
			};
		}

		// Step 7: persist the proposal + link the seen-row to it.
		// `attachments` + `attachmentWarnings` carry the fetch-time image refs
		// for the apply-time orchestrator. Existing keys are preserved via
		// the explicit object below — readers that don't know about the new
		// keys keep working (FR-5, FR-27 backward compat).
		const sourceMetadata = {
			slackTeamId: linked.slackTeamId,
			channelId,
			channelName: linked.channelName,
			channelWebUrl: linked.channelWebUrl,
			threadTs: threadRootTs,
			messageCount: thread.messages.length,
			transcript: formatted,
			attachments: thread.pendingAttachments,
			attachmentWarnings: thread.attachmentWarnings,
		};
		const proposalJson = JSON.parse(JSON.stringify(proposal));
		const sourceMetadataJson = JSON.parse(JSON.stringify(sourceMetadata));

		const pending = await createPendingBacklogProposal({
			projectId,
			source: "SLACK_CHANNEL",
			proposal: proposalJson,
			summary: proposal.summary,
			changeCount: proposal.changes.length,
			sourceMetadata: sourceMetadataJson,
			// Fold any decision-precheck findings that rode along on the proposal
			// into `sourceMetadata.decisionPrecheck` so the review inbox reads them
			// back durably. Undefined (flag off / no conflicts) is a no-op merge.
			decisionPrecheck: proposalJson.decisionConflicts,
			userId,
			organizationId,
		});

		await attachProposalToSeenSlackMessage(
			linked.linkedChannelId,
			threadRootTs,
			pending.id,
		);

		logger.info("[SlackChannelMonitor] Pending proposal created", {
			projectId,
			channelId,
			threadRootTs,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
			attachmentCount: thread.pendingAttachments.length,
			attachmentWarningCount: thread.attachmentWarnings.length,
		});

		await jobIncrement(
			{ groupsFlushed: 1, proposalsCreated: 1 },
			linked.linkedChannelId,
		);
		await jobStep("analyze", "completed", {
			sourceId: linked.linkedChannelId,
		});
		await jobStep("propose", "completed", {
			sourceId: linked.linkedChannelId,
		});

		return {
			success: true,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
			pendingAttachments: thread.pendingAttachments,
			attachmentWarnings: thread.attachmentWarnings,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[SlackChannelMonitor] Analyze thread failed", {
			error: errorMessage,
			projectId,
			channelId,
			threadRootTs,
		});
		await jobStep("analyze", "failed", {
			sourceId: linked.linkedChannelId,
			error: errorMessage,
		});
		// Rethrow so Temporal retries; the seen-marker stays in place because
		// the lock is not transactional with the LLM/proposal write. That's
		// intentional: a permanently-failing thread should not loop forever.
		throw error;
	}
}

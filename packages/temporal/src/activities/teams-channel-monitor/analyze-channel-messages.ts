/**
 * Teams Channel Monitor — per-thread LLM analysis activity.
 *
 * For each mature thread (root message + quiet-window-idle replies), build a
 * single conversational block, run the existing `analyzeContextAndPropose`
 * LLM call, and persist either:
 *   - a `PendingBacklogProposal` anchored to the thread (when LLM returns
 *     one or more changes), or
 *   - just a seen-message marker (when the thread has no relevant content).
 *
 * Cursor advance + dedup markers + proposal insert all happen after the LLM
 * call returns, so retries are bounded to Temporal's default 3 attempts.
 */

import {
	db,
	markTeamsMessagesAsSeen,
	resolveProposalSummary,
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
import type { FetchedThread } from "./fetch-new-messages";

// =============================================================================
// Types
// =============================================================================

export interface AnalyzeChannelThreadInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	linkedChannelId: string;
	/**
	 * Microsoft Graph team id (NOT the DB `linkedChannelId` cuid). Required
	 * by the apply-time orchestrator to build the
	 * `/teams/{teamId}/channels/{channelId}/messages/...` URL when
	 * downloading hostedContents. Persisted on
	 * `PendingBacklogProposal.sourceMetadata.teamId`.
	 */
	teamId: string;
	/**
	 * Microsoft Graph channel id (e.g. `19:abc@thread.tacv2`). Persisted on
	 * `PendingBacklogProposal.sourceMetadata.channelId`. Distinct from
	 * `linkedChannelId` which is the DB-side cuid of the linked-channel row.
	 */
	channelId: string;
	thread: FetchedThread;
	channelDisplayName: string;
	channelWebUrl?: string;
}

export interface AnalyzeChannelThreadOutput {
	success: boolean;
	pendingProposalId?: string;
	changeCount: number;
	/** Set when we deliberately skipped persisting a proposal (e.g. zero changes). */
	skippedReason?: string;
	error?: string;
	/**
	 * Sidecar — image refs flattened from `thread.pendingAttachments` (root +
	 * replies). Persisted into `PendingBacklogProposal.sourceMetadata.attachments`
	 * for consumption by the apply-time orchestrator. NOT threaded into the
	 * LLM analyzer prompt (FR-9 / spec § 4.4).
	 */
	pendingAttachments: PendingAttachmentRef[];
	/**
	 * Sidecar warnings collected at fetch time. The apply-time orchestrator
	 * appends more warnings later (size cap, download failures, etc.); this
	 * carries only the fetch-time skip reasons (currently none — the Teams
	 * parser is silent on malformed-HTML drops per decisions § 12). Mirrors
	 * the Slack activity output for symmetry.
	 */
	attachmentWarnings: AttachmentWarning[];
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Semantic guidance for the thread-level extraction pass.
 *
 * Keep this focused on WHAT to look for, not HOW to format — the
 * ChangeProposalSchema (with its {from, to} title/description shapes)
 * is provided by generateObject and handles formatting.
 */
const THREAD_ANALYSIS_USER_PROMPT = `The context below is a Microsoft Teams channel discussion (one thread with all replies). Analyze it and propose backlog changes — features or bugs — that the discussion implies.

A single thread typically yields zero or one proposal. Only split into multiple if the thread clearly covers distinct, unrelated needs. Ignore social chatter, status updates, and off-topic tangents.

Keep each proposal concise: a short title and brief reasoning citing the discussion. Description and acceptance criteria can be minimal — they will be refined later.`;

// =============================================================================
// Formatter
// =============================================================================

/**
 * Format a Teams thread (root message + replies) as a single conversational
 * block for LLM analysis. Exported for reuse if the on-demand backlog path
 * later wants the same thread-aware representation.
 *
 * Shape:
 *   ## Thread in #<channel> — started <iso> by <author>
 *
 *   **<author>**: <rootContent>
 *     ↳ **<replyAuthor>** (<iso>): <replyContent>
 *     ↳ ...
 */
export function formatTeamsThreadForBacklog(
	thread: FetchedThread,
	channelDisplayName: string,
): string {
	const lines: string[] = [];
	lines.push(
		`## Thread in #${channelDisplayName} — started ${thread.rootCreatedAt} by ${thread.rootAuthor}`,
	);
	lines.push("");
	lines.push(`**${thread.rootAuthor}**: ${thread.rootContent}`);
	for (const reply of thread.replies) {
		lines.push(
			`  ↳ **${reply.author}** (${reply.createdAt}): ${reply.content}`,
		);
	}
	return lines.join("\n");
}

// =============================================================================
// Activity
// =============================================================================

/**
 * Run the one-thread-per-LLM-call extraction pass.
 *
 * On zero-change output: insert a seen-message marker and advance the cursor
 * so the noisy thread is never re-analyzed.
 *
 * On one-or-more-change output: insert a `PendingBacklogProposal`, a seen
 * marker pointing at the proposal, and advance the cursor.
 *
 * Note: the existing DB helpers are not transaction-aware; they each open
 * their own Prisma client call. Full atomicity is not required here because
 * the seen-message marker alone is sufficient to prevent duplicate proposals
 * on retry — createPendingBacklogProposal is idempotent enough given the
 * seen-message pre-check in the fetch activity.
 */
export async function analyzeChannelThreadActivity(
	input: AnalyzeChannelThreadInput,
): Promise<AnalyzeChannelThreadOutput> {
	const {
		projectId,
		userId,
		organizationId,
		linkedChannelId,
		teamId,
		channelId,
		thread,
		channelDisplayName,
		channelWebUrl,
	} = input;

	logger.info("[TeamsChannelMonitor] Analyzing channel thread", {
		projectId,
		linkedChannelId,
		threadRootId: thread.rootMessageId,
		replyCount: thread.replies.length,
		channelDisplayName,
	});

	// Job Hub: the first analyzed thread opens this channel's job row for the
	// tick. Opening here — rather than at tick start — is what keeps ticks that
	// find nothing from filling the panel with empty runs.
	await jobEnsure({
		kind: "TEAMS_CHANNEL_MONITOR",
		title: `Teams · ${channelDisplayName}`,
		projectId,
		userId,
		organizationId,
		sourceType: JOB_SOURCE.teamsLinkedChannel,
		sourceId: linkedChannelId,
		steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
	});
	await jobStep("fetch", "completed", { sourceId: linkedChannelId });
	await jobStep("analyze", "running", { sourceId: linkedChannelId });

	try {
		// Step 1: Fetch the existing flat backlog (TTL-cached across threads in the same tick).
		heartbeat("fetching project backlog");
		const existingBacklog = await getCachedProjectBacklog(projectId);

		// Step 2: Format thread + invoke the existing LLM analysis.
		const formatted = formatTeamsThreadForBacklog(
			thread,
			channelDisplayName,
		);

		// Step 2b: Capture the conversation BEFORE the analyzer runs, so it
		// happens on both branches of the analyzer's outcome (Fizzy #2228).
		// The zero-change branch below is where this channel's content used to
		// disappear entirely: the transcript only ever survived inside a
		// PendingBacklogProposal, and that branch writes none. Placing capture
		// here — rather than duplicating it into each branch — is what makes
		// the guarantee independent of what the LLM decided.
		//
		// Not wrapped in its own try/catch on purpose. A failure inside the
		// capture transaction rolls its message claims back, so the Temporal
		// retry re-claims the same messages and writes the bundle it was going
		// to write. Swallowing it would leave the claims committed with no
		// bundle, and the retry would then compute an empty claim set — losing
		// exactly the content this exists to keep.
		heartbeat("capturing conversation bundle");
		await captureChannelConversationBundle({
			channel: { provider: "MICROSOFT_TEAMS", teamId, channelId },
			projectId,
			userId,
			organizationId,
			channelDisplayName,
			providerThreadId: thread.rootMessageId,
			messages: [
				{
					providerMessageId: thread.rootMessageId,
					author: thread.rootAuthor,
					createdAt: thread.rootCreatedAt,
					content: thread.rootContent,
				},
				...thread.replies.map((reply) => ({
					providerMessageId: reply.messageId,
					author: reply.author,
					createdAt: reply.createdAt,
					content: reply.content,
				})),
			],
		});

		heartbeat("calling analyzeContextAndPropose");
		const proposal: ChangeProposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext: {
				teamsMessages: formatted,
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

		// Flatten root + reply image-attachment refs into a single sidecar
		// list (chat-thread image-attachments feature, FR-9 / spec § 4.4).
		// The fetch activity already populates these; we just project them
		// here for persistence into `sourceMetadata.attachments`.
		const pendingAttachments: PendingAttachmentRef[] = [
			...(thread.pendingAttachments ?? []),
		];
		// Fetch-time warnings — currently always empty for Teams; reserved
		// for future fetch-time skip reasons. Mirrors the Slack contract.
		const attachmentWarnings: AttachmentWarning[] = [];

		// Step 3a: Zero-change thread → seen marker only (cursor is advanced
		// by the workflow after all threads in a channel are processed).
		if (proposal.changes.length === 0) {
			await markTeamsMessagesAsSeen(
				linkedChannelId,
				[thread.rootMessageId],
				null,
			);
			await jobIncrement(
				{ threadsAnalyzed: 1, emptyThreads: 1 },
				linkedChannelId,
			);
			await jobStep("analyze", "completed", {
				sourceId: linkedChannelId,
			});
			return {
				success: true,
				changeCount: 0,
				skippedReason: "no_relevant_content",
				pendingAttachments,
				attachmentWarnings,
			};
		}

		// Step 3b: Atomically claim the thread AND insert the proposal in a
		// single DB transaction. The seen-marker acts as an idempotency fence
		// (first writer wins on the unique constraint), and if the proposal
		// insert fails the claim rolls back so retries can succeed.
		//
		// `attachments` + `attachmentWarnings` carry the fetch-time image refs
		// for the apply-time orchestrator. Existing keys are preserved via
		// the explicit object below — readers that don't know about the new
		// keys keep working (FR-10, FR-27 backward compat).
		const messageCount = 1 + thread.replies.length;
		const sourceMetadata = {
			linkedChannelId,
			// Microsoft Graph identifiers — required by the apply-time
			// orchestrator to build the hostedContents download URL
			// (`/teams/{teamId}/channels/{channelId}/messages/...`). Without
			// these, every Teams attachment fails with `download_failed` at
			// approve time (bug_001).
			teamId,
			channelId,
			channelDisplayName,
			channelWebUrl: channelWebUrl ?? null,
			threadRootId: thread.rootMessageId,
			threadRootWebLink: thread.rootWebLink ?? null,
			messageCount,
			threadLastActivity: thread.threadLastActivity,
			transcript: formatted,
			replies: thread.replies.map((reply) => ({
				messageId: reply.messageId,
				author: reply.author,
				createdAt: reply.createdAt,
				content: reply.content,
				webLink: reply.webLink ?? null,
			})),
			attachments: pendingAttachments,
			attachmentWarnings,
			// Fold any decision-precheck findings that rode along on the proposal
			// under `sourceMetadata.decisionPrecheck` so the review inbox reads
			// them back durably. Omitted when the flag is off / no conflicts.
			...(proposal.decisionConflicts
				? { decisionPrecheck: proposal.decisionConflicts }
				: {}),
		};

		const proposalJson = JSON.parse(JSON.stringify(proposal));
		const sourceMetadataJson = JSON.parse(JSON.stringify(sourceMetadata));

		const txResult = await db.$transaction(async (tx) => {
			const claim =
				await tx.projectLinkedTeamsChannelSeenMessage.createMany({
					data: [
						{
							linkedChannelId,
							messageId: thread.rootMessageId,
							pendingProposalId: null,
						},
					],
					skipDuplicates: true,
				});
			if (claim.count === 0) {
				return { claimed: false as const };
			}
			const pending = await tx.pendingBacklogProposal.create({
				data: {
					projectId,
					source: "TEAMS_CHANNEL",
					proposal: proposalJson,
					summary: resolveProposalSummary(
						proposal.summary,
						proposalJson,
					),
					changeCount: proposal.changes.length,
					sourceMetadata: sourceMetadataJson,
					userId,
					organizationId,
				},
			});
			await tx.projectLinkedTeamsChannelSeenMessage.updateMany({
				where: {
					linkedChannelId,
					messageId: thread.rootMessageId,
				},
				data: { pendingProposalId: pending.id },
			});
			return { claimed: true as const, pending };
		});

		if (!txResult.claimed) {
			await jobIncrement(
				{ threadsAnalyzed: 1, skippedAlreadySeen: 1 },
				linkedChannelId,
			);
			await jobStep("analyze", "completed", {
				sourceId: linkedChannelId,
			});
			return {
				success: true,
				changeCount: 0,
				skippedReason: "already_claimed",
				pendingAttachments,
				attachmentWarnings,
			};
		}
		const pending = txResult.pending;

		logger.info("[TeamsChannelMonitor] Pending proposal created", {
			projectId,
			linkedChannelId,
			threadRootId: thread.rootMessageId,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
			attachmentCount: pendingAttachments.length,
			attachmentWarningCount: attachmentWarnings.length,
		});

		await jobIncrement(
			{ threadsAnalyzed: 1, proposalsCreated: 1 },
			linkedChannelId,
		);
		await jobStep("analyze", "completed", { sourceId: linkedChannelId });
		await jobStep("propose", "completed", { sourceId: linkedChannelId });

		return {
			success: true,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
			pendingAttachments,
			attachmentWarnings,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[TeamsChannelMonitor] Analyze thread activity failed", {
			error: errorMessage,
			projectId,
			linkedChannelId,
			threadRootId: thread.rootMessageId,
		});
		await jobStep("analyze", "failed", {
			sourceId: linkedChannelId,
			error: errorMessage,
		});
		// Re-throw so Temporal retries (default 3 attempts) and the workflow's
		// per-channel catch records consecutiveFailures + lastErrorMessage.
		// We do NOT silently mark the thread seen — failures must stay visible.
		throw error;
	}
}

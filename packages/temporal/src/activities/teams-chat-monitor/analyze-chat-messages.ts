/**
 * Teams Chat Monitor — per-bundle LLM analysis activity.
 *
 * For each bundle of new chat messages (root + chronological replies, all
 * idle for at least the quiet-window), build a single conversational block,
 * run the existing `analyzeContextAndPropose` LLM call, and persist either:
 *   - a `PendingBacklogProposal` anchored to the bundle (when LLM returns
 *     one or more changes), or
 *   - just per-message seen markers (when the bundle has no relevant content).
 *
 * Mirrors `analyze-channel-messages.ts` but adapted for chat semantics
 * (no native thread hierarchy → bundle every new message into one synthetic
 * thread per tick per chat).
 */

import {
	db,
	markTeamsChatMessagesAsSeen,
	resolveProposalSummary,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
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
import type { FetchedChatThread } from "./fetch-new-messages";

// =============================================================================
// Types
// =============================================================================

export interface AnalyzeChatThreadInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	linkedChatId: string;
	thread: FetchedChatThread;
	chatTopic: string;
	chatWebUrl?: string;
}

export interface AnalyzeChatThreadOutput {
	success: boolean;
	pendingProposalId?: string;
	changeCount: number;
	skippedReason?: string;
	error?: string;
}

// =============================================================================
// Constants
// =============================================================================

const CHAT_ANALYSIS_USER_PROMPT = `The context below is a Microsoft Teams group chat conversation (a bundle of recent messages from one chat). Analyze it and propose backlog changes — features or bugs — that the conversation implies.

A single conversation typically yields zero or one proposal. Only split into multiple if the chat clearly covers distinct, unrelated needs. Ignore social chatter, status updates, scheduling messages, and off-topic tangents.

Keep each proposal concise: a short title and brief reasoning citing the conversation. Description and acceptance criteria can be minimal — they will be refined later.`;

// =============================================================================
// Formatter
// =============================================================================

/**
 * Format a chat bundle (root + replies, all in chronological order) as a
 * single conversational block for LLM analysis.
 *
 * Shape:
 *   ## Conversation in chat "<topic>" — started <iso> by <author>
 *
 *   **<author>**: <rootContent>
 *     ↳ **<replyAuthor>** (<iso>): <replyContent>
 *     ↳ ...
 */
export function formatTeamsChatThreadForBacklog(
	thread: FetchedChatThread,
	chatTopic: string,
): string {
	const lines: string[] = [];
	lines.push(
		`## Conversation in chat "${chatTopic}" — started ${thread.rootCreatedAt} by ${thread.rootAuthor}`,
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
 * Run the one-bundle-per-LLM-call extraction pass for chats.
 *
 * On zero-change output: insert seen-message markers for every message in the
 * bundle so they're never re-analyzed.
 *
 * On one-or-more-change output: insert a `PendingBacklogProposal`, plus seen
 * markers for every message in the bundle, with the bundle root marker
 * pointing at the proposal.
 */
export async function analyzeChatThreadActivity(
	input: AnalyzeChatThreadInput,
): Promise<AnalyzeChatThreadOutput> {
	const {
		projectId,
		userId,
		organizationId,
		linkedChatId,
		thread,
		chatTopic,
		chatWebUrl,
	} = input;

	logger.info("[TeamsChatMonitor] Analyzing chat bundle", {
		projectId,
		linkedChatId,
		rootMessageId: thread.rootMessageId,
		messageCount: thread.messageIds.length,
		chatTopic,
	});

	// Job Hub: the first analyzed bundle opens this chat's job row for the tick.
	// Ticks that find nothing open none, so idle monitors stay out of the panel.
	await jobEnsure({
		kind: "TEAMS_CHAT_MONITOR",
		title: `Teams chat · ${chatTopic}`,
		projectId,
		userId,
		organizationId,
		sourceType: JOB_SOURCE.teamsLinkedChat,
		sourceId: linkedChatId,
		steps: seedJobSteps([...JOB_STEPS.channelMonitor]),
	});
	await jobStep("fetch", "completed", { sourceId: linkedChatId });
	await jobStep("analyze", "running", { sourceId: linkedChatId });

	try {
		heartbeat("fetching project backlog");
		const existingBacklog = await getCachedProjectBacklog(projectId);

		const formatted = formatTeamsChatThreadForBacklog(thread, chatTopic);

		heartbeat("calling analyzeContextAndPropose");
		const proposal: ChangeProposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext: {
				teamsMessages: formatted,
			},
			existingBacklog,
			userPrompt: CHAT_ANALYSIS_USER_PROMPT,
			// Bug 1429: the channel-monitor feature-proposal flow only supports
			// feature/bug. `epic` is not a valid proposal type here, so forbid
			// the analyzer from emitting it (mirrors the teams-channel + slack
			// callers; the apply/approve paths also normalize via forbidEpics).
			allowEpics: false,
			// Capture-as-is: the ANALYZER only creates new work items — it never
			// suggests updating/merging off the truncated backlog listing in its
			// prompt, which is what made its update suggestions unreliable.
			allowUpdates: false,
			// Enrichment is decided afterwards by the semantic routing pass, which
			// applies the project's own opt-in.
			allowRouting: true,
		});

		// Zero-change bundle → seen markers only
		if (proposal.changes.length === 0) {
			await markTeamsChatMessagesAsSeen(
				linkedChatId,
				thread.messageIds,
				null,
			);
			await jobIncrement(
				{ threadsAnalyzed: 1, emptyThreads: 1 },
				linkedChatId,
			);
			await jobStep("analyze", "completed", { sourceId: linkedChatId });
			return {
				success: true,
				changeCount: 0,
				skippedReason: "no_relevant_content",
			};
		}

		// Atomically claim the bundle AND insert the proposal.
		const sourceMetadata = {
			linkedChatId,
			chatTopic,
			chatWebUrl: chatWebUrl ?? null,
			threadRootId: thread.rootMessageId,
			threadRootWebLink: thread.rootWebLink ?? null,
			messageCount: thread.messageIds.length,
			threadLastActivity: thread.threadLastActivity,
			transcript: formatted,
			messageIds: thread.messageIds,
			replies: thread.replies.map((reply) => ({
				messageId: reply.messageId,
				author: reply.author,
				createdAt: reply.createdAt,
				content: reply.content,
				webLink: reply.webLink ?? null,
			})),
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
			// Use the root message ID as the idempotency claim — first writer
			// wins on the unique constraint.
			const claim = await tx.projectLinkedTeamsChatSeenMessage.createMany(
				{
					data: [
						{
							linkedChatId,
							messageId: thread.rootMessageId,
							pendingProposalId: null,
						},
					],
					skipDuplicates: true,
				},
			);
			if (claim.count === 0) {
				return { claimed: false as const };
			}
			const pending = await tx.pendingBacklogProposal.create({
				data: {
					projectId,
					source: "TEAMS_CHAT",
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
			await tx.projectLinkedTeamsChatSeenMessage.updateMany({
				where: {
					linkedChatId,
					messageId: thread.rootMessageId,
				},
				data: { pendingProposalId: pending.id },
			});
			// Mark the rest of the bundle as seen (no proposal link)
			const remainingIds = thread.messageIds.filter(
				(id) => id !== thread.rootMessageId,
			);
			if (remainingIds.length > 0) {
				await tx.projectLinkedTeamsChatSeenMessage.createMany({
					data: remainingIds.map((messageId) => ({
						linkedChatId,
						messageId,
						pendingProposalId: null,
					})),
					skipDuplicates: true,
				});
			}
			return { claimed: true as const, pending };
		});

		if (!txResult.claimed) {
			await jobIncrement(
				{ threadsAnalyzed: 1, skippedAlreadySeen: 1 },
				linkedChatId,
			);
			await jobStep("analyze", "completed", { sourceId: linkedChatId });
			return {
				success: true,
				changeCount: 0,
				skippedReason: "already_claimed",
			};
		}
		const pending = txResult.pending;

		logger.info("[TeamsChatMonitor] Pending proposal created", {
			projectId,
			linkedChatId,
			rootMessageId: thread.rootMessageId,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
		});

		await jobIncrement(
			{ threadsAnalyzed: 1, proposalsCreated: 1 },
			linkedChatId,
		);
		await jobStep("analyze", "completed", { sourceId: linkedChatId });
		await jobStep("propose", "completed", { sourceId: linkedChatId });

		return {
			success: true,
			pendingProposalId: pending.id,
			changeCount: proposal.changes.length,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[TeamsChatMonitor] Analyze bundle activity failed", {
			error: errorMessage,
			projectId,
			linkedChatId,
			rootMessageId: thread.rootMessageId,
		});
		await jobStep("analyze", "failed", {
			sourceId: linkedChatId,
			error: errorMessage,
		});
		throw error;
	}
}

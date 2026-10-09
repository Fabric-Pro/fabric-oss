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
 * A thread that was analyzed before and is back because a reply arrived after
 * that analysis (`thread.previouslyAnalyzedThrough` set — a "revisit") is
 * analyzed for its NEW replies only: the earlier messages ride along as
 * already-reviewed context, and its existing seen row's `analyzedThroughAt`
 * watermark is moved forward instead of a new row being inserted.
 *
 * Cursor advance + dedup markers + proposal insert all happen after the LLM
 * call returns, so retries are bounded to Temporal's default 3 attempts.
 */

import {
	advanceTeamsThreadWatermark,
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
import type { FetchedThread, FetchedThreadReply } from "./fetch-new-messages";
import { isReplyNewerThanWatermark } from "./reply-watermark";

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
	 * Microsoft Graph channel id (the `19:`-prefixed thread id). Persisted on
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

/**
 * Appended to `THREAD_ANALYSIS_USER_PROMPT` on a revisit only — a thread that
 * was analyzed before and has since received new replies. The first-analysis
 * prompt stays byte-identical.
 */
const THREAD_REVISIT_USER_PROMPT_ADDENDUM = `This thread was already analyzed once. Everything under "Earlier messages" was reviewed then and is context only — anything it asked for has already been proposed or deliberately left out, so do not propose it again. Propose changes only for what the messages under "New replies" add: a new requirement, a newly reported bug, or a material change in scope. If the new replies only restate, acknowledge, thank, or chat about the already-reviewed content, return zero changes.`;

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

/**
 * Format a revisited thread for LLM analysis: the root and every reply created
 * at or before `previouslyAnalyzedThrough` go under an "already reviewed —
 * context only" heading, and the replies created after it under a "New
 * replies" heading. Same line shapes as `formatTeamsThreadForBacklog`.
 */
export function formatTeamsThreadRevisitForBacklog(
	thread: FetchedThread,
	channelDisplayName: string,
	previouslyAnalyzedThrough: string,
): string {
	const newReplies = selectNewReplies(
		thread.replies,
		previouslyAnalyzedThrough,
	);
	const newIds = new Set(newReplies.map((reply) => reply.messageId));
	const earlierReplies = thread.replies.filter(
		(reply) => !newIds.has(reply.messageId),
	);
	const lines: string[] = [];
	lines.push(
		`## Thread in #${channelDisplayName} — started ${thread.rootCreatedAt} by ${thread.rootAuthor}`,
	);
	lines.push("");
	lines.push(
		`### Earlier messages (already reviewed through ${previouslyAnalyzedThrough} — context only)`,
	);
	lines.push("");
	lines.push(`**${thread.rootAuthor}**: ${thread.rootContent}`);
	for (const reply of earlierReplies) {
		lines.push(
			`  ↳ **${reply.author}** (${reply.createdAt}): ${reply.content}`,
		);
	}
	lines.push("");
	lines.push(
		`### New replies since ${previouslyAnalyzedThrough} (analyze these)`,
	);
	lines.push("");
	for (const reply of newReplies) {
		lines.push(
			`  ↳ **${reply.author}** (${reply.createdAt}): ${reply.content}`,
		);
	}
	return lines.join("\n");
}

/**
 * Replies created strictly after `previouslyAnalyzedThrough`, in their
 * original order, under the rule the fetch activity used to send the thread
 * here (`isReplyNewerThanWatermark`): a reply created exactly at the
 * watermark is the one the previous analysis ended on, and a reply whose
 * `createdAt` does not parse is not new either.
 */
export function selectNewReplies(
	replies: FetchedThreadReply[],
	previouslyAnalyzedThrough: string,
): FetchedThreadReply[] {
	const watermarkMs = new Date(previouslyAnalyzedThrough).getTime();
	return replies.filter((reply) =>
		isReplyNewerThanWatermark(reply.createdAt, watermarkMs),
	);
}

/**
 * Revisit counterpart of `isAppAuthoredOnly`: true when every NEW reply (see
 * `selectNewReplies`) is positively application-authored AND the reply list is
 * known complete. The root and the older replies were handled by the earlier
 * analysis, so their authorship is irrelevant here — a human reply on an
 * application root is analyzed, and an application reply on a human thread is
 * not.
 *
 * Fails open exactly like `isAppAuthoredOnly`: a missing/"unknown" `fromKind`
 * on any new reply, or `repliesComplete` not strictly `true`, returns false.
 * Returns false for a first analysis (`previouslyAnalyzedThrough` absent).
 */
export function hasOnlyAppAuthoredNewReplies(thread: FetchedThread): boolean {
	if (thread.previouslyAnalyzedThrough === undefined) {
		return false;
	}
	if (thread.repliesComplete !== true) {
		return false;
	}
	return selectNewReplies(
		thread.replies,
		thread.previouslyAnalyzedThrough,
	).every((reply) => reply.fromKind === "application");
}

/**
 * True when every message in the thread — root and every reply — is
 * positively known to be application-authored (`fromKind === "application"`)
 * AND the reply list is known to be complete. A thread with an
 * application-authored root and no replies still counts.
 *
 * Fails OPEN (returns false, so the thread is still analyzed) on:
 *  - `"unknown"` or missing `fromKind` (older fetch results, or a message
 *    Graph didn't attribute a `from` for) — treated as possibly-human;
 *  - `repliesComplete` not strictly `true` — Graph's `$expand=replies` caps
 *    how many replies come back per message, and a busy thread with more
 *    replies than that cap only has the newest page reflected here. A later
 *    (unfetched) reply could be human-authored, and this activity marks the
 *    thread's root seen forever on the skip path, so an incomplete reply
 *    list must never be treated as "all application" — that would discard a
 *    reply this code never looked at.
 *
 * Only a thread where every message IS PRESENT and is POSITIVELY known to be
 * app/connector/bot authored is skipped: a thread that contains any human or
 * unattributed message at the time it is analyzed is still analyzed.
 *
 * This is the FIRST-analysis rule. A reply that arrives after the thread was
 * marked seen is no longer lost: the fetch activity sends the thread back as
 * a revisit (`previouslyAnalyzedThrough` set) once a reply is newer than the
 * seen row's watermark, and `hasOnlyAppAuthoredNewReplies` decides the skip
 * for that pass from the new replies alone.
 */
export function isAppAuthoredOnly(thread: FetchedThread): boolean {
	if (thread.rootFromKind !== "application") {
		return false;
	}
	if (thread.repliesComplete !== true) {
		return false;
	}
	return thread.replies.every((reply) => reply.fromKind === "application");
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

	// A revisit: this thread was analyzed before and is back because a reply
	// was created after that analysis. Absent on every first analysis, and on
	// any input recorded before the field existed.
	//
	// Every revisit write is a compare-and-swap of the seen row's watermark
	// from the value the fetch read (`previouslyAnalyzedThrough`) to this
	// analysis's `threadLastActivity`. Two overlapping runs (e.g. a one-shot
	// "monitor now" run beside the scheduled one) that read the same
	// watermark cannot both record: the first to commit wins, the other
	// matches nothing. Any reply newer than the winner's watermark is still
	// newer on the next tick, so it is revisited then rather than lost.
	//
	// Known limit: replies Graph left out of a truncated `$expand=replies`
	// page (`repliesComplete === false`) are not recovered — one that falls
	// between two watermarks is never seen. That gap predates revisits and
	// needs a full reply-paging path to close.
	const previouslyAnalyzedThrough = thread.previouslyAnalyzedThrough;
	const isRevisit = previouslyAnalyzedThrough !== undefined;
	// The watermark this analysis records: the thread's threadLastActivity,
	// i.e. the newest message it saw.
	const analyzedThroughAt = new Date(thread.threadLastActivity);
	const newReplies = isRevisit
		? selectNewReplies(thread.replies, previouslyAnalyzedThrough)
		: thread.replies;

	logger.info("[TeamsChannelMonitor] Analyzing channel thread", {
		projectId,
		linkedChannelId,
		threadRootId: thread.rootMessageId,
		replyCount: thread.replies.length,
		channelDisplayName,
		isRevisit,
		...(isRevisit ? { newReplyCount: newReplies.length } : {}),
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

		// Step 2: Format thread + invoke the existing LLM analysis. A revisit
		// separates the already-reviewed messages from the new replies.
		const formatted = isRevisit
			? formatTeamsThreadRevisitForBacklog(
					thread,
					channelDisplayName,
					previouslyAnalyzedThrough,
				)
			: formatTeamsThreadForBacklog(thread, channelDisplayName);

		// Step 2b: Capture the conversation BEFORE the analyzer runs, so it
		// happens on both branches of the analyzer's outcome (Fizzy #2228).
		// The zero-change branch below is where this channel's content used to
		// disappear entirely: the transcript only ever survived inside a
		// PendingBacklogProposal, and that branch writes none. Placing capture
		// here — rather than duplicating it into each branch — is what makes
		// the guarantee independent of what the LLM decided.
		//
		// A revisit hands over the whole thread too. Capture claims per
		// message, so the root and replies an earlier pass already bundled
		// lose their claims and only the new replies land in this bundle.
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

		// Flatten root + reply image-attachment refs into a single sidecar
		// list (chat-thread image-attachments feature, FR-9 / spec § 4.4).
		// The fetch activity already populates these; we just project them
		// here for persistence into `sourceMetadata.attachments`. Computed
		// before the app-authored skip check below so both the skip return
		// and the zero-change return carry the same sidecar shape.
		const pendingAttachments: PendingAttachmentRef[] = [
			...(thread.pendingAttachments ?? []),
		];
		// Fetch-time warnings — currently always empty for Teams; reserved
		// for future fetch-time skip reasons. Mirrors the Slack contract.
		const attachmentWarnings: AttachmentWarning[] = [];

		// Record "analyzed through threadLastActivity, no proposal" for this
		// thread. A first analysis inserts the root's seen row; a revisit
		// already has one, so it compare-and-swaps that row's watermark from
		// the value the fetch read.
		//
		// If the process dies right after this write, the thread is not
		// revisited again until a reply newer than threadLastActivity arrives.
		// That is the intended outcome of both callers (skip / zero changes):
		// the analysis they record has already happened.
		const recordAnalyzedWithoutProposal = async () => {
			if (isRevisit) {
				const advanced = await advanceTeamsThreadWatermark(
					linkedChannelId,
					thread.rootMessageId,
					new Date(previouslyAnalyzedThrough),
					analyzedThroughAt,
				);
				if (advanced === 0) {
					// Another run recorded this thread first. Nothing to undo:
					// this pass wrote nothing, and whatever is newer than the
					// winner's watermark comes back on the next tick.
					logger.info(
						"[TeamsChannelMonitor] Revisit watermark already moved by another run",
						{
							projectId,
							linkedChannelId,
							threadRootId: thread.rootMessageId,
							previouslyAnalyzedThrough,
							threadLastActivity: thread.threadLastActivity,
						},
					);
				}
			} else {
				await markTeamsMessagesAsSeen(
					linkedChannelId,
					[thread.rootMessageId],
					null,
					analyzedThroughAt,
				);
			}
		};

		// Step 2c: Skip the LLM analyzer entirely when every message in the
		// thread — root and every reply — is application-authored AND the
		// reply list is known complete (e.g. an automated alerts/bot
		// channel): a monitor linked to such a channel was running one
		// COMPLEX-tier analyzer call per thread and getting zero changes
		// back every time. `isAppAuthoredOnly` fails OPEN on "unknown"
		// authorship (missing/unattributed `from`) and on an incomplete
		// reply page, so a human or not-yet-fetched reply still reaches the
		// analyzer below. Capture already ran unconditionally above, so this
		// channel's content stays exportable/citable exactly as on the
		// zero-change branch — only the analyzer call and its cost are
		// skipped. On a revisit only the NEW replies decide: the root and
		// the older replies were handled by the earlier analysis.
		const skipAsAppAuthored = isRevisit
			? hasOnlyAppAuthoredNewReplies(thread)
			: isAppAuthoredOnly(thread);
		if (skipAsAppAuthored) {
			logger.info("[TeamsChannelMonitor] Skipping app-authored thread", {
				projectId,
				linkedChannelId,
				threadRootId: thread.rootMessageId,
				isRevisit,
			});
			await recordAnalyzedWithoutProposal();
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
				skippedReason: "app_authored_thread",
				pendingAttachments,
				attachmentWarnings,
			};
		}

		heartbeat("calling analyzeContextAndPropose");
		const proposal: ChangeProposal = await analyzeContextAndPropose({
			projectId,
			userId,
			organizationId,
			fetchedContext: {
				teamsMessages: formatted,
			},
			existingBacklog,
			userPrompt: isRevisit
				? `${THREAD_ANALYSIS_USER_PROMPT}\n\n${THREAD_REVISIT_USER_PROMPT_ADDENDUM}`
				: THREAD_ANALYSIS_USER_PROMPT,
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
			jobType: "teams-channel-monitor",
		});

		// Step 3a: Zero-change thread → seen marker only (cursor is advanced
		// by the workflow after all threads in a channel are processed). On a
		// revisit, the existing marker's watermark moves forward instead.
		if (proposal.changes.length === 0) {
			await recordAnalyzedWithoutProposal();
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
		// A revisit already has its seen row, so inserting it cannot be the
		// fence (it would report `already_claimed` every time). Its fence is
		// the watermark compare-and-swap instead: only the first run to move
		// the watermark off the value the fetch read matches. The advance
		// and the proposal insert share the transaction, so if the process
		// dies between them nothing is left behind — the watermark rolls back
		// with the missing proposal and the retry (or next tick) redoes both.
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
			// A revisit proposal covers only the replies created after the
			// earlier analysis; record which ones, and the watermark they are
			// newer than, so a reviewer can tell it from a first analysis.
			...(isRevisit
				? {
						revisitOfAnalyzedThrough: previouslyAnalyzedThrough,
						newReplyIds: newReplies.map((reply) => reply.messageId),
					}
				: {}),
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
			if (isRevisit) {
				const advanced = await advanceTeamsThreadWatermark(
					linkedChannelId,
					thread.rootMessageId,
					new Date(previouslyAnalyzedThrough),
					analyzedThroughAt,
					tx,
				);
				if (advanced === 0) {
					return { claimed: false as const };
				}
			} else {
				const claim =
					await tx.projectLinkedTeamsChannelSeenMessage.createMany({
						data: [
							{
								linkedChannelId,
								messageId: thread.rootMessageId,
								pendingProposalId: null,
								analyzedThroughAt,
							},
						],
						skipDuplicates: true,
					});
				if (claim.count === 0) {
					return { claimed: false as const };
				}
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
			// A revisit leaves the root row pointing at the proposal it already
			// has, if any; it only fills an empty link (e.g. the earlier pass
			// found zero changes). The daily brief resolves the channel of an
			// unlinked revisit proposal from its sourceMetadata instead.
			await tx.projectLinkedTeamsChannelSeenMessage.updateMany({
				where: {
					linkedChannelId,
					messageId: thread.rootMessageId,
					...(isRevisit ? { pendingProposalId: null } : {}),
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
			isRevisit,
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

import { ORPCError } from "@orpc/server";
import {
	type AttachmentWarningRecord,
	appendAppliedChangeIndexes,
	buildBacklogDedupGuard,
	db,
	getPendingBacklogProposal,
	inferDedupFamily,
	markPendingProposalApplied,
	markPendingProposalApproved,
	markPendingProposalFailed,
	type SkippedDuplicate,
	setPendingProposalAttachmentResult,
	setProposalApplyWorkflowId,
	updateStory,
} from "@repo/database";
import type { TeamsHostedContentRef } from "@repo/integrations";
import { getMicrosoftAccessToken } from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import {
	createStoryFromProposal,
	triggerDuplicateDetection,
	unwrapPmSyncError,
} from "@repo/temporal";
import { mapPriority, mapSize } from "@repo/temporal/activities";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { linkStoryToSourceActionItem } from "../../lib/action-item-link-provenance";
import {
	appendWarningLinesToAttachmentsBlock,
	attachPendingMediaToStory,
	formatAttachmentWarningLines,
} from "../../lib/attach-pending-media-to-story";
import { isChannelMonitorSource } from "../../lib/channel-monitor-source";
import {
	backlogChangeSnapshot,
	extractDecisionPrecheck,
	filterFindingsToApprovedChanges,
	recordDecisionOverridesAccepted,
} from "../../lib/decision-override-audit";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { resolveMeetingTranscriptForProposal } from "../../lib/meeting-provenance";
import { backlogApplyWorkflowId } from "../backlog/workflow-id";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * approve proposals.
 *
 * Approves a PendingBacklogProposal: CREATE changes are materialized through
 * the same path as the "Add Feature" button (createStoryFromProposal), UPDATE
 * changes are dispatched to the existing backlogApplyChangesWorkflow.
 *
 * Status transitions:
 *   - All-create proposals with no errors → APPLIED synchronously
 *   - Mixed / update-only proposals → APPROVED + applyWorkflowId set; the
 *     workflow flips the row to APPLIED on completion
 *   - Any CREATE errors → FAILED with applyError populated
 */

const changeItemSchema = z.object({
	type: z.enum(["epic", "feature", "story", "bug"]),
	action: z.enum(["create", "update"]),
	existingId: z.string().nullable().optional(),
	existingIdentifier: z.string().nullable().optional(),
	existingExternalId: z.string().nullable().optional(),
	title: z.object({
		from: z.string().nullable().optional(),
		to: z.string(),
	}),
	description: z
		.object({
			from: z.string().nullable().optional(),
			to: z.string(),
		})
		.nullable()
		.optional(),
	acceptanceCriteria: z
		.object({
			from: z.string().nullable().optional(),
			to: z.string(),
		})
		.nullable()
		.optional(),
	priority: z
		.object({
			from: z.string().nullable().optional(),
			to: z.string(),
		})
		.nullable()
		.optional(),
	size: z
		.object({
			from: z.string().nullable().optional(),
			to: z.string(),
		})
		.nullable()
		.optional(),
	parentEpicIdentifier: z.string().nullable().optional(),
	parentFeatureIdentifier: z.string().nullable().optional(),
	parentEpicTitle: z.string().nullable().optional(),
	parentFeatureTitle: z.string().nullable().optional(),
	// Annotation, not payload — same reasoning as `backlog/apply-changes.ts`.
	// These rows come from the same analyzer, which is allowed to return a
	// change without either field.
	reasoning: z.string().nullable().optional(),
	sourceContext: z
		.enum([
			"teams_messages",
			"meeting_transcript",
			"notion_page",
			"multiple",
		])
		.nullable()
		.optional(),
	/**
	 * Inline PM override of the AI classifier's kind decision. When set, the
	 * approve handler passes `kind` + `skipClassifier: true` to
	 * createStoryFromProposal so the classifier is bypassed and the user's
	 * choice wins. Only meaningful for `action: "create"` rows where the
	 * analyzer proposed feature/story/bug — epics ignore this field.
	 */
	kindOverride: z.enum(["BUG", "FEATURE"]).nullable().optional(),
	/**
	 * Set by the review UI when this CREATE's body was already drafted through
	 * the kind-appropriate prompt at review time (lazy draft on open). When true,
	 * the approve handler persists the proposed body verbatim (skipDrafting) and
	 * does NOT re-draft from the thread transcript — carrying `needsMoreInfo`.
	 */
	predrafted: z.boolean().nullable().optional(),
	/** Bug triage flag captured by the review-time draft (paired with predrafted). */
	needsMoreInfo: z.boolean().nullable().optional(),
});

type ChangeItem = z.infer<typeof changeItemSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Structural shape of a single Teams pending-attachment ref as persisted on
 * `PendingBacklogProposal.sourceMetadata.attachments` by the Teams monitor's
 * analyze activity (spec § 7.2 / FR-10). We never trust the JSON blindly —
 * `collectTeamsAttachmentRefs` narrows it.
 */
interface TeamsPendingAttachmentRef {
	source: "teams";
	ref: {
		id: string;
		messageId: string;
		contentType?: string;
		fileName?: string;
		altText?: string;
	};
}

/**
 * Defensively extract Teams-source attachment refs from a proposal's
 * `sourceMetadata`. The persisted JSON shape is `unknown` per Prisma so we
 * narrow only the fields we recognize and drop refs that don't have the
 * required `{source: "teams", ref: {id, messageId}}` shape.
 *
 * Cross-source refs (e.g. `source: "slack"` landing on a row routed to the
 * Teams approve endpoint) are dropped AND warn-logged so a UI dispatch
 * regression never silently swallows attachments — that's exactly the bug
 * uncovered during PR validation (the inbox previously sent every
 * approval to the Teams endpoint regardless of `proposal.source`).
 */
function collectTeamsAttachmentRefs(
	sourceMetadata: unknown,
	proposalId: string,
): TeamsPendingAttachmentRef[] {
	if (!sourceMetadata || typeof sourceMetadata !== "object") {
		return [];
	}
	const meta = sourceMetadata as Record<string, unknown>;
	const raw = meta.attachments;
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: TeamsPendingAttachmentRef[] = [];
	const droppedCrossSource: { count: number; sourcesSeen: Set<string> } = {
		count: 0,
		sourcesSeen: new Set(),
	};
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const e = entry as Record<string, unknown>;
		if (e.source !== "teams") {
			if (typeof e.source === "string") {
				droppedCrossSource.count += 1;
				droppedCrossSource.sourcesSeen.add(e.source);
			}
			continue;
		}
		if (!e.ref || typeof e.ref !== "object") {
			continue;
		}
		const r = e.ref as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.messageId !== "string") {
			continue;
		}
		out.push({
			source: "teams",
			ref: {
				id: r.id,
				messageId: r.messageId,
				contentType:
					typeof r.contentType === "string"
						? r.contentType
						: undefined,
				fileName:
					typeof r.fileName === "string" ? r.fileName : undefined,
				altText: typeof r.altText === "string" ? r.altText : undefined,
			},
		});
	}
	if (droppedCrossSource.count > 0) {
		logger.warn(
			{
				event: "chat-thread-attachments.cross_source_dropped",
				proposalId,
				expectedSource: "teams",
				droppedCount: droppedCrossSource.count,
				droppedSources: Array.from(droppedCrossSource.sourcesSeen),
			},
			"Teams approve dropped non-Teams attachment refs — UI dispatch may be misrouting proposals",
		);
	}
	return out;
}

/**
 * Stable per-ref identifier for warnings + log lines. Mirrors the
 * orchestrator's internal `refIdOf` so the call-site warnings line up with
 * what the orchestrator would have emitted.
 */
function refIdOfTeams(ref: TeamsPendingAttachmentRef): string {
	return ref.ref.id;
}

/**
 * Return a copy of `sourceMetadata` with `attachments` filtered to ONLY the
 * Teams refs the orchestrator will accept. Defensive against a proposal row
 * that may carry mixed-source refs (shouldn't happen — channel monitors
 * persist single-source — but the filter is cheap and protects the
 * orchestrator from cross-source dispatch).
 */
function filterSourceMetadataForTeams(
	sourceMetadata: unknown,
	teamsRefs: TeamsPendingAttachmentRef[],
): unknown {
	if (!sourceMetadata || typeof sourceMetadata !== "object") {
		return { attachments: teamsRefs };
	}
	return {
		...(sourceMetadata as Record<string, unknown>),
		attachments: teamsRefs,
	};
}

/**
 * Read the parent Teams message location from `sourceMetadata` for use by
 * the orchestrator's `teamsMessageUrlBuilder`. The channel-monitor analyze
 * activity persists `{teamId, channelId}` (channel context). Returns null
 * when the metadata doesn't carry the channel coordinates — the orchestrator
 * then falls back to its built-in default that also reads these keys.
 */
interface TeamsChannelCoordinates {
	teamId: string;
	channelId: string;
}

function extractTeamsChannelCoordinates(
	sourceMetadata: unknown,
): TeamsChannelCoordinates | null {
	if (!sourceMetadata || typeof sourceMetadata !== "object") {
		return null;
	}
	const meta = sourceMetadata as Record<string, unknown>;
	// Teams analyze activity persists Graph identifiers as `teamId` and
	// `channelId` on `sourceMetadata` (bug_001 fix). The earlier
	// `linkedTeamId` / `linkedChannelId` fallbacks were dead code: no writer
	// ever set `linkedTeamId`, and `linkedChannelId` is a DB cuid — building
	// a Graph URL from it produces a 404.
	const teamId =
		typeof meta.teamId === "string" && meta.teamId
			? meta.teamId
			: undefined;
	const channelId =
		typeof meta.channelId === "string" && meta.channelId
			? meta.channelId
			: undefined;
	if (!teamId || !channelId) {
		return null;
	}
	return { teamId, channelId };
}

/**
 * Reduce an unknown error to its constructor name for safe logging.
 * `err.message` can carry URL fragments / token tails that the chat-thread
 * security contract forbids in logs.
 */
function redactErrorName(err: unknown): string {
	if (err instanceof Error) {
		return err.name || "Error";
	}
	return "unknown";
}

/**
 * F-171 reporter tracking: extract `reporterSourceUrl` + `reporterName` from
 * the proposal's Teams source metadata so the created bug carries an
 * audit trail back to the originating thread/chat (REQ-8, AC13). Falls back
 * to nulls when the metadata is missing the fields. The reporterSource is
 * always "TEAMS" for this path.
 */
function buildTeamsReporterInfo(sourceMetadata: unknown): {
	reporterSourceUrl: string | null;
	reporterName: string | null;
} {
	const meta =
		sourceMetadata && typeof sourceMetadata === "object"
			? (sourceMetadata as Record<string, unknown>)
			: {};

	const reporterSourceUrl =
		typeof meta.threadRootWebLink === "string" && meta.threadRootWebLink
			? meta.threadRootWebLink
			: typeof meta.channelWebUrl === "string" && meta.channelWebUrl
				? meta.channelWebUrl
				: null;

	// Best-effort reporter name: prefer an explicit reporterName field
	// emitted by the analyzer; otherwise grab the first message author.
	let reporterName: string | null = null;
	if (typeof meta.reporterName === "string" && meta.reporterName) {
		reporterName = meta.reporterName;
	} else if (Array.isArray(meta.messages)) {
		for (const m of meta.messages as Array<Record<string, unknown>>) {
			const from =
				typeof m.from === "string"
					? m.from
					: typeof m.author === "string"
						? m.author
						: null;
			if (from) {
				reporterName = from;
				break;
			}
		}
	}

	return { reporterSourceUrl, reporterName };
}

/**
 * Build the `additionalContext` string passed to the drafting LLM.
 *
 * The pending proposal's `sourceMetadata` shape is owned by the Temporal
 * analysis activity, which runs in parallel with this code. The plan
 * (activities/teams-channel-monitor/analyze-channel-messages.ts) stores
 * metadata like:
 *   { linkedChannelId, channelDisplayName, channelWebUrl,
 *     threadRootId, threadRootWebLink, messageCount, threadLastActivity }
 *
 * If the analysis activity is later extended to inline the full thread
 * transcript ({messages: [...]} or {thread: {...}}), we prefer that. Otherwise
 * we fall back to a short channel-reference string PLUS the proposal's
 * `reasoning` field, which already captures the LLM's rationale for proposing
 * this item.
 *
 * TODO(coordinate-with-temporal): once the analyze activity lands, confirm
 * whether it persists the full thread text. If yes, switch to reading it
 * directly so the placeholder stage prompt sees verbatim user intent.
 */
function buildThreadTranscript(
	sourceMetadata: unknown,
	reasoning: string,
): string {
	const meta =
		sourceMetadata && typeof sourceMetadata === "object"
			? (sourceMetadata as Record<string, unknown>)
			: {};

	// Prefer a pre-rendered transcript if the activity inlined one
	if (typeof meta.transcript === "string" && meta.transcript.length > 0) {
		return meta.transcript;
	}

	// Or a structured messages array
	if (Array.isArray(meta.messages) && meta.messages.length > 0) {
		const channelName =
			typeof meta.channelDisplayName === "string"
				? meta.channelDisplayName
				: "channel";
		const lines = [`## Thread in #${channelName}`];
		for (const m of meta.messages as Array<Record<string, unknown>>) {
			const author =
				typeof m.from === "string"
					? m.from
					: typeof m.author === "string"
						? m.author
						: "unknown";
			const content =
				typeof m.content === "string"
					? m.content
					: typeof m.text === "string"
						? m.text
						: "";
			if (content) {
				lines.push(`**${author}**: ${content}`);
			}
		}
		return lines.join("\n");
	}

	// Fallback: source reference + LLM's own rationale. The stage prompt can
	// still produce a reasonable description from the title + rationale alone.
	// Chat sources expose `chatTopic`; channel sources expose
	// `channelDisplayName` / `channelName`. Try chat first since chat-monitor
	// metadata never has a channel name.
	const chatTopic =
		typeof meta.chatTopic === "string" ? meta.chatTopic : null;
	const channelName =
		typeof meta.channelDisplayName === "string"
			? meta.channelDisplayName
			: typeof meta.channelName === "string"
				? meta.channelName
				: null;

	const parts: string[] = [];
	if (chatTopic) {
		parts.push(
			`Based on a Microsoft Teams group chat conversation: "${chatTopic}".`,
		);
	} else if (channelName) {
		parts.push(
			`Based on a Microsoft Teams channel thread in #${channelName}.`,
		);
	}
	if (reasoning) {
		parts.push(`Reasoning from discussion analysis:\n${reasoning}`);
	}
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

export const approvePendingProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/pending-proposals/{proposalId}/approve",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Approve a pending backlog proposal",
		description:
			"Materializes approved CREATE changes via the Add-Feature path and dispatches UPDATEs to the backlog apply workflow.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			proposalId: z.string(),
			approvedChanges: z.array(changeItemSchema),
			// Optional opt-out for PM sync. Undefined ⇒ sync if PM is wired
			// up — matches user intent ("approved proposals sync when the PM
			// tool is configured"). Explicit `false` skips. Explicit `true`
			// is also honored for callers that want to be explicit.
			syncToPM: z.boolean().optional(),
			pmConfig: z
				.object({
					mcpConfigId: z.string(),
					containerId: z.string(),
					additionalContext: z
						.record(z.string(), z.string())
						.optional(),
				})
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Load + verify the proposal
		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal not found",
			});
		}

		if (
			proposal.status !== "PENDING" &&
			proposal.status !== "FAILED" &&
			proposal.status !== "BACKLOG"
		) {
			// PENDING/FAILED are the normal review states; BACKLOG is admitted so
			// a deferred proposal can be approved (transition out of backlog — a
			// backlogged proposal never materialized a story, so approving it
			// behaves identically to approving a pending one). Anything else
			// (APPROVED/APPLIED/REJECTED/SUPERSEDED) means another reviewer already
			// actioned it — surface a conflict so the inbox shows the "already
			// approved or rejected" toast.
			throw new ORPCError("CONFLICT", {
				message:
					"This proposal has already been approved or rejected perhaps by another user.",
			});
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementContainerName: true,
				// Read PM config to gate the auto-push enqueue below — when
				// either is null the project simply has no PM tool wired up
				// and there's nowhere to sync to.
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Idempotent retry tracking.
		// Map each approved change to its ORIGINAL index in the proposal's
		// stored changes array — matching by (action, type, title.to, parent)
		// so partial approvals / retries stay aligned with what's been applied
		// before. Changes whose original index is in `appliedChangeIndexes`
		// are skipped so re-runs never duplicate work.
		const proposalChanges = (() => {
			const raw = proposal.proposal;
			if (
				raw &&
				typeof raw === "object" &&
				"changes" in raw &&
				Array.isArray((raw as { changes: unknown }).changes)
			) {
				return (raw as { changes: ChangeItem[] }).changes;
			}
			return [] as ChangeItem[];
		})();

		// Bug 1429 / Codex round 4: epic-suppression is gated on the
		// proposal SOURCE. The three monitored-channel sources (TEAMS_CHANNEL
		// / TEAMS_CHAT / SLACK_CHANNEL) are feature/bug-only; AI_UPDATE_SIDEBAR
		// (general AI Update) keeps `epic` first-class. The inbox's
		// `endpointForSource()` routes AI_UPDATE_SIDEBAR proposals to THIS
		// teams procedure via its default fallthrough, so we must NOT assume
		// every proposal reaching here is channel-monitor.
		const forbidEpics = isChannelMonitorSource(proposal.source);

		// Channel-monitor flow only: normalize epic->feature here too. CREATE
		// changes are materialized synchronously below via
		// `createStoryFromProposal` (only UPDATEs reach the workflow's
		// `forbidEpics` gate), so we MUST normalize before the create/update
		// split, to keep the invariant local and enforced (and robust against
		// a future create-path refactor). We mutate the approved changes in
		// place: set `type: "feature"`, drop the parent-epic references, and
		// warn for auditability. `"epic"` stays in `changeItemSchema` for
		// backward-compat with stored proposals.
		if (forbidEpics) {
			for (const change of input.approvedChanges) {
				if ((change as { type: string }).type === "epic") {
					logger.warn(
						"[approvePendingProposal:teams] forbidEpics — normalizing epic-typed change to feature (Bug 1429)",
						{
							proposalId: input.proposalId,
							title: change.title.to,
							action: change.action,
						},
					);
					change.type = "feature";
					change.parentEpicIdentifier = null;
					change.parentEpicTitle = null;
				}
			}
		}

		// Epic-tolerant type comparison for index resolution. The stored
		// proposal JSON may still carry `type: "epic"` while the approved
		// change has already been normalized to `feature` (above, or by the
		// web `normalizeChange` before it was sent). Treat epic + feature as
		// one family so the lookup still lines up — otherwise the stored
		// Bug 1429 epic proposal would 400 as "stale".
		// Codex round 5: the epic->feature collapse is gated on
		// `forbidEpics`. For the channel-monitor flow a stored `epic` and a
		// web-normalized `feature` are the same family (so the lookup lines
		// up); for AI_UPDATE_SIDEBAR (epics first-class, NOT normalized) we
		// use STRICT matching so an epic only matches an epic — otherwise a
		// feature sharing an epic's action+title could resolve to the epic's
		// stored index and corrupt `appliedChangeIndexes`.
		const typeForMatch = (t: string): string =>
			forbidEpics && t === "epic" ? "feature" : t;
		const alreadyApplied = new Set(proposal.appliedChangeIndexes ?? []);

		// Does stored change `c` match approved `change`? (action + type
		// [forbidEpics-gated collapse] + title + parentFeature + the
		// forbidEpics-gated parentEpic skip.)
		const matchesStored = (c: ChangeItem, change: ChangeItem): boolean =>
			c.action === change.action &&
			typeForMatch(c.type) === typeForMatch(change.type) &&
			c.title.to === change.title.to &&
			(c.parentFeatureIdentifier ?? null) ===
				(change.parentFeatureIdentifier ?? null) &&
			// Parent-epic ids are nulled during epic normalization, so
			// skip that field ONLY when (a) we're in the channel-monitor
			// flow (`forbidEpics`) AND (b) the STORED side is a genuine
			// epic (Bug 1429) — a normalized feature has parentEpic null
			// and would never match a stored epic's value. For
			// AI_UPDATE_SIDEBAR (`!forbidEpics`) the full parentEpic
			// comparison always runs (strict matching). Gate on the raw
			// stored `c.type === "epic"`, NOT `typeForMatch(...)` (which
			// is also true for real features and would wrongly let two
			// distinct feature rows differing only by parentEpic cross-match).
			((forbidEpics && c.type === "epic") ||
				(c.parentEpicIdentifier ?? null) ===
					(change.parentEpicIdentifier ?? null));

		// Codex round 7: consumed-index assignment. The matcher was
		// stateless (a fresh `findIndex` per approved change), so when the
		// epic-tolerant collapse makes a stored `epic` and `feature`
		// (same action+title+parentFeature) match-equal, two approved
		// changes could both resolve to the SAME stored index — leaving
		// the other index unrecorded in `appliedChangeIndexes` and
		// replay-eligible. Assign each approved change the FIRST stored
		// index that matches AND hasn't already been claimed, so every
		// approved change maps to a DISTINCT stored index. (Same
		// action+title+parentFeature rows are interchangeable for
		// index-bookkeeping, so which-of-the-two is harmless.)
		const usedIndexes = new Set<number>();
		const indexedChanges = input.approvedChanges.map((change, position) => {
			let index = -1;
			for (let i = 0; i < proposalChanges.length; i++) {
				const c = proposalChanges[i];
				if (!c || usedIndexes.has(i)) {
					continue;
				}
				if (matchesStored(c, change)) {
					index = i;
					usedIndexes.add(i);
					break;
				}
			}
			return { change, index, position };
		});
		// Reject approvals that don't line up with the stored proposal — the
		// proposal may have been superseded or the client sent stale data.
		for (const entry of indexedChanges) {
			if (entry.index < 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Approved change "${entry.change.title.to}" not found in proposal — it may be stale. Re-open the proposal.`,
				});
			}
		}
		const creates = indexedChanges.filter(
			({ change, index }) =>
				change.action === "create" && !alreadyApplied.has(index),
		);
		const updates = indexedChanges.filter(
			({ change, index }) =>
				change.action === "update" && !alreadyApplied.has(index),
		);

		// Claim the approval up-front. We only set APPROVED once, here, before
		// any work runs — this guarantees that when the apply workflow (below)
		// calls finalizePendingProposalActivity it can safely transition from
		// APPROVED → APPLIED/FAILED without this handler racing a later
		// markPendingProposalApproved() that would overwrite the terminal state.
		await markPendingProposalApproved({
			proposalId: input.proposalId,
			reviewedBy: user.id,
			applyWorkflowId: null,
		});

		// 1. Process CREATE changes sequentially so partial failure leaves a
		//    clean record of what succeeded. Each successful create's index is
		//    persisted to the proposal row immediately, so if we bail out
		//    halfway through, a retry resumes from exactly where we stopped.
		const createdStoryIds: string[] = [];
		const createErrors: string[] = [];
		const freshlyApplied: number[] = [];

		// Title-collision dedup guard. Mirrors the AI Update sidebar guard
		// (PR #1137, `applyBacklogChanges`) — applies here too because this
		// procedure calls `createStoryFromProposal` directly. The same
		// implementation backs the Slack approve procedure via
		// `buildBacklogDedupGuard`.
		const skipped: SkippedDuplicate[] = [];
		const dedupGuard = await buildBacklogDedupGuard(input.projectId);

		// Cumulative attachment warnings across every CREATE in this approval
		// loop. Persisted once at the end via `setPendingProposalAttachmentResult`
		// so the proposal-inbox UI's `⚠ M` chip reflects the apply-time outcome
		// (spec § 4.6 step 8, FR-22). Lazy-resolved Microsoft Graph token: we
		// only pay the DB lookup + decrypt cost when the proposal actually
		// carries attachment refs.
		const cumulativeWarnings: AttachmentWarningRecord[] = [];
		const teamsAttachmentRefs = collectTeamsAttachmentRefs(
			proposal.sourceMetadata,
			proposal.id,
		);
		const teamsChannelCoords = extractTeamsChannelCoordinates(
			proposal.sourceMetadata,
		);
		const teamsMessageUrlBuilder = teamsChannelCoords
			? (ref: TeamsHostedContentRef): string => {
					// bug_002: a hostedContent living on a reply is NOT
					// addressable through the flat `/messages/{replyId}/`
					// path — Graph requires the nested
					// `/messages/{rootId}/replies/{replyId}/` form. Reply
					// refs carry `parentMessageId` (= thread root) from
					// extraction time; build accordingly.
					const base = `https://graph.microsoft.com/v1.0/teams/${teamsChannelCoords.teamId}/channels/${teamsChannelCoords.channelId}/messages`;
					return ref.parentMessageId !== undefined
						? `${base}/${ref.parentMessageId}/replies/${ref.messageId}`
						: `${base}/${ref.messageId}`;
				}
			: undefined;
		let teamsAccessToken: string | null = null;
		let teamsCredentialResolutionError: Error | null = null;

		// #1814: meeting provenance — resolved once per approval, stamped on every
		// story this proposal creates. Best-effort: null for non-meeting sources.
		const sourceMeetingTranscript =
			await resolveMeetingTranscriptForProposal({
				projectId: input.projectId,
				proposalId: input.proposalId,
				proposalSource: proposal.source,
				sourceMetadata: proposal.sourceMetadata,
			});

		for (const { change, index } of creates) {
			try {
				// Title-collision dedup. Family inference mirrors the
				// kind-hint logic below so the guard checks the same family
				// the create lands in (BUG vs FEATURE/USER_STORY). The
				// classifier inside `createStoryFromProposal` may still
				// flip kind after the fact — matches the sidebar guard.
				const dedupFamily = inferDedupFamily(change);
				const collision = dedupGuard.findCollision(
					dedupFamily,
					change.title.to,
				);
				if (collision) {
					logger.warn(
						"[approvePendingProposal:teams] Skipping duplicate CREATE — title matches existing item",
						{
							proposalId: input.proposalId,
							changeIndex: index,
							family: dedupFamily,
							title: change.title.to,
							existingIdentifier: collision.existingIdentifier,
							existingId: collision.existingId,
						},
					);
					skipped.push({
						changeIndex: index,
						title: change.title.to,
						existingIdentifier: collision.existingIdentifier,
						existingId: collision.existingId,
					});
					// Mark applied so a retry of this proposal doesn't
					// re-process this skipped item.
					freshlyApplied.push(index);
					await appendAppliedChangeIndexes(input.proposalId, [index]);
					continue;
				}

				const additionalContext = buildThreadTranscript(
					proposal.sourceMetadata,
					change.reasoning ?? proposal.summary ?? "",
				);
				const { reporterSourceUrl, reporterName } =
					buildTeamsReporterInfo(proposal.sourceMetadata);
				// When the PM picks a kind in the approval UI we honor it
				// verbatim and skip the F-171 classifier. Otherwise we keep
				// the legacy behavior of letting the classifier decide.
				const overrideKind = change.kindOverride ?? undefined;
				const effectiveKindHint =
					overrideKind ?? (change.type === "bug" ? "BUG" : undefined);
				const labels =
					(overrideKind ??
						(change.type === "bug" ? "BUG" : "FEATURE")) === "BUG"
						? ["bug"]
						: [];
				if (overrideKind) {
					// Audit trail: PM corrected the classifier inline. Pairs
					// with the "classifier overrode caller-provided kind" log
					// inside createStoryFromProposal so we can reconstruct the
					// kind decision chain from logs alone.
					console.info(
						"[approvePendingProposal:teams] PM-supplied kindOverride honored — classifier bypassed",
						{
							proposalId: input.proposalId,
							changeIndex: index,
							changeType: change.type,
							overrideKind,
							title: change.title.to,
						},
					);
				}
				// When the reviewer opened this proposal, its body was already
				// drafted through the kind prompt at review time (lazy draft on
				// open). Persist that body verbatim instead of re-drafting from the
				// thread transcript at approve — that's the "draft right away, not
				// on ticket creation" behavior. Unopened / bulk-approved creates
				// fall back to drafting from the transcript as before.
				const isPredrafted =
					change.predrafted === true &&
					Boolean(
						change.description?.to || change.acceptanceCriteria?.to,
					);
				const predraftKind: "BUG" | "FEATURE" =
					overrideKind ?? (change.type === "bug" ? "BUG" : "FEATURE");
				const { story } = await createStoryFromProposal({
					projectId: input.projectId,
					organizationId,
					createdById: user.id,
					title: change.title.to,
					...(isPredrafted
						? {
								kind: predraftKind,
								skipClassifier: true,
								skipDrafting: true,
								bodyAlreadyDrafted: true,
								description: change.description?.to,
								acceptanceCriteria:
									change.acceptanceCriteria?.to,
								needsMoreInfo:
									change.needsMoreInfo ?? undefined,
							}
						: {
								kind: effectiveKindHint,
								skipClassifier: overrideKind !== undefined,
								additionalContext,
							}),
					priority: mapPriority(change.priority?.to),
					size: mapSize(change.size?.to),
					labels,
					draftingStage: "PLACEHOLDER",
					source: "APPROVED_PROPOSAL",
					// F-171: attribute the new story back to its Teams origin
					// (REQ-8, AC13). The classifier inside createStoryFromProposal
					// determines the canonical kind regardless of change.type —
					// we don't pass change.type as a kind hint because the
					// analyzer's `bug`/`feature`/`story` tag predates the
					// classifier and may not match its decision.
					reporterSource: "TEAMS",
					reporterSourceUrl,
					reporterName,
					// Record which proposal produced this item so the roadmap
					// can link back to it. Written inside the creating INSERT,
					// so an approved change can never lose its provenance.
					createdFromProposalId: input.proposalId,
					// Persist the per-row PM-sync gate on the new story so
					// later Fabric edits also push to the PM tool (see
					// `[[project_pm_sync_gate]]`). Without this, subsequent
					// edits would silently diverge after the initial push.
					// Match the enqueue gate: stamp on whenever the row will
					// actually be PM-pushed (PM configured + not opted out).
					enablePmAutoSync:
						input.syncToPM !== false &&
						!!project.projectManagementMcpConfigId &&
						!!project.projectManagementContainerId
							? true
							: undefined,
				});
				createdStoryIds.push(story.id);
				if (sourceMeetingTranscript) {
					// Post-create stamp (not a createStoryFromProposal param) to keep the
					// shared lib's signature untouched. Best-effort by design: its own
					// try/catch (mirroring the attachment patch_description handler
					// below) so a transient failure here only loses provenance — which
					// the backfill script re-derives — and never aborts the batch or
					// skips appendAppliedChangeIndexes for a story that WAS created.
					try {
						await db.userStory.update({
							where: { id: story.id },
							data: {
								sourceMeetingTranscriptId:
									sourceMeetingTranscript.id,
							},
						});
					} catch (stampErr) {
						logger.warn(
							"[meeting-provenance] stamp_source_meeting",
							{
								span: "meeting-provenance",
								step: "stamp_source_meeting",
								source: "teams",
								outcome: "failed",
								proposalId: proposal.id,
								projectId: input.projectId,
								storyId: story.id,
								sourceMeetingTranscriptId:
									sourceMeetingTranscript.id,
								errorName:
									stampErr instanceof Error
										? stampErr.name
										: "Unknown",
								errorMessage:
									stampErr instanceof Error
										? stampErr.message
										: String(stampErr),
							},
						);
					}
				}
				// #1902 FR7/AC9: a ticket created FROM an action item is linked
				// to it at creation time. Best-effort with the same discipline as
				// the provenance stamp above — losing a link must never abort the
				// batch or skip appendAppliedChangeIndexes for a story that WAS
				// created. No-ops for proposals not born from a single action item.
				try {
					await linkStoryToSourceActionItem({
						projectId: input.projectId,
						sourceMetadata: proposal.sourceMetadata,
						storyId: story.id,
						createdById: user.id,
					});
				} catch (linkErr) {
					logger.warn(
						"[meeting-provenance] link_source_action_item",
						{
							span: "meeting-provenance",
							step: "link_source_action_item",
							source: "teams",
							outcome: "failed",
							proposalId: proposal.id,
							projectId: input.projectId,
							storyId: story.id,
							errorName:
								linkErr instanceof Error
									? linkErr.name
									: "Unknown",
							errorMessage:
								linkErr instanceof Error
									? linkErr.message
									: String(linkErr),
						},
					);
				}
				freshlyApplied.push(index);
				await appendAppliedChangeIndexes(input.proposalId, [index]);

				// Audit trail (AI Backlog change history) — proposal content is
				// AI-generated, so attribute the create to the AI agent. Shows as
				// "AI" in the read-only Audit tab. Fire-and-forget.
				recordAuditFromRequest(context, {
					action: "story.created",
					category: "story",
					actor: {
						type: "agent",
						userId: user.id,
						nameSnapshot: "Fabric AI",
					},
					organizationId,
					projectId: input.projectId,
					resource: {
						type: "story",
						id: story.id,
						name: change.title.to,
					},
					metadata: {
						source: "APPROVED_PROPOSAL",
						reporterSource: "TEAMS",
						kind: change.type,
					},
				});

				// Record on the in-batch dedup index so the analyzer's
				// occasional same-batch duplicate (two paraphrased CREATEs
				// of the same item) is caught on the next iteration.
				dedupGuard.recordCreated(dedupFamily, change.title.to, {
					id: story.id,
					identifier: story.identifier,
				});

				// Chat-thread image attachments (spec § 4.6, § 8.6, FR-18,
				// FR-23). Only fires when the proposal carries Teams image
				// refs in `sourceMetadata.attachments`. Defense-in-depth
				// try/catch — `attachPendingMediaToStory` already catches its
				// own exceptions and never throws (FR-23), but a logger fault
				// or unexpected synchronous throw must NOT take down the
				// approve handler.
				if (teamsAttachmentRefs.length > 0) {
					// Resolve the Microsoft Graph access token once per
					// approval. The token belongs to the channel-monitor
					// owner (proposal.userId / proposal.organizationId), not
					// the approving user — mirrors `executeMicrosoftTeamsTool`.
					if (
						teamsAccessToken === null &&
						teamsCredentialResolutionError === null
					) {
						try {
							const tokenSubjectUserId =
								proposal.userId ?? user.id;
							const tokenSubjectOrgId =
								proposal.organizationId ??
								organizationId ??
								undefined;
							const creds = await getMicrosoftAccessToken(
								tokenSubjectUserId,
								tokenSubjectOrgId ?? undefined,
							);
							teamsAccessToken = creds.accessToken;
						} catch (credErr) {
							teamsCredentialResolutionError =
								credErr instanceof Error
									? credErr
									: new Error(
											"Failed to resolve Microsoft Graph credentials",
										);
							logger.warn(
								"[chat-thread-attachments] teams credential lookup failed",
								{
									span: "chat-thread-attachments",
									step: "download",
									outcome: "failed",
									source: "teams",
									proposalId: proposal.id,
									projectId: input.projectId,
									storyId: story.id,
									errorName: redactErrorName(
										teamsCredentialResolutionError,
									),
								},
							);
							// Record one warning per attachment ref so the UI
							// surfaces the failure mode (defense-in-depth —
							// the orchestrator would emit the same shape).
							for (const ref of teamsAttachmentRefs) {
								cumulativeWarnings.push({
									source: "teams",
									refId: refIdOfTeams(ref),
									reason: "download_failed",
								});
							}
						}
					}

					// Even when the orchestrator never runs (credential lookup
					// failed), patch the story's description with the same
					// `## Attachments` warning line the orchestrator would have
					// emitted on a download failure (spec § 4.6 step 6, § 4.8).
					// Without this the `⚠ M` chip shows on the proposal card
					// but the reviewer who opens the story sees nothing about
					// the missing attachments — exactly what FR-23 (no silent
					// failure) is meant to prevent. Idempotent thanks to
					// `appendWarningLinesToAttachmentsBlock`'s `.includes`
					// dedup.
					if (teamsCredentialResolutionError !== null) {
						const warningLines = formatAttachmentWarningLines(
							teamsAttachmentRefs.map((ref) => ({
								source: "teams" as const,
								refId: refIdOfTeams(ref),
								reason: "download_failed" as const,
							})),
						);
						const baseDescription = story.description ?? "";
						const patchedDescription =
							appendWarningLinesToAttachmentsBlock(
								baseDescription,
								warningLines,
							);
						if (patchedDescription !== baseDescription) {
							try {
								await updateStory(
									story.id,
									input.projectId,
									{ description: patchedDescription },
									{
										userId: user.id,
										organizationId:
											organizationId ?? undefined,
										changedBy: user.id,
										changeDescription:
											"Record chat-thread attachment warnings (Microsoft Graph credential lookup failed)",
										lastEditedByName: user.name ?? null,
										lastEditedSource: "AI_BACKLOG_UPDATE",
									},
								);
							} catch (patchErr) {
								logger.warn(
									"[chat-thread-attachments] patch_description",
									{
										span: "chat-thread-attachments",
										step: "patch_description",
										source: "teams",
										outcome: "failed",
										proposalId: proposal.id,
										projectId: input.projectId,
										storyId: story.id,
										errorName:
											patchErr instanceof Error
												? patchErr.name
												: "Unknown",
									},
								);
							}
						}
					}

					if (
						teamsAccessToken !== null &&
						teamsCredentialResolutionError === null
					) {
						const startedAt = Date.now();
						try {
							const { uploaded, warnings } =
								await attachPendingMediaToStory({
									proposal: {
										id: proposal.id,
										sourceMetadata:
											filterSourceMetadataForTeams(
												proposal.sourceMetadata,
												teamsAttachmentRefs,
											),
									},
									story: {
										id: story.id,
										description: story.description ?? null,
									},
									source: "teams",
									accessToken: teamsAccessToken,
									projectId: input.projectId,
									organizationId: organizationId ?? null,
									userId: user.id,
									userName: user.name ?? null,
									logger,
									...(teamsMessageUrlBuilder
										? { teamsMessageUrlBuilder }
										: {}),
								});
							for (const w of warnings) {
								cumulativeWarnings.push(
									w as AttachmentWarningRecord,
								);
							}
							logger.info(
								"[chat-thread-attachments] approve_orchestrator",
								{
									span: "chat-thread-attachments",
									step: "approve_orchestrator",
									source: "teams",
									outcome: "success",
									proposalId: proposal.id,
									projectId: input.projectId,
									storyId: story.id,
									durationMs: Date.now() - startedAt,
									uploadedCount: uploaded.length,
									warningCount: warnings.length,
								},
							);
						} catch (err) {
							logger.warn(
								"[chat-thread-attachments] approve_orchestrator",
								{
									span: "chat-thread-attachments",
									step: "approve_orchestrator",
									source: "teams",
									outcome: "failed",
									proposalId: proposal.id,
									projectId: input.projectId,
									storyId: story.id,
									durationMs: Date.now() - startedAt,
									uploadedCount: 0,
									warningCount: 0,
									errorName: redactErrorName(err),
								},
							);
						}
					}
				}

				// Wire the initial PM push for newly-approved stories. Without
				// this, the row lands in Fabric, the roadmap shows it as
				// Unsynced, and no workflow ever runs to push it to Fizzy/etc.
				// Gate: sync when the project has a PM tool configured AND
				// the caller did not explicitly opt out via `syncToPM: false`.
				// `undefined` means "no opinion" → default to syncing, matching
				// the user-visible promise that approvals with a configured
				// PM tool reach that tool. Failures stamp the row FAILED via
				// `enqueuePmSync`'s own `markFailed` path so the roadmap badge
				// stays honest; we never throw out of the loop.
				const shouldEnqueueSync =
					input.syncToPM !== false &&
					project.projectManagementMcpConfigId &&
					project.projectManagementContainerId;
				if (shouldEnqueueSync) {
					const itemTypeForEnqueue =
						story.kind === "BUG" ? "bug" : "story";
					try {
						const enqueueResult = await enqueuePmSync({
							itemId: story.id,
							itemType: itemTypeForEnqueue,
							projectId: input.projectId,
							userId: user.id,
							forceInitialPush: true,
							triggerSource: "auto-push",
						});
						logger.info(
							"[approvePendingProposal:teams] enqueued PM sync for created story",
							{
								proposalId: input.proposalId,
								storyId: story.id,
								changeIndex: index,
								enqueued: enqueueResult.enqueued,
								reason: enqueueResult.reason,
								workflowId: enqueueResult.workflowId,
							},
						);
					} catch (enqueueErr) {
						// `enqueuePmSync` swallows its own errors and returns
						// a typed reason; an exception here is genuinely
						// unexpected. Log and continue — the row is already
						// persisted, and `enqueuePmSync` itself stamped
						// `lastPmSyncStatus = FAILED` on the row if the
						// failure happened past the markPending step.
						logger.warn(
							"[approvePendingProposal:teams] enqueuePmSync threw — story persisted without sync attempt",
							{
								proposalId: input.proposalId,
								storyId: story.id,
								changeIndex: index,
								errorName:
									enqueueErr instanceof Error
										? enqueueErr.name
										: "Unknown",
								message:
									enqueueErr instanceof Error
										? enqueueErr.message
										: String(enqueueErr),
							},
						);
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error
						? err.message
						: "Failed to create story from proposal";
				console.error(
					"[approvePendingProposal] create failed:",
					msg,
					err,
				);
				createErrors.push(msg);
				// Do NOT continue: fail-fast so later creates don't run
				// alongside a known failure.
				break;
			}
		}

		// Persist the apply-time warning ledger once per approval (spec § 4.6
		// step 8). Idempotent: if the proposal has no warnings AND no prior
		// warnings, the query is a no-op write.
		if (teamsAttachmentRefs.length > 0) {
			try {
				await setPendingProposalAttachmentResult(
					input.proposalId,
					cumulativeWarnings,
				);
				logger.info("[chat-thread-attachments] persist_warnings", {
					span: "chat-thread-attachments",
					step: "persist_warnings",
					source: "teams",
					outcome: "success",
					proposalId: proposal.id,
					projectId: input.projectId,
					warningCount: cumulativeWarnings.length,
				});
			} catch (err) {
				// Persist failure does NOT block the approval. The user-facing
				// approve response must succeed even when the warning ledger
				// can't be written (FR-23).
				logger.warn("[chat-thread-attachments] persist_warnings", {
					span: "chat-thread-attachments",
					step: "persist_warnings",
					source: "teams",
					outcome: "failed",
					proposalId: proposal.id,
					projectId: input.projectId,
					errorName: redactErrorName(err),
				});
			}
		}

		// 2. Bail if any creates failed — don't apply partial updates
		if (createErrors.length > 0) {
			// Classify the first reported error so the inbox + roadmap banner
			// can show plain-English copy. Raw text retained on `applyError`.
			const joinedErrors = createErrors.join("\n");
			const classified = unwrapPmSyncError(
				new Error(createErrors[0] ?? "create failed"),
			);
			await markPendingProposalFailed(input.proposalId, {
				errorClass: classified.errorClass,
				errorMessage: classified.message,
				rawApplyError: joinedErrors,
			});
			return {
				approvedChangeIds: input.approvedChanges.map((_c, i) =>
					String(i),
				),
				createdStoryIds,
				updateWorkflowId: null,
				status: "failed" as const,
				errors: createErrors,
				skipped,
			};
		}

		// 2b. Monitored-channel proposals are "capture as-is": the analyzer only
		//     proposes CREATE changes (allowUpdates:false) — never an update to an
		//     existing ticket. Genuine near-duplicates are still surfaced for the
		//     reviewer: the exact-title guard above drops title collisions, and this
		//     runs semantic duplicate detection over the just-created stories so
		//     different-title lookalikes get flagged as PENDING StoryDuplicateLinks
		//     → the roadmap "Possible duplicate" chip + Merge/Dismiss dialog (a flag
		//     for the PM, NOT an auto-merge). Fire-and-forget, retried Temporal workflow.
		if (createdStoryIds.length > 0) {
			await triggerDuplicateDetection({
				projectId: input.projectId,
				userId: user.id,
				organizationId,
				targetStoryIds: createdStoryIds,
			});
		}

		// 3. Dispatch UPDATE changes. We pass `pendingProposalId` into the
		//    workflow so it flips terminal state (APPLIED/FAILED) when the
		//    apply + PM-sync finishes. The approval row stays APPROVED
		//    until the workflow reports back — inbox queries include
		//    APPROVED so in-flight proposals remain visible.
		let updateWorkflowId: string | null = null;
		if (updates.length > 0) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const workflowId = backlogApplyWorkflowId(input.projectId);
				const handle = await client.workflow.start(
					"backlogApplyChangesWorkflow",
					withCorrelationMemo({
						taskQueue: "ai-chat",
						workflowId,
						args: [
							{
								projectId: input.projectId,
								userId: user.id,
								approvedByName: user.name ?? null,
								organizationId:
									organizationId ??
									project.organizationId ??
									undefined,
								approvedChanges: updates.map((u) => u.change),
								approvedChangeIndexes: updates.map(
									(u) => u.index,
								),
								pendingProposalId: input.proposalId,
								syncToPM: input.syncToPM,
								// Bug 1429 / Codex round 4: gated on proposal.source
								// (computed above). For the three monitored-channel
								// sources the apply activity normalizes any `epic`
								// change to a feature; for AI_UPDATE_SIDEBAR (routed
								// here via the inbox default) epics stay first-class.
								forbidEpics,
								pmConfig: input.pmConfig
									? {
											...input.pmConfig,
											containerName:
												project.projectManagementContainerName ??
												undefined,
										}
									: undefined,
							},
						],
					}),
				);
				updateWorkflowId = handle.workflowId;
				// Persist only the workflow id — DO NOT call
				// markPendingProposalApproved again. If the workflow finalized
				// APPLIED/FAILED between handle.start() and this line, this
				// update keeps the terminal status intact and just stamps the
				// workflow reference for traceability.
				try {
					await setProposalApplyWorkflowId(
						input.proposalId,
						updateWorkflowId,
					);
				} catch (persistErr) {
					// Non-fatal — the workflow is still running and will flip
					// terminal state via finalizePendingProposalActivity.
					console.error(
						"[approvePendingProposal] failed to persist applyWorkflowId (non-fatal):",
						persistErr,
					);
				}
			} catch (err) {
				const msg =
					err instanceof Error
						? err.message
						: "Failed to start backlog apply workflow";
				console.error(
					"[approvePendingProposal] apply workflow start failed:",
					msg,
					err,
				);
				// Same classifier the workflow uses on FAILED transitions so
				// inbox + banner copy stays consistent across error paths.
				const classified = unwrapPmSyncError(err);
				await markPendingProposalFailed(input.proposalId, {
					errorClass: classified.errorClass,
					errorMessage: classified.message,
					rawApplyError: msg,
				});
				return {
					approvedChangeIds: input.approvedChanges.map((_c, i) =>
						String(i),
					),
					createdStoryIds,
					updateWorkflowId: null,
					status: "failed" as const,
					errors: [msg],
					skipped,
				};
			}
		}

		// 3. Terminal transitions:
		//    - Updates dispatched → stays APPROVED (workflow flips APPLIED/FAILED)
		//    - Creates-only, all succeeded → APPLIED now
		let finalStatus: "applied" | "pending";
		if (updateWorkflowId) {
			finalStatus = "pending";
		} else {
			await markPendingProposalApplied(input.proposalId);
			finalStatus = "applied";
		}

		// Server-authoritative override log: the reviewer accepted this proposal.
		// If it carries unresolved decision-contradiction findings, record one
		// immutable row per conflicting decision. Flag-gated + best-effort inside
		// the helper; only reached on the success path (failures returned above).
		// Filter to findings whose change was actually approved+applied (title
		// correlation against `approvedChanges`, mirroring the AI-Update apply
		// path) — a reviewer who DESELECTED the conflicting change logs no
		// override for it.
		const persistedPrecheck = extractDecisionPrecheck(
			(proposal.sourceMetadata as Record<string, unknown> | null)
				?.decisionPrecheck,
		);
		recordDecisionOverridesAccepted(context, {
			projectId: input.projectId,
			organizationId,
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			artifactId: proposal.id,
			precheck: persistedPrecheck
				? filterFindingsToApprovedChanges(
						persistedPrecheck,
						input.approvedChanges,
					)
				: persistedPrecheck,
			resolveSnapshot: (finding) =>
				backlogChangeSnapshot(proposalChanges, finding),
		});

		return {
			approvedChangeIds: input.approvedChanges.map((_c, i) => String(i)),
			createdStoryIds,
			updateWorkflowId,
			status: finalStatus,
			errors: createErrors,
			skipped,
		};
	});

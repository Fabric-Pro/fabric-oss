/**
 * Backlog Context Analysis Activities
 *
 * Core LLM analysis activity that takes fetched context (Teams messages,
 * meeting transcripts, Notion pages, RAG results) plus the existing backlog
 * and produces structured change proposals.
 *
 * Also includes applyBacklogChanges() which creates/updates items in Fabric DB
 * from approved change proposals.
 */
import type { DecisionPrecheckResult } from "@repo/agent-types";
import {
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module (uniform rule across the budget sites).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	db,
	getBoundPromptForAgent,
	isTerminalWorkItemState,
	normalizeBacklogTitle,
	recordAudit,
	TERMINAL_DRAFTING_STAGES,
	tenantWhere,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, Context, heartbeat } from "@temporalio/activity";
import { z } from "zod";
import { classifyBacklogAnalysisError } from "../../lib/classify-analysis-error";
import { createStoryFromProposal } from "../../lib/create-story-from-proposal";
import { runDecisionPrecheck } from "../../lib/decision-precheck";
import { reanalyzeBodyByKind } from "../../lib/reanalyze-body-by-kind";
import {
	type ResolvableBacklogItem,
	resolveBacklogUpdateTarget,
} from "../../lib/resolve-backlog-update-target";
import { detectDestructiveRewrite } from "../../lib/structure-guards";
import { triggerDuplicateDetection } from "../../lib/trigger-duplicate-detection";
import { routeActionItemsToExistingTickets } from "./route-action-items";

// =============================================================================
// Schemas
// =============================================================================

/**
 * Diff-shaped field `{from?, to}` that also tolerates a plain string from the
 * LLM. For create actions the model frequently emits `field: "..."` instead of
 * `field: {to: "..."}`. Coerce so downstream consumers can keep reading
 * `change.field.to` without normalizing per call site.
 */
function diffField(toDescription: string, fromDescription = "Current value") {
	return z.preprocess(
		(v) => (typeof v === "string" ? { to: v } : v),
		z.object({
			from: z.string().nullable().optional().describe(fromDescription),
			to: z.string().describe(toDescription),
		}),
	);
}

/**
 * One proposed change, as the model is asked to produce it.
 *
 * Named, exported and reused so the array can validate ELEMENT-WISE (see
 * `dropUnusableChanges`) and so callers can introspect one change without
 * reaching through the array wrapper.
 */
export const backlogChangeItemSchema = z.object({
	// This is the analyzer's GENERATION output schema (used by
	// `generateObject` below). Fabric supports two work-item types —
	// "feature" and "bug" — so "story" is intentionally absent: the
	// model cannot emit a User Story. ("epic" stays only as an input
	// the apply activity normalizes to "feature"; the Epic/Feature
	// folder tables were dropped.) Legacy PendingBacklogProposal rows
	// that still carry `type: "story"` are parsed by the approve-flow
	// schemas, not this one, and the apply activity normalizes them
	// into the "feature" leaf path.
	type: z.enum(["epic", "feature", "bug"]),
	action: z.enum(["create", "update"]),
	existingId: z
		.string()
		.nullable()
		.optional()
		.describe("Fabric DB ID of the existing item (for updates)"),
	existingIdentifier: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Fabric identifier like EPIC-001, FEAT-002, F-003 (for updates)",
		),
	existingExternalId: z
		.string()
		.nullable()
		.optional()
		.describe("External PM tool ID (for updates)"),
	title: diffField("New or updated title", "Current title (for updates)"),
	description: diffField(
		"New or updated description",
		"Current description",
	).optional(),
	acceptanceCriteria: diffField(
		"New or updated acceptance criteria",
		"Current acceptance criteria",
	).optional(),
	priority: diffField(
		"Priority: P0_CRITICAL, P1_HIGH, P2_MEDIUM, or P3_LOW",
	).optional(),
	size: diffField("Size estimate: XS, S, M, L, or XL").optional(),
	parentEpicIdentifier: z
		.string()
		.nullable()
		.optional()
		.describe("Identifier of the parent epic (e.g. EPIC-001) for features"),
	parentFeatureIdentifier: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Identifier of the parent feature (e.g. FEAT-001) for stories",
		),
	parentEpicTitle: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Title of the parent epic (used when creating new epics inline)",
		),
	parentFeatureTitle: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Title of the parent feature (used when creating new features inline)",
		),
	// OPTIONAL ON PURPOSE, and it is a bug fix rather than a loosening.
	//
	// Both fields are narrative annotation: nothing downstream needs
	// either one to apply a change. Every consumer already guards them
	// (`change.reasoning ? … : ""` in structurePreserveUpdates and
	// applyBacklogChanges), and the sibling `routing.reasoning` below is
	// already `.nullable().optional()`.
	//
	// This is the GENERATION schema, though, so a required field here is
	// not a validation rule — it is a liveness condition on the model.
	// When it omitted one sentence, `generateObject` threw a ZodError and
	// the WHOLE run died, discarding every other valid change in the same
	// response. Measured on staging 18 Aug 2026: 3 of 9 live AI Update
	// runs lost, on both the imported and team-synced lanes.
	reasoning: z
		.string()
		.nullable()
		.optional()
		.describe("Why this change is proposed, referencing specific context"),
	sourceContext: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Which context source(s) informed this change (e.g. teams_messages, meeting_transcript, notion_page, or multiple)",
		),
	/**
	 * Inline PM override of the AI classifier's kind decision. NOT
	 * filled by the analyzer LLM — supplied by the approval UI when a
	 * reviewer picks a different kind than the classifier's default.
	 * Honored by `applyBacklogChanges` for create rows: passes
	 * `kind` + `skipClassifier: true` to createStoryFromProposal so
	 * the reviewer's choice bypasses the classifier.
	 */
	kindOverride: z
		.enum(["BUG", "FEATURE"])
		.nullable()
		.optional()
		.describe(
			"Reviewer's explicit kind selection from the approval UI. Never set by the analyzer.",
		),
	/**
	 * Resolution annotation stamped AFTER generation (never by the
	 * analyzer LLM). Records whether an `action:"update"` resolves to a
	 * real backlog item, the canonical identity to display, and whether
	 * the change was demoted update→create because no item matched.
	 */
	targetResolution: z
		.object({
			status: z.enum(["resolved", "unresolved"]),
			resolvedBy: z
				.enum(["id", "identifier", "externalId", "title"])
				.nullable()
				.optional(),
			resolvedIdentifier: z.string().nullable().optional(),
			resolvedTitle: z.string().nullable().optional(),
			demotedFromUpdate: z.boolean().optional(),
		})
		.nullable()
		.optional()
		.describe(
			"Post-generation resolution annotation. Never set by the analyzer.",
		),
	/**
	 * Set AFTER generation by the structure-preserving update pass (never
	 * by the analyzer LLM). True when AI could not safely produce a
	 * targeted, structure-preserving edit and the existing body was kept
	 * unchanged ("safe-hold"). Surfaced in the review UI as a note so the
	 * reviewer knows the description was intentionally left as-is.
	 */
	bodyMergeFallback: z
		.boolean()
		.optional()
		.describe(
			"Post-generation safe-hold flag for the structure-preserving update pass. Never set by the analyzer.",
		),
	/**
	 * Set AFTER generation by the analysis-time structure-preserving pass
	 * when it has already merged this update's body. The apply activity
	 * reads it to avoid re-merging (no double LLM call). When absent — e.g.
	 * a proposal that bypassed `analyzeContextAndPropose` (the chat agent's
	 * "skip analysis" shortcut) — apply runs the merge itself so every
	 * update body is structure-preserved regardless of its origin. Never
	 * set by the analyzer.
	 */
	structurePreserved: z
		.boolean()
		.optional()
		.describe(
			"Post-generation flag: this update's body was already structure-preserved at analysis time. Never set by the analyzer.",
		),
	/**
	 * Set by the review UI when a CREATE proposal's body was already
	 * drafted through the kind-appropriate prompt at review time (lazy
	 * draft on open). Apply then persists the body verbatim instead of
	 * re-drafting at create time — including for bugs, carrying
	 * `needsMoreInfo` below. Never set by the analyzer.
	 */
	predrafted: z
		.boolean()
		.optional()
		.describe(
			"Post-generation flag: this create's body was drafted at review time; apply must not re-draft. Never set by the analyzer.",
		),
	/**
	 * Bug triage flag captured by the review-time draft, carried so a
	 * pre-drafted bug keeps `needsMoreInfo` without re-running the prompt.
	 */
	needsMoreInfo: z.boolean().optional(),
	/**
	 * Create-vs-Enrich routing annotation, stamped AFTER generation by
	 * `routeActionItemsToExistingTickets` (never by the analyzer LLM) for
	 * the capture-as-is ingestion flows. Records the classification, the
	 * matched ticket, the judge's confidence, and the ranked shortlist the
	 * review UI offers when the reviewer overrides the decision.
	 *
	 * `error` is set when the evaluation itself failed: the item stays a
	 * create, and the review UI shows an error state rather than implying
	 * the item was judged net-new.
	 */
	routing: z
		.object({
			decision: z.enum(["create", "enrich"]),
			confidence: z.number().min(0).max(1),
			matchedStoryId: z.string().nullable().optional(),
			matchedIdentifier: z.string().nullable().optional(),
			matchedTitle: z.string().nullable().optional(),
			reasoning: z.string().nullable().optional(),
			/**
			 * The action item AS CAPTURED, before an enrich adopted the
			 * target ticket's title and before the structure-preserving pass
			 * rewrote the body into a merge against that ticket.
			 *
			 * This is what the reviewer's override re-submits. Without it, a
			 * reviewer who re-targets the enrichment at a different ticket
			 * would send the body already merged for the FIRST ticket, and
			 * apply would write that ticket's content onto the new one.
			 */
			proposedTitle: z.string().nullable().optional(),
			proposedDescription: z.string().nullable().optional(),
			proposedAcceptanceCriteria: z.string().nullable().optional(),
			/** Ranked shortlist backing the override picker's suggestions. */
			alternatives: z
				.array(
					z.object({
						storyId: z.string(),
						identifier: z.string(),
						title: z.string(),
						similarity: z.number(),
					}),
				)
				.optional(),
			/** Set by the review UI when the reviewer changed the routing. */
			overridden: z.boolean().optional(),
			error: z.string().nullable().optional(),
		})
		.nullable()
		.optional()
		.describe(
			"Post-generation Create/Enrich routing annotation. Never set by the analyzer.",
		),
});

/**
 * Drop the changes the model malformed; keep the ones it got right.
 *
 * `generateObject` validates the WHOLE response, so anything wrong anywhere in
 * `changes` rejects the lot — every valid change in the same response included.
 * Measured on staging: runs lost that way on both the imported-meeting and
 * team-synced lanes, first on a missing `reasoning` string (18 Aug, fixed by
 * making the field optional) and then, once that was gone, on an element that
 * was not an object at all:
 *
 *   ZodError: expected "object", code "invalid_type", path ["changes", 1]
 *
 * Relaxing fields one at a time cannot close that: it treats instances of a
 * class. No schema can enumerate every way a model might malform an element,
 * and the cost of each miss is the entire response rather than one item. So the
 * array salvages instead — a run returns whatever the model got right.
 *
 * The array ITSELF stays strict. A response carrying no `changes` at all is a
 * wholesale generation failure, and quietly reporting 'nothing proposed' would
 * hide it; only individual elements are salvageable.
 */
function dropUnusableChanges(value: unknown): unknown {
	if (!Array.isArray(value)) {
		// Not our problem to fix — let the array schema reject it.
		return value;
	}

	const usable = value.filter(
		(entry) => backlogChangeItemSchema.safeParse(entry).success,
	);

	if (usable.length !== value.length) {
		// Never silent: the operator log is the only place a dropped change is
		// visible, since the user just sees a smaller (but valid) proposal.
		logger.warn(
			"[Backlog Analysis] Discarded malformed changes from the model response",
			{
				discarded: value.length - usable.length,
				kept: usable.length,
			},
		);
	}

	return usable;
}

/**
 * Change proposal schema for generateObject.
 * Defines the structured output the LLM must produce.
 */
export const ChangeProposalSchema = z.object({
	summary: z
		.string()
		.optional()
		.default("")
		.describe("High-level summary of all proposed changes"),
	contextSummary: z
		.string()
		.optional()
		.default("")
		.describe(
			"Summary of the context sources analyzed (what was discussed, decided, etc.)",
		),
	changes: z.preprocess(
		dropUnusableChanges,
		z.array(backlogChangeItemSchema),
	),
});

/**
 * A generated change proposal plus the async decision pre-check result. The
 * pre-check field is a POST-hoc type intersection, deliberately NOT part of
 * `ChangeProposalSchema`: it is stamped AFTER generation (never emitted by the
 * analyzer LLM), so keeping it off the `generateObject` contract avoids forcing
 * a strict-enum field into the model's output schema and prevents a model-echoed
 * value from ever surviving `.parse`. The sidebar renders these findings from the
 * workflow result before a row exists; the monitor paths fold them into
 * `sourceMetadata.decisionPrecheck`.
 */
export type ChangeProposal = z.infer<typeof ChangeProposalSchema> & {
	decisionConflicts?: DecisionPrecheckResult;
};

/**
 * Flatten a proposed change into the plain text the decision pre-check judges
 * against — the reviewer-facing fields (`to` sides of the diff shapes) plus the
 * analyzer's reasoning. Empty/blank fields are skipped.
 */
function buildChangePrecheckText(
	change: ChangeProposal["changes"][number],
): string {
	return [
		change.title?.to,
		change.description?.to,
		change.acceptanceCriteria?.to,
		change.reasoning,
	]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.join("\n\n");
}

/**
 * Build the decision pre-check artifact items for a set of proposed changes —
 * one entry per change, `ref.index` preserving the change's position in the
 * proposal so a finding can be attached back to the exact change. Shared by the
 * inline monitor pre-check and the async AI-Update `runBacklogDecisionPrecheckActivity`
 * so both surfaces judge identical inputs.
 */
export function buildBacklogPrecheckItems(
	changes: ChangeProposal["changes"],
): Array<{ ref: { index: number; title?: string }; text: string }> {
	return changes.map((change, index) => ({
		ref: { index, title: change.title?.to },
		text: buildChangePrecheckText(change),
	}));
}

// =============================================================================
// Input Types
// =============================================================================

export interface AnalyzeContextInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	fetchedContext: FetchedContextInput;
	/**
	 * The flat list of existing work items. `user_story` is the only work-item
	 * table — the Epic/Feature folder tables were dropped, so the backlog has
	 * no container hierarchy. Workflow callers that still construct legacy
	 * `epics`/`features` arrays remain structurally assignable; those arrays
	 * are ignored.
	 */
	existingBacklog: {
		stories: Array<{
			id: string;
			identifier: string;
			title: string;
			description?: string | null;
			acceptanceCriteria?: string | null;
			priority?: string | null;
			size?: string | null;
			externalId?: string | null;
		}>;
	};
	pmWorkItems?: {
		epics: Array<{
			id: string;
			title?: string;
			description?: string | null;
			url?: string | null;
		}>;
		features: Array<{
			id: string;
			title?: string;
			description?: string | null;
			url?: string | null;
		}>;
		stories: Array<{
			id: string;
			title?: string;
			description?: string | null;
			url?: string | null;
		}>;
	};
	userPrompt: string;
	/** Detected PM tool type (e.g. "fizzy", "azure-devops"). Used to constrain proposed change types. */
	pmToolType?: string;
	/**
	 * DEPRECATED — retained for caller compatibility only; the value is
	 * ignored. The Epic/Feature folder tables were dropped, so the analyzer
	 * NEVER offers `type: "epic"`: the prompt always carries the explicit
	 * "do not propose epic" constraint (previously the `allowEpics: false`
	 * channel-monitor behavior, Bug 1429) and any epic the model emits anyway
	 * is normalized to a feature by `applyBacklogChanges`.
	 */
	allowEpics?: boolean;
	/**
	 * Whether the analyzer may propose `action: "update"` items (modify/merge an
	 * existing backlog item). Defaults to `true` to preserve the AI Update +
	 * document analyzer + Azure DevOps sync behavior, where comparing context
	 * against the backlog and proposing updates is the whole point.
	 *
	 * The monitored-channel feature-proposal flow (Teams/Slack) passes `false`:
	 * it is a "capture as-is" pathway that must ONLY create new work items —
	 * never suggest updating, merging, or deduplicating against existing
	 * tickets. When `false`, the update-bearing prompt rules are replaced with
	 * create-only guidance, an explicit CREATE-ONLY constraint is added, and any
	 * `action: "update"` the model emits anyway is dropped before the proposal
	 * is returned. Mirrors the `allowEpics` gate.
	 */
	allowUpdates?: boolean;
	/**
	 * Whether this flow permits the Create-vs-Enrich routing pass to run over
	 * the create-only proposal it produced, so an action item that is really
	 * additional detail on work the project already tracks is proposed as an
	 * enrichment of that ticket instead of a duplicate new one.
	 *
	 * Only meaningful alongside `allowUpdates: false` — the capture-as-is
	 * ingestion flows set it. `allowUpdates: true` callers (AI Update, document
	 * analyzer, ADO sync) already compare against the backlog inside the
	 * analyzer prompt and must not have a second, contradictory pass run over
	 * their result.
	 *
	 * This is the FLOW's permission, not the project's: whether routing actually
	 * happens is decided inside the pass, which reads
	 * `Project.actionItemRoutingEnabled` itself. Defaults to `false`, so every
	 * existing caller keeps today's behaviour untouched.
	 */
	allowRouting?: boolean;
	/**
	 * Skip the INLINE decision pre-check so the proposal returns immediately.
	 *
	 * The pre-check is a second COMPLEX LLM judge call (up to
	 * `DECISION_PRECHECK_TIMEOUT_MS`) that only DECORATES an already-formed
	 * proposal. The monitored-channel sources (Slack/Teams/meeting) run it
	 * inline (default `false`) because they are background jobs with no user
	 * waiting and persist the findings into `sourceMetadata.decisionPrecheck`
	 * at the same time they persist the proposal row.
	 *
	 * The user-interactive AI-Update path passes `true`: card #1365's async NFR
	 * requires generation to proceed immediately and conflicts to surface after,
	 * so the analysis workflow returns the proposal first and runs the judge as a
	 * separate, post-return `runBacklogDecisionPrecheckActivity` (gated by
	 * `patched("backlog-decision-precheck-async-v1")`), then folds the findings
	 * back into its queryable proposal state.
	 */
	deferDecisionPrecheck?: boolean;
}

/**
 * The apply path additionally uses "story" as an INTERNAL reconciliation
 * discriminator for an existing user_story row (an update / type-correction
 * that must resolve in the user_story table), as opposed to "feature" which
 * routes a brand-new feature create. The GENERATION schema never emits
 * "story" — the model is restricted to epic/feature/bug — so this widening
 * only affects server-side reconciliation, never AI output. It also lets
 * legacy PendingBacklogProposal rows that still carry `type: "story"` flow
 * through unchanged; they normalize to the feature leaf at create time.
 */
export type AppliedBacklogChange = Omit<
	ChangeProposal["changes"][number],
	"type"
> & { type: "epic" | "feature" | "story" | "bug" };

export interface ApplyBacklogChangesInput {
	projectId: string;
	userId: string;
	approvedByName?: string | null;
	/**
	 * Organization id for tenant scoping. Required in workflow callers —
	 * without it, the project lookup below defaults to personal-context and
	 * cross-tenant forged projectIds would succeed.
	 */
	organizationId?: string;
	approvedChanges: ChangeProposal["changes"];
	/** Optional -- if not provided, the activity will fetch the hierarchy itself. */
	existingBacklog?: AnalyzeContextInput["existingBacklog"];
	/**
	 * Reflects the AI Update approval's "Sync to PM" choice. When true, every
	 * row created during this apply is stamped `pmAutoSyncEnabled: true` so
	 * subsequent Fabric edits push to the configured PM tool automatically
	 * (see `[[project_pm_sync_gate]]`). The first push itself is still done
	 * by the workflow's per-item `syncWorkItemToPM` loop. Default `false`
	 * preserves the legacy behavior where new rows are Fabric-only.
	 */
	syncToPM?: boolean;
	/**
	 * DEPRECATED — retained for caller compatibility only; the value is
	 * ignored. Epic→feature normalization (originally the channel-monitor
	 * opt-in, Bug 1429) is now UNCONDITIONAL for every caller: the
	 * Epic/Feature folder tables were dropped, so an `epic`-typed change is
	 * always normalized to `feature` and materialized as a roadmap-visible
	 * UserStory(kind=FEATURE) leaf.
	 */
	forbidEpics?: boolean;
	/**
	 * Id of the originating `PendingBacklogProposal` for this apply, stamped
	 * into the AI audit metadata so the read-only Audit history can link a
	 * change back to its `BacklogUpdateSession`. Optional — only the AI Update
	 * apply path threads it; absent for direct/legacy callers.
	 */
	pendingProposalId?: string;
}

export interface ApplyBacklogChangesResult {
	/** Total number of items successfully applied (created + updated). */
	appliedCount: number;
	/**
	 * Map from change array index to created Fabric DB item ID.
	 * Only entries for "create" actions are populated; update entries are absent.
	 */
	createdItemMap: Record<number, string>;
	/**
	 * Map from change array index to resolved Fabric DB item ID for updates.
	 * Populated when an "update" action needed ID resolution (e.g., LLM provided
	 * a PM tool ID instead of a Fabric UUID, and we resolved the correct item).
	 */
	updatedItemMap: Record<number, string>;
	typeCorrections: Record<number, "epic" | "feature" | "story" | "bug">;
	createdItems: Array<{
		type: "epic" | "feature" | "story" | "bug";
		id: string;
		identifier: string;
		title: string;
	}>;
	updatedItems: Array<{
		type: "epic" | "feature" | "story" | "bug";
		id: string;
		identifier: string;
		title: string;
	}>;
	errors: Array<{
		// Public result type stays the (narrow) generated shape so the workflow
		// that consumes `errors[].change` is unchanged. The reconciler only ever
		// reports the original change here; its `.type`/`.title` are read for
		// logging/identity, so the internal "story" discriminator (if any) is
		// cast away at the push site.
		change: ChangeProposal["changes"][number];
		error: string;
	}>;
	/**
	 * Creates skipped by the exact-title dedup guard because an item with the
	 * same normalized title already exists (avoids backlog row-explosion on
	 * repeat AI runs). Reported here — NOT silently swallowed — so callers can
	 * tell the reviewer "skipped: already exists as F-123".
	 */
	skippedDuplicates: Array<{
		type: "epic" | "feature" | "story" | "bug";
		changeIndex: number;
		proposedTitle: string;
		existingId: string;
		existingIdentifier: string;
		existingTitle: string;
	}>;
	/**
	 * Updates that could not be resolved to a real backlog item and were applied
	 * as new creates instead. Reported — NOT silent — so the reviewer is told the
	 * AI's "update FEAT-023" became a brand-new item.
	 */
	convertedToCreate: Array<{
		changeIndex: number;
		proposedTitle: string;
		attemptedReference: string | null;
	}>;
	/**
	 * AI-Update `action:"update"` items whose resolved target was in a terminal
	 * lifecycle state (closed / declined / auto-hidden) and were therefore
	 * redirected into a NEW ticket instead of mutating the immutable record. Each
	 * entry links the closed source to the freshly created ticket (which also
	 * carries a `supersedes:<id>` label + a provenance footer). Optional so
	 * existing result consumers are unaffected.
	 */
	redirectedTerminalUpdates?: Array<{
		changeIndex: number;
		closedId: string;
		closedIdentifier: string;
		newId: string;
		newIdentifier: string;
		proposedTitle: string;
	}>;
	/**
	 * Workflow id of the background semantic duplicate-detection scan enqueued
	 * for the newly created stories/bugs (different-title near-duplicates the
	 * exact-title guard cannot catch). Detection runs in a fire-and-forget,
	 * retried Temporal workflow — see `triggerDuplicateDetection` — and flags
	 * confirmed pairs as PENDING `StoryDuplicateLink`s (the same "Possible
	 * duplicate" chip + Merge/Dismiss dialog as the manual roadmap scan). `null`
	 * when there were no new stories to scan or the enqueue was skipped.
	 */
	duplicateDetectionWorkflowId: string | null;
}

// =============================================================================
// Token Budget Management
// =============================================================================

const MAX_TOKEN_BUDGET = 80_000;
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from a string (rough approximation: 1 token ~ 4 chars).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate text to fit within a token budget.
 * Keeps the beginning of the text (most recent context is usually most relevant).
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
	const maxChars = maxTokens * CHARS_PER_TOKEN;
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n\n[... truncated to fit token budget ...]`;
}

/**
 * Apply progressive truncation to context sections to stay within budget.
 * Priority order (last truncated first): ragContext, notionContent, meetingTranscripts, slackMessages, teamsMessages.
 */
/**
 * The context sections `applyTokenBudget` returns. Both of its exit paths build
 * this by iterating the priority list rather than hand-listing keys: a
 * hand-listed return silently dropped `applicationLogs` on the truncation path
 * only, which is invisible until the budget is actually exceeded.
 */
type ContextSections = {
	teamsMessages?: string;
	slackMessages?: string;
	meetingTranscripts?: string;
	notionContent?: string;
	ragContext?: string;
	securityFindings?: string;
	architectureDecisions?: string;
	/**
	 * Redacted application-log excerpts (Fizzy #1234). Already rendered as a
	 * self-contained prompt section by `@repo/ai/lib/log-context`, which is
	 * also where redaction happened — this activity never sees raw log
	 * content. Absent whenever the feature flag is off or the project has no
	 * log source configured.
	 */
	applicationLogs?: string;
};

/**
 * The same set in the shape the WORKFLOW supplies: two sources arrive as
 * arrays and are joined before the prompt is built.
 */
type FetchedContextInput = Omit<
	ContextSections,
	"meetingTranscripts" | "notionContent"
> & {
	meetingTranscripts?: string[];
	notionContent?: string[];
};

/**
 * What the budget did to one context section on a single run.
 *
 * `kept` — included whole. `truncated` — included, clipped to what was left.
 * `dropped` — the budget ran out before this section and it never reached the
 * model at all.
 */
type SectionBudgetOutcome = {
	key: keyof ContextSections;
	requestedTokens: number;
	grantedTokens: number;
	outcome: "kept" | "truncated" | "dropped";
};

/**
 * One structured line per analysis describing what the budget squeezed out.
 *
 * The reason this exists: allocation is greedy in a fixed priority order, so a
 * single oversized section silently evicts everything behind it — and until now
 * that eviction was invisible unless someone happened to read a warn line. The
 * open question of whether accumulated context is actually hurting analyses
 * (Fizzy #2316, Phase 2) cannot be answered without measuring it, and a
 * measurement that only fires under pressure has no denominator. So this logs on
 * BOTH exit paths, `underPressure` telling the two apart.
 */
function logBudgetOutcome(args: {
	projectId?: string;
	fixedTokens: number;
	availableForContext: number;
	requestedContextTokens: number;
	underPressure: boolean;
	outcomes: SectionBudgetOutcome[];
}): void {
	const { outcomes } = args;
	logger.info("[Backlog Analysis] context budget outcome", {
		event: "backlog.context_budget",
		projectId: args.projectId,
		maxTokenBudget: MAX_TOKEN_BUDGET,
		fixedTokens: args.fixedTokens,
		availableForContext: args.availableForContext,
		requestedContextTokens: args.requestedContextTokens,
		underPressure: args.underPressure,
		droppedSections: outcomes
			.filter((o) => o.outcome === "dropped")
			.map((o) => o.key),
		truncatedSections: outcomes
			.filter((o) => o.outcome === "truncated")
			.map((o) => o.key),
		sections: outcomes,
	});
}

export function applyTokenBudget(
	sections: ContextSections & {
		backlog: string;
		pmWorkItems?: string;
		systemPrompt: string;
		userPrompt: string;
		/** Correlation only — never affects allocation. */
		projectId?: string;
	},
): ContextSections {
	// Calculate fixed costs (system prompt, user prompt, backlog, PM items)
	const fixedTokens =
		estimateTokens(sections.systemPrompt) +
		estimateTokens(sections.userPrompt) +
		estimateTokens(sections.backlog) +
		estimateTokens(sections.pmWorkItems ?? "");

	const availableForContext = MAX_TOKEN_BUDGET - fixedTokens;

	if (availableForContext <= 0) {
		logger.warn(
			"[Backlog Analysis] Fixed content exceeds token budget, truncating everything",
		);
		logBudgetOutcome({
			projectId: sections.projectId,
			fixedTokens,
			availableForContext,
			requestedContextTokens: 0,
			underPressure: true,
			outcomes: [],
		});
		return {};
	}

	// Ordered by truncation priority (first = keep longest, last = truncate first)
	// Security findings and architecture decisions are always first — they're
	// small, authoritative, and must not be dropped.
	const contextSections: Array<{
		key: keyof ContextSections;
		text: string;
	}> = [];

	if (sections.securityFindings) {
		contextSections.push({
			key: "securityFindings",
			text: sections.securityFindings,
		});
	}

	if (sections.architectureDecisions) {
		contextSections.push({
			key: "architectureDecisions",
			text: sections.architectureDecisions,
		});
	}

	// Application logs sit just behind architecture decisions: they are direct
	// runtime evidence for a bug, and already hard-capped upstream
	// (MAX_LOG_CONTEXT_CHARS), so they cannot crowd out the other sources.
	if (sections.applicationLogs) {
		contextSections.push({
			key: "applicationLogs",
			text: sections.applicationLogs,
		});
	}

	if (sections.teamsMessages) {
		contextSections.push({
			key: "teamsMessages",
			text: sections.teamsMessages,
		});
	}
	if (sections.slackMessages) {
		contextSections.push({
			key: "slackMessages",
			text: sections.slackMessages,
		});
	}
	if (sections.meetingTranscripts) {
		contextSections.push({
			key: "meetingTranscripts",
			text: sections.meetingTranscripts,
		});
	}
	if (sections.notionContent) {
		contextSections.push({
			key: "notionContent",
			text: sections.notionContent,
		});
	}
	if (sections.ragContext) {
		contextSections.push({
			key: "ragContext",
			text: sections.ragContext,
		});
	}

	const totalContextTokens = contextSections.reduce(
		(acc, s) => acc + estimateTokens(s.text),
		0,
	);

	// If everything fits, return as-is
	if (totalContextTokens <= availableForContext) {
		const everything: ContextSections = {};
		for (const section of contextSections) {
			everything[section.key] = section.text;
		}
		logBudgetOutcome({
			projectId: sections.projectId,
			fixedTokens,
			availableForContext,
			requestedContextTokens: totalContextTokens,
			underPressure: false,
			outcomes: contextSections.map((section) => ({
				key: section.key,
				requestedTokens: estimateTokens(section.text),
				grantedTokens: estimateTokens(section.text),
				outcome: "kept" as const,
			})),
		});
		return everything;
	}

	// Progressive truncation: truncate from the back of the priority list
	let remainingBudget = availableForContext;
	const result: ContextSections = {};

	const outcomes: SectionBudgetOutcome[] = [];

	for (const section of contextSections) {
		const sectionTokens = estimateTokens(section.text);
		if (remainingBudget <= 0) {
			logger.warn(
				`[Backlog Analysis] Dropping context section: ${section.key} (no budget remaining)`,
			);
			outcomes.push({
				key: section.key,
				requestedTokens: sectionTokens,
				grantedTokens: 0,
				outcome: "dropped",
			});
			continue;
		}
		if (sectionTokens <= remainingBudget) {
			result[section.key] = section.text;
			remainingBudget -= sectionTokens;
			outcomes.push({
				key: section.key,
				requestedTokens: sectionTokens,
				grantedTokens: sectionTokens,
				outcome: "kept",
			});
		} else {
			result[section.key] = truncateToTokenBudget(
				section.text,
				remainingBudget,
			);
			outcomes.push({
				key: section.key,
				requestedTokens: sectionTokens,
				grantedTokens: remainingBudget,
				outcome: "truncated",
			});
			remainingBudget = 0;
		}
	}

	logBudgetOutcome({
		projectId: sections.projectId,
		fixedTokens,
		availableForContext,
		requestedContextTokens: totalContextTokens,
		underPressure: true,
		outcomes,
	});

	return result;
}

// =============================================================================
// Work-item body templates (prompt catalog)
// =============================================================================

/**
 * Fizzy #2048 (AC7): the analyzer must read the type-specific placeholder prompt
 * for a work-item type instead of applying a hard-coded ticket structure.
 *
 * The catalog records live at the SAME agent + (documentType, storyKind) pairs
 * every other creation path resolves — see `draftBodyByKind` in
 * `create-story-from-proposal.ts`. The stage mapping is deliberately asymmetric:
 * bugs are single-stage and bind at DRAFT (`bug_creation`), features bind their
 * create-time prompt at PLACEHOLDER (`feature_placeholder`). Mirrored here so
 * "the prompt the analyzer drafts against" and "the prompt creation drafts
 * against" can never drift apart.
 */
const WORK_ITEM_TEMPLATE_AGENT = "project_document_generator";

const WORK_ITEM_TEMPLATE_DOCUMENT_TYPE = {
	FEATURE: "PLACEHOLDER",
	BUG: "DRAFT",
} as const;

/**
 * Upper bound on injected template text (characters, per kind). The system
 * prompt is FIXED content in `applyTokenBudget` — every character it grows by
 * comes straight out of the fetched-context budget. A tenant fork of a drafting
 * prompt can be arbitrarily long, so clamp on a line boundary rather than let
 * one silently evict meeting transcripts.
 */
const MAX_TEMPLATE_CHARS = 6000;

/**
 * The line that opens the OUTPUT FORMAT block in the seeded drafting prompts.
 * Tolerant of markdown decoration (`## OUTPUT FORMAT`, `**Output Format**`) and
 * of a trailing qualifier (`OUTPUT FORMAT (use this exact structure)`), because
 * tenant forks reword the surrounding prose far more often than the marker.
 */
const OUTPUT_FORMAT_MARKER = /^\s{0,3}(?:#{1,6}\s*)?\**\s*OUTPUT\s+FORMAT\b/i;

/**
 * Reduce a drafting prompt to the part the analyzer can actually use: its output
 * structure (the section skeleton), not its drafting procedure.
 *
 * A catalog record is a COMPLETE drafting prompt — persona, hard rules, tool and
 * flag directives ("Output MUST be Markdown only", "needsMoreInfo: <true|false>",
 * "preserve the reporter's raw submission verbatim"), all of it phrased around
 * producing ONE finished document. The analyzer's job is different in shape: it
 * emits a JSON proposal carrying MANY items, each with its own `title`,
 * `description.to` and `acceptanceCriteria.to` fields. Splicing the whole record
 * into the analyzer's system prompt imports instructions that contradict that
 * contract. The section list is the part that transfers cleanly.
 *
 * Degrades to the whole record when the marker is absent — a tenant may have
 * authored a bare section list with no marker at all, and a template that
 * resolved is still better evidence of the wanted structure than the in-code
 * skeleton.
 */
export function extractWorkItemBodyStructure(template: string): string {
	const trimmed = template.trim();
	if (!trimmed) {
		return "";
	}

	const lines = trimmed.split("\n");
	const markerIdx = lines.findIndex((line) =>
		OUTPUT_FORMAT_MARKER.test(line),
	);
	const structure =
		markerIdx === -1
			? trimmed
			: lines
					.slice(markerIdx + 1)
					.join("\n")
					.trim();

	// An empty OUTPUT FORMAT section (marker present, nothing under it) is not
	// usable — fall back to the whole record rather than inject a blank block.
	const usable = structure.length > 0 ? structure : trimmed;
	if (usable.length <= MAX_TEMPLATE_CHARS) {
		return usable;
	}

	const clipped = usable.slice(0, MAX_TEMPLATE_CHARS);
	const lastBreak = clipped.lastIndexOf("\n");
	return `${(lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped).trimEnd()}\n…`;
}

export interface WorkItemBodyTemplates {
	feature?: string;
	bug?: string;
}

/**
 * Resolve the per-type body structure the analyzer should draft against.
 *
 * NEVER throws and never fails the run: an unbound tenant, an environment where
 * the prompt seed has not run, or a DB hiccup all resolve to `undefined`, and
 * the caller keeps the in-code skeleton. A missing binding must degrade to a
 * differently-worded prompt, never to a failed analysis or an empty structure.
 */
async function resolveWorkItemBodyTemplates(params: {
	projectId?: string;
	userId?: string;
	organizationId?: string;
}): Promise<WorkItemBodyTemplates> {
	const resolveOne = async (
		storyKind: "FEATURE" | "BUG",
	): Promise<string | undefined> => {
		const documentType = WORK_ITEM_TEMPLATE_DOCUMENT_TYPE[storyKind];
		const logResolution = (
			outcome: "hit" | "miss",
			promptKey: string | null,
		) => {
			// Keys and kinds only — never the resolved content. Prompt bodies are
			// tenant-authored; the sibling resolution logs omit them for the same
			// reason.
			logger.info("[Backlog Analysis] work-item template resolved", {
				projectId: params.projectId,
				storyKind,
				documentType,
				agentName: WORK_ITEM_TEMPLATE_AGENT,
				outcome,
				promptKey,
				promptSource: "bound",
			});
		};

		try {
			const bound = await getBoundPromptForAgent({
				agentName: WORK_ITEM_TEMPLATE_AGENT,
				documentType,
				storyKind,
				userId: params.userId,
				organizationId: params.organizationId,
			});
			const content = bound?.version?.content;
			if (!bound || !content?.trim()) {
				logResolution("miss", bound?.key ?? null);
				return undefined;
			}
			const structure = extractWorkItemBodyStructure(content);
			if (!structure) {
				logResolution("miss", bound.key);
				return undefined;
			}
			logResolution("hit", bound.key);
			return structure;
		} catch (error) {
			logger.warn(
				"[Backlog Analysis] work-item template lookup failed; using the in-code structure",
				{
					projectId: params.projectId,
					storyKind,
					documentType,
					agentName: WORK_ITEM_TEMPLATE_AGENT,
					outcome: "miss",
					promptKey: null,
					promptSource: "bound",
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			return undefined;
		}
	};

	const [feature, bug] = await Promise.all([
		resolveOne("FEATURE"),
		resolveOne("BUG"),
	]);

	return { feature, bug };
}

// =============================================================================
// Prompt Building
// =============================================================================

function buildAnalysisPrompt(input: {
	/** Correlation only, for the budget-outcome log. Never affects the prompt. */
	projectId?: string;
	fetchedContext: ContextSections;
	existingBacklog: AnalyzeContextInput["existingBacklog"];
	pmWorkItems?: AnalyzeContextInput["pmWorkItems"];
	userPrompt: string;
	pmToolType?: string;
	/**
	 * See `AnalyzeContextInput.allowEpics`. DEPRECATED + ignored: the prompt
	 * never offers `type: "epic"` (the Epic/Feature folder tables were
	 * dropped); the explicit "do not propose epic" constraint always fires.
	 */
	allowEpics?: boolean;
	/**
	 * See `AnalyzeContextInput.allowUpdates`. Defaults to `true`. When `false`
	 * (channel-monitor capture-as-is flow) the update-bearing Rules 1/9/10 are
	 * replaced with create-only guidance and an explicit CREATE-ONLY constraint
	 * is added.
	 */
	allowUpdates?: boolean;
	/**
	 * Body structure for `type: "feature"` items, read from the prompt catalog by
	 * the caller (Fizzy #2048 AC7) — `resolveWorkItemBodyTemplates` resolves it,
	 * this function only formats it. Optional BY CONTRACT: when it is absent
	 * (unbound tenant, seed not run) the in-code skeleton below is used verbatim,
	 * so a missing binding costs wording, not output. Keeping the lookup at the
	 * call site is what keeps this function pure and synchronous — the prompt
	 * tests build it directly, with no DB in the picture.
	 */
	featureBodyTemplate?: string;
	/** Body structure for `type: "bug"` items. See `featureBodyTemplate`. */
	bugBodyTemplate?: string;
}): string {
	const {
		projectId,
		fetchedContext,
		existingBacklog,
		pmWorkItems,
		userPrompt,
		pmToolType,
		allowUpdates = true,
		featureBodyTemplate,
		bugBodyTemplate,
	} = input;

	// Build backlog section. The backlog is FLAT: `user_story` is the only
	// work-item table (Epic/Feature folder tables dropped).
	const backlogLines: string[] = [];
	backlogLines.push("## Existing Backlog\n");

	if (existingBacklog.stories.length > 0) {
		backlogLines.push("### Work Items");
		for (const s of existingBacklog.stories) {
			backlogLines.push(
				`- ${s.identifier} [id:${s.id}]${s.externalId ? ` [extId:${s.externalId}]` : ""}: ${s.title}${s.priority ? ` [${s.priority}]` : ""}${s.size ? ` [${s.size}]` : ""}`,
			);
		}
		backlogLines.push("");
	} else {
		backlogLines.push("(Empty backlog — all items will be new creates)\n");
	}

	const backlogSection = backlogLines.join("\n");

	// Build PM work items section
	let pmSection = "";
	if (pmWorkItems) {
		const pmLines: string[] = [];
		pmLines.push(
			"## Current PM Tool Backlog (Source of Truth)\n\nThese items exist in the external PM tool. This is the authoritative list of what currently exists. Do NOT propose creating items that match these.\n",
		);
		if (pmWorkItems.epics.length > 0) {
			pmLines.push("### PM Epics");
			for (const e of pmWorkItems.epics) {
				pmLines.push(
					`- [${e.id}] ${e.title ?? "Untitled"}${e.description ? ` — ${e.description.slice(0, 150)}` : ""}${e.url ? ` (${e.url})` : ""}`,
				);
			}
		}
		if (pmWorkItems.features.length > 0) {
			pmLines.push("### PM Features");
			for (const f of pmWorkItems.features) {
				pmLines.push(
					`- [${f.id}] ${f.title ?? "Untitled"}${f.description ? ` — ${f.description.slice(0, 150)}` : ""}${f.url ? ` (${f.url})` : ""}`,
				);
			}
		}
		if (pmWorkItems.stories.length > 0) {
			pmLines.push("### PM Stories");
			for (const s of pmWorkItems.stories) {
				pmLines.push(
					`- [${s.id}] ${s.title ?? "Untitled"}${s.description ? ` — ${s.description.slice(0, 150)}` : ""}${s.url ? ` (${s.url})` : ""}`,
				);
			}
		}
		pmSection = pmLines.join("\n");
	}

	// Build context sections
	const contextParts: string[] = [];
	contextParts.push("## Fetched Context\n");

	if (fetchedContext.teamsMessages) {
		contextParts.push("### Teams Messages\n");
		contextParts.push(fetchedContext.teamsMessages);
		contextParts.push("");
	}

	if (fetchedContext.slackMessages) {
		contextParts.push("### Slack Messages\n");
		contextParts.push(fetchedContext.slackMessages);
		contextParts.push("");
	}

	if (fetchedContext.meetingTranscripts) {
		contextParts.push("### Meeting Transcripts\n");
		contextParts.push(fetchedContext.meetingTranscripts);
		contextParts.push("");
	}

	if (fetchedContext.notionContent) {
		contextParts.push("### Notion Pages\n");
		contextParts.push(fetchedContext.notionContent);
		contextParts.push("");
	}

	if (fetchedContext.ragContext) {
		contextParts.push("### Additional Context (RAG)\n");
		contextParts.push(fetchedContext.ragContext);
		contextParts.push("");
	}

	if (fetchedContext.securityFindings) {
		contextParts.push("### Security Findings\n");
		contextParts.push(fetchedContext.securityFindings);
		contextParts.push("");
	}

	if (fetchedContext.architectureDecisions) {
		contextParts.push("### Architecture Decisions\n");
		contextParts.push(fetchedContext.architectureDecisions);
		contextParts.push("");
	}

	if (fetchedContext.applicationLogs) {
		contextParts.push("### Application Logs\n");
		contextParts.push(fetchedContext.applicationLogs);
		contextParts.push("");
	}

	// Epic guidance was removed entirely: the Epic/Feature folder tables were
	// dropped, so the analyzer NEVER offers `type: "epic"`. The explicit
	// "do not propose epic" constraint (Rule 12 below) always fires —
	// mirroring the retired-"story" treatment (DSU 2026-05-23).

	// Rule 3: the backlog is a flat list of work items — no Epic layer.
	const rule3Hierarchy =
		'3. **Hierarchy**: The backlog is a flat list of work items (no separate Epic or Story layer). Do NOT create epics — map any large/strategic initiative to one or more `type: "feature"` items.';

	// Rules 1, 9, and 10 carry the "update / merge against the existing backlog"
	// directives. The monitored-channel "capture as-is" flow opts out via
	// `allowUpdates: false`: those proposals must ONLY create new work items and
	// never suggest updating or deduplicating an existing ticket. The general AI
	// Update + document analyzer + ADO sync keep the full behavior (default true).
	const rule1 = allowUpdates
		? `1. **Update existing items** when the context refines, clarifies, or changes something already in the backlog.
   - You MUST set \`action: "update"\` and provide the \`existingId\` (the value in [id:...] brackets) and \`existingIdentifier\` (e.g., EPIC-001).
   - If the item has an external PM tool ID (shown as [extId:...]), also set \`existingExternalId\`.
   - Only include fields that actually change (e.g., if only the description changes, leave title.from/to showing the same value).`
		: `1. **Capture new work items only** — this flow records the discussion as new backlog items. Do NOT modify, merge, or update any existing backlog item. Every change you propose MUST use \`action: "create"\` (never \`action: "update"\`).`;

	const rule9 = allowUpdates
		? "9. **No duplicates**: If the context describes something that already exists in the backlog (same meaning or matching an external PM item), you MUST propose an `update` instead of a `create`. Compare titles and descriptions between the existing backlog, PM tool items, and context to detect matches. Items with [extId:...] are already synced to the PM tool — always update those, never recreate them."
		: "9. **Do not deduplicate against the existing backlog**: Even if the context closely matches an existing item, capture it as a NEW `create`. The existing backlog is provided ONLY for awareness of what already exists — never to update, merge with, or skip an item.";

	const rule10 = allowUpdates
		? `10. **PM TOOL IS SOURCE OF TRUTH**: When "Current PM Tool Backlog" items are provided, they represent the AUTHORITATIVE current state of the backlog. Compare new context primarily against PM items to detect duplicates.
    - If an item exists in BOTH the PM tool and the Fabric DB backlog (matched by [extId:...]), propose an \`update\` using the Fabric DB \`existingId\` from the [id:...] bracket.
    - If an item exists in the PM tool but NOT in the Fabric DB backlog (no matching [id:...] entry), propose a \`create\` with \`existingExternalId\` set to the PM tool ID. This will import it into Fabric and link it to the PM tool item. Do NOT propose an \`update\` without a valid Fabric DB [id:...] — updates require an existing Fabric record.
    - If context describes something that semantically matches a PM item, update the existing item rather than creating a duplicate.
    - Prioritize semantic matching against PM item titles when detecting duplicates.`
		: "";

	// Rule 8's per-type body structure (Fizzy #2048 AC7). PREFERRED source is the
	// type-specific prompt from the catalog, resolved by the caller and passed in
	// as `featureBodyTemplate` / `bugBodyTemplate` — the analyzer drafts against
	// the same template creation drafts against, per type, instead of a structure
	// hard-coded here.
	//
	// The skeletons below are the LAST-RESORT text and are load-bearing: they fire
	// whenever a template does not resolve (unbound tenant, prompt seed not run in
	// this environment, lookup failure). Deleting them would turn a missing
	// binding into a work item with no structure at all — the same shape the
	// chained fallback in `create-story-from-proposal.ts` exists to avoid. Each
	// kind falls back INDEPENDENTLY: one template resolving does not deprive the
	// other kind of its skeleton.
	const featureBodySkeleton = `   - \`description.to\`: SHOULD include the relevant sections below. Sections that don't apply to a single-user-need item can be omitted, but the standard format is preferred:
     - **Overview**: 1-2 sentence summary of the capability or user need
     - **Business Value**: Why this matters to users and the business
     - **Scope**: What's included and what's explicitly out of scope
     - **Success Criteria**: Measurable outcomes that define "done"`;

	const bugBodySkeleton = `   - \`description.to\`: MUST include the diagnostic sections below, each written as a \`##\` MARKDOWN HEADING on its own line, spelled exactly as shown. Do NOT write them as inline bold labels or as list bullets: the structure guard that stops a bug body from being reformatted into feature shape matches heading lines only, so a bolded label scores zero and silently disarms it (Fizzy #2048). These names are the canonical bug section names shared with the bug-creation prompt — do not paraphrase them.
     \`\`\`
     ## Steps to Reproduce
     1. Numbered steps to trigger the bug

     ## Expected Result
     What should happen

     ## Actual Result
     What currently happens

     ## Impact
     Who is affected and how severely
     \`\`\``;

	// Indent injected template lines to sit with the surrounding rule block.
	// Blank lines stay blank so section spacing survives.
	const indentTemplate = (text: string) =>
		text
			.split("\n")
			.map((line) => (line.trim().length > 0 ? `     ${line}` : line))
			.join("\n");

	/**
	 * Wrap a catalog-sourced structure as the `description.to` rule for one kind.
	 *
	 * The caveat paragraph is the load-bearing part: a catalog record is a
	 * complete drafting prompt written to produce ONE finished document, while the
	 * analyzer emits many items as JSON fields. Without it the model inherits
	 * "return the complete document", flag/metadata directives and reporter
	 * questions into a field that has room for none of them.
	 *
	 * Fenced with `~~~` rather than backticks because catalog prompts routinely
	 * contain ``` blocks of their own, which would close a backtick fence early.
	 */
	const catalogBodyRule = (
		kindWord: "feature" | "bug",
		structure: string,
		headingNote: string,
	) => `   - \`description.to\`: MUST follow the project's configured ${kindWord} template below. Reproduce that template's section names, in the order it shows them, as \`##\` MARKDOWN HEADINGS on their own lines — spelled as the template spells them.${headingNote}
     Apply the template's OUTPUT STRUCTURE ONLY. It was authored to draft one complete document on its own, so IGNORE anything in it that tells you to return a whole document, to ask the reporter questions, to emit metadata/flag fields, or to call a tool: here you are filling ONE item's \`description.to\` inside a JSON proposal, and that item's title and acceptance criteria travel in their own fields. Do NOT repeat the item's title as a heading, and OMIT any section the context gives you nothing grounded to write — never invent content to fill one.
     ~~~
${indentTemplate(structure)}
     ~~~`;

	const featureBodyRules = featureBodyTemplate
		? catalogBodyRule("feature", featureBodyTemplate, "")
		: featureBodySkeleton;

	const bugBodyRules = bugBodyTemplate
		? catalogBodyRule(
				"bug",
				bugBodyTemplate,
				" Heading lines are not cosmetic here: the structure guard that stops a bug body from being reformatted into feature shape matches heading lines only, so an inline bold label or a list bullet scores zero and silently disarms it (Fizzy #2048).",
			)
		: bugBodySkeleton;

	// System prompt
	const systemPrompt = `You are a senior product manager and backlog analyst. Your job is to analyze new context (from team messages, meeting transcripts, Notion pages, and other sources) and propose structured changes to a project's backlog.

## Rules

${rule1}

2. **Create new items** when the context describes genuinely new work not covered by existing backlog items.
   - Every non-defect work item is created as \`type: "feature"\` (not "story") — the "story" type has been retired.

${rule3Hierarchy}

4. **Priority values**: P0_CRITICAL, P1_HIGH, P2_MEDIUM, P3_LOW
5. **Size values**: XS, S, M, L, XL

6. **Be conservative**: Only propose changes that are clearly supported by the context. Do not invent requirements.

7. **Source attribution**: For each change, indicate which context source(s) it came from.

8. **Work item formatting** (CRITICAL — items without proper formatting are worthless):

   **IMPORTANT — Allowed leaf types are "feature" and "bug" ONLY.** The "story"
   type has been retired (DSU 2026-05-23 decision: emitting both Feature and
   Story for the same content was a primary source of duplicate tickets). Any
   user-facing capability, request, or requirement that previously would have
   been a "story" MUST now be emitted as a "feature". Defects/regressions are
   still "bug". Do NOT propose \`type: "story"\` under any circumstance.

   **Features** (type: "feature") — Use for any non-defect work item: new capability, user-facing need, UX request, requirement, or initiative.
   - Title should be a clear, concise capability name (e.g. "User Authentication", "Export to CSV"), OR — when the work is a single user-facing need — a "As a [role], I want [goal], so that [benefit]" sentence is also acceptable.
${featureBodyRules}
   - \`acceptanceCriteria.to\`: When the item describes user-facing behavior, include Given/When/Then (Gherkin) scenarios:
     \`\`\`
     **Given** [precondition]
     **When** [action]
     **Then** [expected result]
     \`\`\`
     Cover happy path, edge cases, and error states.

   **Bugs** (type: "bug") — Use when the meeting context identifies a defect, regression, or unexpected behavior.
   - Title MUST be a concise description of the issue WITHOUT any "[BUG]" prefix (e.g. "Login page crashes on Safari 17"). The work-item kind is set from \`type: "bug"\`; the kind badge in the UI conveys this — do NOT add a redundant prefix.
${bugBodyRules}
   - \`acceptanceCriteria.to\`: REQUIRED. Define what "fixed" looks like using Given/When/Then format.

${rule9}${rule10 ? `\n\n${rule10}` : ""}`;

	// Add PM tool type constraint for non-hierarchical tools (Fizzy, Linear, etc.)
	const isHierarchicalPM = pmToolType === "azure-devops";
	const pmToolConstraint =
		!isHierarchicalPM && pmToolType
			? `

11. **PM TOOL TYPE CONSTRAINT (CRITICAL)**: The connected PM tool is "${pmToolType}" which is a flat/kanban-style tool that only supports simple cards. You MUST:
    - ONLY propose changes with \`type: "feature"\` or \`type: "bug"\`. Do NOT propose epics. Do NOT propose \`type: "story"\` (the story type has been retired — use "feature" for any non-defect work).
    - Group related work into well-described individual work items instead of creating hierarchy.
    - If context suggests a large initiative, create individual features with clear titles rather than an epic.
    - Features and bugs can reference themes or initiatives in their description, but the \`type\` field MUST always be "feature" or "bug".`
			: "";

	// Epic-suppression constraint — ALWAYS active (was the channel-monitor
	// opt-in, Bug 1429). Mirrors the retired-"story" wording above and fires
	// independently of pmToolType: the Epic/Feature folder tables were
	// dropped, so `epic` is no longer a supported work-item type anywhere.
	const epicSuppressionConstraint = `

12. **DO NOT PROPOSE EPICS (CRITICAL)**: The \`epic\` work-item type is NOT supported. Do NOT propose \`type: "epic"\` under any circumstance. Map any large or strategic initiative to one or more \`type: "feature"\` items with clear, self-contained titles instead. Allowed types are \`feature\` and \`bug\` ONLY (the \`story\` type is also retired — see above).`;

	// Security findings rule. Fires when the fetched context includes a
	// "### Security Findings" section. Instructs the model to propose bugs
	// for untracked findings rather than ignoring them.
	const securityFindingsConstraint = fetchedContext.securityFindings
		? `

13. **Security Findings (CRITICAL)**: When "### Security Findings" is present in the context, you MUST propose \`type: "bug"\` items for any CRITICAL or HIGH severity finding that does not already have a matching backlog item (check [linked: ...] brackets — a linked identifier means a ticket already exists).
    - For MEDIUM/LOW findings, use judgment based on the user instructions. Set \`sourceContext: "security_findings"\` on every proposal derived from a finding. Do NOT reproduce the full finding text in the description — write a concise, actionable bug report using the finding's title, category, and remediation guidance.`
		: "";

	// Architecture decisions rule. Fires when the fetched context includes an
	// "### Architecture Decisions" section. ACCEPTED decisions are binding
	// constraints; PROPOSED ones are informational.
	const architectureDecisionsConstraint = fetchedContext.architectureDecisions
		? `

14. **Architecture Decisions (CRITICAL)**: When "### Architecture Decisions" is present in the context:
    - **ACCEPTED decisions are binding constraints.** Do NOT propose backlog items that contradict or work around an ACCEPTED decision. If an ACCEPTED decision is already satisfied by existing backlog items, do NOT propose duplicates.
    - **PROPOSED decisions are under discussion — not yet binding.** You MAY reference them as context for a proposal, but do not treat them as settled constraints.
    - When a proposal is directly informed by or related to an architecture decision, set \`sourceContext: "architecture_decisions"\`.`
		: "";

	// Channel-monitor create-only constraint. Mirrors the epic-suppression rule:
	// monitored Slack/Teams feature proposals are a "capture as-is" pathway that
	// must never modify existing tickets. Fires only when `allowUpdates: false`.
	const createOnlyConstraint = allowUpdates
		? ""
		: `

13. **CREATE-ONLY — CAPTURE AS-IS (CRITICAL)**: This flow captures monitored-channel discussion as brand-new work items. Every change MUST use \`action: "create"\`. Do NOT emit \`action: "update"\` under ANY circumstance, and do NOT merge into, edit, or deduplicate against existing backlog items. If the discussion relates to existing work, still capture it as a NEW item.`;

	const fullSystemPrompt =
		systemPrompt +
		pmToolConstraint +
		epicSuppressionConstraint +
		securityFindingsConstraint +
		architectureDecisionsConstraint +
		createOnlyConstraint;

	// Apply token budget
	const budgetedContext = applyTokenBudget({
		securityFindings: fetchedContext.securityFindings,
		architectureDecisions: fetchedContext.architectureDecisions,
		applicationLogs: fetchedContext.applicationLogs,
		teamsMessages: fetchedContext.teamsMessages,
		slackMessages: fetchedContext.slackMessages,
		meetingTranscripts: fetchedContext.meetingTranscripts,
		notionContent: fetchedContext.notionContent,
		ragContext: fetchedContext.ragContext,
		backlog: backlogSection,
		pmWorkItems: pmSection,
		systemPrompt: fullSystemPrompt,
		userPrompt,
		projectId,
	});

	// Rebuild context section with budgeted content
	const budgetedContextParts: string[] = [];
	budgetedContextParts.push("## Fetched Context\n");

	if (budgetedContext.teamsMessages) {
		budgetedContextParts.push("### Teams Messages\n");
		budgetedContextParts.push(budgetedContext.teamsMessages);
		budgetedContextParts.push("");
	}

	if (budgetedContext.slackMessages) {
		budgetedContextParts.push("### Slack Messages\n");
		budgetedContextParts.push(budgetedContext.slackMessages);
		budgetedContextParts.push("");
	}

	if (budgetedContext.meetingTranscripts) {
		budgetedContextParts.push("### Meeting Transcripts\n");
		budgetedContextParts.push(budgetedContext.meetingTranscripts);
		budgetedContextParts.push("");
	}

	if (budgetedContext.notionContent) {
		budgetedContextParts.push("### Notion Pages\n");
		budgetedContextParts.push(budgetedContext.notionContent);
		budgetedContextParts.push("");
	}

	if (budgetedContext.ragContext) {
		budgetedContextParts.push("### Additional Context (RAG)\n");
		budgetedContextParts.push(budgetedContext.ragContext);
		budgetedContextParts.push("");
	}

	if (budgetedContext.securityFindings) {
		budgetedContextParts.push("### Security Findings\n");
		budgetedContextParts.push(budgetedContext.securityFindings);
		budgetedContextParts.push("");
	}

	if (budgetedContext.architectureDecisions) {
		budgetedContextParts.push("### Architecture Decisions\n");
		budgetedContextParts.push(budgetedContext.architectureDecisions);
		budgetedContextParts.push("");
	}

	if (budgetedContext.applicationLogs) {
		budgetedContextParts.push("### Application Logs\n");
		budgetedContextParts.push(budgetedContext.applicationLogs);
		budgetedContextParts.push("");
	}

	const budgetedContextSection = budgetedContextParts.join("\n");

	return `${fullSystemPrompt}

---

${pmSection ? `${pmSection}\n\n` : ""}${backlogSection}
${budgetedContextSection}

---

## User Instructions

${userPrompt}

---

Analyze the fetched context against the ${pmSection ? "PM tool backlog (source of truth) and " : ""}existing backlog and propose structured changes. Return a JSON object matching the ChangeProposal schema.`;
}

// =============================================================================
// Resolution Annotation
// =============================================================================

/**
 * Stamp each proposed change with a `targetResolution`. For `action:"update"`:
 * resolve against the live backlog and either normalize the reference to the
 * canonical Fabric identity, or demote update→create when nothing matches so the
 * reviewer never sees a phantom update target. Create actions are left as-is.
 */
export function annotateProposalResolutions(
	changes: ChangeProposal["changes"],
	stories: ResolvableBacklogItem[],
): ChangeProposal["changes"] {
	return changes.map((change) => {
		if (change.action !== "update") {
			return change;
		}

		const result = resolveBacklogUpdateTarget(stories, change);
		if (result.status === "resolved") {
			return {
				...change,
				existingId: result.storyId,
				existingIdentifier: result.identifier,
				targetResolution: {
					status: "resolved" as const,
					resolvedBy: result.resolvedBy,
					resolvedIdentifier: result.identifier,
					resolvedTitle: result.title,
				},
			};
		}
		// Unresolved → demote to a clearly-labeled create so the REVIEW UI
		// (and every downstream consumer that reads `action`) never shows a
		// phantom "update FEAT-023". This is the user-facing guardrail for the
		// AI Update flow: the demoted change carries `demotedFromUpdate` and the
		// approval UI renders a "new item — no existing match" badge before the
		// user approves. By apply time these changes already have action:"create".
		return {
			...change,
			action: "create" as const,
			existingId: null,
			existingIdentifier: null,
			existingExternalId: null,
			targetResolution: {
				status: "unresolved" as const,
				demotedFromUpdate: true,
			},
			// A routed enrichment can land here when its target is missing from
			// the (TTL-cached, up to 60s stale) backlog snapshot this resolves
			// against. Reconcile the routing stamp with the demotion, or the
			// review row shows "New item — no existing match" while the routing
			// control simultaneously reads "Enrich existing" against a named
			// ticket — two contradictory answers on one row.
			routing: change.routing
				? {
						...change.routing,
						decision: "create" as const,
						matchedStoryId: null,
						matchedIdentifier: null,
						matchedTitle: null,
					}
				: change.routing,
		};
	});
}

// =============================================================================
// Structure-preserving update pass
// =============================================================================

/**
 * Compact pre/post snapshot for the story.updated audit metadata. Full bodies
 * live in the FeatureVersion trail; the audit keeps a short preview + lengths so
 * the change history stays lightweight while still capturing pre/post state.
 */
function auditState(
	title?: string | null,
	description?: string | null,
	acceptanceCriteria?: string | null,
) {
	const preview = (s?: string | null) => (s ? s.slice(0, 300) : "");
	return {
		title: title ?? "",
		descriptionPreview: preview(description),
		descriptionLength: description?.length ?? 0,
		acceptanceCriteriaPreview: preview(acceptanceCriteria),
		acceptanceCriteriaLength: acceptanceCriteria?.length ?? 0,
	};
}

/**
 * Type-aware, structure-preserving merge over resolved UPDATE proposals.
 *
 * The analyzer regenerates a full `description.to` for updates from a generic
 * template, WITHOUT the existing body — which is exactly how a bug card gets
 * reformatted into feature sections. This pass runs AFTER resolution: for each
 * update that resolves to a real Fabric item and proposes a body change, it
 * loads the item's TRUE current kind + body and re-derives the body via the
 * kind-appropriate re-analysis prompt (`reanalyzeBodyByKind`), so the proposed
 * `to` preserves the existing structure and applies only targeted edits. The
 * review diff and the saved body then match and stay type-correct (bugs stay
 * bugs, features stay features).
 *
 * SAFETY ("safe-hold"): `reanalyzeBodyByKind` never throws and never returns a
 * destructive rewrite — on any problem it signals `fallbackUsed`, and here we
 * keep the existing body unchanged (neutralize the body diff so apply skips it)
 * and stamp `bodyMergeFallback` so the reviewer sees the description was held
 * as-is. Title/priority/size edits are preserved either way.
 *
 * Only invoked for `allowUpdates` flows; monitored channels (create-only) never
 * reach this. Mutates and returns the `changes` array.
 */
export async function structurePreserveUpdates(params: {
	changes: ChangeProposal["changes"];
	projectId: string;
	userId: string;
	organizationId?: string;
	connectedContext?: string;
}): Promise<ChangeProposal["changes"]> {
	const { changes, projectId, userId, organizationId, connectedContext } =
		params;

	// Resolved updates that actually propose a body change.
	const targets = changes.filter(
		(c) =>
			c.action === "update" &&
			!!c.existingId &&
			(!!c.description?.to || !!c.acceptanceCriteria?.to),
	);
	if (targets.length === 0) {
		return changes;
	}

	// Batch-load the TRUE current kind + body. DB is the source of truth: the
	// passed backlog snapshot lacks `kind` and may be slightly stale. Scoped by
	// projectId so a forged id can't read another project's item.
	const ids = Array.from(
		new Set(
			targets
				.map((c) => c.existingId)
				.filter((x): x is string => typeof x === "string"),
		),
	);
	const items = await db.userStory.findMany({
		where: { id: { in: ids }, projectId },
		select: {
			id: true,
			kind: true,
			title: true,
			identifier: true,
			description: true,
			acceptanceCriteria: true,
		},
	});
	const byId = new Map(items.map((i) => [i.id, i]));

	type Change = ChangeProposal["changes"][number];
	type Item = (typeof items)[number];

	const counters = { merged: 0, heldBack: 0 };

	// Safe-hold: keep the existing body. Neutralize the body diff so apply skips
	// description/AC writes; title/priority/size still apply.
	const safeHold = (change: Change, item: Item) => {
		const existingDescription = item.description ?? "";
		const existingAc = item.acceptanceCriteria ?? "";
		if (change.description) {
			change.description = {
				from: existingDescription,
				to: existingDescription,
			};
		}
		if (change.acceptanceCriteria) {
			change.acceptanceCriteria = { from: existingAc, to: existingAc };
		}
		change.bodyMergeFallback = true;
		counters.heldBack++;
	};

	const mergeOne = async (change: Change) => {
		const item = change.existingId
			? byId.get(change.existingId)
			: undefined;
		// Item not found (deleted/forged/cross-project) — leave untouched; the
		// apply path handles unresolved updates loudly.
		if (!item) {
			return;
		}

		// Capture whether the analyzer actually proposed a DESCRIPTION change
		// before we mutate anything, so an AC-only update never silently picks up
		// a description rewrite.
		const proposedDescription = !!change.description?.to;

		// New information = the analyzer's proposed content + reasoning. The merge
		// folds this into the existing structured body.
		const newInfo = [
			change.description?.to ?? "",
			change.acceptanceCriteria?.to
				? `Acceptance criteria update:\n${change.acceptanceCriteria.to}`
				: "",
			change.reasoning ? `Why this update: ${change.reasoning}` : "",
		]
			.filter(Boolean)
			.join("\n\n");

		const result = await reanalyzeBodyByKind({
			kind: item.kind,
			title: item.title,
			identifier: item.identifier,
			existingDescription: item.description ?? "",
			existingAcceptanceCriteria: item.acceptanceCriteria,
			newInfo,
			connectedContext,
			userId,
			organizationId,
			projectId,
		});

		if (result.fallbackUsed) {
			safeHold(change, item);
			return;
		}

		const existingDescription = item.description ?? "";
		const existingAc = item.acceptanceCriteria ?? "";
		counters.merged++;
		// Mark as already merged so the apply activity does not re-run the merge
		// (avoids a double LLM call on the analysis path).
		change.structurePreserved = true;

		// Only rewrite the description when the analyzer actually proposed a
		// description change. `from` = the TRUE existing body so the review diff is
		// accurate. AC-only updates leave the description untouched.
		if (proposedDescription) {
			change.description = {
				from: existingDescription,
				to: result.description,
			};
		}
		if (result.acceptanceCriteria !== undefined) {
			change.acceptanceCriteria = {
				from: existingAc,
				to: result.acceptanceCriteria,
			};
		} else if (change.acceptanceCriteria) {
			// Merge decided AC shouldn't change — neutralize so the analyzer's raw
			// AC proposal doesn't override.
			change.acceptanceCriteria = { from: existingAc, to: existingAc };
		}
	};

	// Bound the work: each merge is a COMPLEX LLM call running inside the analysis
	// activity's startToCloseTimeout. Cap the number per run (safe-hold the rest so
	// nothing is destructively overwritten) and run with limited concurrency to
	// keep wall-time well under the timeout even for large batches.
	const MAX_MERGES = 20;
	const CONCURRENCY = 4;
	const toProcess = targets.slice(0, MAX_MERGES);
	const overflow = targets.slice(MAX_MERGES);

	for (const change of overflow) {
		const item = change.existingId
			? byId.get(change.existingId)
			: undefined;
		if (item) {
			safeHold(change, item);
		}
	}
	if (overflow.length > 0) {
		logger.warn(
			"[Backlog Analysis] structure-preserving merge cap hit; safe-held overflow",
			{ projectId, cap: MAX_MERGES, overflow: overflow.length },
		);
	}

	for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
		heartbeat(`structurePreserveUpdates: ${i}/${toProcess.length}`);
		await Promise.all(toProcess.slice(i, i + CONCURRENCY).map(mergeOne));
	}

	logger.info(
		"[Backlog Analysis] Structure-preserving update pass complete",
		{
			projectId,
			candidates: targets.length,
			merged: counters.merged,
			heldBack: counters.heldBack,
		},
	);

	return changes;
}

// =============================================================================
// Main Analysis Activity
// =============================================================================

/**
 * Analyze fetched context against the existing backlog and produce
 * structured change proposals using LLM.
 *
 * Uses resolveModelWithCredentials for COMPLEX task type, then calls
 * generateObject with a Zod schema for structured output.
 */
export async function analyzeContextAndPropose(
	input: AnalyzeContextInput,
): Promise<ChangeProposal> {
	const {
		projectId,
		userId,
		organizationId,
		fetchedContext,
		existingBacklog,
		pmWorkItems,
		userPrompt,
		pmToolType,
		allowUpdates = true,
		allowRouting = false,
		deferDecisionPrecheck = false,
	} = input;

	logger.info("[Backlog Analysis] Starting context analysis", {
		projectId,
		userId,
		organizationId,
		pmToolType,
		hasTeamsMessages: !!fetchedContext.teamsMessages,
		hasSlackMessages: !!fetchedContext.slackMessages,
		hasMeetingTranscripts:
			(fetchedContext.meetingTranscripts ?? []).length > 0,
		hasNotionContent: (fetchedContext.notionContent ?? []).length > 0,
		hasRagContext: !!fetchedContext.ragContext,
		hasSecurityFindings: !!fetchedContext.securityFindings,
		hasArchitectureDecisions: !!fetchedContext.architectureDecisions,
		existingStories: existingBacklog.stories.length,
	});

	// Flatten array context into single strings for the prompt
	// Spread, then override ONLY the two array-shaped sources with their joined
	// form. Hand-listing every key here silently dropped `applicationLogs` when
	// it was added — the logs were fetched and redacted, then discarded before
	// the prompt was built, while the user was still told they had been
	// included. Spreading means a new scalar context source cannot be lost at
	// this seam again; only a new ARRAY source needs a line.
	const flattenedContext = {
		...fetchedContext,
		meetingTranscripts:
			fetchedContext.meetingTranscripts?.join("\n\n---\n\n"),
		notionContent: fetchedContext.notionContent?.join("\n\n---\n\n"),
	};

	// Fizzy #2048 (AC7): read the type-specific body structure from the prompt
	// catalog instead of applying the hard-coded skeleton. Resolved HERE, not
	// inside `buildAnalysisPrompt`, so that function stays pure and synchronous
	// (the prompt unit tests call it through this activity with no DB). Either
	// kind may come back undefined — the builder then keeps its in-code skeleton
	// for that kind alone.
	const workItemBodyTemplates = await resolveWorkItemBodyTemplates({
		projectId,
		userId,
		organizationId,
	});

	// Build the analysis prompt
	const prompt = buildAnalysisPrompt({
		projectId,
		fetchedContext: flattenedContext,
		existingBacklog,
		pmWorkItems,
		userPrompt,
		pmToolType,
		allowUpdates,
		featureBodyTemplate: workItemBodyTemplates.feature,
		bugBodyTemplate: workItemBodyTemplates.bug,
	});

	// Bug #391: model resolution and the LLM call were previously unguarded, so
	// any failure (provider not configured, quota/rate-limit, context-length,
	// schema/parse, transient) bubbled up raw and surfaced as an opaque
	// "Analysis failed: <raw>" card. Wrap them, classify the failure into a
	// stable errorClass + actionable message, log a single self-diagnosing line,
	// and re-throw a typed ApplicationFailure the workflow unwraps for the user.
	const analysisStart = Date.now();
	let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
	let result: Awaited<
		ReturnType<typeof generateObject<typeof ChangeProposalSchema>>
	>;
	try {
		// Resolve AI model via centralized entry point
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{ userId, organizationId, featureKey: "backlog-update" },
		);

		logger.info("[Backlog Analysis] Using AI model", {
			modelString: metadata.modelString,
			provider: metadata.provider,
			selectionSource: metadata.selectionSource,
		});

		// Heartbeat every 30s so Temporal doesn't time out during the LLM call.
		heartbeatInterval = setInterval(() => {
			try {
				heartbeat("analyzeContextAndPropose: waiting for LLM response");
			} catch {
				// Activity may have been cancelled — clearInterval happens in finally.
			}
		}, 30_000);

		// The proposal can restate large verbatim descriptions for many items, so
		// output tracks the assembled analysis content — scaled mode. Without an
		// explicit budget Databricks/Anthropic-direct truncate at their injected
		// defaults (8,192 / 4,096), which surfaces as a NoObjectGeneratedError
		// with finishReason "length" (see classify-analysis-error.ts).
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: prompt.length,
			promptChars: prompt.length,
		});

		result = await generateObject({
			model,
			schema: ChangeProposalSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			// Bug #1681: ChangeProposalSchema has many optional fields. The
			// OpenAI/Azure provider (@ai-sdk/openai) defaults
			// `strictJsonSchema` to `true`, which sends a strict
			// `response_format: { type: "json_schema", strict: true }`. Strict
			// mode REQUIRES every property to appear in `required`, so optional
			// fields make Azure reject the request with a 400 ("Invalid schema
			// for response_format"). Plain-text generation (chat/connection
			// test) never hits this path — which is exactly why text worked but
			// AI Update's structured generateObject failed on Azure AI Foundry.
			// Disable strict mode so optional fields are tolerated; the AI SDK
			// still validates the result against the Zod schema.
			providerOptions: { openai: { strictJsonSchema: false } },
		});

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "COMPLEX",
			usage: result.usage,
			latencyMs: Date.now() - analysisStart,
			projectId,
		});
	} catch (error) {
		const classified = classifyBacklogAnalysisError(error);
		logger.error("[Backlog Analysis] generate failed", {
			...classified.logFields,
			workflowId: Context.current().info.workflowExecution.workflowId,
			projectId,
			approxPromptChars: prompt.length,
			// Spec §4: per-source context sizes for self-diagnosis. teams/slack/
			// transcripts/notion/rag are flattenedContext strings (already in scope).
			// backlog/pm are objects serialized inside buildAnalysisPrompt — not
			// separately available as strings, so approximated via JSON.stringify.
			contextSizes: {
				teams: flattenedContext.teamsMessages?.length ?? 0,
				slack: flattenedContext.slackMessages?.length ?? 0,
				transcripts: flattenedContext.meetingTranscripts?.length ?? 0,
				notion: flattenedContext.notionContent?.length ?? 0,
				rag: flattenedContext.ragContext?.length ?? 0,
				// Listed here for the same reason the others are, and because
				// its absence hid a real defect: the log section was being
				// dropped before the prompt while the user was told it had
				// been included. A `logs: 0` next to an "included N entries"
				// note is the contradiction that makes that visible.
				logs: flattenedContext.applicationLogs?.length ?? 0,
				backlog: JSON.stringify(existingBacklog).length,
				pm: pmWorkItems ? JSON.stringify(pmWorkItems).length : 0,
			},
			latencyMs: Date.now() - analysisStart,
		});
		// DO NOT pass a `cause` argument here. The classified message/errorClass
		// survive Temporal's ActivityFailure wrapper ONLY because no cause is
		// attached — `unwrapPmSyncError` in the workflow walks the `.cause` chain
		// and would surface a deeper raw frame over the classified message,
		// silently re-breaking #391 (the same hazard is documented in
		// `backlog-apply-outcome.ts`). Keep this throw to exactly two arguments.
		throw ApplicationFailure.nonRetryable(
			classified.userMessage,
			classified.errorClass,
		);
	} finally {
		if (heartbeatInterval) {
			clearInterval(heartbeatInterval);
		}
	}

	const proposal: ChangeProposal = result.object;

	// Capture-as-is enforcement: when the monitored-channel flow disabled
	// updates (`allowUpdates: false`), drop any `action: "update"` the model
	// emitted anyway so the proposal can only ever create new work items —
	// belt-and-suspenders behind the create-only prompt rules above. AI Update /
	// document analyzer / ADO sync (allowUpdates defaults true) are unaffected.
	if (!allowUpdates) {
		const updateCount = proposal.changes.filter(
			(c) => c.action === "update",
		).length;
		if (updateCount > 0) {
			logger.warn(
				"[Backlog Analysis] capture-as-is flow dropped model-emitted update action(s)",
				{ projectId, dropped: updateCount },
			);
			proposal.changes = proposal.changes.filter(
				(c) => c.action !== "update",
			);
		}
	}

	// Create-vs-Enrich routing. Runs AFTER the create-only enforcement above, so
	// it sees exactly the create-only proposal the capture-as-is flows produce,
	// and BEFORE resolution/structure-preservation below, so the enrichments it
	// produces flow through the same target-resolution and structure-preserving
	// merge the AI Update path already uses. Never throws — a routing outage
	// leaves every item a create with an error stamp.
	let routedEnrichCount = 0;
	if (allowRouting) {
		const routingResult = await routeActionItemsToExistingTickets({
			changes: proposal.changes,
			projectId,
			userId,
			organizationId,
		});
		proposal.changes = routingResult.changes;
		routedEnrichCount = routingResult.enriched;
	}

	// "story" can no longer be emitted — the generation schema only permits
	// epic/feature/bug — so there is no story-drift to detect here anymore.
	logger.info("[Backlog Analysis] Analysis complete", {
		projectId,
		totalChanges: proposal.changes.length,
		creates: proposal.changes.filter((c) => c.action === "create").length,
		updates: proposal.changes.filter((c) => c.action === "update").length,
		epics: proposal.changes.filter((c) => c.type === "epic").length,
		features: proposal.changes.filter((c) => c.type === "feature").length,
		bugs: proposal.changes.filter((c) => c.type === "bug").length,
	});

	if (existingBacklog?.stories != null) {
		proposal.changes = annotateProposalResolutions(
			proposal.changes,
			existingBacklog.stories,
		);
		logger.info("[Backlog Analysis] Annotated proposal resolutions", {
			projectId,
			demoted: proposal.changes.filter(
				(c) => c.targetResolution?.demotedFromUpdate,
			).length,
		});
	}

	// Structure-preserving update pass: for resolved UPDATE proposals, re-derive
	// the body via the kind-appropriate re-analysis prompt so an AI Update never
	// reformats a bug into feature sections (or vice versa) and only targeted
	// edits are applied.
	//
	// Runs for `allowUpdates` flows and for capture-as-is flows whose routing
	// pass just produced enrichments. Routed enrichments need it for two
	// reasons: it is what keeps FR10 true (the merge integrates into the
	// existing structure rather than replacing it), and it is what makes the
	// review diff honest — `description.from` becomes the ticket's TRUE current
	// body and `.to` the merged result, so the preview shows only what is being
	// added instead of looking like a wholesale rewrite.
	if (
		(allowUpdates || routedEnrichCount > 0) &&
		existingBacklog?.stories != null
	) {
		proposal.changes = await structurePreserveUpdates({
			changes: proposal.changes,
			projectId,
			userId,
			organizationId,
			connectedContext: fetchedContext.ragContext,
		});
	}

	// INLINE decision pre-check (non-fatal) — monitored-channel sources only.
	// Runs once the proposal is fully formed so its findings can ride along on
	// the returned proposal and be folded into `sourceMetadata.decisionPrecheck`
	// when the monitor persists the pending row. These are background jobs with
	// no user waiting, so the extra COMPLEX judge call is acceptable inline.
	//
	// The user-interactive AI-Update path passes `deferDecisionPrecheck: true`:
	// card #1365's async NFR requires the proposal to return immediately, so the
	// analysis workflow skips this block and runs the judge as a separate
	// post-return activity instead (see `runBacklogDecisionPrecheckActivity`).
	// `runDecisionPrecheck` is itself the degradation boundary and never throws,
	// but the call stays defensively wrapped so no pre-check failure can break
	// analysis.
	if (!deferDecisionPrecheck) {
		try {
			const decisionConflicts = await runDecisionPrecheck({
				projectId,
				userId,
				organizationId,
				artifact: {
					surface: "backlog_proposal",
					items: buildBacklogPrecheckItems(proposal.changes),
				},
			});
			if (decisionConflicts.findings.length > 0) {
				proposal.decisionConflicts = decisionConflicts;
			}
		} catch (precheckError) {
			logger.warn(
				"[Backlog Analysis] decision pre-check failed; returning proposal without warnings",
				{
					projectId,
					reason:
						precheckError instanceof Error
							? precheckError.message
							: String(precheckError),
				},
			);
		}
	}

	return proposal;
}

/**
 * Async decision pre-check for the user-interactive AI-Update surface.
 *
 * A thin activity wrapper around `runDecisionPrecheck` so the backlog analysis
 * workflow can run the LLM judge OFF the proposal's critical path (card #1365's
 * async NFR): the workflow returns/exposes the proposal first, then invokes this
 * activity and folds any findings back into its queryable state. Keeping it a
 * dedicated activity (rather than inline in `analyzeContextAndPropose`) is what
 * lets the workflow gate the new command behind `patched()` for replay safety.
 *
 * Never throws — `runDecisionPrecheck` is the degradation boundary and returns
 * an empty "ok" result on any failure.
 */
export interface RunBacklogDecisionPrecheckInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** The proposed changes to judge (the returned proposal's `changes`). */
	changes: ChangeProposal["changes"];
}

export async function runBacklogDecisionPrecheckActivity(
	input: RunBacklogDecisionPrecheckInput,
): Promise<DecisionPrecheckResult> {
	const { projectId, userId, organizationId, changes } = input;
	return runDecisionPrecheck({
		projectId,
		userId,
		organizationId,
		artifact: {
			surface: "backlog_proposal",
			items: buildBacklogPrecheckItems(changes),
		},
	});
}

// =============================================================================
// Apply Changes Activity
// =============================================================================

/**
 * Map a priority string from the LLM proposal to a valid StoryPriority enum value.
 */
export function mapPriority(
	priority: string | undefined | null,
): "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW" | undefined {
	if (!priority) {
		return undefined;
	}
	const upper = priority.toUpperCase();
	if (upper.includes("P0") || upper.includes("CRITICAL")) {
		return "P0_CRITICAL";
	}
	if (upper.includes("P1") || upper.includes("HIGH")) {
		return "P1_HIGH";
	}
	if (upper.includes("P2") || upper.includes("MEDIUM")) {
		return "P2_MEDIUM";
	}
	if (upper.includes("P3") || upper.includes("LOW")) {
		return "P3_LOW";
	}
	return undefined;
}

/**
 * Map a size string from the LLM proposal to a valid StorySize enum value.
 */
export function mapSize(
	size: string | undefined | null,
): "XS" | "S" | "M" | "L" | "XL" | undefined {
	if (!size) {
		return undefined;
	}
	const upper = size.toUpperCase().trim();
	if (upper === "XS") {
		return "XS";
	}
	if (upper === "S") {
		return "S";
	}
	if (upper === "M") {
		return "M";
	}
	if (upper === "L") {
		return "L";
	}
	if (upper === "XL") {
		return "XL";
	}
	return undefined;
}

/**
 * Normalize a backlog-item title for duplicate detection.
 *
 * Two titles that normalize to the same string are treated as the same item by
 * the AI Update applier's pre-create dedup guard. Normalization handles:
 *   - case differences ("Login Crashes" vs "login crashes")
 *   - surrounding whitespace
 *   - the pre-#1041 "[BUG] " prefix convention: legacy bug rows still carry it,
 *     but PR #1041 told the analyzer to stop emitting it, so a new proposal
 *     for the same underlying bug would otherwise look novel.
 *
 * Empty strings normalize to empty — callers must treat an empty key as "no
 * dedup signal available" and let the create proceed.
 */
// normalizeBacklogTitle moved to @repo/database/utils so the AI Update
// sidebar guard (here) and the Teams/Slack approve-pending-proposal guards
// share a single equivalence class.

/**
 * Run a slow per-change operation while emitting a Temporal heartbeat every 15s.
 *
 * A single LLM-heavy `createStoryFromProposal` (bug classify + draft) can exceed
 * the activity's 60s `heartbeatTimeout`. The apply loop only heartbeats BETWEEN
 * changes, so without an intra-call keepalive the activity is timed out and
 * retried mid-create — and a retry re-runs the whole batch, which for the
 * terminal-redirect create produced duplicate rows. The interval is a no-op for
 * fast calls (they resolve before the first tick) and harmless outside an
 * activity context (unit tests), where `heartbeat()` throws and is swallowed.
 */
async function withHeartbeatKeepalive<T>(
	details: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	const interval = setInterval(() => {
		try {
			heartbeat({ keepalive: true, ...details });
		} catch {
			// Not inside an activity (e.g. unit tests) — nothing to keep alive.
		}
	}, 15_000);
	try {
		return await fn();
	} finally {
		clearInterval(interval);
	}
}

/**
 * Apply approved backlog changes to Fabric DB.
 *
 * `user_story` is the only work-item table (the Epic/Feature folder tables
 * were dropped): every CREATE is materialized as a roadmap-visible
 * UserStory leaf via `createStoryFromProposal` (kind FEATURE or BUG), and
 * every UPDATE resolves against the flat story list. Legacy `epic`-typed
 * changes (stored proposals) are normalized to `feature` up-front.
 *
 * Returns appliedCount, a createdItemMap (change-index to new ID), and
 * detailed created/updated item lists.
 */
export async function applyBacklogChanges(
	input: ApplyBacklogChangesInput,
): Promise<ApplyBacklogChangesResult> {
	const {
		projectId,
		userId,
		approvedByName,
		organizationId,
		pendingProposalId,
	} = input;
	// Widen to the apply-internal type. The public input stays the (narrow)
	// generated shape so the workflow's activity proxy is unchanged, but the
	// reconciler below uses "story" as an internal discriminator for existing
	// user_story rows (and to pass legacy stored "story" proposals through).
	// Narrow ⊆ wide, so no cast is needed.
	const approvedChanges: AppliedBacklogChange[] = input.approvedChanges;

	// Epic → feature normalization — UNCONDITIONAL for every caller (this was
	// the channel-monitor `forbidEpics` opt-in, Bug 1429, before the folder
	// tables were dropped). An `epic`-typed change can no longer materialize
	// as an Epic row, so it routes to the feature/leaf creation path
	// (createStoryFromProposal with kind FEATURE) instead. This also covers
	// already-stored proposals — no data migration. The `forbidEpics` input is
	// retained for caller compatibility but no longer changes behavior.
	if (input.forbidEpics !== undefined) {
		logger.info(
			"[Backlog Apply] forbidEpics input is deprecated — epic→feature normalization is now unconditional",
			{ projectId, forbidEpics: input.forbidEpics },
		);
	}
	for (const change of approvedChanges) {
		if ((change as { type: string }).type === "epic") {
			// Mirror the retired-"story" warn (below) so epic normalization
			// is auditable on staging.
			logger.warn(
				"[Backlog Apply] Normalizing epic-typed change to feature (Epic/Feature folder tables removed)",
				{
					projectId,
					title: change.title?.to,
					action: change.action,
				},
			);
			change.type = "feature";
			// An epic carries no real parent-epic; drop any parent-epic
			// reference so the normalized feature is created as a top-level
			// leaf rather than nesting under a phantom epic.
			change.parentEpicIdentifier = null;
			change.parentEpicTitle = null;
		}
	}
	// When the approval carried "Sync to PM", persist the per-row gate on
	// every new story so later edits don't silently diverge
	// (see `[[project_pm_sync_gate]]`). Default `undefined` preserves the
	// column default (`false`) for legacy callers that haven't opted in.
	const enablePmAutoSync = input.syncToPM === true ? true : undefined;

	// Legacy proposals stored before the DSU 2026-05-23 prompt change may
	// still carry `type: "story"`. The story-typed branches downstream
	// process them via createStoryFromProposal exactly like feature/bug. New
	// analyses produced after the prompt change never emit "story" at all.
	const legacyStoryCount = approvedChanges.filter(
		(c) => (c as { type: string }).type === "story",
	).length;
	if (legacyStoryCount > 0) {
		logger.info(
			"[Backlog Apply] Applying legacy story-typed changes from a pre-2026-05-23 proposal",
			{ projectId, legacyStoryCount },
		);
	}

	logger.info("[Backlog Apply] Applying approved changes", {
		projectId,
		totalChanges: approvedChanges.length,
	});

	// Gatekeeper: a forged projectId from another tenant must not reach the
	// create/update calls below.
	const projectOwner = await db.project.findFirst({
		where: {
			id: projectId,
			...tenantWhere(userId, organizationId),
		},
		select: { id: true },
	});
	if (!projectOwner) {
		throw new Error(
			`Project not found or not accessible for this tenant: ${projectId}`,
		);
	}

	// If existingBacklog was not provided, fetch the flat story list for
	// update-resolution + the pre-create dedup index.
	let existingBacklog = input.existingBacklog;
	if (!existingBacklog) {
		const stories = await db.userStory.findMany({
			where: { projectId },
			orderBy: { order: "asc" },
			select: {
				id: true,
				identifier: true,
				title: true,
				description: true,
				externalId: true,
			},
		});
		existingBacklog = { stories };
	}

	const createdItems: ApplyBacklogChangesResult["createdItems"] = [];
	const updatedItems: ApplyBacklogChangesResult["updatedItems"] = [];
	const errors: ApplyBacklogChangesResult["errors"] = [];
	const skippedDuplicates: ApplyBacklogChangesResult["skippedDuplicates"] =
		[];
	const convertedToCreate: ApplyBacklogChangesResult["convertedToCreate"] =
		[];
	const redirectedTerminalUpdates: NonNullable<
		ApplyBacklogChangesResult["redirectedTerminalUpdates"]
	> = [];
	const createdItemMap: Record<number, string> = {};
	const updatedItemMap: Record<number, string> = {};
	const typeCorrections: Record<
		number,
		"epic" | "feature" | "story" | "bug"
	> = {};

	// Build a mapping from the original change index to the sorted order
	// so we can populate createdItemMap with the correct original index.
	const indexedChanges = approvedChanges.map((change, originalIndex) => ({
		change,
		originalIndex,
	}));

	// Sort changes: creates before updates so the in-batch dedup index sees
	// every freshly created row before an update tries to resolve it. (The
	// epic/feature keys remain in the order map defensively for stored legacy
	// payloads; after the normalization above only feature/story/bug occur.)
	const sortOrder = { epic: 0, feature: 1, story: 2, bug: 2 };
	const actionOrder = { create: 0, update: 1 };
	indexedChanges.sort((a, b) => {
		const typeCompare = sortOrder[a.change.type] - sortOrder[b.change.type];
		if (typeCompare !== 0) {
			return typeCompare;
		}
		return actionOrder[a.change.action] - actionOrder[b.change.action];
	});

	// Pre-create dedup index — keyed by normalizeBacklogTitle().
	//
	// The analyzer is instructed to prefer UPDATE over CREATE for matching
	// items, but it's an LLM heuristic, not a guarantee. Pre-PR-#1041 bug rows
	// carry a "[BUG] " title prefix that the analyzer is now forbidden to emit,
	// so semantically-identical proposals look novel to the LLM. Together with
	// the analyzer occasionally emitting the same change twice within a single
	// batch, this caused user-visible duplicate-creation. Maintain a title
	// index here and consult it before every CREATE.
	//
	// Empty normalized keys are skipped — they collide with nothing meaningful.
	const dedupStories = new Map<
		string,
		{ id: string; identifier: string; title: string }
	>();
	//
	// Terminal items (closed / declined / auto-hidden — see
	// `TERMINAL_DRAFTING_STAGES` / `isTerminalWorkItemState`) must NEVER seed this
	// index: a resolved, immutable record must not block a fresh create that
	// shares its title, and — critically — the terminal-state redirect below must
	// not skip its new ticket as a "duplicate" of the very (closed) ticket it is
	// superseding. `existingBacklog` carries no lifecycle fields, so fetch the
	// project's terminal ids once and subtract them while building the index.
	const terminalStoryIds = new Set(
		(
			await db.userStory.findMany({
				where: {
					projectId,
					OR: [
						{ draftingStage: { in: TERMINAL_DRAFTING_STAGES } },
						{ pmAutoHidden: true },
					],
				},
				select: { id: true },
			})
		).map((s) => s.id),
	);
	for (const s of existingBacklog.stories) {
		if (terminalStoryIds.has(s.id)) {
			continue;
		}
		const key = normalizeBacklogTitle(s.title);
		if (key && !dedupStories.has(key)) {
			dedupStories.set(key, {
				id: s.id,
				identifier: s.identifier,
				title: s.title,
			});
		}
	}

	/**
	 * Shared CREATE routine for every change type (feature / legacy story /
	 * bug — epics were normalized to features above). Consults the dedup
	 * index, creates the UserStory leaf via createStoryFromProposal, links
	 * the proposal-supplied externalId, and records the result maps.
	 *
	 * Returns true when a row was created, false when the dedup guard
	 * skipped the create.
	 */
	const createLeafFromChange = async (
		change: AppliedBacklogChange,
		originalIndex: number,
		logContext: string,
		opts?: { supersedes?: { id: string; identifier: string } },
	): Promise<boolean> => {
		// Dedup guard — handles three real-world vectors:
		//   1. LLM emits a CREATE for an item already in the backlog
		//      (its semantic-match dedup missed)
		//   2. PR #1041 dropped the "[BUG] " prefix from new bug
		//      titles, but pre-existing rows still carry it — bare
		//      vs prefixed titles now compare unequal at exact-match
		//      (normalizeBacklogTitle strips the prefix to match)
		//   3. Same change emitted twice in a single batch (caught
		//      because successful creates append to dedupStories
		//      below, so the second iteration sees it)
		const dedupKey = normalizeBacklogTitle(change.title.to);
		const dup = dedupKey ? dedupStories.get(dedupKey) : undefined;
		if (dup) {
			logger.warn(
				`[Backlog Apply] Skipping duplicate CREATE${logContext} — title matches existing item`,
				{
					projectId,
					proposedTitleLength: change.title.to?.length ?? 0,
					existingId: dup.id,
					existingIdentifier: dup.identifier,
					changeIndex: originalIndex,
					changeType: change.type,
				},
			);
			skippedDuplicates.push({
				type: change.type,
				changeIndex: originalIndex,
				proposedTitle: change.title.to,
				existingId: dup.id,
				existingIdentifier: dup.identifier,
				existingTitle: dup.title,
			});
			return false;
		}

		// F-171 parity: route AI Update creates through the same helper used
		// by manual create, Slack/Teams approval, and the fabric_create_story
		// tool. The classifier inside the helper is authoritative for `kind`;
		// `change.type` is passed as a hint only. AI Update has no per-source
		// attribution beyond `source: "AI_UPDATE"` on the row — there is no
		// ReporterSource enum value for AI Update by design.
		//
		// When the approval UI supplied `kindOverride` we bypass the
		// classifier and use the reviewer's selection verbatim. This is the
		// safety net for the classifier BUG-bias (see DSU 2026-05-20).
		// Without an override the classifier still runs for legacy
		// story-typed changes (preserves AC3).
		//
		// `skipDrafting: true` preserves the analyzer-produced description
		// verbatim for FEATURE rows (AC4 — features unaffected). The helper
		// still runs the bug_creation prompt for BUG rows so `needsMoreInfo`
		// is populated (AC3).
		//
		// `feature`-typed creates honor the analyzer's FEATURE decision
		// verbatim (skipClassifier below): the senior-PM analyzer already
		// classified feature-vs-bug, and re-running the work-item classifier
		// risks the documented BUG-bias flipping a genuine feature to a bug.
		const overrideKind = change.kindOverride ?? undefined;
		const isRoutedFeature = change.type === "feature";
		const effectiveKindHint =
			overrideKind ??
			(change.type === "bug"
				? "BUG"
				: isRoutedFeature
					? "FEATURE"
					: undefined);
		const labels = [
			...((overrideKind ??
				(change.type === "bug" ? "BUG" : "FEATURE")) === "BUG"
				? ["bug"]
				: []),
			// Queryable provenance marker for a terminal-state redirect; pairs with
			// the human-readable footer appended to the body after creation.
			...(opts?.supersedes
				? [`supersedes:${opts.supersedes.identifier}`]
				: []),
		];
		if (overrideKind) {
			// Trace the reviewer's manual correction so we can audit
			// classifier override rates over time (was the classifier
			// biased? did the PM step in?). Pairs with the
			// "classifier overrode caller-provided kind" log inside
			// createStoryFromProposal — together they triangulate
			// where the kind decision came from on every row.
			logger.info(
				"[Backlog Apply] PM-supplied kindOverride honored — classifier bypassed",
				{
					projectId,
					changeIndex: originalIndex,
					changeType: change.type,
					overrideKind,
					title: change.title.to,
				},
			);
		}
		const createParams: Parameters<typeof createStoryFromProposal>[0] = {
			projectId,
			organizationId,
			createdById: userId,
			title: change.title.to,
			description: change.description?.to,
			acceptanceCriteria: change.acceptanceCriteria?.to,
			kind: effectiveKindHint,
			// Pre-drafted creates fixed their kind at review time → don't let the
			// classifier override it (the body was drafted for that exact kind).
			skipClassifier:
				overrideKind !== undefined ||
				isRoutedFeature ||
				change.predrafted === true,
			priority: mapPriority(change.priority?.to),
			size: mapSize(change.size?.to),
			labels,
			source: "AI_UPDATE",
			reporterName: null,
			reporterSource: null,
			reporterSourceUrl: null,
			// Pre-drafted at review time (lazy draft on open) → persist the body
			// verbatim, no re-draft (bugs included), carrying the captured triage
			// flag; the pre-draft already ran through the Clean Spec prompt via
			// draftBodyByKind, so re-drafting would be a wasteful double pass.
			// #1799: for a non-predrafted create, DO draft (skipDrafting false) so the
			// analyzer's body is refined through the kind-scoped Clean Spec prompt
			// (feature_clean_spec_generator / bug_clean_spec_generator) — no creation
			// path stays on the legacy template. (Previously non-override creates kept
			// the analyzer body verbatim; #1799 supersedes that.)
			skipDrafting: change.predrafted === true,
			bodyAlreadyDrafted: change.predrafted === true,
			needsMoreInfo:
				change.predrafted === true ? change.needsMoreInfo : undefined,
			enablePmAutoSync,
			// This path also creates work items from a proposal (its `source`
			// is AI_UPDATE rather than APPROVED_PROPOSAL), so it carries the
			// same provenance. Undefined for direct/legacy callers that apply
			// changes without a proposal.
			createdFromProposalId: pendingProposalId,
		};
		const { story } = await withHeartbeatKeepalive(
			{ stage: "create-leaf", changeIndex: originalIndex },
			() => createStoryFromProposal(createParams),
		);
		// Link the new row to the proposal-supplied PM card — EXCEPT on a
		// terminal-state redirect, where `existingExternalId` is the CLOSED
		// ticket's PM card. Binding the new ticket to it would let PM sync mutate
		// or reopen the very record the gate is protecting, so the redirect path
		// deliberately creates an UNLINKED ticket (a fresh PM card is created on
		// first sync instead).
		if (change.existingExternalId && !opts?.supersedes) {
			await updateStory(story.id, projectId, {
				externalId: change.existingExternalId,
			});
		}
		createdItems.push({
			type: change.type,
			id: story.id,
			identifier: story.identifier,
			title: story.title,
		});
		createdItemMap[originalIndex] = story.id;
		// Audit trail (AI Backlog change history). Attributed to the AI agent so
		// the read-only Audit tab shows it as "AI". Fire-and-forget — never blocks
		// or fails the apply.
		recordAudit({
			action: "story.created",
			category: "story",
			actor: { type: "agent", userId, nameSnapshot: "Fabric AI" },
			organizationId: organizationId ?? null,
			projectId,
			resource: { type: "story", id: story.id, name: story.title },
			metadata: {
				source: "AI_UPDATE",
				kind: change.type,
				...(pendingProposalId ? { proposalId: pendingProposalId } : {}),
			},
		});
		if (isRoutedFeature) {
			// This `feature` change became a UserStory leaf; the PM-sync step
			// resolves items by type, so correct it to "story" (user_story
			// table). Without this the sync would look for a non-existent
			// container row and never find it.
			typeCorrections[originalIndex] = "story";
		}
		if (dedupKey) {
			dedupStories.set(dedupKey, {
				id: story.id,
				identifier: story.identifier,
				title: story.title,
			});
		}

		if (opts?.supersedes) {
			// Append the human-readable provenance footer to the PERSISTED body
			// (post-draft, so it survives the bug_creation prompt re-draft for BUG
			// rows; FEATURE bodies are preserved verbatim). Pairs with the
			// queryable `supersedes:<id>` label set at create time (REQ-4).
			const footer = `\n\n---\n> ⤺ Supersedes closed ticket ${opts.supersedes.identifier} (${opts.supersedes.id})`;
			await updateStory(
				story.id,
				projectId,
				{ description: `${story.description ?? ""}${footer}` },
				{ lastEditedSource: "AI_BACKLOG_UPDATE" },
			);
			redirectedTerminalUpdates.push({
				changeIndex: originalIndex,
				closedId: opts.supersedes.id,
				closedIdentifier: opts.supersedes.identifier,
				newId: story.id,
				newIdentifier: story.identifier,
				proposedTitle: story.title,
			});
			// REQ-8 observability: one warn-level entry carrying the closed
			// ticket id, the proposed update title, and the NEW ticket id.
			logger.warn(
				"[Backlog Apply] Terminal-state update redirected to a new ticket",
				{
					projectId,
					changeIndex: originalIndex,
					closedId: opts.supersedes.id,
					closedIdentifier: opts.supersedes.identifier,
					newId: story.id,
					newIdentifier: story.identifier,
					proposedTitleLength: story.title?.length ?? 0,
				},
			);
		}
		return true;
	};

	for (const { change, originalIndex } of indexedChanges) {
		// Liveness signal — the per-change work now includes a classifier LLM
		// call and (for bugs) a drafting LLM call inside createStoryFromProposal,
		// so each iteration can take several seconds. Without a heartbeat the
		// 60-second heartbeatTimeout fires mid-batch and the worker is killed,
		// triggering a from-scratch retry (potential duplicate creates).
		heartbeat({
			changeIndex: originalIndex,
			total: indexedChanges.length,
			type: change.type,
			action: change.action,
		});

		try {
			if (change.action === "create") {
				await createLeafFromChange(change, originalIndex, "");
			} else if (change.action === "update") {
				let itemId = change.existingId;

				// Validate that existingId is a Fabric DB identifier (CUID or UUID)
				const isValidFabricId =
					itemId &&
					(/^c[a-z0-9]{24,}$/.test(itemId) ||
						/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
							itemId,
						));

				// Even when existingId is a valid Fabric CUID/UUID, the LLM may
				// still mis-classify the entity type (e.g. type: "feature" for
				// an F-XXX user_story). All work items live in the user_story
				// table now, so correct feature-typed updates that resolve to a
				// story row. If the ID is not in the loaded backlog (pagination,
				// filters) we fall through and let the update fail loudly.
				if (isValidFabricId && itemId) {
					const inStories = existingBacklog.stories.some(
						(s) => s.id === itemId,
					);
					if (inStories) {
						const actualType =
							change.type === "bug" ? "bug" : "story";
						if (actualType !== change.type) {
							logger.info(
								"[Backlog Apply] Corrected type from existingId table lookup",
								{
									originalType: change.type,
									actualType,
									itemId,
									title: change.title.to,
								},
							);
							typeCorrections[originalIndex] = actualType;
							change.type = actualType;
						}
					}
				}

				// If the LLM provided a non-Fabric ID (e.g., a PM tool card ID),
				// try to resolve the correct Fabric story by identifier,
				// externalId, or title.
				if (!isValidFabricId) {
					const resolution = resolveBacklogUpdateTarget(
						existingBacklog.stories,
						change,
					);

					if (resolution.status === "resolved") {
						const resolvedType =
							change.type === "bug" ? "bug" : "story";
						if (resolvedType !== change.type) {
							logger.info(
								"[Backlog Apply] Corrected LLM type mismatch",
								{
									originalType: change.type,
									resolvedType,
									identifier: change.existingIdentifier,
									title: change.title.to,
								},
							);
							typeCorrections[originalIndex] = resolvedType;
							change.type = resolvedType;
						}
						logger.info("[Backlog Apply] Resolved Fabric ID", {
							type: change.type,
							title: change.title.to,
							originalId: itemId,
							resolvedId: resolution.storyId,
							resolvedBy: resolution.resolvedBy,
						});
						itemId = resolution.storyId;
						updatedItemMap[originalIndex] = resolution.storyId;
					} else {
						// Could not resolve — fall back to create, and RECORD it
						// (not silent) so the reviewer is told the proposed update
						// became a new item.
						logger.warn(
							"[Backlog Apply] Update could not resolve to a Fabric item, converting to create",
							{
								type: change.type,
								title: change.title.to,
								existingId: itemId,
								existingIdentifier: change.existingIdentifier,
								existingExternalId: change.existingExternalId,
							},
						);
						// Apply-time safety net. In the normal AI Update flow the
						// analyzer already demoted unresolved updates to creates
						// (see annotateProposalResolutions), so this branch mainly
						// catches: (a) callers that skip analysis-time annotation
						// (Slack/Teams channel-monitor approve flows), and (b)
						// TOCTOU — an update that resolved at analysis time but
						// whose target was deleted/merged before approval. Record
						// it (not silent) so the apply summary reports the conversion.
						convertedToCreate.push({
							changeIndex: originalIndex,
							proposedTitle: change.title.to,
							attemptedReference:
								change.existingIdentifier ||
								change.existingExternalId ||
								itemId ||
								null,
						});
						await createLeafFromChange(
							change,
							originalIndex,
							" (update fallback)",
						);
						continue;
					}
				}

				// At this point itemId is guaranteed to be a valid Fabric UUID
				// (either the original passed UUID check, or was resolved above)
				if (!itemId) {
					continue;
				}

				// Load the current row once (scoped by projectId so a forged
				// itemId from another project can't be read or mutated). Includes
				// the lifecycle fields for the terminal-state gate; reused below
				// for bug-label maintenance, the apply-time structure-preserving
				// merge, the defensive guard, and the audit pre-state.
				const existingRow = await db.userStory.findFirst({
					where: { id: itemId, projectId },
					select: {
						kind: true,
						title: true,
						identifier: true,
						description: true,
						acceptanceCriteria: true,
						labels: true,
						draftingStage: true,
						pmAutoHidden: true,
					},
				});

				// Terminal-state gate (REQ-1/2/3): a resolved update target that is
				// closed, declined, or auto-hidden is an immutable, terminal record.
				// Redirect the proposed change into a NEW ticket instead of mutating
				// it — placed BEFORE any write (the externalId link just below is a
				// write too, and even that preparatory link must be skipped). The new
				// ticket carries a `supersedes:<id>` label + a provenance footer and
				// is deliberately NOT linked to the closed ticket's PM card. Lifecycle
				// fields are read from the DB at apply time, never from the backlog
				// snapshot / MCP cache (which can be stale by up to its 7-day TTL).
				if (existingRow && isTerminalWorkItemState(existingRow)) {
					logger.warn(
						"[Backlog Apply] Update target is in a terminal state — redirecting to create",
						{
							projectId,
							changeIndex: originalIndex,
							closedId: itemId,
							closedIdentifier: existingRow.identifier,
							draftingStage: existingRow.draftingStage,
							pmAutoHidden: existingRow.pmAutoHidden,
							proposedTitle: change.title.to,
						},
					);
					// A resolve-by-identifier update may have stamped updatedItemMap
					// for the (closed) target; this item becomes a CREATE, so drop
					// that stale mapping — the index now maps only to the new row.
					delete updatedItemMap[originalIndex];

					// Idempotency: if a NON-TERMINAL ticket already supersedes this
					// closed source (e.g. a prior attempt of THIS activity that the
					// worker retried after a heartbeat timeout, or an earlier run), do
					// not create another. The title-based dedup can miss it when the
					// kind classifier regenerates the redirect's title, so key on the
					// stable `supersedes:<identifier>` provenance label.
					const alreadySuperseded = await db.userStory.findFirst({
						where: {
							projectId,
							draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
							labels: {
								has: `supersedes:${existingRow.identifier}`,
							},
						},
						select: { id: true, identifier: true, title: true },
					});
					if (alreadySuperseded) {
						logger.warn(
							"[Backlog Apply] Terminal redirect skipped — closed ticket already superseded (idempotent)",
							{
								projectId,
								changeIndex: originalIndex,
								closedId: itemId,
								closedIdentifier: existingRow.identifier,
								existingSupersederId: alreadySuperseded.id,
								existingSupersederIdentifier:
									alreadySuperseded.identifier,
							},
						);
						skippedDuplicates.push({
							type: change.type,
							changeIndex: originalIndex,
							proposedTitle: change.title.to,
							existingId: alreadySuperseded.id,
							existingIdentifier: alreadySuperseded.identifier,
							existingTitle: alreadySuperseded.title,
						});
						continue;
					}

					await createLeafFromChange(
						change,
						originalIndex,
						" (terminal redirect)",
						{
							supersedes: {
								id: itemId,
								identifier: existingRow.identifier,
							},
						},
					);
					continue;
				}

				// Link to PM tool if existingExternalId provided and not already linked.
				// This ensures PM sync can find the item later.
				if (change.existingExternalId) {
					const backlogItem = existingBacklog.stories.find(
						(s) => s.id === itemId,
					);

					if (backlogItem && !backlogItem.externalId) {
						await updateStory(itemId, projectId, {
							externalId: change.existingExternalId,
						});
						logger.info(
							"[Backlog Apply] Linked existing item to PM tool",
							{
								type: change.type,
								itemId,
								externalId: change.existingExternalId,
							},
						);
					}
				}

				// Update dispatch — feature/story/bug all live in the
				// user_story table. A feature-typed update whose id was not
				// found in the loaded backlog still goes through updateStory;
				// a non-existent id fails loudly into the per-change error
				// collector below.
				const updateData: {
					title?: string;
					description?: string;
					acceptanceCriteria?: string;
					priority?:
						| "P0_CRITICAL"
						| "P1_HIGH"
						| "P2_MEDIUM"
						| "P3_LOW";
					size?: "XS" | "S" | "M" | "L" | "XL";
					labels?: string[];
				} = {};
				if (change.type === "bug") {
					const currentLabels = existingRow?.labels ?? [];
					if (!currentLabels.includes("bug")) {
						updateData.labels = [...currentLabels, "bug"];
					}
				}
				// Title is persisted verbatim. F-171 makes `kind = BUG` the
				// source of truth for type; a "[BUG]" title prefix would
				// be redundant with the kind badge and risks duplicating
				// on subsequent updates.
				const updatedTitle = change.title.to;
				if (updatedTitle && updatedTitle !== change.title.from) {
					updateData.title = updatedTitle;
				}

				// Proposed body changes (the analyzer/agent's intent).
				const proposedDescription = Boolean(
					change.description?.to &&
						change.description.to !== change.description.from,
				);
				const proposedAcceptanceCriteria = Boolean(
					change.acceptanceCriteria?.to &&
						change.acceptanceCriteria.to !==
							change.acceptanceCriteria.from,
				);
				// Values to persist (undefined = leave the field unchanged).
				let nextDescription = proposedDescription
					? change.description?.to
					: undefined;
				let nextAcceptanceCriteria = proposedAcceptanceCriteria
					? change.acceptanceCriteria?.to
					: undefined;

				// Apply-time structure-preserving merge — the GUARANTEED choke
				// point. The analysis-time pass already merged + flagged
				// (`structurePreserved`) updates that went through
				// analyzeContextAndPropose. Proposals that bypassed analysis (e.g.
				// the chat agent's "skip analysis" shortcut) arrive unflagged —
				// merge them here so EVERY update body is structure-preserving and
				// type-aware regardless of origin. Skipped when already merged (no
				// double LLM call → no cost on the analysis path) and when there is
				// no body change. `reanalyzeBodyByKind` never throws.
				if (
					(proposedDescription || proposedAcceptanceCriteria) &&
					!change.structurePreserved &&
					existingRow
				) {
					heartbeat(`apply structure-preserving merge: ${itemId}`);
					const newInfo = [
						change.description?.to ?? "",
						change.acceptanceCriteria?.to
							? `Acceptance criteria update:\n${change.acceptanceCriteria.to}`
							: "",
						change.reasoning
							? `Why this update: ${change.reasoning}`
							: "",
					]
						.filter(Boolean)
						.join("\n\n");
					const merged = await reanalyzeBodyByKind({
						kind: existingRow.kind,
						title: existingRow.title,
						identifier: existingRow.identifier,
						existingDescription: existingRow.description ?? "",
						existingAcceptanceCriteria:
							existingRow.acceptanceCriteria,
						newInfo,
						userId,
						organizationId,
						projectId,
					});
					if (merged.fallbackUsed) {
						// Safe-hold: keep the existing body unchanged.
						nextDescription = undefined;
						nextAcceptanceCriteria = undefined;
						change.bodyMergeFallback = true;
					} else {
						nextDescription = proposedDescription
							? merged.description
							: undefined;
						nextAcceptanceCriteria =
							merged.acceptanceCriteria !== undefined
								? merged.acceptanceCriteria
								: undefined;
					}
				}

				// Defensive structure guard (belt-and-suspenders): never persist a
				// BUG body that dropped its diagnostic sections or was reformatted
				// as a feature, whether merged here or pre-merged at analysis time.
				if (nextDescription !== undefined) {
					const guardKind =
						(existingRow?.kind ??
							(change.type === "bug" ? "BUG" : "FEATURE")) ===
						"BUG"
							? "BUG"
							: "FEATURE";
					// Fizzy #2048: run the guard for BOTH kinds. It used to
					// short-circuit to "not destructive" for features, which skipped
					// not just the feature-shape check but the kind-agnostic ones
					// too — an empty rewrite or a body collapsed to a third of its
					// length was waved through on every feature.
					const bodyGuard = detectDestructiveRewrite({
						existing:
							existingRow?.description ??
							change.description?.from,
						candidate: nextDescription,
						kind: guardKind,
					});
					if (bodyGuard.destructive) {
						logger.warn(
							"[Backlog Apply] Skipped destructive BUG body overwrite (safe-hold)",
							{ itemId, projectId, reason: bodyGuard.reason },
						);
						change.bodyMergeFallback = true;
					} else {
						updateData.description = nextDescription;
					}
				}
				if (nextAcceptanceCriteria !== undefined) {
					updateData.acceptanceCriteria = nextAcceptanceCriteria;
				}
				const mappedPriority = mapPriority(change.priority?.to);
				if (
					mappedPriority &&
					change.priority?.to !== change.priority?.from
				) {
					updateData.priority = mappedPriority;
				}
				const mappedSize = mapSize(change.size?.to);
				if (mappedSize && change.size?.to !== change.size?.from) {
					updateData.size = mappedSize;
				}

				if (Object.keys(updateData).length > 0) {
					await updateStory(itemId, projectId, updateData, {
						// The proposal content came from AI, but the authenticated
						// reviewer committed it. Keep source and human actor separate;
						// the database still suppresses identical/no-op payloads.
						lastEditedSource: "AI_BACKLOG_UPDATE",
						lastEditedByName: approvedByName ?? null,
						// When this apply moves a priority band, the entry it
						// writes to the item's priority history must read as the
						// AI's doing, not the approving human's. The analyzer's
						// change schema carries no per-field rationale, so the
						// entry records the move without one rather than
						// inventing a justification.
						prioritySource: "AI",
						userId,
					});
					// Audit trail (AI Backlog change history) — attributed to the
					// AI agent. Only emitted when a real field changed. Fire-and-
					// forget; never blocks or fails the apply.
					recordAudit({
						action: "story.updated",
						category: "story",
						actor: {
							type: "agent",
							userId,
							nameSnapshot: "Fabric AI",
						},
						organizationId: organizationId ?? null,
						projectId,
						resource: {
							type: "story",
							id: itemId,
							name: updatedTitle ?? change.title.to,
						},
						metadata: {
							source: "AI_BACKLOG_UPDATE",
							changedFields: Object.keys(updateData),
							// Structure-preservation observability. Full bodies live
							// in the FeatureVersion trail; the audit keeps compact
							// pre/post previews + the safe-hold flag so reviewers can
							// see when AI held the body unchanged.
							structurePreserved: true,
							bodyMergeFallback:
								change.bodyMergeFallback ?? false,
							preState: auditState(
								existingRow?.title ?? change.title.from,
								existingRow?.description,
								existingRow?.acceptanceCriteria,
							),
							postState: auditState(
								updateData.title ??
									existingRow?.title ??
									change.title.from,
								updateData.description ??
									existingRow?.description,
								updateData.acceptanceCriteria ??
									existingRow?.acceptanceCriteria,
							),
							...(pendingProposalId
								? { proposalId: pendingProposalId }
								: {}),
						},
					});
				}
				updatedItems.push({
					type: change.type,
					id: itemId,
					identifier: change.existingIdentifier ?? "",
					title: updatedTitle ?? change.title.to,
				});
				updatedItemMap[originalIndex] = itemId;
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[Backlog Apply] Failed to apply change", {
				changeType: change.type,
				action: change.action,
				title: change.title.to,
				error: errorMessage,
			});
			errors.push({
				change: change as ChangeProposal["changes"][number],
				error: errorMessage,
			});
		}
	}

	const appliedCount = createdItems.length + updatedItems.length;

	logger.info("[Backlog Apply] Changes applied", {
		projectId,
		appliedCount,
		created: createdItems.length,
		updated: updatedItems.length,
		errors: errors.length,
		skippedDuplicates: skippedDuplicates.length,
	});

	// Automatic semantic duplicate detection over the newly-created backlog
	// LEAVES (story/bug-typed changes — matching the manual scan's corpus).
	// Catches different-title near-duplicates the exact-title guard above
	// cannot. Enqueued as a fire-and-forget, RETRIED Temporal workflow (not
	// run inline) so a transient embedding/LLM blip is retried with backoff
	// instead of being silently swallowed, and so it never blocks or fails
	// the apply.
	const createdStoryIds = createdItems
		.filter((i) => i.type === "story" || i.type === "bug")
		.map((i) => i.id);
	let duplicateDetectionWorkflowId: string | null = null;
	if (createdStoryIds.length > 0) {
		const enqueued = await triggerDuplicateDetection({
			projectId,
			userId,
			organizationId,
			targetStoryIds: createdStoryIds,
		});
		duplicateDetectionWorkflowId = enqueued?.workflowId ?? null;
	}

	return {
		appliedCount,
		createdItemMap,
		updatedItemMap,
		typeCorrections,
		createdItems,
		updatedItems,
		errors,
		skippedDuplicates,
		convertedToCreate,
		redirectedTerminalUpdates,
		duplicateDetectionWorkflowId,
	};
}

"use client";

import { useAnalytics } from "@analytics";
import type { DecisionPrecheckResult } from "@repo/agent-types";
import type {
	AttachmentWarning,
	AttachmentWarningReason,
	PendingAttachmentRef,
} from "@repo/integrations";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { stripMarkdown } from "@ui/lib/strip-markdown";
import {
	ArchiveIcon,
	CheckIcon,
	ExternalLinkIcon,
	EyeIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
	BACKLOG_OPEN_EXISTING_EVENT,
	type BacklogProposalPanel,
} from "../../../../analytics/events/backlog-open-existing";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	buildProjectSettingsRoute,
	buildStoryDetailsRoute,
} from "../../lib/stories/routes";
import {
	BacklogChangeDetailDialog,
	type SkippableField,
} from "./BacklogChangeDetailDialog";
import { DecisionConflictNote } from "./DecisionConflictNote";
import { ProposalDiffField } from "./ProposalDiffField";
import {
	ProposalRoutingControl,
	type RoutingAnnotation,
	type RoutingOverride,
	resolveEffectiveRouting,
	routingBlocker,
} from "./ProposalRoutingControl";
import { PmSyncConflictBadge } from "./pm-sync/PmSyncConflictBadge";
import { PmSyncDiffModal } from "./pm-sync/PmSyncDiffModal";
import { PmSyncOutageRollup } from "./pm-sync/PmSyncOutageRollup";
import type { PmSyncError } from "./pm-sync/pmSyncError";
import { usePersistedProposalDrafts } from "./use-persisted-proposal-drafts";

// Exported so the per-item detail dialog (`BacklogChangeDetailDialog`)
// can render the same shape without duplicating the type.
type DiffField = { from?: string; to: string };

export type ChangeItemKind = "BUG" | "FEATURE";

export type ChangeItem = {
	type: "epic" | "feature" | "story" | "bug";
	action: "create" | "update";
	existingId?: string;
	existingIdentifier?: string;
	existingExternalId?: string;
	title: DiffField;
	description?: DiffField;
	acceptanceCriteria?: DiffField;
	priority?: DiffField;
	size?: DiffField;
	parentEpicIdentifier?: string;
	parentFeatureIdentifier?: string;
	parentEpicTitle?: string;
	parentFeatureTitle?: string;
	reasoning: string;
	sourceContext:
		| "teams_messages"
		| "meeting_transcript"
		| "notion_page"
		| "slack_messages"
		| "multiple";
	/**
	 * PM-supplied override of the AI classifier's kind decision. Sent up by the
	 * approval UI when a reviewer picks a different kind than the analyzer's
	 * default. Absent unless the reviewer made an explicit selection.
	 */
	kindOverride?: ChangeItemKind;
	/**
	 * Set by the review UI on a CREATE's effective change when its body was
	 * already drafted through the kind prompt at review time (lazy draft on
	 * open). Tells apply to persist the body verbatim — no re-draft at create
	 * time — and to carry `needsMoreInfo` for a pre-drafted bug.
	 */
	predrafted?: boolean;
	/** Bug triage flag captured by the review-time draft (paired with `predrafted`). */
	needsMoreInfo?: boolean;
	/**
	 * Safe-hold flag from the structure-preserving update pass: AI could not
	 * safely produce a targeted edit, so the existing body was kept unchanged.
	 */
	bodyMergeFallback?: boolean;
	/**
	 * Backend guardrail stamp indicating whether the AI's target reference
	 * could be resolved to a real Fabric item.
	 *
	 * - `status: "resolved"` — the reference was matched; `resolvedIdentifier`
	 *   and `resolvedTitle` carry the canonical Fabric identity.
	 * - `status: "unresolved"` + `demotedFromUpdate: true` — the AI proposed
	 *   an update but no matching item was found; the change has been demoted
	 *   to a create and should show a "New item — no existing match" badge.
	 */
	targetResolution?: {
		status: "resolved" | "unresolved";
		resolvedBy?: "id" | "identifier" | "externalId" | "title" | null;
		resolvedIdentifier?: string | null;
		resolvedTitle?: string | null;
		demotedFromUpdate?: boolean;
	} | null;
	/**
	 * Create-vs-Enrich classification stamped by the backend routing pass for
	 * action items captured from meetings and monitored chats. Absent on every
	 * other proposal source, and on projects that have not enabled routing — the
	 * row then renders exactly as it does today.
	 */
	routing?: RoutingAnnotation | null;
};

/**
 * Map the analyzer's change.type to its default kind for the type selector.
 * "feature" and "story" both map to FEATURE; "bug" maps to BUG; "epic" is
 * ineligible (epics are containers, not kinds). The selector only renders for
 * non-epic create rows, so callers should gate by `change.type !== "epic"`
 * before reading this value.
 */
export function deriveDefaultKind(
	changeType: ChangeItem["type"],
): ChangeItemKind {
	return changeType === "bug" ? "BUG" : "FEATURE";
}

/**
 * Normalize a diff field that may arrive as a plain string (from LLM tool args)
 * instead of the expected { from?, to } object.
 */
function normalizeDiffField(field: unknown): DiffField | undefined {
	if (!field) {
		return undefined;
	}
	if (typeof field === "string") {
		return { to: field };
	}
	if (typeof field === "object" && field !== null) {
		const obj = field as Record<string, unknown>;
		if (typeof obj.to === "string") {
			// Clean up: convert null/non-string `from` to undefined
			// so it passes Zod validation (z.string().optional())
			return {
				from: typeof obj.from === "string" ? obj.from : undefined,
				to: obj.to,
			};
		}
		// Some LLMs send { value: "..." } or { name: "..." }
		const fallback = obj.value ?? obj.name;
		if (typeof fallback === "string") {
			return { to: fallback };
		}
	}
	return undefined;
}

const VALID_TYPES = new Set(["epic", "feature", "story", "bug"]);
const VALID_ACTIONS = new Set(["create", "update"]);
const VALID_SOURCE_CONTEXTS = new Set([
	"teams_messages",
	"meeting_transcript",
	"notion_page",
	"slack_messages",
	"multiple",
]);
const VALID_KIND_OVERRIDES: ReadonlySet<ChangeItemKind> =
	new Set<ChangeItemKind>(["BUG", "FEATURE"]);

/**
 * Normalize sourceContext — the LLM sometimes returns a comma-separated
 * string like "meeting_transcript, teams_messages" instead of a single enum.
 * If the value contains multiple sources or is unrecognized, default to "multiple".
 */
function normalizeSourceContext(raw: unknown): ChangeItem["sourceContext"] {
	if (typeof raw !== "string") {
		return "multiple";
	}
	const trimmed = raw.trim().toLowerCase();
	if (VALID_SOURCE_CONTEXTS.has(trimmed)) {
		return trimmed as ChangeItem["sourceContext"];
	}
	// Comma-separated or unrecognized → "multiple"
	return "multiple";
}

/**
 * Normalize a change item that may have fields in unexpected formats.
 *
 * Handles two data sources:
 * 1. Stored proposal from Temporal (schema-validated, fields are correct)
 * 2. LLM tool args fallback (CopilotKit agent reconstructs changes from
 *    analysis text — fields may be swapped, capitalized, or missing)
 *
 * Exported for unit testing.
 *
 * `forbidEpics` (Bug 1429 / Codex P1) gates the epic→feature normalization.
 * `BacklogChangeProposal` is SHARED between the channel-monitor pending-proposal
 * inbox (feature/bug-only — passes `forbidEpics: true`) and the general AI
 * Update flow (`BacklogChat`, where `epic` is first-class). Pass `true` ONLY in
 * the channel-monitor context; the default `false` preserves epics so general
 * epic creation is not silently rewritten to a feature.
 */
export function normalizeChange(raw: any, forbidEpics = false): ChangeItem {
	// Normalize type and action — handle capitalization and swapped fields
	let rawType = String(raw.type ?? "").toLowerCase();
	let rawAction = String(raw.action ?? "").toLowerCase();

	// Detect swapped fields: if type has an action value and action has a type value
	if (!VALID_TYPES.has(rawType) && VALID_TYPES.has(rawAction)) {
		[rawType, rawAction] = [rawAction, rawType];
	}
	// If type holds an action value (e.g. "update") but action also has an action value,
	// use the type field's value as the intended action
	if (!VALID_TYPES.has(rawType) && VALID_ACTIONS.has(rawType)) {
		rawAction = rawType;
		rawType = "story";
	}

	// Bug 1429: in the channel-monitor flow `epic` is not a supported proposal
	// type. Stored proposals created before the epic-suppression fix may carry
	// `type: "epic"`; render them with the Feature/Bug toggle (deriveDefaultKind
	// → FEATURE) by normalizing epic → feature. The Temporal apply path applies
	// the same normalization server-side via `forbidEpics`, so display and
	// approve stay consistent without a data migration.
	//
	// Codex P1: gate on `forbidEpics` so this fires ONLY for the channel-monitor
	// inbox. The general AI Update flow (BacklogChat) keeps `epic` first-class —
	// rewriting it here would silently break general epic creation on approve.
	if (forbidEpics && rawType === "epic") {
		rawType = "feature";
	}

	const type = VALID_TYPES.has(rawType)
		? (rawType as ChangeItem["type"])
		: "story";
	const action = VALID_ACTIONS.has(rawAction)
		? (rawAction as ChangeItem["action"])
		: "create";

	// Resolve title — try multiple field names LLMs might use
	const titleField = raw.title ?? raw.name ?? raw.summary ?? raw.label;
	const title = normalizeDiffField(titleField) ?? {
		to:
			(typeof titleField === "string" ? titleField : null) ||
			raw.title ||
			raw.name ||
			"Untitled",
	};

	// Helper to coerce null → undefined (Zod z.string().optional() rejects null)
	const optStr = (v: unknown): string | undefined =>
		typeof v === "string" ? v : undefined;

	const rawKindOverride =
		typeof raw.kindOverride === "string"
			? (raw.kindOverride.toUpperCase() as string)
			: typeof raw.kind_override === "string"
				? (raw.kind_override.toUpperCase() as string)
				: undefined;
	const kindOverride: ChangeItemKind | undefined =
		rawKindOverride &&
		VALID_KIND_OVERRIDES.has(rawKindOverride as ChangeItemKind)
			? (rawKindOverride as ChangeItemKind)
			: undefined;

	return {
		type,
		action,
		existingId: optStr(raw.existingId ?? raw.existing_id),
		existingIdentifier: optStr(
			raw.existingIdentifier ?? raw.existing_identifier,
		),
		existingExternalId: optStr(
			raw.existingExternalId ?? raw.existing_external_id,
		),
		title,
		description: normalizeDiffField(raw.description),
		acceptanceCriteria: normalizeDiffField(
			raw.acceptanceCriteria ?? raw.acceptance_criteria,
		),
		priority: normalizeDiffField(raw.priority),
		size: normalizeDiffField(raw.size),
		parentEpicIdentifier: optStr(
			raw.parentEpicIdentifier ?? raw.parent_epic_identifier,
		),
		parentFeatureIdentifier: optStr(
			raw.parentFeatureIdentifier ?? raw.parent_feature_identifier,
		),
		parentEpicTitle: optStr(raw.parentEpicTitle ?? raw.parent_epic_title),
		parentFeatureTitle: optStr(
			raw.parentFeatureTitle ?? raw.parent_feature_title,
		),
		reasoning: raw.reasoning ?? "",
		sourceContext: normalizeSourceContext(
			raw.sourceContext ?? raw.source_context,
		),
		kindOverride,
		// Safe-hold flag stamped by the structure-preserving update pass when AI
		// kept the existing body unchanged. Carried through so the review row can
		// surface a "description kept as-is" note and apply records it in the audit.
		bodyMergeFallback:
			typeof raw.bodyMergeFallback === "boolean"
				? raw.bodyMergeFallback
				: undefined,
		// Pass targetResolution through unchanged — it is a structured object
		// stamped by the backend guardrail; no normalization needed on the FE.
		targetResolution: raw.targetResolution ?? undefined,
		// Same for routing: a post-generation stamp, never LLM tool args, so
		// there is no loose shape to normalize.
		routing:
			(raw.routing as RoutingAnnotation | null | undefined) ?? undefined,
	};
}

type ApplyResult = {
	status: "success" | "failed";
	createdCount: number;
	updatedCount: number;
	// `failedCount` + `batchTotal` are populated by BacklogChat from the
	// apply-progress poll so the in-chat result card can render the AC #5
	// batch summary even on partial-success batches. Optional for backward
	// compatibility — older callers (none today) get a fallback of 0/0.
	failedCount?: number;
	skippedCount?: number;
	batchTotal?: number;
	syncedToPM: boolean;
	items: {
		id?: string;
		identifier: string;
		title: string;
		type: string;
		_action?: string;
		reason?: string;
	}[];
	message: string;
	pmSyncOutage?: {
		tool: string;
		errorClass: string;
		count: number;
		items: Array<{
			id: string;
			itemType: "epic" | "feature" | "story" | "bug";
		}>;
	};
};

type PmConflictPreview = {
	hasConflict: boolean;
	pmCurrent?: { title: string; description: string };
	pmUrl?: string;
	/** Set when the user's PM connection couldn't load the PM side. */
	pmError?: PmSyncError;
	pmTool?: string | null;
};

type PmSyncOverrideMap = Record<
	number,
	{ pushAnyway?: boolean; skip?: boolean }
>;

type Props = {
	summary: string;
	contextSummary: string;
	/** Raw changes from stored proposal or LLM tool args (normalized at render). */
	changes: ChangeItem[] | Record<string, unknown>[];
	/**
	 * Async decision pre-check result for the whole proposal. Per-change findings
	 * are matched to each change by `changeRef.index` and surfaced as an inline
	 * `DecisionConflictNote`. Read from `sourceMetadata.decisionPrecheck` in the
	 * monitor inbox, or from the ride-along `proposal.decisionConflicts` in the
	 * AI-Update sidebar. Advisory only — never gates Apply; absent/`ok` ⇒ nothing.
	 */
	decisionConflicts?: DecisionPrecheckResult | null;
	/**
	 * AI-Update sidebar only: the async decision pre-check is still running (the
	 * judge folds its result in a beat after the proposal appears). Drives a
	 * subtle "checking…" line so the async check is visible instead of a note
	 * that silently pops in later. The parent clears it the instant the judge
	 * resolves — to the amber note (conflicts) or to nothing (clean).
	 */
	decisionPrecheckPending?: boolean;
	hasPMTool: boolean;
	pmToolName?: string;
	/**
	 * Initial checked-state of the "Also sync to {PM Tool}" checkbox. Defaults
	 * to `hasPMTool` (pre-checked when a PM tool is connected), preserving the
	 * AI Update flow's behavior. The channel-monitor proposal inbox passes
	 * `false` so approved proposals stay on the Fabric roadmap only unless the
	 * reviewer explicitly opts into the PM-tool push.
	 */
	defaultSyncToPM?: boolean;
	/** Project + tenant context — required for the conflict-check call. */
	projectId?: string;
	organizationId?: string | null;
	/**
	 * Inbox-only: the PendingBacklogProposal id. When set, the in-review draft is
	 * server-persisted + team-shared (generated once per kind, on explicit "Draft
	 * with AI" request) instead of the in-memory per-session reformat. Absent for
	 * the AI Update sidebar (transient chat proposals).
	 */
	proposalId?: string;
	/** Progress message shown while apply workflow is running. */
	applyProgressMsg?: string;
	/**
	 * When set, the apply is in flight and can be stopped — renders a "Cancel"
	 * control next to the progress indicator. The parent owns the actual cancel
	 * call (it has the proposal id) and the toast / state reset.
	 */
	onCancelApply?: () => void;
	/** Final result from the apply workflow. */
	applyResult?: ApplyResult | null;
	/**
	 * When provided, the user's per-item review state — selected,
	 * reviewed, and per-field skipped — is persisted to localStorage
	 * under this key so the PM can close the dialog / refresh / come
	 * back later and resume from where they left off (acceptance
	 * criterion #4 of the AI-Update detail-review story).
	 *
	 * Pass a stable, scoped identifier — typically the proposal's
	 * database id (PendingBacklogProposal.id) when this component is
	 * rendered from the inbox detail view. When omitted (e.g., the
	 * chat-driven `BacklogChat` that shows transient proposals), state
	 * is held in memory only.
	 */
	persistenceKey?: string;
	/**
	 * Chat-thread image attachments captured at proposal-fetch time
	 * (Slack `files` / Teams hostedContents). Surfaced as the `📎 N`
	 * chip in the proposal header so the reviewer can see at a glance
	 * how many images will be auto-attached on approval.
	 *
	 * Legacy proposals predating the chat-thread-image-attachments
	 * feature carry no `attachments` key on `sourceMetadata`; callers
	 * pass `undefined` or `[]` and the chip is suppressed (FR-27).
	 */
	attachments?: PendingAttachmentRef[];
	/**
	 * Skip / failure warnings recorded for the same set of attachments
	 * — surfaced as the `⚠ M` chip with a tooltip listing the distinct
	 * reasons. Only rendered while the proposal is still actionable
	 * (status `PENDING` or `FAILED`); already-applied proposals
	 * suppress the chip per FR-25 because the warning line has already
	 * been written into the resulting story description.
	 */
	attachmentWarnings?: AttachmentWarning[];
	/**
	 * Lifecycle status of the underlying `PendingBacklogProposal`. Used
	 * to gate the `⚠ M` chip per FR-25 — the chip is suppressed once
	 * the proposal has been actioned and the warning line is already
	 * persisted on the resulting story description. Optional because
	 * non-inbox callers (chat-driven transient proposals) have no row
	 * to look up. Matches the local `ProposalStatus` union in
	 * `PendingBacklogProposalsInbox.tsx`.
	 */
	proposalStatus?:
		| "PENDING"
		| "APPROVED"
		| "APPLIED"
		| "REJECTED"
		| "FAILED"
		| "SUPERSEDED"
		| "BACKLOG";
	/**
	 * Bug 1429 / Codex P1 — channel-monitor scoping. When `true` (the Teams/
	 * Slack pending-proposal inbox, which is feature/bug-only), any `type:
	 * "epic"` change is normalized to `feature` for both display and the
	 * submitted approve payload. Default `false` preserves epics for the
	 * general AI Update flow (`BacklogChat`), where `epic` is first-class — the
	 * shared component must NOT rewrite epics there.
	 */
	forbidEpics?: boolean;
	/**
	 * Which panel mounted this component, used only to discriminate the
	 * "open existing ticket" analytics event. Optional so existing callers /
	 * tests compile unchanged; defaults to "ai-update".
	 */
	panel?: BacklogProposalPanel;
	onApprove: (
		approvedChanges: ChangeItem[],
		syncToPM: boolean,
		pmSyncOverrides?: PmSyncOverrideMap,
	) => void;
	onReject: () => void;
	/**
	 * Move the proposal to the user-facing Rejected list — hidden from the active
	 * review queue but preserved and retrievable. The stored status remains
	 * `BACKLOG` for compatibility. Optional: only the pending-proposal inbox wires
	 * it. The "Move to Rejected" button is rendered only
	 * when this is provided AND `proposalStatus === "PENDING"` (deferral is
	 * offered on pending proposals only).
	 */
	onBacklog?: () => void;
};

const SOURCE_LABELS: Record<string, string> = {
	teams_messages: "Teams messages",
	meeting_transcript: "Meeting transcript",
	notion_page: "Notion page",
	multiple: "Multiple sources",
};

/**
 * "A", "A and B", "A, B and C" — capped, because a proposal can carry a dozen
 * blocked rows and an unbounded list stops being readable long before that.
 */
function listTitles(titles: string[]): string {
	const shown = titles.slice(0, 3).map((t) => `"${t}"`);
	const rest = titles.length - shown.length;
	if (rest > 0) {
		return `${shown.join(", ")} and ${rest} more`;
	}
	if (shown.length <= 1) {
		return shown[0] ?? "";
	}
	return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const TYPE_COLORS: Record<string, string> = {
	epic: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
	feature: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
	story: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
	bug: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export function BacklogChangeProposal({
	summary,
	contextSummary,
	changes: rawChanges,
	decisionConflicts,
	decisionPrecheckPending,
	hasPMTool,
	pmToolName,
	defaultSyncToPM,
	projectId,
	organizationId,
	proposalId,
	applyProgressMsg,
	onCancelApply,
	applyResult,
	persistenceKey,
	attachments,
	attachmentWarnings,
	proposalStatus,
	forbidEpics = false,
	panel = "ai-update",
	onApprove,
	onReject,
	onBacklog,
}: Props) {
	// Normalize changes — LLM tool args may pass title/description as plain
	// strings instead of the expected { from?, to } object format. `forbidEpics`
	// (channel-monitor inbox only) additionally maps epic → feature; the general
	// AI Update flow leaves it false so epics are preserved (Codex P1).
	const changes = rawChanges.map((raw) => normalizeChange(raw, forbidEpics));

	// Async decision pre-check findings for the whole proposal, matched to each
	// change below by `changeRef.index`. Only "conflicts" runs carry findings; an
	// absent / "ok" result yields none, so no note renders.
	const decisionFindings =
		decisionConflicts?.status === "conflicts"
			? (decisionConflicts.findings ?? [])
			: [];

	// Persisted, team-shared in-review drafts (inbox flow), triggered on demand by
	// "Draft with AI". Inert for the AI Update sidebar (no proposalId), which
	// falls through to the in-memory per-session reformat path below.
	const persistedDrafts = usePersistedProposalDrafts({
		proposalId,
		projectId,
		organizationId,
	});
	// The persisted draft is keyed by (proposal, kind), so it maps to the
	// proposal's primary draftable (create) change.
	const primaryDraftIndex = changes.findIndex(
		(c) => c.action === "create" && c.type !== "epic",
	);
	const isPersistedDraftIndex = (itemIndex: number): boolean =>
		persistedDrafts.active && itemIndex === primaryDraftIndex;

	// Stuck-apply escape hatch: once Cancel is clicked we disable the control and
	// show "Cancelling…" until the progress banner resolves to a result (the
	// parent owns the actual cancel call + toast). Reset when a fresh apply runs.
	const [cancelRequested, setCancelRequested] = useState(false);
	useEffect(() => {
		if (!applyProgressMsg) {
			setCancelRequested(false);
		}
	}, [applyProgressMsg]);

	// Hydrate persisted review state on first mount when a key is
	// provided (typically a proposal id from the inbox detail view).
	// Lives in localStorage rather than DB so it survives a refresh /
	// tab restart but does not need a backend migration.
	const initialPersisted = readPersistedReviewState(
		persistenceKey,
		changes.length,
	);

	// PM-unavailable CTA destination. The project "settings" tab is a
	// `?tab=settings` query param on the project DETAIL route — it does not
	// exist on the subroutes this proposal renders from (the AI-Update chat
	// panel under `/projects/:id/documents/:id`, the kanban/roadmap tabs,
	// etc.), so we must build it from the context base + projectId rather
	// than from the current pathname (which produced e.g.
	// `/documents/:id?tab=settings` and never opened PM settings).
	//
	// When projectId is absent (the channel-monitor inbox renders this with
	// `hasPMTool={false}`, so the PM-settings CTA is never actually surfaced
	// there) we fall back to the org-level integrations page.
	const basePath = useBasePath();
	const settingsHref = projectId
		? buildProjectSettingsRoute(basePath, projectId)
		: `${basePath}/settings/integrations`;

	// Copy for the "open existing ticket" affordance and its "Ticket not
	// found" counterpart live in the shared `tooltips.stories` bucket.
	const t = useTranslations("tooltips.stories");
	// Decision pre-check copy (shared with `DecisionConflictNote`).
	const tDecision = useTranslations("projects.decisionPrecheck");
	const { trackEvent } = useAnalytics();

	// Open the existing UserStory ("Feature") a resolved Update points at in a
	// new browser tab, leaving this panel's state untouched. Defensively
	// no-ops when the deep-link inputs are missing — the affordance only
	// renders for resolved updates with a non-empty `existingId`, but the
	// guard mirrors the open-in-new-tab precedent (FR-2).
	const openExistingTicket = (change: ChangeItem) => {
		if (!projectId || !change.existingId) {
			return;
		}
		trackEvent(BACKLOG_OPEN_EXISTING_EVENT, { panel });
		window.open(
			buildStoryDetailsRoute(basePath, projectId, change.existingId),
			"_blank",
			"noopener,noreferrer",
		);
	};

	const [selected, setSelected] = useState<Set<number>>(
		() => initialPersisted.selected ?? new Set(changes.map((_, i) => i)),
	);
	// Inbox (channel-monitor proposals) passes `defaultSyncToPM={false}` so
	// approvals default to Fabric-only; the AI Update flow omits the prop and
	// keeps the pre-checked behavior when a PM tool is connected.
	const [syncToPM, setSyncToPM] = useState(defaultSyncToPM ?? hasPMTool);
	const [resolved, setResolved] = useState<
		"approved" | "rejected" | "backlog" | null
	>(null);
	const [approvedCount, setApprovedCount] = useState(0);
	const [totalCount, setTotalCount] = useState(0);
	const [conflictsByIndex, setConflictsByIndex] = useState<
		Record<number, PmConflictPreview>
	>({});
	const [pushAnywayByIndex, setPushAnywayByIndex] = useState<
		Record<number, boolean>
	>({});
	const [skipByIndex, setSkipByIndex] = useState<Record<number, boolean>>({});
	const [diffModalIndex, setDiffModalIndex] = useState<number | null>(null);
	const [isRetryingOutage, setIsRetryingOutage] = useState(false);
	const conflictCheckStartedRef = useRef(false);

	// Per-item review state for the new detail dialog.
	//
	// `detailIndex` — the change currently open in the detail dialog,
	// or null when the dialog is closed.
	//
	// `reviewedIndexes` — every change the user has *opened* in the
	// detail dialog at least once. Items here get a small "Reviewed"
	// badge in the list so the PM can pick up where they left off if
	// they get interrupted mid-review (acceptance criterion #4).
	const [detailIndex, setDetailIndex] = useState<number | null>(null);
	const [reviewedIndexes, setReviewedIndexes] = useState<Set<number>>(
		() => initialPersisted.reviewed ?? new Set(),
	);
	// Per-item, per-field skip state for the in-dialog Accept/Reject
	// toggles. Map<itemIndex, Set<fieldName>>. When a field is in the
	// inner set, the parent transforms the change before applying so
	// the backend sees no update for that field.
	const [skippedFieldsByIndex, setSkippedFieldsByIndex] = useState<
		Map<number, Set<SkippableField>>
	>(() => initialPersisted.skippedFields ?? new Map());

	// Per-item kind override. Map<itemIndex, "BUG" | "FEATURE">.
	//
	// Safety-net for the F-171 classifier BUG-bias documented in DSU 2026-05-20:
	// the classifier sometimes labels feature-shaped requests as BUG. PMs need
	// an inline correction before the ticket is created — applying a fix
	// post-creation requires extra steps in Fabric AND a re-sync to the PM
	// tool, which is the pain point product reported.
	//
	// An entry here means the user *explicitly* overrode the analyzer's default
	// (derived via `deriveDefaultKind`). The override is sent up on approve as
	// `change.kindOverride`, and the backend passes `kind` + `skipClassifier`
	// so the user's choice survives F-171 unchallenged. When the user picks
	// the same kind as the default we still record it (so the entry counts
	// as "explicitly chosen") to keep behavior predictable — but the
	// classifier-bypass only matters when the choice differs from what the
	// classifier would have output.
	const [kindOverridesByIndex, setKindOverridesByIndex] = useState<
		Map<number, ChangeItemKind>
	>(() => initialPersisted.kindOverrides ?? new Map());

	// Draft cache (CREATE rows), per (index, kind). Populated two ways, both via
	// `reformatBodyForKind`: lazily when a proposal's detail is opened (so the
	// reviewer sees the proper bug/feature-prompt draft right away rather than the
	// analyzer's raw body), and when a reviewer flips the kind. Cached ONCE per
	// type so re-opening / flipping back is instant. `needsMoreInfo` is the bug
	// triage flag, carried to apply so a pre-drafted bug keeps it without a re-draft.
	const [reformattedByIndex, setReformattedByIndex] = useState<
		Map<
			number,
			Map<
				ChangeItemKind,
				{
					description: string;
					acceptanceCriteria: string | null;
					needsMoreInfo: boolean;
				}
			>
		>
	>(new Map());
	const [reformattingIndex, setReformattingIndex] = useState<number | null>(
		null,
	);

	// Reviewer overrides of the backend's Create/Enrich routing, keyed by change
	// index. Deliberately NOT persisted alongside the four structures above: an
	// override names a specific target ticket, and a ticket can be closed,
	// merged or deleted between sessions — restoring a stale target would let
	// the reviewer approve an enrichment of something that no longer exists.
	const [routingOverridesByIndex, setRoutingOverridesByIndex] = useState<
		Map<number, RoutingOverride>
	>(new Map());

	const setRoutingOverride = (
		itemIndex: number,
		next: RoutingOverride | undefined,
	): void => {
		setRoutingOverridesByIndex((prev) => {
			const map = new Map(prev);
			if (next === undefined) {
				map.delete(itemIndex);
			} else {
				map.set(itemIndex, next);
			}
			return map;
		});
	};

	// Persist any change to the four review-state structures so a
	// refresh restores the same view. Skipped when no key is provided
	// (chat-driven transient proposals — state stays in memory).
	useEffect(() => {
		if (!persistenceKey) {
			return;
		}
		writePersistedReviewState(persistenceKey, {
			selected,
			reviewed: reviewedIndexes,
			skippedFields: skippedFieldsByIndex,
			kindOverrides: kindOverridesByIndex,
		});
	}, [
		persistenceKey,
		selected,
		reviewedIndexes,
		skippedFieldsByIndex,
		kindOverridesByIndex,
	]);

	// Draft a CREATE row's proposed body through the kind-appropriate prompt and
	// cache it once per (index, kind). Drives both the lazy draft-on-open (the
	// `kind` is the row's current selected kind) and the type-switch flip. No-op
	// for updates/epics, when there's nothing to draft, when already cached, or
	// without a projectId. Non-fatal on failure — the original body is kept and
	// apply backstops it (re-draft at create time).
	const reformatBodyForKind = async (
		itemIndex: number,
		kind: ChangeItemKind,
	): Promise<void> => {
		const change = changes[itemIndex];
		// A routing enrichment the reviewer sent back to "new ticket" is applied
		// as a create, so its body has to be drafted through the work-item kind
		// prompt like any other create. Reading the raw action here meant an
		// overridden row shipped the analyzer's captured text unformatted.
		const routedBackToCreate =
			resolveEffectiveRouting(
				change?.routing ?? undefined,
				routingOverridesByIndex.get(itemIndex),
			)?.overridden === true;
		const actionForKind = routedBackToCreate ? "create" : change?.action;
		if (!change || actionForKind !== "create" || change.type === "epic") {
			return;
		}
		if (!change.description?.to && !change.acceptanceCriteria?.to) {
			return;
		}
		if (reformattedByIndex.get(itemIndex)?.has(kind)) {
			return; // once per type
		}
		if (!projectId) {
			return;
		}
		setReformattingIndex(itemIndex);
		try {
			const res = await orpcClient.projects.stories.reformatProposalBody({
				projectId,
				organizationId: organizationId ?? null,
				kind,
				title: change.title.to,
				description: change.description?.to,
				acceptanceCriteria: change.acceptanceCriteria?.to,
			});
			// Only cache a genuine draft. When no prompt was bound or the AI call
			// failed, keep the original body (don't mark the row pre-drafted).
			if (!res.aiDrafted) {
				return;
			}
			setReformattedByIndex((prev) => {
				const next = new Map(prev);
				const inner = new Map(next.get(itemIndex) ?? []);
				inner.set(kind, {
					description: res.description,
					acceptanceCriteria: res.acceptanceCriteria,
					needsMoreInfo: res.needsMoreInfo,
				});
				next.set(itemIndex, inner);
				return next;
			});
		} catch (err) {
			// Non-fatal: keep the original body. Apply backstops this — an
			// un-pre-drafted create still drafts through its kind's prompt at
			// create time. Surface for debugging rather than swallow.
			console.error("[BacklogChangeProposal] proposal draft failed", err);
		} finally {
			setReformattingIndex((cur) => (cur === itemIndex ? null : cur));
		}
	};

	const setKindOverride = (itemIndex: number, kind: ChangeItemKind): void => {
		setKindOverridesByIndex((prev) => {
			const next = new Map(prev);
			next.set(itemIndex, kind);
			return next;
		});
		// The persisted (inbox) path only changes the selected kind here — drafting
		// is explicit ("Draft with AI" drafts the selected kind; a completed draft
		// for that kind, if any, shows immediately). The in-memory sidebar path
		// reformats once per kind on switch.
		if (!isPersistedDraftIndex(itemIndex)) {
			void reformatBodyForKind(itemIndex, kind);
		}
	};

	// The body to show/apply for a row. Returns the cached draft for the selected
	// kind when one exists (lazy draft-on-open or a type-switch flip) — including
	// the default kind — otherwise the original analyzer body. When a draft is
	// used it also reports `predrafted` + `needsMoreInfo` so apply persists the
	// body verbatim (no re-draft) and keeps the bug triage flag.
	const getEffectiveBody = (
		itemIndex: number,
		change: ChangeItem,
	): {
		description?: string;
		acceptanceCriteria?: string;
		predrafted?: boolean;
		needsMoreInfo?: boolean;
	} => {
		const selectedKind =
			kindOverridesByIndex.get(itemIndex) ??
			deriveDefaultKind(change.type);
		// Persisted (inbox) path: use the server-shared draft for this kind once
		// it's COMPLETED; until then show the original analyzer body (the banner
		// communicates the in-flight draft).
		if (isPersistedDraftIndex(itemIndex)) {
			const d = persistedDrafts.byKind[selectedKind];
			if (d?.status === "COMPLETED" && d.description) {
				return {
					description: d.description,
					acceptanceCriteria: d.acceptanceCriteria ?? undefined,
					predrafted: true,
					needsMoreInfo: d.needsMoreInfo ?? undefined,
				};
			}
			return {
				description: change.description?.to,
				acceptanceCriteria: change.acceptanceCriteria?.to,
			};
		}
		const cached = reformattedByIndex.get(itemIndex)?.get(selectedKind);
		if (!cached) {
			return {
				description: change.description?.to,
				acceptanceCriteria: change.acceptanceCriteria?.to,
			};
		}
		return {
			description: cached.description,
			acceptanceCriteria: cached.acceptanceCriteria ?? undefined,
			predrafted: change.action === "create",
			needsMoreInfo: cached.needsMoreInfo,
		};
	};

	// A copy of `change` with the effective (possibly reformatted) body folded in,
	// so the preview, detail dialog, and apply payload all reflect the type-switch.
	const buildEffectiveChange = (
		itemIndex: number,
		change: ChangeItem,
	): ChangeItem => {
		const eff = getEffectiveBody(itemIndex, change);
		const next: ChangeItem = { ...change };
		if (eff.description !== undefined) {
			next.description = change.description
				? { ...change.description, to: eff.description }
				: { to: eff.description };
		}
		if (eff.acceptanceCriteria !== undefined) {
			next.acceptanceCriteria = change.acceptanceCriteria
				? { ...change.acceptanceCriteria, to: eff.acceptanceCriteria }
				: { to: eff.acceptanceCriteria };
		}
		// Mark a pre-drafted create so apply persists this body verbatim (no
		// re-draft at create time) and carries the captured bug triage flag.
		if (eff.predrafted) {
			next.predrafted = true;
			next.needsMoreInfo = eff.needsMoreInfo;
		}
		return next;
	};

	const toggleSkippedField = (
		itemIndex: number,
		field: SkippableField,
	): void => {
		setSkippedFieldsByIndex((prev) => {
			const next = new Map(prev);
			const current = new Set(next.get(itemIndex) ?? []);
			if (current.has(field)) {
				current.delete(field);
			} else {
				current.add(field);
			}
			if (current.size === 0) {
				next.delete(itemIndex);
			} else {
				next.set(itemIndex, current);
			}
			return next;
		});
	};

	const openDetail = (index: number) => {
		setDetailIndex(index);
		// Sidebar (non-persisted) only: lazily draft the CREATE body through its
		// kind's prompt on open, so the reviewer sees the proper draft (cached once
		// per kind). The inbox (persisted) flow does NOT auto-draft — the reviewer
		// triggers it explicitly via "Draft with AI"; the ticket is always created
		// through the prompt at apply regardless.
		const change = changes[index];
		if (change && !isPersistedDraftIndex(index)) {
			const selectedKind =
				kindOverridesByIndex.get(index) ??
				deriveDefaultKind(change.type);
			void reformatBodyForKind(index, selectedKind);
		}
		setReviewedIndexes((prev) => {
			if (prev.has(index)) {
				return prev;
			}
			const next = new Set(prev);
			next.add(index);
			return next;
		});
	};

	const goToDetail = (nextIndex: number) => {
		if (nextIndex < 0 || nextIndex >= changes.length) {
			return;
		}
		openDetail(nextIndex);
	};

	// If the selected proposal's persisted draft is still RUNNING, return its
	// selected kind (so Apply can cancel it before creating to avoid a redundant
	// spend); else null.
	const selectedRunningDraftKind = (): ChangeItemKind | null => {
		if (
			!persistedDrafts.active ||
			primaryDraftIndex < 0 ||
			!selected.has(primaryDraftIndex)
		) {
			return null;
		}
		const change = changes[primaryDraftIndex];
		if (!change) {
			return null;
		}
		const kind =
			kindOverridesByIndex.get(primaryDraftIndex) ??
			deriveDefaultKind(change.type);
		return persistedDrafts.byKind[kind]?.status === "RUNNING" ? kind : null;
	};

	// Build + submit the approved changes. A COMPLETED persisted draft is created
	// verbatim (predrafted via getEffectiveBody); otherwise the apply drafts the
	// body through the kind prompt (createStoryFromProposal) — so the ticket is
	// always prompt-drafted. An in-flight persisted draft is cancelled first to
	// avoid a redundant spend.
	const runApply = () => {
		const runningKind = selectedRunningDraftKind();
		if (runningKind) {
			void persistedDrafts.cancelDraft(runningKind);
		}
		const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
		const approvedChanges = selectedIndexes.map((i) =>
			applyFieldSkips(
				applyKindOverride(
					// Routing folds in first: it decides create-vs-update, and
					// the kind override only applies to creates.
					applyRoutingOverride(
						buildEffectiveChange(i, changes[i]),
						routingOverridesByIndex.get(i),
					),
					kindOverridesByIndex.get(i),
				),
				skippedFieldsByIndex.get(i),
			),
		);
		setApprovedCount(approvedChanges.length);
		setTotalCount(changes.length);
		setResolved("approved");
		const overrides: PmSyncOverrideMap = {};
		selectedIndexes.forEach((origIdx, newIdx) => {
			const entry: { pushAnyway?: boolean; skip?: boolean } = {};
			if (pushAnywayByIndex[origIdx]) {
				entry.pushAnyway = true;
			}
			if (skipByIndex[origIdx]) {
				entry.skip = true;
			}
			if (entry.pushAnyway !== undefined || entry.skip !== undefined) {
				overrides[newIdx] = entry;
			}
		});
		onApprove(
			approvedChanges,
			syncToPM,
			Object.keys(overrides).length > 0 ? overrides : undefined,
		);
	};

	const handleRetryOutage = async () => {
		if (!projectId || !applyResult?.pmSyncOutage) {
			return;
		}
		setIsRetryingOutage(true);
		try {
			await orpcClient.projects.stories.retryPmSyncBatch({
				projectId,
				items: applyResult.pmSyncOutage.items,
				organizationId: organizationId ?? null,
			});
		} catch {
			// Error handled by parent toast surface; rollup stays visible.
		} finally {
			setIsRetryingOutage(false);
		}
	};

	// `existingExternalId` is an LLM-supplied hint that normalizeChange
	// drops to undefined when the model omits it, so requiring it here
	// silently excluded synced items from the conflict pre-check.
	// The authoritative gate is server-side: check-pm-sync-conflicts
	// filters by `externalId IS NOT NULL` on the DB row and returns
	// hasConflict:false for non-synced items, so passing the wider
	// set is safe. All hierarchy types (epic/feature/story/bug) are
	// eligible — Feature/Epic now carry the same PM sync state.
	const eligibleIndexes = changes
		.map((c, i) =>
			c.action === "update" && c.existingId
				? {
						id: c.existingId as string,
						itemType: c.type,
						index: i,
					}
				: null,
		)
		.filter(
			(
				v,
			): v is {
				id: string;
				itemType: "epic" | "feature" | "story" | "bug";
				index: number;
			} => v !== null,
		);

	useEffect(() => {
		if (
			!projectId ||
			conflictCheckStartedRef.current ||
			eligibleIndexes.length === 0
		) {
			return;
		}
		conflictCheckStartedRef.current = true;
		const items = eligibleIndexes.map((e) => ({
			id: e.id,
			itemType: e.itemType,
		}));

		void (async () => {
			try {
				const res =
					await orpcClient.projects.stories.checkPmSyncConflicts({
						projectId,
						items,
						organizationId: organizationId ?? null,
					});
				const next: Record<number, PmConflictPreview> = {};
				for (const item of res.results) {
					const match = eligibleIndexes.find(
						(e) => e.id === item.id && e.itemType === item.itemType,
					);
					if (!match) {
						continue;
					}
					// Keep rows that either have a real conflict OR couldn't be
					// checked because the user's PM connection is unavailable —
					// dropping the latter would hide that the conflict status is
					// unknown and let the user approve blind.
					if (!item.hasConflict && !item.pmError) {
						continue;
					}
					next[match.index] = {
						hasConflict: item.hasConflict,
						pmCurrent: item.pmCurrent,
						pmUrl: item.pmUrl,
						pmError: item.pmError,
						pmTool: item.pmTool,
					};
				}
				setConflictsByIndex(next);
			} catch {
				// Conflict check is best-effort — silent failure preserves the
				// existing approve flow without blocking the user.
			}
		})();
	}, [projectId, organizationId, eligibleIndexes]);

	const toggleItem = (index: number) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	};

	const selectedCount = selected.size;
	const isRejectedProposal = proposalStatus === "BACKLOG";

	// Selected rows whose routing is not yet approvable: switched to Enrich with
	// no target chosen, or aimed at a closed ticket the reviewer has not
	// acknowledged. Blocks Apply for the whole proposal — approving the rest and
	// silently dropping these would be worse than saying what is unfinished.
	const routingBlockedIndexes = Array.from(selected)
		.sort((a, b) => a - b)
		.filter((index) => {
			const change = changes[index];
			return (
				change?.routing != null &&
				routingBlocker(
					change.routing,
					routingOverridesByIndex.get(index),
				) !== null
			);
		});

	// Name the items, don't just count them. The row list scrolls, so a bare
	// count leaves the reviewer hunting for which row is holding up Apply — and
	// a screen-reader user with no visual scan at all.
	const routingBlockedMessage =
		routingBlockedIndexes.length === 0
			? ""
			: `Choose a ticket to enrich for ${listTitles(
					routingBlockedIndexes.map(
						(i) => changes[i]?.title?.to ?? "",
					),
				)} before applying.`;

	const _handleToggleKeyDown = (
		e: KeyboardEvent<HTMLElement>,
		toggle: () => void,
	) => {
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			toggle();
		}
	};

	// Collapsed view after user approves or rejects
	if (resolved) {
		return (
			<div className="rounded-lg border bg-card p-3 max-w-full space-y-2">
				<div className="flex items-center gap-2">
					{resolved === "approved" ? (
						<>
							<CheckIcon className="size-4 text-success dark:text-green-400" />
							<p className="text-sm text-muted-foreground">
								Approved {approvedCount} of {totalCount}{" "}
								proposed changes
								{syncToPM
									? ` (syncing to ${pmToolName ?? "PM Tool"})`
									: ""}
							</p>
						</>
					) : resolved === "backlog" ? (
						<>
							<ArchiveIcon className="size-4 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">
								Moved to Rejected
							</p>
						</>
					) : (
						<>
							<XIcon className="size-4 text-destructive" />
							<p className="text-sm text-muted-foreground">
								{isRejectedProposal
									? "Proposal deleted"
									: "Rejected all proposed changes"}
							</p>
						</>
					)}
				</div>

				{/* Apply progress / result (only shown after approval). The
					whole region is an aria-live container so screen readers
					announce the "Applying…" status and then the final
					per-item result without a focus change. */}
				{resolved === "approved" && (
					<div
						aria-live="polite"
						aria-busy={!applyResult && !!applyProgressMsg}
					>
						{applyResult ? (
							(() => {
								const appliedTotal =
									applyResult.createdCount +
									applyResult.updatedCount;
								const failedCount =
									applyResult.failedCount ?? 0;
								const batchTotal =
									applyResult.batchTotal ??
									appliedTotal + failedCount;
								const partialFailure =
									applyResult.status === "success" &&
									failedCount > 0;
								return (
									<div
										className={cn(
											"rounded-md p-2",
											applyResult.status === "failed"
												? "bg-red-50 dark:bg-red-950/30"
												: partialFailure
													? "bg-amber-50 dark:bg-amber-950/30"
													: "bg-green-50 dark:bg-green-950/30",
										)}
									>
										<p
											className={cn(
												"text-xs font-medium",
												applyResult.status === "failed"
													? "text-destructive/80"
													: partialFailure
														? "text-amber-700 dark:text-amber-300"
														: "text-green-700 dark:text-green-300",
											)}
										>
											{applyResult.status === "failed"
												? `Failed: ${applyResult.message}`
												: partialFailure
													? `${appliedTotal} of ${batchTotal} proposals added to roadmap — ${failedCount} failed, open Review proposals to retry`
													: `Applied ${appliedTotal} item(s)`}
										</p>
										{applyResult.items.length > 0 && (
											<ul className="mt-1 space-y-0.5">
												{applyResult.items.map(
													(item, i) => (
														<li
															key={i}
															className="text-xs text-muted-foreground flex items-start gap-1.5"
														>
															<span
																className={cn(
																	"inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium leading-none shrink-0",
																	item._action ===
																		"updated"
																		? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
																		: item._action ===
																				"skipped"
																			? "bg-muted text-muted-foreground"
																			: item._action ===
																					"failed"
																				? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
																				: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
																)}
															>
																{item._action ===
																"updated"
																	? "Updated"
																	: item._action ===
																			"skipped"
																		? "Skipped"
																		: item._action ===
																				"failed"
																			? "Failed"
																			: "Created"}
															</span>
															<span className="min-w-0">
																{item.identifier ? (
																	item.id &&
																	projectId ? (
																		<>
																			<a
																				href={buildStoryDetailsRoute(
																					basePath,
																					projectId,
																					item.id,
																				)}
																				target="_blank"
																				rel="noopener noreferrer"
																				className="font-medium underline underline-offset-2 hover:text-primary"
																			>
																				{
																					item.identifier
																				}
																			</a>
																			{
																				": "
																			}
																		</>
																	) : (
																		`${item.identifier}: `
																	)
																) : (
																	""
																)}
																{item.title}
																{item.reason ? (
																	<span className="text-muted-foreground/70">
																		{
																			" \u2014 "
																		}
																		{
																			item.reason
																		}
																	</span>
																) : null}
															</span>
														</li>
													),
												)}
											</ul>
										)}
									</div>
								);
							})()
						) : applyProgressMsg ? (
							<div
								className="flex items-center gap-2"
								role="status"
							>
								<div className="size-2 shrink-0 rounded-full bg-green-500 motion-safe:animate-pulse" />
								<span className="sr-only">
									Applying changes:
								</span>
								<p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
									{applyProgressMsg}
								</p>
								{onCancelApply ? (
									<button
										type="button"
										onClick={() => {
											setCancelRequested(true);
											onCancelApply();
										}}
										disabled={cancelRequested}
										className="shrink-0 rounded font-medium text-destructive text-xs hover:underline disabled:opacity-60"
									>
										{cancelRequested
											? "Cancelling…"
											: "Cancel"}
									</button>
								) : null}
							</div>
						) : null}
					</div>
				)}

				{/* PM-tool outage rollup — replaces N per-ticket failure toasts */}
				{resolved === "approved" && applyResult?.pmSyncOutage && (
					<PmSyncOutageRollup
						pmToolName={
							applyResult.pmSyncOutage.tool ??
							pmToolName ??
							"PM Tool"
						}
						count={applyResult.pmSyncOutage.count}
						items={applyResult.pmSyncOutage.items}
						errorClass={applyResult.pmSyncOutage.errorClass}
						onRetryAll={handleRetryOutage}
						isRetrying={isRetryingOutage}
					/>
				)}
			</div>
		);
	}

	// Chat-thread image attachments — read defensively because legacy
	// proposals predating the feature carry neither field on
	// `sourceMetadata` (FR-27). The `⚠ M` chip is additionally gated
	// on the proposal status so already-applied proposals stop surfacing
	// the warning (the markdown warning line is already on the story).
	const attachmentList = Array.isArray(attachments) ? attachments : [];
	const warningList = Array.isArray(attachmentWarnings)
		? attachmentWarnings
		: [];
	const warningsActionable =
		proposalStatus === undefined ||
		proposalStatus === "PENDING" ||
		proposalStatus === "FAILED" ||
		// A backlogged proposal can still be approved (transition out of
		// backlog), so its attachment warnings remain actionable.
		proposalStatus === "BACKLOG";
	const attachmentCount = attachmentList.length;
	const warningCount = warningList.length;

	return (
		<div className="rounded-lg border bg-card space-y-3 p-4 max-w-full">
			{/* Header */}
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h4 className="font-semibold text-sm">
						Proposed Backlog Changes ({changes.length} items)
					</h4>
					{proposalStatus === "BACKLOG" && (
						<Badge
							variant="secondary"
							className="gap-1 bg-muted text-muted-foreground"
						>
							<ArchiveIcon
								className="size-3"
								aria-hidden="true"
							/>
							Rejected
						</Badge>
					)}
					{attachmentCount > 0 && (
						<Badge
							variant="secondary"
							className="gap-1 bg-muted text-muted-foreground"
							role="img"
							aria-label={`${attachmentCount} image attachment${attachmentCount === 1 ? "" : "s"} from chat thread`}
						>
							<span aria-hidden="true">📎</span>
							{attachmentCount}
						</Badge>
					)}
					{warningCount > 0 && warningsActionable && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Badge
										variant="secondary"
										className="gap-1 bg-muted text-muted-foreground"
										role="img"
										aria-label={`${warningCount} attachment warning${warningCount === 1 ? "" : "s"}`}
										tabIndex={0}
									>
										<span aria-hidden="true">⚠</span>
										{warningCount}
									</Badge>
								</TooltipTrigger>
								<TooltipContent>
									{formatWarningReasons(warningList)}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
				{contextSummary && (
					<p className="text-xs text-muted-foreground mt-1">
						{contextSummary}
					</p>
				)}
				{summary && (
					<p className="text-xs text-muted-foreground mt-0.5">
						{summary}
					</p>
				)}
			</div>

			{/* Async decision pre-check in flight (AI-Update sidebar): a subtle,
				proposal-level "checking…" line so the check is visible instead of a
				note that silently pops in. Suppressed once conflicts surface (the
				amber notes speak for themselves) or the check resolves clean. */}
			{decisionPrecheckPending && decisionFindings.length === 0 && (
				<div
					role="status"
					className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
				>
					<span
						className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50 motion-safe:animate-pulse"
						aria-hidden="true"
					/>
					{tDecision("checking")}
				</div>
			)}

			{/* Change Items */}
			<div className="space-y-2 max-h-[400px] overflow-y-auto">
				{changes.map((change, index) => {
					const checkboxId = `backlog-change-${index}`;
					// Per-change findings resolve solely from the proposal-level
					// pre-check result, matching each finding's `changeRef.index`
					// to this change's position.
					const changeConflicts = decisionFindings.filter(
						(finding) => finding.changeRef?.index === index,
					);
					// Single source of truth for the per-row affordance state.
					// Any update with a concrete existing
					// story id (not demoted) gets the working "open existing
					// ticket" button. Channel-monitor inbox proposals carry the
					// target via existingId/existingIdentifier with NO
					// targetResolution stamp (only the AI Update path stamps it),
					// so we gate on existingId, not targetResolution.status.
					// Updates with no existing id get the inline "Ticket not
					// found" note; creates get neither.
					// Once the reviewer overrides the routing, everything the
					// backend wrote about the original target is out of date:
					// the "Updates F-12" badge names a ticket that is no longer
					// the destination, and the diff below was merged against
					// that ticket's body. The routing control renders the
					// accurate picture for an overridden row, so the row's own
					// update-shaped chrome stands down rather than contradict it.
					const routingOverridden =
						resolveEffectiveRouting(
							change.routing ?? undefined,
							routingOverridesByIndex.get(index),
						)?.overridden === true;
					// An enrichment the reviewer sent back to "new ticket" IS a
					// create from here on: it will be applied as one, so it must
					// offer everything a create offers — the Bug/Feature choice
					// and the work-item prompt that drafts the body. Keying the
					// chrome off the raw `change.action` (still "update") was why
					// an overridden row silently skipped both.
					const effectiveAction = routingOverridden
						? "create"
						: change.action;
					const isResolvedUpdate =
						!routingOverridden &&
						change.action === "update" &&
						change.targetResolution?.demotedFromUpdate !== true &&
						typeof change.existingId === "string" &&
						change.existingId.length > 0;
					const isUnresolvedUpdate =
						!routingOverridden &&
						change.action === "update" &&
						!isResolvedUpdate;
					return (
						<div
							key={index}
							className={cn(
								"rounded-md border p-3 space-y-2 transition-colors",
								selected.has(index)
									? "bg-background"
									: "bg-muted/30 opacity-60",
							)}
						>
							{/* Item header */}
							<div className="flex items-start gap-2">
								<Checkbox
									id={checkboxId}
									checked={selected.has(index)}
									onCheckedChange={() => toggleItem(index)}
									aria-label={`Toggle ${change.title.to}`}
									className="mt-0.5 shrink-0 cursor-pointer"
								/>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 flex-wrap">
										<Badge
											variant="outline"
											className={cn(
												"text-xs capitalize",
												effectiveAction === "create"
													? "border-green-500 text-green-700 dark:text-green-400"
													: "border-amber-500 text-amber-700 dark:text-amber-400",
											)}
										>
											{effectiveAction}
										</Badge>
										{effectiveAction === "create" &&
										change.type !== "epic" ? (
											<KindSelector
												selected={
													kindOverridesByIndex.get(
														index,
													) ??
													deriveDefaultKind(
														change.type,
													)
												}
												overridden={
													(kindOverridesByIndex.get(
														index,
													) ??
														deriveDefaultKind(
															change.type,
														)) !==
													deriveDefaultKind(
														change.type,
													)
												}
												onChange={(next) =>
													setKindOverride(index, next)
												}
												disabled={
													!selected.has(index) ||
													reformattingIndex === index
												}
												itemTitle={change.title.to}
											/>
										) : effectiveAction === "update" &&
											change.type !== "epic" ? (
											// Updates carry the existing item's kind — the
											// selector hides because changing kind isn't part
											// of the AI-Update update path (separate
											// convert-kind action exists on the story
											// detail page). We still surface the kind as a
											// readonly pill in the same visual language as
											// the selector so the PM sees what type the
											// edited row is.
											<ReadOnlyKindBadge
												kind={deriveDefaultKind(
													change.type,
												)}
												itemTitle={change.title.to}
											/>
										) : (
											<Badge
												variant="secondary"
												className={cn(
													"text-xs capitalize",
													TYPE_COLORS[change.type],
												)}
											>
												{change.type}
											</Badge>
										)}
										{change.existingIdentifier && (
											<span className="text-xs font-mono text-muted-foreground">
												{change.existingIdentifier}
											</span>
										)}
										{conflictsByIndex[index]
											?.hasConflict && (
											<PmSyncConflictBadge
												pmToolName={pmToolName}
												onClick={() =>
													setDiffModalIndex(index)
												}
											/>
										)}
										{conflictsByIndex[index]?.pmError &&
											!conflictsByIndex[index]
												?.hasConflict && (
												<PmSyncConflictBadge
													pmToolName={pmToolName}
													label="PM unavailable"
													onClick={() =>
														setDiffModalIndex(index)
													}
												/>
											)}
										{pushAnywayByIndex[index] && (
											<span className="text-[10px] uppercase tracking-[0.18em] text-destructive">
												will push anyway
											</span>
										)}
										{skipByIndex[index] && (
											<span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
												PM sync skipped
											</span>
										)}
										{reviewedIndexes.has(index) && (
											<Badge
												variant="outline"
												className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground border-muted-foreground/30"
											>
												<EyeIcon className="mr-1 size-3" />
												Reviewed
											</Badge>
										)}
									</div>

									{/* Title */}
									<p className="font-medium text-sm mt-1">
										{change.title.to}
									</p>

									{/* Target-resolution badge */}
									{isResolvedUpdate ? (
										<div className="flex items-center gap-1 flex-wrap">
											<span className="text-muted-foreground text-xs">
												Updates{" "}
												{change.targetResolution
													?.resolvedIdentifier ??
													change.existingIdentifier}
												{change.targetResolution
													?.resolvedTitle
													? ` — ${change.targetResolution?.resolvedTitle}`
													: ""}
											</span>
											{isResolvedUpdate && (
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<button
																type="button"
																aria-label={t(
																	"openExisting",
																	{
																		identifier:
																			change
																				.targetResolution
																				?.resolvedIdentifier ??
																			change.existingIdentifier ??
																			"",
																		title:
																			change
																				.targetResolution
																				?.resolvedTitle ??
																			"",
																	},
																)}
																onClick={() =>
																	openExistingTicket(
																		change,
																	)
																}
																className="inline-flex items-center text-muted-foreground hover:text-primary focus-visible:text-primary"
															>
																<ExternalLinkIcon
																	className="size-3.5"
																	aria-hidden="true"
																/>
															</button>
														</TooltipTrigger>
														<TooltipContent>
															{t(
																"openExistingTooltip",
															)}
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											)}
										</div>
									) : change.targetResolution
											?.demotedFromUpdate ? (
										<span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 text-xs dark:bg-amber-950 dark:text-amber-300">
											New item — no existing match
										</span>
									) : null}

									{/* Non-blocking "Ticket not found" note for
									    an update whose target could not be
									    resolved / was demoted / lost its id.
									    Create rows never reach this branch. */}
									{isUnresolvedUpdate && (
										<span className="text-muted-foreground text-xs">
											{t("ticketNotFound")}
										</span>
									)}

									{/* Create-vs-Enrich routing (capture-as-is sources only) */}
									{change.routing && (
										<ProposalRoutingControl
											routing={change.routing}
											override={routingOverridesByIndex.get(
												index,
											)}
											onOverrideChange={(next) =>
												setRoutingOverride(index, next)
											}
											projectId={projectId}
											organizationId={organizationId}
											disabled={!selected.has(index)}
											itemTitle={change.title.to}
										/>
									)}

									{/* Diff fields for updates */}
									{change.action === "update" &&
										!routingOverridden && (
											<div className="mt-2 space-y-1">
												{change.title.from &&
													change.title.from !==
														change.title.to && (
														<ProposalDiffField
															label="Title"
															from={
																change.title
																	.from
															}
															to={change.title.to}
														/>
													)}
												{change.description?.from &&
													change.description.from !==
														change.description
															.to && (
														<ProposalDiffField
															label="Description"
															from={stripMarkdown(
																change
																	.description
																	.from,
															)}
															to={stripMarkdown(
																change
																	.description
																	.to,
															)}
														/>
													)}
												{change.priority?.from &&
													change.priority.from !==
														change.priority.to && (
														<ProposalDiffField
															label="Priority"
															from={
																change.priority
																	.from
															}
															to={
																change.priority
																	.to
															}
														/>
													)}
												{change.size?.from &&
													change.size.from !==
														change.size.to && (
														<ProposalDiffField
															label="Size"
															from={
																change.size.from
															}
															to={change.size.to}
														/>
													)}
											</div>
										)}

									{/* Create details */}
									{change.action === "create" && (
										<div className="mt-1 space-y-1">
											{change.description?.to && (
												<p className="text-xs text-muted-foreground line-clamp-2">
													{stripMarkdown(
														getEffectiveBody(
															index,
															change,
														).description ??
															change.description
																.to,
													)}
												</p>
											)}
											{change.parentEpicIdentifier && (
												<p className="text-xs text-muted-foreground">
													Under:{" "}
													{
														change.parentEpicIdentifier
													}
												</p>
											)}
											{change.parentFeatureIdentifier && (
												<p className="text-xs text-muted-foreground">
													Under:{" "}
													{
														change.parentFeatureIdentifier
													}
												</p>
											)}
											{change.priority?.to && (
												<span className="text-xs text-muted-foreground">
													Priority:{" "}
													{change.priority.to}
												</span>
											)}
										</div>
									)}

									{change.bodyMergeFallback && (
										<p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
											AI kept the existing description —
											it couldn't safely merge the new
											info without losing structure.
										</p>
									)}
									<DecisionConflictNote
										findings={changeConflicts}
									/>
									{reformattingIndex === index && (
										<p
											className="mt-1 text-[11px] text-muted-foreground"
											aria-live="polite"
										>
											Reformatting for{" "}
											{(
												kindOverridesByIndex.get(
													index,
												) ??
												deriveDefaultKind(change.type)
											).toLowerCase()}
											…
										</p>
									)}
									{/* Source & reasoning */}
									<div className="flex items-center gap-2 mt-2">
										<span className="text-xs text-muted-foreground">
											Source:{" "}
											{SOURCE_LABELS[
												change.sourceContext
											] ?? change.sourceContext}
										</span>
									</div>
									{change.reasoning && (
										<p className="text-xs text-muted-foreground italic mt-0.5 line-clamp-2">
											{stripMarkdown(change.reasoning)}
										</p>
									)}

									{/* Open the per-item detail dialog. The list
									    only shows truncated previews; full review
									    happens here so PMs can decide based on the
									    complete content rather than 80–200 char
									    snippets. Marks the item reviewed on open. */}
									<div className="mt-2">
										<Button
											type="button"
											variant="link"
											size="sm"
											className="h-auto p-0 text-xs"
											onClick={(e) => {
												e.stopPropagation();
												openDetail(index);
											}}
										>
											<EyeIcon className="mr-1 size-3" />
											{reviewedIndexes.has(index)
												? "Review again"
												: "Open full detail to review"}
										</Button>
									</div>
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{/* PM sync checkbox */}
			{hasPMTool && (
				<div
					className="flex items-center gap-2 pt-1"
					onClick={(e) => e.stopPropagation()}
				>
					<Checkbox
						checked={syncToPM}
						onCheckedChange={(checked) => setSyncToPM(!!checked)}
						id="sync-pm"
					/>
					<label
						htmlFor="sync-pm"
						className="text-xs text-muted-foreground cursor-pointer"
					>
						Also sync to {pmToolName ?? "PM Tool"}
					</label>
				</div>
			)}

			{/* Actions */}
			<div className="flex flex-wrap items-center gap-2 pt-1">
				<Button
					size="sm"
					// Field-skip / kindOverride folding + the per-row PM-sync
					// overrides happen inside runApply(), which also cancels any
					// in-flight persisted draft. The ticket is always created
					// through the kind prompt (verbatim if a completed draft exists,
					// else drafted at apply).
					onClick={runApply}
					disabled={
						selectedCount === 0 ||
						routingBlockedIndexes.length > 0 ||
						(reformattingIndex !== null &&
							selected.has(reformattingIndex))
					}
				>
					<CheckIcon className="size-3.5 mr-1.5" />
					{isRejectedProposal ? "Restore & Apply" : "Apply"} Selected
					({selectedCount}/{changes.length})
				</Button>
				{/* Always mounted, empty when there is nothing to say: several
				    screen readers do not announce a live region that is inserted
				    into the DOM at the moment it first has content. */}
				<output className="text-destructive text-xs">
					{routingBlockedMessage}
				</output>
				{/* Move to Rejected — on a PENDING proposal this is the only way
				    to clear it besides Apply. Reject is intentionally NOT offered
				    on pending: every suggestion funnels through Rejected first,
				    so nothing is permanently dismissed while still recoverable. A
				    quiet `ghost` treatment keeps Apply the primary action (FR6). */}
				{onBacklog && proposalStatus === "PENDING" && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setResolved("backlog");
							onBacklog();
						}}
						aria-label="Move this proposal to Rejected proposals"
					>
						<ArchiveIcon className="size-3.5 mr-1.5" />
						Move to Rejected
					</Button>
				)}
				{/* Permanent dismissal is offered only once a proposal is out of
				    the pending queue (already in Rejected, or FAILED). This makes
				    Rejected the single funnel: a pending suggestion is moved there
				    first, then can be deleted for good from the Rejected
				    view — it can never be permanently rejected straight from the
				    review queue. */}
				{proposalStatus !== "PENDING" && (
					<Button
						size="sm"
						variant="outline"
						aria-label={
							isRejectedProposal
								? "Delete proposal permanently"
								: "Reject all proposed changes"
						}
						onClick={() => {
							setResolved("rejected");
							onReject();
						}}
					>
						{isRejectedProposal ? (
							<Trash2Icon className="size-3.5 mr-1.5" />
						) : (
							<XIcon className="size-3.5 mr-1.5" />
						)}
						{isRejectedProposal ? "Delete proposal" : "Reject All"}
					</Button>
				)}
			</div>

			{/* PM sync diff modal — opened from the per-row conflict badge.
			    Also mounts for "PM unavailable" rows, where it shows the
			    credential error in place of the diff. */}
			{diffModalIndex !== null &&
				(conflictsByIndex[diffModalIndex]?.pmCurrent ||
					conflictsByIndex[diffModalIndex]?.pmError) && (
					<PmSyncDiffModal
						open={diffModalIndex !== null}
						onOpenChange={(open) => {
							if (!open) {
								setDiffModalIndex(null);
							}
						}}
						pmToolName={pmToolName ?? "PM Tool"}
						pmCurrent={conflictsByIndex[diffModalIndex].pmCurrent}
						pmError={conflictsByIndex[diffModalIndex].pmError}
						pmTool={conflictsByIndex[diffModalIndex].pmTool}
						settingsHref={settingsHref}
						fabricProposed={{
							title: changes[diffModalIndex].title.to,
							description:
								changes[diffModalIndex].description?.to ?? "",
						}}
						pmUrl={conflictsByIndex[diffModalIndex].pmUrl}
						onPushAnyway={() => {
							const idx = diffModalIndex;
							setPushAnywayByIndex((prev) => ({
								...prev,
								[idx]: true,
							}));
							setSkipByIndex((prev) => {
								const { [idx]: _, ...rest } = prev;
								return rest;
							});
							setDiffModalIndex(null);
						}}
						onSkip={() => {
							const idx = diffModalIndex;
							setSkipByIndex((prev) => ({
								...prev,
								[idx]: true,
							}));
							setPushAnywayByIndex((prev) => {
								const { [idx]: _, ...rest } = prev;
								return rest;
							});
							setDiffModalIndex(null);
						}}
					/>
				)}

			{/* Per-item full-detail review dialog. Mounts only when an
			    index is selected. Approve / Reject toggle the parent's
			    `selected` set so the PM can stage decisions one by one
			    without leaving the dialog. Prev / Next walk the list and
			    auto-mark each visited item as reviewed (badge shows up
			    in the list when this dialog closes). */}
			{detailIndex !== null &&
				changes[detailIndex] &&
				(() => {
					const di = detailIndex;
					const detailChange = changes[di];
					const detailKind =
						kindOverridesByIndex.get(di) ??
						deriveDefaultKind(detailChange.type);
					// Persisted (inbox) draft state for the open kind, if any.
					const persisted = isPersistedDraftIndex(di)
						? persistedDrafts.byKind[detailKind]
						: undefined;
					const isDrafting = persisted
						? persisted.status === "RUNNING"
						: reformattingIndex === di;
					return (
						<BacklogChangeDetailDialog
							open={detailIndex !== null}
							onOpenChange={(open) => {
								if (!open) {
									setDetailIndex(null);
								}
							}}
							change={buildEffectiveChange(di, detailChange)}
							index={di}
							totalCount={changes.length}
							isSelected={selected.has(di)}
							canGoPrev={di > 0}
							canGoNext={di < changes.length - 1}
							onApprove={() => {
								setSelected((prev) => {
									const next = new Set(prev);
									next.add(di);
									return next;
								});
							}}
							onReject={() => {
								setSelected((prev) => {
									const next = new Set(prev);
									next.delete(di);
									return next;
								});
							}}
							onPrev={() => goToDetail(di - 1)}
							onNext={() => goToDetail(di + 1)}
							skippedFields={
								skippedFieldsByIndex.get(di) ?? EMPTY_SKIP_SET
							}
							onToggleField={(field) =>
								toggleSkippedField(di, field)
							}
							kindOverride={kindOverridesByIndex.get(di)}
							onKindOverride={(next) => setKindOverride(di, next)}
							reformatting={isDrafting}
							draftStartedAt={persisted?.startedAt}
							draftStatus={persisted?.status}
							onCancelDraft={
								persisted?.status === "RUNNING"
									? () => {
											void persistedDrafts.cancelDraft(
												detailKind,
											);
										}
									: undefined
							}
							onStartDraft={
								isPersistedDraftIndex(di)
									? () =>
											persistedDrafts.startDraft(
												detailKind,
											)
									: undefined
							}
						/>
					);
				})()}
		</div>
	);
}

/**
 * Inline kind selector for AI Update approval rows.
 *
 * Renders a two-button segmented control (Feature | Bug) inline with the row
 * header. Honors the editorial-restraint visual language used elsewhere in
 * the approval UI: only the active button carries the type color, the
 * inactive option is muted, and a faint "edited" dot appears when the
 * reviewer's selection diverges from the analyzer's default. The control
 * hides itself for epic rows (epics are containers, not kinds).
 *
 * Keyboard contract (WAI-ARIA radiogroup pattern):
 *   - Only the selected radio is in the tab order (tabIndex=0); the other
 *     option is `tabIndex={-1}` so Tab leaves the group instead of stepping
 *     through both buttons.
 *   - ArrowLeft / ArrowUp → previous option; selects + focuses.
 *   - ArrowRight / ArrowDown → next option; selects + focuses.
 *   - Home → first option; End → last option.
 *   - Space / Enter on a non-active radio selects it (mirrors Click).
 *
 * The "Story" type is intentionally absent (DSU 2026-05-23 decision: removing
 * USER_STORY from the AI Update vocabulary cuts a documented source of
 * duplicate Feature/Story tickets).
 */
function KindSelector({
	selected,
	overridden,
	onChange,
	disabled,
	itemTitle,
}: {
	selected: ChangeItemKind;
	overridden: boolean;
	onChange: (next: ChangeItemKind) => void;
	disabled?: boolean;
	itemTitle: string;
}) {
	const t = useTranslations("tooltips.stories");
	const options: Array<{ value: ChangeItemKind; label: string }> = [
		{ value: "FEATURE", label: "Feature" },
		{ value: "BUG", label: "Bug" },
	];
	const groupRef = useRef<HTMLDivElement>(null);
	const focusOption = (value: ChangeItemKind) => {
		const el = groupRef.current?.querySelector<HTMLButtonElement>(
			`button[data-kind-value="${value}"]`,
		);
		el?.focus();
	};
	const moveSelection = (delta: number) => {
		if (disabled) {
			return;
		}
		const i = options.findIndex((o) => o.value === selected);
		const next = options[(i + delta + options.length) % options.length]!;
		onChange(next.value);
		focusOption(next.value);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (disabled) {
			return;
		}
		switch (e.key) {
			case "ArrowLeft":
			case "ArrowUp":
				e.preventDefault();
				moveSelection(-1);
				break;
			case "ArrowRight":
			case "ArrowDown":
				e.preventDefault();
				moveSelection(1);
				break;
			case "Home":
				e.preventDefault();
				if (selected !== options[0]!.value) {
					onChange(options[0]!.value);
				}
				focusOption(options[0]!.value);
				break;
			case "End":
				e.preventDefault();
				if (selected !== options[options.length - 1]!.value) {
					onChange(options[options.length - 1]!.value);
				}
				focusOption(options[options.length - 1]!.value);
				break;
		}
	};
	return (
		<>
			<div
				ref={groupRef}
				role="radiogroup"
				aria-label={`Work item type for "${itemTitle}"`}
				aria-disabled={disabled || undefined}
				onKeyDown={onKeyDown}
				className={cn(
					"inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5",
					disabled && "opacity-50",
				)}
			>
				{options.map((opt) => {
					const isActive = opt.value === selected;
					return (
						// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup-on-buttons pattern (same shape Radix's ToggleGroup uses) — native <input type=radio> can't carry the segmented-control visual treatment we need here.
						<button
							key={opt.value}
							type="button"
							role="radio"
							aria-checked={isActive}
							disabled={disabled}
							data-kind-value={opt.value}
							tabIndex={isActive && !disabled ? 0 : -1}
							onClick={(e) => {
								e.stopPropagation();
								if (!disabled && !isActive) {
									onChange(opt.value);
								}
							}}
							className={cn(
								"px-2 py-0.5 text-xs rounded font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								"cursor-pointer disabled:cursor-not-allowed",
								isActive
									? opt.value === "BUG"
										? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
										: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{opt.label}
						</button>
					);
				})}
				{/* The dot is decorative, so it stays `aria-hidden` and the tooltip
					is a pointer affordance. The `sr-only` note below sits outside
					the radiogroup — it gives the marker a real accessible identity,
					which the native `title` on an `aria-hidden` element never did,
					without putting stray content between the radios. */}
				{overridden && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								aria-hidden
								className="ml-1 mr-0.5 size-1.5 rounded-full bg-primary"
							/>
						</TooltipTrigger>
						<TooltipContent>{t("typeOverridden")}</TooltipContent>
					</Tooltip>
				)}
			</div>
			{overridden && (
				<span className="sr-only">{t("typeOverridden")}</span>
			)}
		</>
	);
}

/**
 * Read-only kind indicator for UPDATE rows.
 *
 * Same visual shape as `KindSelector` (rounded pill with the type color) so
 * UPDATE rows feel consistent with CREATE rows, but with no click target and
 * a "(Locked)" hint — the AI Update flow doesn't change kind on existing
 * items. Kind changes happen through the dedicated "Convert kind" action on
 * the story detail page (see `ConvertKindConfirmDialog`).
 */
function ReadOnlyKindBadge({
	kind,
	itemTitle,
}: {
	kind: ChangeItemKind;
	itemTitle: string;
}) {
	const t = useTranslations("tooltips.stories");
	const label = kind === "BUG" ? "Bug" : "Feature";
	// `role="img"` + `aria-label` already carry the accessible identity, so only
	// the hover affordance moves to a tooltip — no `sr-only` duplicate needed.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					aria-label={`Work item type for "${itemTitle}": ${label} (locked — update rows preserve the existing kind)`}
					className={cn(
						"inline-flex items-center px-2 py-0.5 text-xs rounded-md border bg-card font-medium leading-tight",
						// Border opacities tuned per theme: light mode reads cleanly
						// at /80 (300-tier border on a 100-tier card surface); dark
						// mode needs /70 on a darker tier to read above the warm
						// zinc card surface without blending in.
						kind === "BUG"
							? "border-red-300/80 text-red-800 dark:border-red-700/70 dark:text-red-300"
							: "border-blue-300/80 text-blue-800 dark:border-blue-700/70 dark:text-blue-300",
					)}
				>
					{label}
				</span>
			</TooltipTrigger>
			<TooltipContent>{t("kindLockedOnUpdate")}</TooltipContent>
		</Tooltip>
	);
}

// Stable reference for "no fields skipped" — passed to the detail
// dialog when an item has no entry in `skippedFieldsByIndex`. Module
// scope so the prop reference is stable across renders and doesn't
// re-trigger child memoization downstream.
const EMPTY_SKIP_SET: ReadonlySet<SkippableField> = new Set();

const PERSIST_KEY_PREFIX = "fabric.backlog-change-proposal.review-state";
// Bumped to v2 to add kindOverrides to the persisted blob — older blobs are
// silently dropped (they only had the older review state) and the reviewer
// starts fresh on next load. Safe because the persisted state is purely a
// convenience for resume-after-refresh; it's never load-bearing.
const PERSIST_VERSION = 2;

type PersistedReviewState = {
	selected: Set<number>;
	reviewed: Set<number>;
	skippedFields: Map<number, Set<SkippableField>>;
	kindOverrides: Map<number, ChangeItemKind>;
};

type PersistedReviewBlob = {
	v: number;
	selected: number[];
	reviewed: number[];
	skipped: Array<[number, SkippableField[]]>;
	kindOverrides?: Array<[number, ChangeItemKind]>;
};

const VALID_SKIPPABLE_FIELDS: ReadonlySet<string> = new Set<SkippableField>([
	"title",
	"description",
	"acceptanceCriteria",
	"priority",
	"size",
]);

/**
 * Read previously-persisted review state from localStorage. Returns
 * an empty / default-shaped object when no key is provided, when SSR
 * (no `window`), when the entry is missing, or when the stored shape
 * is from an incompatible version. Indexes that fall outside the
 * current `changeCount` are dropped — proposals can be edited
 * server-side, so persisted state must always be re-validated.
 */
function readPersistedReviewState(
	key: string | undefined,
	changeCount: number,
): Partial<PersistedReviewState> {
	if (!key || typeof window === "undefined") {
		return {};
	}
	try {
		const raw = window.localStorage.getItem(`${PERSIST_KEY_PREFIX}.${key}`);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw) as PersistedReviewBlob;
		if (parsed?.v !== PERSIST_VERSION) {
			return {};
		}
		const inRange = (i: unknown): i is number =>
			typeof i === "number" &&
			Number.isInteger(i) &&
			i >= 0 &&
			i < changeCount;
		const selected = new Set<number>(
			Array.isArray(parsed.selected)
				? parsed.selected.filter(inRange)
				: [],
		);
		const reviewed = new Set<number>(
			Array.isArray(parsed.reviewed)
				? parsed.reviewed.filter(inRange)
				: [],
		);
		const skippedFields = new Map<number, Set<SkippableField>>();
		if (Array.isArray(parsed.skipped)) {
			for (const entry of parsed.skipped) {
				if (
					!Array.isArray(entry) ||
					entry.length !== 2 ||
					!inRange(entry[0])
				) {
					continue;
				}
				const fields = Array.isArray(entry[1])
					? entry[1].filter(
							(f): f is SkippableField =>
								typeof f === "string" &&
								VALID_SKIPPABLE_FIELDS.has(f),
						)
					: [];
				if (fields.length > 0) {
					skippedFields.set(entry[0], new Set(fields));
				}
			}
		}
		const kindOverrides = new Map<number, ChangeItemKind>();
		if (Array.isArray(parsed.kindOverrides)) {
			for (const entry of parsed.kindOverrides) {
				if (
					!Array.isArray(entry) ||
					entry.length !== 2 ||
					!inRange(entry[0]) ||
					typeof entry[1] !== "string" ||
					!VALID_KIND_OVERRIDES.has(entry[1] as ChangeItemKind)
				) {
					continue;
				}
				kindOverrides.set(entry[0], entry[1] as ChangeItemKind);
			}
		}
		return { selected, reviewed, skippedFields, kindOverrides };
	} catch {
		// Corrupt JSON / quota error / privacy mode — silently fall back
		// to a clean state. Persistence is best-effort, never load-bearing.
		return {};
	}
}

function writePersistedReviewState(
	key: string,
	state: PersistedReviewState,
): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		const blob: PersistedReviewBlob = {
			v: PERSIST_VERSION,
			selected: Array.from(state.selected),
			reviewed: Array.from(state.reviewed),
			skipped: Array.from(state.skippedFields.entries()).map(
				([idx, fields]) => [idx, Array.from(fields)],
			),
			kindOverrides: Array.from(state.kindOverrides.entries()),
		};
		window.localStorage.setItem(
			`${PERSIST_KEY_PREFIX}.${key}`,
			JSON.stringify(blob),
		);
	} catch {
		// Storage quota exceeded / disabled — best-effort persistence.
	}
}

/**
 * Plain-English label for each `AttachmentWarningReason`. Surfaced in
 * the `⚠ M` chip's tooltip so reviewers see a human-readable summary
 * (e.g., "1 unsupported type, 1 too large") instead of the raw enum
 * values. Keep aligned with `AttachmentWarningReason` in
 * `@repo/integrations/shared/attachment-types`.
 */
const WARNING_REASON_LABELS: Record<AttachmentWarningReason, string> = {
	unsupported_mime: "Unsupported image type",
	image_too_large: "Image too large",
	thread_total_exceeded: "Thread image total exceeded",
	count_cap_exceeded: "Too many images",
	scope_missing: "Permission missing — re-authorize integration",
	auth_failed: "Auth expired — re-authorize integration",
	external_workspace: "External workspace",
	download_failed: "Download failed",
	upload_failed: "Upload failed",
	patch_failed: "Couldn't save attachments to story",
	budget_exceeded: "Approval timeout",
};

/**
 * Aggregate the warning list into a comma-separated, human-readable
 * tooltip body. Duplicate reasons collapse into `"N <label>"` entries
 * so reviewers see one row per distinct failure mode rather than N
 * repeats of the same label.
 *
 * Unknown reasons (defensive — should not occur with typed sources)
 * fall back to the raw value so we never silently swallow them.
 */
export function formatWarningReasons(warnings: AttachmentWarning[]): string {
	if (warnings.length === 0) {
		return "";
	}
	// Count per reason, preserving first-seen order so the tooltip
	// reflects the order failures were emitted.
	const counts = new Map<string, number>();
	for (const w of warnings) {
		counts.set(w.reason, (counts.get(w.reason) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [reason, count] of counts) {
		const label =
			WARNING_REASON_LABELS[reason as AttachmentWarningReason] ?? reason;
		parts.push(count > 1 ? `${count} ${label}` : label);
	}
	return parts.join(", ");
}

/**
 * Transform a single approved change so the backend skips any field
 * the user staged-rejected via the detail dialog's per-field toggle.
 *
 * Required fields (`title`) are kept as `from` so the backend writes
 * the same value (effective no-op). Optional fields (`description`,
 * `acceptanceCriteria`, `priority`, `size`) are omitted from the
 * resulting change object, so the backend never sees an update for
 * them. `parent*` identifiers and `reasoning` are not user-rejectable
 * and are passed through unchanged.
 */
function applyFieldSkips(
	change: ChangeItem,
	skipped: Set<SkippableField> | undefined,
): ChangeItem {
	if (!skipped || skipped.size === 0) {
		return change;
	}
	const next: ChangeItem = { ...change };
	if (skipped.has("title") && next.title.from !== undefined) {
		next.title = { from: next.title.from, to: next.title.from };
	}
	if (skipped.has("description")) {
		next.description = undefined;
	}
	if (skipped.has("acceptanceCriteria")) {
		next.acceptanceCriteria = undefined;
	}
	if (skipped.has("priority")) {
		next.priority = undefined;
	}
	if (skipped.has("size")) {
		next.size = undefined;
	}
	return next;
}

/**
 * Fold the reviewer's kind selection into the outgoing payload.
 *
 * Strips overrides that match the analyzer's default (server already would
 * have arrived at the same kind via the classifier in the common case, so
 * sending the override is noise). Only differing overrides are forwarded —
 * those make the backend skip the classifier and use the user's choice.
 * Epics and update rows are passed through untouched (epics aren't a kind;
 * updates preserve the existing item's kind).
 */
/**
 * Fold a reviewer's Create/Enrich override into the change that gets submitted.
 *
 * Enrich becomes `action: "update"` against the chosen ticket; Create strips the
 * target back off. Both directions clear the `from` sides of the diff fields:
 * they describe the *previous* target's current body, and the approve path
 * re-derives the structure-preserving merge against whatever target it is
 * finally given, so carrying a stale `from` would only mislead the audit trail.
 *
 * A row with no routing annotation — every proposal source other than the
 * capture-as-is ingest flows — passes through untouched.
 */
export function applyRoutingOverride(
	change: ChangeItem,
	override: RoutingOverride | undefined,
): ChangeItem {
	if (!override || !change.routing) {
		return change;
	}
	const effective = resolveEffectiveRouting(change.routing, override);
	if (!effective) {
		return change;
	}
	const routing: RoutingAnnotation = { ...change.routing, overridden: true };

	// Always re-submit the action item AS CAPTURED. The row's current body is
	// the merge the backend produced against the ORIGINAL target — sending that
	// to a re-targeted enrichment would write one ticket's content onto another.
	// Apply re-runs the structure-preserving merge against whatever target it
	// finally receives, so the captured content is the correct input.
	const captured = {
		description: change.routing.proposedDescription ?? undefined,
		acceptanceCriteria:
			change.routing.proposedAcceptanceCriteria ?? undefined,
	};

	if (effective.decision === "create") {
		return {
			...change,
			action: "create",
			existingId: undefined,
			existingIdentifier: undefined,
			existingExternalId: undefined,
			// Reinstate the action item's own wording — the enrich path had
			// swapped in the target ticket's title.
			title: {
				to: change.routing.proposedTitle ?? change.title.to,
			},
			description: captured.description
				? { to: captured.description }
				: undefined,
			acceptanceCriteria: captured.acceptanceCriteria
				? { to: captured.acceptanceCriteria }
				: undefined,
			targetResolution: undefined,
			routing: {
				...routing,
				decision: "create",
				matchedStoryId: null,
				matchedIdentifier: null,
				matchedTitle: null,
			},
		};
	}

	// Enrich. The approval gate guarantees a target is present by the time this
	// runs, but a missing one must never silently become an unaddressed update:
	// leave the change as the create it already is.
	if (!effective.targetStoryId || !effective.targetIdentifier) {
		return change;
	}
	return {
		...change,
		action: "update",
		existingId: effective.targetStoryId,
		existingIdentifier: effective.targetIdentifier,
		existingExternalId: undefined,
		title: { to: effective.targetTitle ?? change.title.to },
		description: captured.description
			? { to: captured.description }
			: undefined,
		acceptanceCriteria: captured.acceptanceCriteria
			? { to: captured.acceptanceCriteria }
			: undefined,
		// The backend re-resolves the target; a stale stamp from the system's
		// original match would name the wrong ticket in the review trail.
		targetResolution: undefined,
		routing: {
			...routing,
			decision: "enrich",
			matchedStoryId: effective.targetStoryId,
			matchedIdentifier: effective.targetIdentifier,
			matchedTitle: effective.targetTitle ?? null,
		},
	};
}

function applyKindOverride(
	change: ChangeItem,
	override: ChangeItemKind | undefined,
): ChangeItem {
	// Runs AFTER `applyRoutingOverride`, which has already turned a
	// reviewer-rejected enrichment back into `action: "create"`. Testing the
	// incoming action is therefore correct here — but only because of that
	// ordering, which is why it is stated rather than assumed.
	if (!override || change.action !== "create" || change.type === "epic") {
		return change;
	}
	const defaultKind = deriveDefaultKind(change.type);
	if (override === defaultKind) {
		return change;
	}
	return { ...change, kindOverride: override };
}

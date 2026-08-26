"use client";

import type { LastEditSource } from "@repo/database";
import { pmDetectedTypeDisplayName } from "@repo/utils";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { format } from "date-fns";
import { diffWords } from "diff";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import TurndownService from "turndown";
// @ts-expect-error - turndown-plugin-gfm has no types
import { gfm } from "turndown-plugin-gfm";
import { formatLastEditSource } from "../../lib/last-edit-source-copy";
import { countWords, formatWordCount } from "../../lib/word-count";
import {
	type PmSyncError,
	PmSyncErrorPanel,
	pmSyncErrorCopy,
} from "./pm-sync/pmSyncError";

type ItemType = "epic" | "feature" | "story" | "bug";
type Resolution = "REMOTE" | "LOCAL";

// PM tools like ADO/Jira return descriptions as HTML, while Fabric stores
// markdown. Diffing them raw highlighted every `<h1>`-vs-`#` tag as a "change",
// burying the real content deltas in syntax noise. Converting the PM side to
// markdown (GFM for tables/strikethrough) lets the diff — and the AI merge —
// compare like-for-like. turndown bundles its own DOM (domino), so this is safe
// in both the browser and SSR/tests.
const turndownService = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndownService.use(gfm);

// Matches real HTML tags (`<h1>`, `</p>`, `<img src=…>`) but NOT markdown
// autolinks like `<https://…>` (no space/`>` after the scheme).
const HTML_TAG_RE = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;

/**
 * Normalize a PM-side description to markdown so it diffs cleanly against
 * Fabric's markdown. No-op when the text has no HTML tags (already markdown —
 * Fabric, GitLab, Fizzy), so it only transforms the HTML tools. Never throws:
 * a conversion failure falls back to the raw text rather than break the modal.
 */
function normalizeDescriptionToMarkdown(text: string): string {
	if (!text || !HTML_TAG_RE.test(text)) {
		return text;
	}
	try {
		return turndownService.turndown(text).trim();
	} catch {
		return text;
	}
}

/**
 * Dialog mode.
 * - `"push-conflict"` (default) — Chunk B push-time conflict resolution. Wires
 *   to `resolveConflict` with Use Fabric / Use PM / AI merge / Cancel. Behavior
 *   unchanged.
 * - `"pull-drift"` — Chunk C pull-side content drift (a `CONTENT_DRIFT`
 *   `PendingPmStateChange`). Wires to `resolveContentDrift`. The footer mirrors
 *   the push-conflict modal — Use PM (→ APPLY_ADO) / Use Fabric (→ KEEP_FABRIC,
 *   behind an overwrite confirm) / AI merge / Cancel. (The backend still
 *   supports a DISMISS outcome; it is no longer surfaced as a button.)
 */
type DialogMode = "push-conflict" | "pull-drift";

/** Pull-drift resolve outcomes — mirrors `resolveContentDrift`'s input enum. */
type ContentDriftOutcome = "APPLY_ADO" | "KEEP_FABRIC" | "AI_MERGE" | "DISMISS";

/**
 * Pre-fetched PM-side preview. When supplied (push-time flow — `StoryCard`
 * already ran `checkPmSyncConflicts`), the dialog renders immediately without
 * a fetch. When omitted (Review Center row), the dialog fetches the
 * single-item preview itself on open.
 */
export type ConflictPreview = {
	pmCurrent?: {
		title: string;
		description: string;
		lastChangedBy: string | null;
		lastChangedAt: string | null;
	};
	pmUrl?: string;
	pmTool: string | null;
	/**
	 * Set when the current user's PM connection could not load the PM side
	 * (credentials missing/expired, etc). When present the dialog shows an
	 * actionable error instead of a blank diff, and resolve actions are hidden.
	 */
	pmError?: PmSyncError;
};

/**
 * ─────────────────────────────────────────────────────────────────────────
 * PROP CONTRACT (for T7 `StoryCard` / T8 `ReviewCenterRow` rewiring)
 * ─────────────────────────────────────────────────────────────────────────
 * This is the single canonical resolve modal for BOTH push-time conflicts and
 * Review Center conflict rows.
 *
 * Always required:
 *   - open / onOpenChange  — dialog visibility (controlled).
 *   - projectId            — project the item belongs to.
 *   - organizationId       — tenant scope (`null` for personal context). Passed
 *                            to `proposeAiMerge` + `checkPmSyncConflicts` ONLY;
 *                            `resolveConflict` resolves the tenant server-side
 *                            and its input does NOT accept organizationId.
 *   - itemType             — "epic" | "feature" | "story" | "bug" (drives the
 *                            backend dispatch on resolveConflict / proposeAiMerge).
 *   - entityId             — the Fabric entity id (story/bug → UserStory id,
 *                            feature → Feature id, epic → Epic id).
 *   - fabricTitle / fabricDescription — the Fabric-side content. The conflict
 *                            preview NEVER carries the Fabric side, so callers
 *                            must always pass it.
 *
 * Optional:
 *   - identifier   — e.g. "F-039"; rendered in the header. Falls back to none.
 *   - preview      — pre-fetched PM-side preview (see ConflictPreview). When
 *                    ABSENT the dialog fetches via checkPmSyncConflicts on open.
 *   - onResolved   — caller-owned callback fired after a successful resolve.
 *                    The dialog does NOT invalidate queries itself: every
 *                    caller (StoryCard, ReviewCenterRow, PmSyncChip) wires
 *                    this to the shared useInvalidatePmSyncState helper,
 *                    which refreshes stories.list / stories.get /
 *                    reviewCenter.items / reviewCenter.count together.
 *
 * T7 (StoryCard): already holds `pmConflictPreview` + `story.title/description`.
 *   Pass `preview`, `fabricTitle`, `fabricDescription`, `entityId={story.id}`,
 *   `itemType` derived from the story kind ("bug" vs "story").
 *
 * T8 (ReviewCenterRow): has `item.entityId`, `item.identifier`, `item.title`,
 *   `item.pmTool` — but NO Fabric description and NO PM preview. T8 must source
 *   `fabricDescription` (single-item loader or an extended review-center list
 *   response) and omit `preview` (dialog will fetch). `entityType` → itemType:
 *   "EPIC"→epic, "FEATURE"→feature, "STORY"→story (bugs surface as STORY in the
 *   row today; if bug distinction is needed later, extend the row item).
 * ─────────────────────────────────────────────────────────────────────────
 */
export type ConflictResolveDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId: string | null;
	itemType: ItemType;
	entityId: string;
	fabricTitle: string;
	fabricDescription: string;
	/**
	 * When the Fabric entity last received a genuine content or workflow edit.
	 * `null` means no semantic edit has been recorded since attribution shipped.
	 */
	fabricUpdatedAt?: string | Date | null;
	/**
	 * Fabric-side last-editor display name (`UserStory.lastEditedByName`).
	 * Rendered as "by {name}" on the FABRIC column timestamp line. `null` for
	 * system/AI edits (the source label carries attribution) and pre-feature
	 * rows (→ "Author unavailable").
	 */
	fabricAuthor?: string | null;
	/**
	 * Fabric-side last-edit provenance (`UserStory.lastEditedSource`). Rendered
	 * as a separate source element ("Manual edit", "Pulled from {tool}", …).
	 * `null` → "Source unavailable".
	 */
	fabricSource?: LastEditSource | null;
	identifier?: string;
	preview?: ConflictPreview;
	onResolved?: () => void;
	/**
	 * Link to where the user manages their PM connection (e.g. the project
	 * settings tab). Surfaced as the CTA when the PM side can't be loaded
	 * because the user's credentials are missing/expired.
	 */
	settingsHref?: string;
	/**
	 * Which resolve flow this dialog drives. Defaults to `"push-conflict"`
	 * (Chunk B). Pass `"pull-drift"` for a Review Center `CONTENT_DRIFT` item;
	 * `pendingChangeId` is then required (the `PendingPmStateChange.id`).
	 */
	mode?: DialogMode;
	/**
	 * Pull-drift only: the `PendingPmStateChange` id passed to
	 * `resolveContentDrift`. Required when `mode === "pull-drift"`, ignored
	 * otherwise.
	 */
	pendingChangeId?: string;
};

/** AI-merge lifecycle for the editable middle column. */
type MergeState =
	| { status: "idle" }
	| { status: "loading" }
	// `truncated` — the model hit its output-token limit and the merged text is
	// cut off. Accepting it would write an incomplete description to Fabric (and
	// push it to the PM tool), so the Accept action is blocked until the user
	// regenerates a complete merge or picks a side.
	| { status: "ready"; truncated: boolean }
	| { status: "error" };

const EMPTY_PLACEHOLDER = "(empty)";

function formatPmToolLabel(pmTool: string | null): string | null {
	if (!pmTool) {
		return null;
	}
	return pmDetectedTypeDisplayName(pmTool) ?? pmTool;
}

/**
 * "Last changed by {who} {relative-time} in {tool}". Returns null when there
 * is nothing meaningful to show (both author and timestamp missing).
 */
/**
 * Fabric-side timestamp + author line. Always returns a string:
 * - author present                → `Updated {when} by {name}`
 * - author null, source present    → `Updated {when}` (author phrase omitted;
 *   the separate source element carries attribution for system/AI edits)
 * - author null, source null       → `Updated {when} · Author unavailable`
 * `{when}` falls back to "Updated date unavailable" when the timestamp is
 * missing/invalid.
 */
function buildFabricUpdatedSubtitle(
	updatedAt: string | Date | null | undefined,
	author: string | null,
	hasSource: boolean,
): string {
	let timePart = "Updated date unavailable";
	if (updatedAt) {
		const parsed = new Date(updatedAt);
		if (!Number.isNaN(parsed.getTime())) {
			timePart = `Updated ${format(parsed, "MMM d, yyyy, HH:mm")}`;
		}
	}
	if (author) {
		return `${timePart} by ${author}`;
	}
	if (hasSource) {
		return timePart;
	}
	return `${timePart} · Author unavailable`;
}

/**
 * PM-side metadata line. Mirrors the Fabric column's "Updated {when} by
 * {who}" wording so both columns read the same way. When either piece is
 * missing it degrades to explicit fallbacks ("Author unavailable" / "Updated
 * date unavailable") instead of returning blank, so the line is never empty
 * once a PM version is displayed. The PM tool name is rendered on its own row
 * (the column's source slot) so it lines up with the Fabric side's source row.
 */
function buildLastChangedSubtitle(args: {
	lastChangedBy: string | null;
	lastChangedAt: string | null;
}): string {
	const { lastChangedBy, lastChangedAt } = args;

	let when = "";
	if (lastChangedAt) {
		const parsed = new Date(lastChangedAt);
		if (!Number.isNaN(parsed.getTime())) {
			when = format(parsed, "MMM d, yyyy, HH:mm");
		}
	}

	// Happy path: same "Updated {when} by {who}" order as the Fabric column.
	if (lastChangedBy && when) {
		return `Updated ${when} by ${lastChangedBy}`;
	}
	// Partial / missing metadata: surface explicit fallbacks (AC5).
	const dateText = when ? `Updated ${when}` : "Updated date unavailable";
	const authorText = lastChangedBy
		? `by ${lastChangedBy}`
		: "Author unavailable";
	return `${dateText} · ${authorText}`;
}

/**
 * Word-level diff highlight for a single field. `against` is the comparison
 * baseline; `value` is the side being rendered. Tokens are highlighted with
 * the warm-neutral design tokens (`--mkt-diff-add` / `--mkt-diff-del`) used
 * across the marketing diff surfaces — no hardcoded hex.
 *
 * `mode="added"` highlights tokens present in `value` but not `against`;
 * `mode="removed"` highlights tokens removed from `value` relative to `against`.
 */
function WordDiff({
	value,
	against,
	mode,
}: {
	value: string;
	against: string;
	mode: "added" | "removed";
}): ReactNode {
	const parts = useMemo(() => {
		// diffWords(oldStr, newStr): `added` parts are in newStr only,
		// `removed` parts are in oldStr only. To highlight `value` we put it as
		// the side of interest depending on the requested mode.
		if (mode === "added") {
			return diffWords(against, value);
		}
		return diffWords(value, against);
	}, [value, against, mode]);

	if (!value) {
		return (
			<span className="italic text-muted-foreground">
				{EMPTY_PLACEHOLDER}
			</span>
		);
	}

	return (
		<>
			{parts.map((part, index) => {
				// In "added" mode we render newStr tokens: skip `removed`
				// (baseline-only) tokens, highlight `added` ones.
				// In "removed" mode `value` is the OLD side, so highlight
				// `removed` tokens and skip `added` (baseline-only) ones.
				if (mode === "added" && part.removed) {
					return null;
				}
				if (mode === "removed" && part.added) {
					return null;
				}
				const isChanged = mode === "added" ? part.added : part.removed;
				// Diff parts are derived fresh from the inputs on every render and
				// never reordered, so a positional + flag composite key is stable.
				const key = `${index}:${part.added ? "a" : part.removed ? "r" : "u"}`;
				if (!isChanged) {
					return <span key={key}>{part.value}</span>;
				}
				return (
					<mark
						key={key}
						// `text-foreground` is required: a bare <mark> inherits the
						// UA-default (dark) text color, which is unreadable on the
						// dark-theme diff tint. This keeps marked text legible in
						// both themes.
						className={cn(
							"rounded-[2px] px-0.5 text-foreground",
							mode === "added"
								? "bg-[var(--mkt-diff-add)]"
								: "bg-[var(--mkt-diff-del)]",
						)}
					>
						{part.value}
					</mark>
				);
			})}
		</>
	);
}

function FieldLabel({ children }: { children: ReactNode }) {
	return (
		<span className="block text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
			{children}
		</span>
	);
}

/**
 * A read-only diff column (Fabric or PM). Title and description are both
 * word-diffed against the opposite side.
 */
function DiffColumn({
	editorialLabel,
	meta,
	sourceLabel,
	wordCount,
	title,
	description,
	compareTitle,
	compareDescription,
	mode,
}: {
	editorialLabel: string;
	/** Read-only "Last changed by … / Updated …" reference line under the label. */
	meta?: string | null;
	/**
	 * Provenance label, rendered on its own row so both columns keep the same
	 * header height (and therefore align row-for-row below). Fabric supplies an
	 * edit source ("Manual edit", "Pulled from {tool}", …); the PM column
	 * supplies the PM tool name. Empty/missing values still reserve the row.
	 */
	sourceLabel?: string;
	/** Combined word count of title + description for this side. */
	wordCount: number;
	title: string;
	description: string;
	compareTitle: string;
	compareDescription: string;
	mode: "added" | "removed";
}) {
	return (
		<section
			aria-label={editorialLabel}
			className="flex flex-col rounded-md border border-border bg-muted/40 p-4"
		>
			<span className="editorial-label">{editorialLabel}</span>
			{/* Three fixed header rows on every column — reference line, source,
			    and word count — truncated to one line each so a long value (e.g.
			    a long PM author + timestamp) can't wrap and push the title /
			    description below out of alignment with the other column; the full
			    text stays available via the title tooltip. A missing value
			    renders a non-breaking space so its row is still reserved. */}
			<p
				className="mt-1 truncate text-xs text-muted-foreground"
				title={meta || undefined}
			>
				{meta || "\u00A0"}
			</p>
			<p
				className="mt-1 truncate text-xs text-muted-foreground"
				title={sourceLabel || undefined}
			>
				{sourceLabel || "\u00A0"}
			</p>
			<p className="mt-1 truncate text-xs text-muted-foreground">
				{formatWordCount(wordCount)}
			</p>
			<div className="mt-3 space-y-3">
				<div className="space-y-1">
					<FieldLabel>Title</FieldLabel>
					<p className="whitespace-pre-wrap break-words text-sm text-foreground">
						<WordDiff
							value={title}
							against={compareTitle}
							mode={mode}
						/>
					</p>
				</div>
				<div className="space-y-1">
					<FieldLabel>Description</FieldLabel>
					<p className="whitespace-pre-wrap break-words text-sm text-foreground">
						<WordDiff
							value={description}
							against={compareDescription}
							mode={mode}
						/>
					</p>
				</div>
			</div>
		</section>
	);
}

/**
 * Single canonical PM-sync conflict resolve modal.
 *
 * Default 2-column diff (Fabric vs PM). When AI merge is requested, expands to
 * a 3-column view with an EDITABLE middle column (the AI-refined description).
 * The merge is advisory — nothing is applied until the user explicitly Accepts
 * (`ai/ai-copy-tone.md`). See the PROP CONTRACT block above for caller wiring.
 */
export function ConflictResolveDialog(props: ConflictResolveDialogProps) {
	const {
		open,
		onOpenChange,
		projectId,
		organizationId,
		itemType,
		entityId,
		fabricTitle,
		fabricDescription,
		fabricUpdatedAt,
		fabricAuthor,
		fabricSource,
		identifier,
		preview: providedPreview,
		onResolved,
		settingsHref,
		mode = "push-conflict",
		pendingChangeId,
	} = props;

	const isPullDrift = mode === "pull-drift";

	const [preview, setPreview] = useState<ConflictPreview | null>(
		providedPreview ?? null,
	);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);

	const [submitting, setSubmitting] = useState<
		Resolution | "accept" | ContentDriftOutcome | null
	>(null);

	const [mergeActive, setMergeActive] = useState(false);
	const [mergeState, setMergeState] = useState<MergeState>({
		status: "idle",
	});
	const [mergedText, setMergedText] = useState("");
	const [mergedTitle, setMergedTitle] = useState("");
	const [mergeEdited, setMergeEdited] = useState(false);
	const [confirmRegen, setConfirmRegen] = useState(false);
	// Pull-drift "Use Fabric" overwrites the PM tool — gate it behind an
	// explicit confirmation so the user understands the PM tool's change is
	// discarded.
	const [confirmKeepFabric, setConfirmKeepFabric] = useState(false);

	const mergeTextareaRef = useRef<HTMLTextAreaElement>(null);

	// Reset transient state whenever the dialog is (re)opened, and adopt a
	// freshly-provided preview.
	useEffect(() => {
		if (open) {
			setPreview(providedPreview ?? null);
			setPreviewError(null);
			setMergeActive(false);
			setMergeState({ status: "idle" });
			setMergedText("");
			setMergedTitle("");
			setMergeEdited(false);
			setConfirmRegen(false);
			setConfirmKeepFabric(false);
			setSubmitting(null);
		}
	}, [open, providedPreview]);

	// Fetch the single-item preview when the caller did not supply one.
	useEffect(() => {
		if (!open || providedPreview) {
			return;
		}
		let cancelled = false;
		setPreviewLoading(true);
		setPreviewError(null);
		orpcClient.projects.stories
			.checkPmSyncConflicts({
				projectId,
				organizationId,
				items: [{ id: entityId, itemType }],
			})
			.then((res) => {
				if (cancelled) {
					return;
				}
				const result = res.results[0];
				// The current user's PM connection couldn't load the PM side
				// (credentials missing/expired, no board access, …). Show the
				// actionable error instead of a blank diff.
				if (result?.pmError) {
					setPreview({
						pmTool: result.pmTool ?? null,
						pmError: result.pmError,
					});
					return;
				}
				// Pull-drift adopts the live ADO content whenever the preview can
				// read it — the poll already stamped the push baseline, so
				// `hasConflict` is often false even though ADO genuinely diverged.
				// Push-conflict keeps its stricter `hasConflict` gate.
				if (result?.pmCurrent && (isPullDrift || result.hasConflict)) {
					setPreview({
						pmCurrent: result.pmCurrent,
						pmUrl: result.pmUrl,
						pmTool: result.pmTool,
					});
				} else {
					// No live conflict detected — still allow resolving, but with
					// an empty PM side so the buttons remain usable.
					setPreview({
						pmCurrent: {
							title: "",
							description: "",
							lastChangedBy: null,
							lastChangedAt: null,
						},
						pmUrl: result?.pmUrl,
						pmTool: result?.pmTool ?? null,
					});
				}
			})
			.catch(() => {
				if (!cancelled) {
					setPreviewError(
						"Couldn't load the conflicting versions. Try again.",
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setPreviewLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		open,
		providedPreview,
		projectId,
		organizationId,
		entityId,
		itemType,
		isPullDrift,
	]);

	const pmError = preview?.pmError ?? null;
	const pmCurrent = preview?.pmCurrent;
	const pmTitle = pmCurrent?.title ?? "";
	// PM HTML → markdown so the diff (and the AI merge below) compare like-for-
	// like with Fabric's markdown. The Fabric side is the source of truth and is
	// deliberately NOT normalized — it is already markdown; the asymmetry is the
	// point (the PM side is being reconciled into Fabric's format, not vice
	// versa). Flows to both DiffColumn and `proposeAiMerge` via this one value.
	const pmDescription = useMemo(
		() => normalizeDescriptionToMarkdown(pmCurrent?.description ?? ""),
		[pmCurrent?.description],
	);

	// Nothing for AI to reconcile only when BOTH sides match. A title-only or
	// description-only divergence is still mergeable (the merge covers both).
	const bothIdentical =
		fabricTitle === pmTitle && fabricDescription === pmDescription;

	// Per-column read-only reference metadata (author/timestamp/source) so the
	// user can see which side changed when, by whom, and where the change came
	// from. PM side carries author + timestamp; Fabric side now carries author +
	// timestamp + a provenance "source" element.
	const pmMeta = pmCurrent
		? buildLastChangedSubtitle({
				lastChangedBy: pmCurrent.lastChangedBy,
				lastChangedAt: pmCurrent.lastChangedAt,
			})
		: null;
	const fabricMeta = buildFabricUpdatedSubtitle(
		fabricUpdatedAt,
		fabricAuthor ?? null,
		fabricSource != null,
	);
	const fabricSourceLabel = formatLastEditSource(
		fabricSource ?? null,
		formatPmToolLabel(preview?.pmTool ?? null),
	);
	// PM has no edit-source concept — its source row carries the PM tool name so
	// it lines up with the Fabric side's "Manual edit" / source row.
	const pmSourceLabel = formatPmToolLabel(preview?.pmTool ?? null) ?? "";
	const fabricWordCount = countWords(fabricTitle, fabricDescription);
	const pmWordCount = countWords(pmTitle, pmDescription);

	const isBusy = submitting !== null;

	const resolve = async (
		resolution: Resolution,
		override?: { title: string; description: string },
	) => {
		setSubmitting(override !== undefined ? "accept" : resolution);
		try {
			// `resolveConflict` resolves the tenant scope server-side from the
			// session, so its input takes no `organizationId` (unlike the
			// preview / proposeAiMerge calls below).
			const res = await orpcClient.projects.stories.resolveConflict({
				projectId,
				itemId: entityId,
				itemType,
				resolution,
				...(override !== undefined
					? {
							overrideTitle: override.title,
							overrideDescription: override.description,
						}
					: {}),
			});
			if (!res.cleared) {
				// The resolution couldn't be synced (e.g. the user's own PM
				// connection is missing/expired). Surface the typed error in the
				// dialog instead of a false success — the conflict stays flagged.
				if (res.pmError) {
					setPreview((prev) => ({
						pmTool: prev?.pmTool ?? null,
						pmError: res.pmError,
					}));
				}
				toast.error(
					res.pmError
						? pmSyncErrorCopy(
								res.pmError.kind,
								preview?.pmTool ?? null,
							).title
						: "Couldn't sync the resolution. Try again.",
				);
				return;
			}
			toast.success(
				resolution === "REMOTE"
					? "Conflict cleared — pull from your PM tool to apply its version"
					: override !== undefined
						? "Pushing the merged version to your PM tool"
						: "Pushing the Fabric version to your PM tool",
			);
			onResolved?.();
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to resolve conflict",
			);
		} finally {
			setSubmitting(null);
		}
	};

	const driftSuccessToast: Record<ContentDriftOutcome, string> = {
		APPLY_ADO: "Applying the PM tool's version to Fabric",
		KEEP_FABRIC: "Pushing the Fabric version to your PM tool",
		AI_MERGE: "Pushing the merged version to your PM tool",
		DISMISS: "Dismissed — both sides left unchanged",
	};

	const resolveDrift = async (
		outcome: ContentDriftOutcome,
		override?: { title: string; description: string },
	) => {
		if (!pendingChangeId) {
			toast.error(
				"Missing the review item reference. Refresh and retry.",
			);
			return;
		}
		setSubmitting(outcome);
		try {
			await orpcClient.projects.pmStateChanges.resolveContentDrift({
				projectId,
				id: pendingChangeId,
				organizationId,
				outcome,
				...(outcome === "AI_MERGE" && override !== undefined
					? {
							overrideTitle: override.title,
							overrideDescription: override.description,
						}
					: {}),
			});
			toast.success(driftSuccessToast[outcome]);
			onResolved?.();
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to resolve content drift",
			);
		} finally {
			setSubmitting(null);
		}
	};

	const runMerge = async () => {
		setMergeActive(true);
		setConfirmRegen(false);
		setMergeState({ status: "loading" });
		try {
			const { mergedTitle, mergedDescription, truncated } =
				await orpcClient.projects.stories.proposeAiMerge({
					projectId,
					itemId: entityId,
					itemType,
					organizationId,
					fabricTitle,
					pmTitle,
					fabricDescription,
					pmDescription,
				});
			setMergedTitle(mergedTitle);
			setMergedText(mergedDescription);
			setMergeEdited(false);
			setMergeState({ status: "ready", truncated });
		} catch {
			setMergeState({ status: "error" });
		}
	};

	const handleRegenerateClick = () => {
		if (mergeEdited && mergeState.status === "ready") {
			setConfirmRegen(true);
			return;
		}
		void runMerge();
	};

	const showThreeColumns = mergeActive;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className={cn(
					"bg-card border border-border transition-[max-width] duration-200 motion-reduce:transition-none",
					// Bounded flex column: the body scrolls while the action footer
					// stays pinned (overrides the shared dialog default's `grid` +
					// `overflow-y-auto`, which scroll the whole dialog and push the
					// resolution actions off-screen).
					"flex max-h-[90vh] flex-col overflow-hidden",
					// Wider than the shared dialog default so three rich-text
					// columns (Fabric / AI-refined / PM) are legible side by side
					// instead of narrow scroll strips. Capped at the viewport so
					// it never overflows on smaller laptops.
					showThreeColumns
						? "max-w-[min(96vw,1500px)]"
						: "max-w-[min(92vw,1024px)]",
				)}
				onInteractOutside={(e) => {
					if (isBusy || mergeState.status === "loading") {
						e.preventDefault();
					}
				}}
			>
				<DialogHeader className="space-y-1.5">
					<DialogTitle
						className="font-normal text-2xl"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						{identifier ? (
							<span className="mr-2 align-middle font-sans text-sm font-medium tracking-wide text-muted-foreground">
								{identifier}
							</span>
						) : null}
						{fabricTitle}
					</DialogTitle>
					<DialogDescription className="text-sm text-muted-foreground">
						{isPullDrift
							? "This item's content changed in your linked PM tool since the last sync. Choose how to reconcile it with Fabric."
							: "This item changed in both Fabric and your linked PM tool since the last sync. Choose which version to keep."}
					</DialogDescription>
				</DialogHeader>

				{/* Scrollable body — the ONLY scroll region; the footer below stays pinned. */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{previewLoading ? (
						<div
							className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
							aria-live="polite"
						>
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Loading the conflicting versions…
						</div>
					) : pmError ? (
						<PmSyncErrorPanel
							error={pmError}
							pmTool={preview?.pmTool ?? null}
							settingsHref={settingsHref}
							className="my-2"
						/>
					) : previewError ? (
						<div className="py-8 text-center" aria-live="polite">
							<p className="text-sm text-muted-foreground">
								{previewError}
							</p>
						</div>
					) : (
						<div
							className={cn(
								"grid grid-cols-1 gap-4",
								showThreeColumns
									? "md:grid-cols-3"
									: "md:grid-cols-2",
							)}
						>
							<DiffColumn
								editorialLabel="FABRIC"
								meta={fabricMeta}
								sourceLabel={fabricSourceLabel}
								wordCount={fabricWordCount}
								title={fabricTitle}
								description={fabricDescription}
								compareTitle={pmTitle}
								compareDescription={pmDescription}
								mode="added"
							/>

							{showThreeColumns ? (
								<MergeColumn
									state={mergeState}
									value={mergedText}
									titleValue={mergedTitle}
									confirmRegen={confirmRegen}
									editable={mergeState.status === "ready"}
									textareaRef={mergeTextareaRef}
									onChange={(next) => {
										setMergedText(next);
										setMergeEdited(true);
									}}
									onTitleChange={(next) => {
										setMergedTitle(next);
										setMergeEdited(true);
									}}
									onRetry={() => void runMerge()}
									onConfirmRegen={() => void runMerge()}
									onCancelRegen={() => setConfirmRegen(false)}
								/>
							) : null}

							<DiffColumn
								editorialLabel="PM TOOL"
								meta={pmMeta}
								sourceLabel={pmSourceLabel}
								wordCount={pmWordCount}
								title={pmTitle}
								description={pmDescription}
								compareTitle={fabricTitle}
								compareDescription={fabricDescription}
								mode="removed"
							/>
						</div>
					)}
				</div>

				{/* Pinned footer — always visible without scrolling (AC1/AC2). */}
				<div className="flex shrink-0 flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-end">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onOpenChange(false)}
						disabled={isBusy}
					>
						Cancel
					</Button>

					{pmError ? null : mergeActive ? (
						<>
							<RegenerateButton
								onClick={handleRegenerateClick}
								disabled={
									isBusy || mergeState.status === "loading"
								}
								loading={mergeState.status === "loading"}
							/>
							<Button
								size="sm"
								onClick={() => {
									const override = {
										title: mergedTitle,
										description: mergedText,
									};
									isPullDrift
										? void resolveDrift(
												"AI_MERGE",
												override,
											)
										: void resolve("LOCAL", override);
								}}
								disabled={
									isBusy ||
									mergeState.status !== "ready" ||
									mergeState.truncated ||
									mergedText.trim().length === 0 ||
									mergedTitle.trim().length === 0
								}
							>
								{submitting === "accept" ||
								submitting === "AI_MERGE"
									? "Accepting…"
									: "Accept merge"}
							</Button>
						</>
					) : (
						<Tooltip>
							<TooltipTrigger asChild>
								{/* span wrapper keeps the tooltip reachable when the button is disabled */}
								<span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => void runMerge()}
										disabled={
											isBusy ||
											bothIdentical ||
											previewLoading ||
											!!previewError
										}
									>
										<SparklesIcon
											className="size-3.5 mr-1.5"
											aria-hidden="true"
										/>
										AI merge
									</Button>
								</span>
							</TooltipTrigger>
							{bothIdentical ? (
								<TooltipContent>
									Both sides match — there's nothing to merge.
								</TooltipContent>
							) : (
								<TooltipContent>
									Suggest a merged title and description you
									can review and edit before accepting.
								</TooltipContent>
							)}
						</Tooltip>
					)}

					{pmError ? null : isPullDrift ? (
						// Aligned with the push-conflict footer below: same
						// "Use PM" (take the PM version → APPLY_ADO) / "Use
						// Fabric" (push Fabric, overwrite PM → KEEP_FABRIC)
						// labels, order, and variants. "Use Fabric" keeps the
						// overwrite-confirm guard since it discards a PM edit.
						<>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => void resolveDrift("APPLY_ADO")}
								disabled={
									isBusy || previewLoading || !!previewError
								}
							>
								{submitting === "APPLY_ADO"
									? "Applying…"
									: "Use PM"}
							</Button>
							<Button
								size="sm"
								onClick={() => setConfirmKeepFabric(true)}
								disabled={
									isBusy || previewLoading || !!previewError
								}
							>
								{submitting === "KEEP_FABRIC"
									? "Pushing…"
									: "Use Fabric"}
							</Button>
						</>
					) : (
						<>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => void resolve("REMOTE")}
								disabled={
									isBusy || previewLoading || !!previewError
								}
							>
								{submitting === "REMOTE"
									? "Clearing…"
									: "Use PM"}
							</Button>
							<Button
								size="sm"
								onClick={() => void resolve("LOCAL")}
								disabled={
									isBusy || previewLoading || !!previewError
								}
							>
								{submitting === "LOCAL"
									? "Pushing…"
									: "Use Fabric"}
							</Button>
						</>
					)}
				</div>

				{isPullDrift && confirmKeepFabric ? (
					<div
						role="alertdialog"
						aria-label="Confirm use Fabric"
						aria-describedby="keep-fabric-overwrite-warning"
						className="shrink-0 rounded-md border border-highlight/50 bg-highlight/10 p-3"
					>
						<p
							id="keep-fabric-overwrite-warning"
							className="text-sm text-foreground"
						>
							Using Fabric will push Fabric's version back to your
							PM tool and overwrite the change made there. The PM
							tool's edit will be discarded.
						</p>
						<div className="mt-3 flex justify-end gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setConfirmKeepFabric(false)}
								disabled={isBusy}
							>
								Go back
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => {
									setConfirmKeepFabric(false);
									void resolveDrift("KEEP_FABRIC");
								}}
								disabled={isBusy}
							>
								Overwrite the PM tool
							</Button>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function RegenerateButton({
	onClick,
	disabled,
	loading,
}: {
	onClick: () => void;
	disabled: boolean;
	loading: boolean;
}) {
	return (
		<Button
			variant="outline"
			size="sm"
			onClick={onClick}
			disabled={disabled}
		>
			{loading ? (
				<Loader2Icon
					className="size-3.5 mr-1.5 motion-safe:animate-spin"
					aria-hidden="true"
				/>
			) : (
				<SparklesIcon className="size-3.5 mr-1.5" aria-hidden="true" />
			)}
			Regenerate
		</Button>
	);
}

/**
 * Editable AI-refined middle column. Handles its own loading / error / ready
 * states inline (no toast, no teardown) so the binary Use Fabric / Use PM
 * actions remain available even when the merge fails.
 */
function MergeColumn({
	state,
	value,
	titleValue,
	editable,
	confirmRegen,
	textareaRef,
	onChange,
	onTitleChange,
	onRetry,
	onConfirmRegen,
	onCancelRegen,
}: {
	state: MergeState;
	value: string;
	titleValue: string;
	editable: boolean;
	confirmRegen: boolean;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	onChange: (next: string) => void;
	onTitleChange: (next: string) => void;
	onRetry: () => void;
	onConfirmRegen: () => void;
	onCancelRegen: () => void;
}) {
	// The model stopped on its output-token limit — the draft is cut off.
	const truncated = state.status === "ready" && state.truncated;
	return (
		<section
			aria-label="AI-refined title and description"
			className="flex flex-col rounded-md border border-primary/40 bg-muted/40 p-4"
		>
			<span className="editorial-label">AI-REFINED</span>

			{state.status === "loading" ? (
				<div
					className="mt-3 flex flex-1 flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
					aria-live="polite"
				>
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					Drafting a merged description…
				</div>
			) : state.status === "error" ? (
				<div
					className="mt-3 flex flex-1 flex-col items-start justify-center gap-3 py-8 text-sm"
					aria-live="polite"
				>
					<p className="text-muted-foreground">
						Couldn't draft a merged description.
					</p>
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</div>
			) : (
				<div className="mt-3 space-y-2">
					{truncated ? (
						<p
							className="rounded-md border border-highlight/50 bg-highlight/10 p-2 text-xs text-foreground"
							role="alert"
						>
							This merge was cut off before it finished, so it's
							incomplete and can't be accepted. Regenerate for a
							complete merge, or pick a side with Use Fabric / Use
							PM.
						</p>
					) : null}
					<p className="text-xs text-muted-foreground">
						{formatWordCount(countWords(titleValue, value))}
					</p>
					<FieldLabel>Title</FieldLabel>
					<Input
						value={titleValue}
						onChange={(e) => onTitleChange(e.target.value)}
						readOnly={!editable}
						aria-label="AI-refined merged title"
						className="bg-background text-sm"
					/>
					<FieldLabel>Description</FieldLabel>
					<Textarea
						ref={textareaRef}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						readOnly={!editable}
						aria-label="AI-refined merged description"
						className="min-h-[50vh] resize-y bg-background text-sm"
					/>
					{confirmRegen ? (
						<div
							className="rounded-md border border-border bg-card p-2 text-xs"
							role="alertdialog"
							aria-label="Confirm regenerate"
						>
							<p className="text-muted-foreground">
								Regenerating replaces your edits. Continue?
							</p>
							<div className="mt-2 flex justify-end gap-2">
								<Button
									variant="ghost"
									size="sm"
									onClick={onCancelRegen}
								>
									Keep my edits
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={onConfirmRegen}
								>
									Regenerate anyway
								</Button>
							</div>
						</div>
					) : null}
				</div>
			)}
		</section>
	);
}

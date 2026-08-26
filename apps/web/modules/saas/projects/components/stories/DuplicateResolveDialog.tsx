"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { resolveStoryImageUrls } from "@saas/projects/lib/image-upload-utils";
import {
	MessageAttachmentList,
	type MessageAttachmentListItem,
} from "@saas/shared/components/copilot/MessageAttachmentList";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { diffWords } from "diff";
import {
	AlertTriangleIcon,
	ExternalLinkIcon,
	InfoIcon,
	Link2Icon,
	Loader2Icon,
	RotateCwIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatLastEditSource } from "../../lib/last-edit-source-copy";
import { STORY_SOURCE_LABELS } from "../../lib/roadmap-filters";
import {
	classifyMergeLinkScenario,
	derivePmLinkState,
} from "../../lib/stories/duplicate-link";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import {
	DRAFTING_STAGE_META,
	dbSourceToFe,
	type FeatureDraftingStage,
} from "../../lib/stories/types";
import { getPmToolBrandIcon } from "./pm-sync/pm-tool-brand-icon";

/** One side of a flagged duplicate pair (shape from `listPendingDuplicateLinks`). */
export type DuplicateLinkStory = {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	kind: string;
	draftingStage: string;
	// PM-tool link state (from the extended `STORY_SUMMARY_SELECT`). Date fields
	// are `Date | string | null` so this hand-written type matches the
	// list-duplicates payload whether oRPC delivers Date objects or ISO strings.
	externalId: string | null;
	externalUrl: string | null;
	externalMcpServerId: string | null;
	pmAutoSyncEnabled: boolean;
	lastPmSyncStatus: string | null;
	lastSyncedAt: Date | string | null;
	createdAt: Date | string | null;
	// Per-column metadata strip (from the extended `STORY_SUMMARY_SELECT` +
	// server-resolved author name). `source` is the raw Prisma `StorySource`
	// enum string; `createdByName` is resolved server-side because UserStory has
	// no creator relation. Word count is derived client-side from `description`.
	lastEditedAt: Date | string | null;
	lastEditedByName: string | null;
	lastEditedSource:
		| "MANUAL"
		| "AI_BACKLOG_UPDATE"
		| "AI_MATURATION"
		| "CONFLICT_RESOLUTION"
		| "PM_PULL"
		| null;
	source: string;
	createdById: string;
	reporterName: string | null;
	createdByName: string | null;
};

export type DuplicateLink = {
	id: string;
	similarity: number;
	confidence: number;
	reasoning: string | null;
	/** "DUPLICATE" (same underlying work item) or "OVERLAP" (overlapping
	 * scope — same feature area, different framing; needs human review). A
	 * plain string so the hand-written type matches the list-duplicates
	 * payload's Prisma enum value. */
	linkType: string;
	storyA: DuplicateLinkStory;
	storyB: DuplicateLinkStory;
};

export type DuplicateResolveDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId: string | null;
	link: DuplicateLink | null;
	/** Fired after a successful merge/dismiss so the caller can invalidate its
	 * own queries (mirrors ConflictResolveDialog — the dialog never invalidates
	 * itself). */
	onResolved?: () => void;
};

/** The AI-combined draft for one survivor↔duplicate orientation. */
type Proposal = {
	description: string;
	acceptanceCriteria: string;
	truncated: boolean;
};

/** Which content a card is showing: its own raw text, or the AI-combined merge
 * that keeps that card as the survivor. */
type CardMode = "original" | "ai";

const HTML_TAG_RE = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/gi;
const STORY_MEDIA_KEY_RE = /story-media\/[^\s"'()<>]+/g;
const EMPTY_PLACEHOLDER = "—";

/**
 * Full plain-text of a story field (plain text/markdown, HTML, or TipTap JSON).
 * Preserves line breaks; feeds the diff columns. Never throws.
 */
function toPlainText(value: string | null): string {
	if (!value) {
		return "";
	}
	let text = value.trim();
	if (text.startsWith("{") || text.startsWith("[")) {
		try {
			const parts: string[] = [];
			const walk = (node: unknown): void => {
				if (!node || typeof node !== "object") {
					return;
				}
				const record = node as Record<string, unknown>;
				if (typeof record.text === "string") {
					parts.push(record.text);
				}
				for (const v of Object.values(record)) {
					if (Array.isArray(v)) {
						for (const child of v) {
							walk(child);
						}
					} else if (v && typeof v === "object") {
						walk(v);
					}
				}
			};
			walk(JSON.parse(text));
			if (parts.length > 0) {
				text = parts.join("\n");
			}
		} catch {
			// not JSON after all — fall through to tag-strip
		}
	}
	text = text
		.replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|tr)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(HTML_TAG_RE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text;
}

/** Extract `story-media/...` S3 keys referenced in a story's description. */
function extractMediaKeys(description: string | null): string[] {
	if (!description) {
		return [];
	}
	const seen = new Set<string>();
	for (const m of description.matchAll(STORY_MEDIA_KEY_RE)) {
		const key = m[0].replace(/[)\].,]+$/, "");
		if (key.startsWith("story-media/")) {
			seen.add(key);
		}
	}
	return [...seen];
}

/**
 * Word-level diff highlight, mirroring the PM-sync ConflictResolveDialog so the
 * two merge surfaces look identical. `mode="added"` highlights tokens present in
 * `value` but not `against`. Uses the theme-aware design tokens
 * (`--mkt-diff-add` / `--mkt-diff-del`, correct in light AND dark) with
 * `text-foreground` so marked text stays legible on the dark tint.
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
	const parts = useMemo(
		() =>
			mode === "added"
				? diffWords(against, value)
				: diffWords(value, against),
		[value, against, mode],
	);

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
				if (mode === "added" && part.removed) {
					return null;
				}
				if (mode === "removed" && part.added) {
					return null;
				}
				const isChanged = mode === "added" ? part.added : part.removed;
				const key = `${index}:${part.added ? "a" : part.removed ? "r" : "u"}`;
				if (!isChanged) {
					return <span key={key}>{part.value}</span>;
				}
				return (
					<mark
						key={key}
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

/**
 * The work item's type, shown on its own panel (Fizzy #2048).
 *
 * The survivor's type is not cosmetic here: the server resolves the merge
 * template from the surviving row's stored kind, so on a mixed pair the panel
 * the user merges from decides the shape of the combined body. Before this the
 * two panels were symmetric and the type was nowhere on screen.
 *
 * The word itself carries the meaning — no colour-coding to decode (WCAG 1.4.1)
 * and no new palette. `role="img"` + `aria-label` name the item the type belongs
 * to, so a screen reader never reads a bare "Bug" with no referent.
 */
function KindBadge({
	story,
	t,
}: {
	story: DuplicateLinkStory;
	t: ReturnType<typeof useTranslations>;
}) {
	const label = story.kind === "BUG" ? t("typeBug") : t("typeFeature");
	return (
		<span
			role="img"
			aria-label={t("typeAria", {
				identifier: story.identifier,
				kind: label,
			})}
			className="inline-flex shrink-0 items-center rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
		>
			{label}
		</span>
	);
}

function FieldLabel({ children }: { children: ReactNode }) {
	return (
		<span className="block text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
			{children}
		</span>
	);
}

/** Compact per-column metadata strip shown under the title: created / updated
 * dates, author, source, drafting stage, and a derived word count. Source and
 * stage reuse the roadmap's label maps; a missing author / source / stage is
 * omitted (never a dangling label). Pure presentational, design-token styling. */
function TicketMetaStrip({
	story,
	t,
}: {
	story: DuplicateLinkStory;
	t: ReturnType<typeof useTranslations>;
}) {
	const createdLocal = formatLocalDateTime(story.createdAt);
	const createdUtc = formatUtcClock(story.createdAt);
	const updatedLocal = formatLocalDateTime(story.lastEditedAt);
	const updatedUtc = formatUtcClock(story.lastEditedAt);
	const edited = story.lastEditedAt != null;
	const author = edited
		? story.lastEditedByName
		: (story.createdByName ?? story.reporterName ?? null);
	const sourceLabel = edited
		? formatLastEditSource(story.lastEditedSource, null)
		: (STORY_SOURCE_LABELS[dbSourceToFe(story.source)] ?? null);
	const stageLabel =
		DRAFTING_STAGE_META[story.draftingStage as FeatureDraftingStage]
			?.label ?? null;
	const wordCount = useMemo(() => {
		const text = toPlainText(story.description).trim();
		return text.length === 0 ? 0 : text.split(/\s+/).length;
	}, [story.description]);

	// Main view shows the last-updated date (in the viewer's local time), falling
	// back to the creation date when the item was never edited.
	const primaryDate = edited ? updatedLocal : createdLocal;
	const primary = primaryDate
		? edited
			? t("metaUpdated", { date: primaryDate })
			: t("metaCreated", { date: primaryDate })
		: null;

	// Concise inline chips; the labelled breakdown lives in the hover tooltip.
	const inline: { key: string; node: ReactNode }[] = [];
	if (primary) {
		inline.push({ key: "primary", node: primary });
	}
	if (author) {
		inline.push({ key: "author", node: t("metaByAuthor", { author }) });
	}
	if (sourceLabel) {
		inline.push({ key: "source", node: sourceLabel });
	}
	if (stageLabel) {
		inline.push({ key: "stage", node: stageLabel });
	}
	inline.push({ key: "words", node: t("metaWords", { count: wordCount }) });

	// Date value with both the local time and the UTC clock, so a distributed
	// team reads the same instant regardless of timezone.
	const dateValue = (local: string, utc: string | null): ReactNode => (
		<>
			{local}
			{utc ? (
				<span className="text-muted-foreground">
					{" · "}
					{t("metaUtcSuffix", { time: utc })}
				</span>
			) : null}
		</>
	);

	const rows: { key: string; label: string; value: ReactNode }[] = [];
	if (createdLocal) {
		rows.push({
			key: "created",
			label: t("metaLabelCreated"),
			value: dateValue(createdLocal, createdUtc),
		});
	}
	rows.push({
		key: "updated",
		label: t("metaLabelUpdated"),
		value:
			edited && updatedLocal ? (
				dateValue(updatedLocal, updatedUtc)
			) : (
				<span className="text-muted-foreground">
					{t("metaNeverEdited")}
				</span>
			),
	});
	if (author) {
		rows.push({
			key: "author",
			label: t("metaLabelAuthor"),
			value: author,
		});
	}
	if (sourceLabel) {
		rows.push({
			key: "source",
			label: t("metaLabelSource"),
			value: sourceLabel,
		});
	}
	if (stageLabel) {
		rows.push({
			key: "stage",
			label: t("metaLabelStage"),
			value: stageLabel,
		});
	}
	rows.push({
		key: "words",
		label: t("metaLabelWords"),
		value: String(wordCount),
	});

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={t("metaDetailsAria", {
						identifier: story.identifier,
					})}
					className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-left text-[11px] leading-relaxed text-muted-foreground"
				>
					{inline.map((item, index) => (
						<span
							key={item.key}
							className="inline-flex items-center gap-1.5"
						>
							{index > 0 ? (
								<span
									aria-hidden="true"
									className="text-muted-foreground/40"
								>
									·
								</span>
							) : null}
							<span
								className={
									index === 0
										? "underline decoration-dotted decoration-muted-foreground/50 underline-offset-2"
										: undefined
								}
							>
								{item.node}
							</span>
						</span>
					))}
				</button>
			</TooltipTrigger>
			{/* Rich label/value rows use theme tokens (text-foreground /
			    text-muted-foreground); the default "inverse" surface paints
			    bg-foreground, which makes text-foreground values invisible. The
			    "popover" surface keeps those tokens legible (see TooltipContent). */}
			<TooltipContent
				surface="popover"
				className="max-w-[340px] text-left"
			>
				<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					{rows.map((row) => (
						<div key={row.key} className="contents">
							<span className="font-medium text-muted-foreground">
								{row.label}
							</span>
							<span className="text-foreground">{row.value}</span>
						</div>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

/** Lazily-resolved attachment thumbnails for one story. */
function StoryAttachments({
	projectId,
	organizationId,
	story,
	label,
}: {
	projectId: string;
	organizationId: string | null;
	story: DuplicateLinkStory;
	label: string;
}) {
	const keys = useMemo(
		() => extractMediaKeys(story.description),
		[story.description],
	);
	const [items, setItems] = useState<MessageAttachmentListItem[] | null>(
		null,
	);

	useEffect(() => {
		if (keys.length === 0) {
			setItems([]);
			return;
		}
		let cancelled = false;
		setItems(null);
		void resolveStoryImageUrls({
			projectId,
			userStoryId: story.id,
			organizationId,
			s3Keys: keys,
		})
			.then((urlMap) => {
				if (cancelled) {
					return;
				}
				setItems(
					keys.map((k) => {
						const name = k.split("/").pop() ?? k;
						const isImage =
							/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
						return {
							id: k,
							s3Path: k,
							name,
							kind: isImage ? "image" : "file",
							previewUrl: urlMap[k],
						};
					}),
				);
			})
			.catch(() => {
				if (!cancelled) {
					setItems([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [keys, projectId, organizationId, story.id]);

	if (keys.length === 0) {
		return null;
	}

	return (
		<div className="space-y-1">
			<FieldLabel>{label}</FieldLabel>
			{items === null ? (
				<Loader2Icon
					className="size-3 motion-safe:animate-spin text-muted-foreground"
					aria-hidden="true"
				/>
			) : (
				<MessageAttachmentList attachments={items} align="start" />
			)}
		</div>
	);
}

/** Segmented Original | AI-merge toggle. When AI is active the AI segment also
 * acts as the regenerate control — clicking it again regenerates (showing a
 * spinner while it runs); the ↻ icon signals that. */
function ModeToggle({
	mode,
	loading,
	onOriginal,
	onAiOrRegenerate,
	disabled,
	t,
}: {
	mode: CardMode;
	loading: boolean;
	onOriginal: () => void;
	onAiOrRegenerate: () => void;
	disabled: boolean;
	t: ReturnType<typeof useTranslations>;
}) {
	const tTooltip = useTranslations("tooltips.stories");
	const isAI = mode === "ai";
	// State-specific accessible name (Generating… / Regenerate / switch to AI merge);
	// the tooltip carries the fuller explanation of what the click does.
	const aiTitle = isAI
		? loading
			? t("generating")
			: t("regenerate")
		: t("modeAiTooltip");
	return (
		<div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs">
			<button
				type="button"
				aria-pressed={!isAI}
				disabled={disabled}
				onClick={onOriginal}
				className={cn(
					"rounded-[5px] px-2.5 py-1 font-medium transition-colors disabled:opacity-60",
					!isAI
						? "bg-card text-foreground shadow-sm"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				{t("modeOriginal")}
			</button>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-pressed={isAI}
						disabled={disabled || loading}
						onClick={onAiOrRegenerate}
						aria-label={aiTitle}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 font-medium transition-colors disabled:opacity-60",
							isAI
								? "bg-card text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<SparklesIcon
							className="size-3 text-primary"
							aria-hidden="true"
						/>
						{t("modeAiMerge")}
						{isAI ? (
							loading ? (
								<Loader2Icon
									className="size-3 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<RotateCwIcon
									className="size-3"
									aria-hidden="true"
								/>
							)
						) : null}
					</button>
				</TooltipTrigger>
				<TooltipContent>{tTooltip("aiRegenerateMode")}</TooltipContent>
			</Tooltip>
		</div>
	);
}

/**
 * One ticket panel. Shows the ticket's Original content (word-diffed against the
 * OTHER ticket) or its AI-merged content (word-diffed against this ticket's
 * original). Carries its own mode toggle (with in-button regenerate), an info
 * tooltip, a header "open in Fabric" link, a per-card merge action, and a crop
 * fade when the content overflows. Generation is independent per card.
 */
function TicketPanel({
	story,
	other,
	storyHref,
	mode,
	loading,
	proposal,
	onSetOriginal,
	onAiOrRegenerate,
	onMerge,
	merging,
	disabled,
	projectId,
	organizationId,
	t,
}: {
	story: DuplicateLinkStory;
	other: DuplicateLinkStory;
	storyHref: string;
	mode: CardMode;
	loading: boolean;
	proposal: Proposal | null;
	onSetOriginal: () => void;
	onAiOrRegenerate: () => void;
	onMerge: () => void;
	merging: boolean;
	disabled: boolean;
	projectId: string;
	organizationId: string | null;
	t: ReturnType<typeof useTranslations>;
}) {
	const isAI = mode === "ai";
	const rawDesc = toPlainText(story.description);
	const rawAc = toPlainText(story.acceptanceCriteria);
	const otherDesc = toPlainText(other.description);
	const otherAc = toPlainText(other.acceptanceCriteria);

	const aiUsable =
		proposal !== null &&
		!proposal.truncated &&
		proposal.description.trim().length > 0;

	const mergeLabel = isAI
		? t("mergeKeepCombined", { identifier: story.identifier })
		: t("mergeKeepAsIs", { identifier: story.identifier });
	const mergeDisabled = disabled || loading || (isAI && !aiUsable);

	const legend = isAI
		? t("diffLegendAi", { identifier: story.identifier })
		: t("diffLegendOriginal", {
				identifier: story.identifier,
				other: other.identifier,
			});

	// Only a MIXED pair has anything to say here: the server resolves the merge
	// template from the survivor's stored kind, so on a mixed pair the panel you
	// merge from silently decides the combined body's shape — and that is the one
	// thing the two symmetric panels never told the user. On a same-type pair the
	// sentence would be identical on both sides and carry no information, so it is
	// not rendered (editorial restraint).
	const mergeTypeNote =
		story.kind === other.kind
			? null
			: t(
					story.kind === "BUG"
						? "mergeTypeNoteBug"
						: "mergeTypeNoteFeature",
					{ identifier: story.identifier },
				);

	return (
		<section
			aria-label={story.identifier}
			className="flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-muted/40 p-3 md:flex-1"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="flex min-w-0 items-center gap-2">
					<span className="editorial-label">{story.identifier}</span>
					<KindBadge story={story} t={t} />
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<a
							href={storyHref}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={t("viewInFabricAria", {
								identifier: story.identifier,
							})}
							className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:text-primary"
						>
							<ExternalLinkIcon
								className="size-3.5"
								aria-hidden="true"
							/>
						</a>
					</TooltipTrigger>
					<TooltipContent>
						{t("viewInFabric", { identifier: story.identifier })}
					</TooltipContent>
				</Tooltip>
			</div>
			<p className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
				{story.title}
			</p>

			<TicketMetaStrip story={story} t={t} />

			<PmLinkBadge story={story} t={t} />

			{/* Toggle + info + the diff-highlight key, all on one row so the
			    description below gets more vertical room. */}
			<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
				<ModeToggle
					mode={mode}
					loading={loading}
					onOriginal={onSetOriginal}
					onAiOrRegenerate={onAiOrRegenerate}
					disabled={disabled}
					t={t}
				/>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={t("aiMergeInfoAria")}
							className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-primary"
						>
							<InfoIcon className="size-3.5" aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent className="max-w-[280px] text-left">
						{t("aiMergeInfo", { identifier: story.identifier })}
					</TooltipContent>
				</Tooltip>
				<span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<span
						className={cn(
							"size-3 shrink-0 rounded-[3px] ring-1 ring-inset ring-secondary/40",
							"bg-[var(--mkt-diff-add)]",
						)}
						aria-hidden="true"
					/>
					{legend}
				</span>
			</div>

			{/* Scrollable content — the only scroll region in the panel, so the
			    "Merge — keep this" action below it always stays visible (AC1-AC4). */}
			<div className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
				{isAI ? (
					loading ? (
						<div
							className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
							aria-live="polite"
						>
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							{t("combining")}
						</div>
					) : proposal ? (
						<>
							{proposal.truncated ? (
								<p
									className="rounded-md border border-highlight/50 bg-highlight/10 p-2 text-[11px] text-foreground"
									role="alert"
								>
									{t("combineTruncated")}
								</p>
							) : null}
							<div className="space-y-1">
								<FieldLabel>
									{t("combineDescriptionLabel")}
								</FieldLabel>
								<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
									<WordDiff
										value={proposal.description}
										against={rawDesc}
										mode="added"
									/>
								</p>
							</div>
							<div className="space-y-1">
								<FieldLabel>
									{t("combineAcceptanceLabel")}
								</FieldLabel>
								<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
									<WordDiff
										value={proposal.acceptanceCriteria}
										against={rawAc}
										mode="added"
									/>
								</p>
							</div>
							<StoryAttachments
								projectId={projectId}
								organizationId={organizationId}
								story={story}
								label={t("attachmentsKeptLabel")}
							/>
						</>
					) : (
						<div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-xs text-muted-foreground">
							{t("combineHint", {
								identifier: story.identifier,
							})}
						</div>
					)
				) : (
					<>
						<div className="space-y-1">
							<FieldLabel>
								{t("combineDescriptionLabel")}
							</FieldLabel>
							<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
								<WordDiff
									value={rawDesc}
									against={otherDesc}
									mode="added"
								/>
							</p>
						</div>
						<div className="space-y-1">
							<FieldLabel>
								{t("combineAcceptanceLabel")}
							</FieldLabel>
							<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
								<WordDiff
									value={rawAc}
									against={otherAc}
									mode="added"
								/>
							</p>
						</div>
						<StoryAttachments
							projectId={projectId}
							organizationId={organizationId}
							story={story}
							label={t("attachmentsLabel")}
						/>
					</>
				)}
			</div>

			{mergeTypeNote ? (
				<p
					id={`duplicate-merge-type-${story.id}`}
					className="mt-2 shrink-0 text-[11px] leading-relaxed text-muted-foreground"
				>
					{mergeTypeNote}
				</p>
			) : null}

			<Button
				size="sm"
				onClick={onMerge}
				disabled={mergeDisabled}
				// The note is the action's own explanation, so it is described by
				// the button rather than left as loose text beside it.
				aria-describedby={
					mergeTypeNote
						? `duplicate-merge-type-${story.id}`
						: undefined
				}
				className="mt-2 w-full shrink-0"
			>
				{merging ? t("merging") : mergeLabel}
			</Button>
		</section>
	);
}

/** Format a wire date (Date or ISO string) for the link step; null when missing
 * or invalid so callers can omit the line. */
function formatLinkDate(
	value: Date | string | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime())
		? null
		: d.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
}

/** Local date + time in the viewer's timezone, e.g. "May 24, 2026, 9:10 AM".
 * Null when missing/invalid so callers can omit the line. */
function formatLocalDateTime(
	value: Date | string | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime())
		? null
		: d.toLocaleString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
}

/** UTC clock time only, e.g. "6:10 AM" (the calling label appends "UTC").
 * Null when missing/invalid. */
function formatUtcClock(
	value: Date | string | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime())
		? null
		: d.toLocaleTimeString("en-US", {
				timeZone: "UTC",
				hour: "numeric",
				minute: "2-digit",
			});
}

/**
 * Compact, informational PM-link chip shown on a ticket panel before the user
 * merges (Q1). Linked → "{tool} {ref}" with the brand icon, a new-tab link, and
 * an amber stale/failed flag (DV-4). Unlinked → renders nothing.
 */
function PmLinkBadge({
	story,
	t,
}: {
	story: DuplicateLinkStory;
	t: ReturnType<typeof useTranslations>;
}) {
	const state = useMemo(() => derivePmLinkState(story), [story]);
	if (!state.linked) {
		return null;
	}
	const tool = state.toolName ?? t("linkBadgeFallbackTool");
	const ref = state.ticketRef ?? "";
	const label = t("linkBadgeLabel", { tool, ticketRef: ref });
	const aria = t("linkBadgeAria", { tool, ticketRef: ref });
	const BrandIcon = getPmToolBrandIcon(state.detectedType);
	const icon = BrandIcon ? (
		<BrandIcon className="size-3" />
	) : (
		<Link2Icon className="size-3" aria-hidden="true" />
	);
	return (
		<div className="mt-2 flex flex-wrap items-center gap-1.5">
			{state.url ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<a
							href={state.url}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={aria}
							className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
						>
							{icon}
							<span>{label}</span>
							<ExternalLinkIcon
								className="size-3"
								aria-hidden="true"
							/>
						</a>
					</TooltipTrigger>
					<TooltipContent>{aria}</TooltipContent>
				</Tooltip>
			) : (
				<span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
					{icon}
					<span>{label}</span>
				</span>
			)}
			{state.error || state.stale ? (
				<span className="inline-flex items-center gap-1 rounded-full border border-highlight/40 bg-highlight/10 px-2 py-0.5 text-[11px] text-foreground">
					<AlertTriangleIcon
						className="size-3 text-highlight"
						aria-hidden="true"
					/>
					{state.error ? t("linkSyncFailed") : t("linkSyncStale")}
				</span>
			) : null}
		</div>
	);
}

/** The in-dialog link step shown for UC1 / UC3-different before the merge fires
 * — a combined screen that replaces the two panels (not a stacked modal). It
 * carries the survivor/duplicate plus the AI-merge choice from the clicked card
 * so the deferred merge applies the same content (FR-13). */
type LinkStep =
	| {
			kind: "uc1";
			survivor: DuplicateLinkStory;
			duplicate: DuplicateLinkStory;
			useAi: boolean;
			proposal: Proposal | null;
	  }
	| {
			kind: "uc3";
			survivor: DuplicateLinkStory;
			duplicate: DuplicateLinkStory;
			useAi: boolean;
			proposal: Proposal | null;
			selected: "survivor" | "duplicate" | null;
	  };

/** A standalone "open the PM ticket in a new tab" link. */
function OpenTicketLink({
	url,
	label,
	aria,
}: {
	url: string;
	label: string;
	aria: string;
}) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={aria}
			className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
		>
			{label}
			<ExternalLinkIcon className="size-3" aria-hidden="true" />
		</a>
	);
}

/** The amber "last sync failed / out of date" inline flag (DV-4). Conveys
 * meaning through text, not color alone. */
function StaleFlag({
	state,
	t,
}: {
	state: ReturnType<typeof derivePmLinkState>;
	t: ReturnType<typeof useTranslations>;
}) {
	if (!state.error && !state.stale) {
		return null;
	}
	return (
		<span className="inline-flex items-center gap-1 text-[11px] text-foreground">
			<AlertTriangleIcon
				className="size-3 text-highlight"
				aria-hidden="true"
			/>
			{state.error ? t("linkSyncFailed") : t("linkSyncStale")}
		</span>
	);
}

/**
 * The PM-link resolution step. For UC1 it asks whether to move the discarded
 * item's link onto the survivor; for UC3-different it lets the user pick which of
 * the two links the survivor keeps (independent of which item survives).
 * Cancelling (button / Escape / outside-click — the last two handled by the
 * parent) returns to the two panels without merging. Copy is advisory and
 * dismissible (ai-copy-tone).
 */
function LinkResolveStep({
	step,
	merging,
	onAccept,
	onDecline,
	onSelect,
	onConfirm,
	onCancel,
	t,
}: {
	step: LinkStep;
	merging: boolean;
	onAccept: () => void;
	onDecline: () => void;
	onSelect: (side: "survivor" | "duplicate") => void;
	onConfirm: () => void;
	onCancel: () => void;
	t: ReturnType<typeof useTranslations>;
}) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		// Move focus into the step when it opens (a11y).
		headingRef.current?.focus();
	}, []);

	if (step.kind === "uc1") {
		const dup = derivePmLinkState(step.duplicate);
		const tool = dup.toolName ?? t("linkBadgeFallbackTool");
		const ref = dup.ticketRef ?? "";
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1">
				<div className="space-y-2">
					<h3
						ref={headingRef}
						tabIndex={-1}
						className="text-base font-medium text-foreground outline-none"
					>
						{t("linkMigrateTitle", { tool })}
					</h3>
					<p className="text-sm text-muted-foreground">
						{t("linkMigrateBody", {
							discardedRef: step.duplicate.identifier,
							survivorRef: step.survivor.identifier,
							tool,
							ticketRef: ref,
						})}
					</p>
					<div className="flex flex-wrap items-center gap-3">
						{dup.url ? (
							<OpenTicketLink
								url={dup.url}
								label={t("linkOpen", { tool, ticketRef: ref })}
								aria={t("linkBadgeAria", {
									tool,
									ticketRef: ref,
								})}
							/>
						) : null}
						<StaleFlag state={dup} t={t} />
					</div>
				</div>
				<div className="mt-auto flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
					<Button
						variant="ghost"
						size="sm"
						onClick={onCancel}
						disabled={merging}
					>
						{t("cancel")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={onDecline}
						disabled={merging}
					>
						{t("linkMigrateDecline")}
					</Button>
					<Button size="sm" onClick={onAccept} disabled={merging}>
						{merging ? t("merging") : t("linkMigrateAccept")}
					</Button>
				</div>
			</div>
		);
	}

	// UC3 — different links: choose which one the survivor keeps.
	const renderOption = (
		side: "survivor" | "duplicate",
		story: DuplicateLinkStory,
	) => {
		const ls = derivePmLinkState(story);
		const tool = ls.toolName ?? t("linkBadgeFallbackTool");
		const ref = ls.ticketRef ?? "";
		const BrandIcon = getPmToolBrandIcon(ls.detectedType);
		const synced = formatLinkDate(ls.lastSyncedAt);
		const created = formatLinkDate(story.createdAt);
		const checked = step.selected === side;
		const inputId = `duplicate-pm-link-${side}`;
		return (
			<div
				className={cn(
					"flex items-start gap-3 rounded-md border p-3 transition-colors",
					checked
						? "border-primary bg-accent"
						: "border-border bg-muted/40",
				)}
			>
				<input
					id={inputId}
					type="radio"
					name="duplicate-pm-link"
					className="mt-1 accent-[var(--primary)]"
					checked={checked}
					disabled={merging}
					onChange={() => onSelect(side)}
				/>
				<div className="min-w-0 flex-1 space-y-1">
					<label
						htmlFor={inputId}
						className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground"
					>
						{BrandIcon ? (
							<BrandIcon className="size-3.5" />
						) : (
							<Link2Icon
								className="size-3.5"
								aria-hidden="true"
							/>
						)}
						<span className="truncate">
							{t("linkBadgeLabel", { tool, ticketRef: ref })}
						</span>
					</label>
					<span className="block text-[11px] text-muted-foreground">
						{t("linkSelectOnItem", {
							identifier: story.identifier,
						})}
					</span>
					<span className="block text-[11px] text-muted-foreground">
						{synced
							? t("linkLastSynced", { date: synced })
							: t("linkNeverSynced")}
					</span>
					{created ? (
						<span className="block text-[11px] text-muted-foreground">
							{t("linkCreated", { date: created })}
						</span>
					) : null}
					<div className="flex flex-wrap items-center gap-3 pt-0.5">
						{ls.url ? (
							<OpenTicketLink
								url={ls.url}
								label={t("linkOpen", { tool, ticketRef: ref })}
								aria={t("linkBadgeAria", {
									tool,
									ticketRef: ref,
								})}
							/>
						) : null}
						<StaleFlag state={ls} t={t} />
					</div>
				</div>
			</div>
		);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1">
			<div className="space-y-2">
				<h3
					ref={headingRef}
					tabIndex={-1}
					className="text-base font-medium text-foreground outline-none"
				>
					{t("linkSelectTitle")}
				</h3>
				<p className="text-sm text-muted-foreground">
					{t("linkSelectBody", {
						survivorRef: step.survivor.identifier,
					})}
				</p>
			</div>
			<fieldset className="space-y-2 border-0 p-0">
				<legend className="sr-only">{t("linkSelectLegend")}</legend>
				{renderOption("survivor", step.survivor)}
				{renderOption("duplicate", step.duplicate)}
			</fieldset>
			<div className="mt-auto flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
				<Button
					variant="ghost"
					size="sm"
					onClick={onCancel}
					disabled={merging}
				>
					{t("cancel")}
				</Button>
				<Button
					size="sm"
					onClick={onConfirm}
					disabled={merging || step.selected === null}
				>
					{merging ? t("merging") : t("linkSelectConfirm")}
				</Button>
			</div>
		</div>
	);
}

/**
 * Resolve a flagged duplicate pair in a wide TWO-column view. Each ticket column
 * independently toggles between its Original content and an AI-merged draft
 * (combine kept on that ticket), with the regenerate folded into the AI-merge
 * button and an info tooltip explaining the merge. Each column has its own
 * "Merge — keep this" action, so it is explicit that a merge is based on ONE
 * ticket. Generation is per-card and independent (both can run at once). The
 * other ticket is retired to Declined and its tasks carried over. When a side
 * carries an external PM-tool link, an in-dialog link step (UC1 migrate prompt /
 * UC3 link selection) is the final gate before the merge fires.
 */
export function DuplicateResolveDialog({
	open,
	onOpenChange,
	projectId,
	organizationId,
	link,
	onResolved,
}: DuplicateResolveDialogProps) {
	const t = useTranslations("projects.stories.duplicates");
	const { basePath } = useOrganizationContext();
	const [modeByCard, setModeByCard] = useState<Record<string, CardMode>>({});
	const [proposalsByCard, setProposalsByCard] = useState<
		Record<string, Proposal>
	>({});
	const [loadingByCard, setLoadingByCard] = useState<Record<string, boolean>>(
		{},
	);
	const [submitting, setSubmitting] = useState<
		{ kind: "merge"; cardId: string } | { kind: "dismiss" } | null
	>(null);
	// The in-dialog PM-link step (UC1 migrate prompt / UC3 selection). Null shows
	// the two panels; non-null replaces them with the link step (combined screen).
	const [linkStep, setLinkStep] = useState<LinkStep | null>(null);

	// Reset when a DIFFERENT pair opens. Keyed on `link?.id` (stable) — a
	// background `listDuplicates` refetch hands us a new object for the same
	// pair, and keying on identity would wipe in-progress state.
	const linkId = link?.id ?? null;
	useEffect(() => {
		if (open && linkId) {
			setModeByCard({});
			setProposalsByCard({});
			setLoadingByCard({});
			setSubmitting(null);
			setLinkStep(null);
		}
	}, [open, linkId]);

	if (!link) {
		return null;
	}

	const isBusy = submitting !== null;
	const similarityPct = Math.round(link.similarity * 100);
	const confidencePct = Math.round(link.confidence * 100);
	// OVERLAP pairs get their own title/description — telling the user two
	// overlapping-scope items "look like the same work" would contradict the
	// tier the header pill asserts.
	const isOverlap = link.linkType === "OVERLAP";

	const getMode = (cardId: string): CardMode =>
		modeByCard[cardId] ?? "original";

	// Independent per-card generation — both cards can generate/regenerate at
	// once (no global lock). Reads the survivor/duplicate's CURRENT content via
	// the procedure, so a previous merge that updated this story feeds the next.
	const generate = async (cardId: string) => {
		const dupId =
			cardId === link.storyA.id ? link.storyB.id : link.storyA.id;
		setLoadingByCard((prev) => ({ ...prev, [cardId]: true }));
		try {
			const { mergedDescription, mergedAcceptanceCriteria, truncated } =
				await orpcClient.projects.stories.proposeDuplicateMerge({
					projectId,
					organizationId,
					survivorId: cardId,
					duplicateId: dupId,
				});
			setProposalsByCard((prev) => ({
				...prev,
				[cardId]: {
					description: mergedDescription,
					acceptanceCriteria: mergedAcceptanceCriteria,
					truncated,
				},
			}));
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t("combineFailed"),
			);
		} finally {
			setLoadingByCard((prev) => ({ ...prev, [cardId]: false }));
		}
	};

	const handleAiOrRegenerate = (cardId: string) => {
		if (loadingByCard[cardId] || isBusy) {
			return;
		}
		if (getMode(cardId) !== "ai") {
			setModeByCard((prev) => ({ ...prev, [cardId]: "ai" }));
			if (!proposalsByCard[cardId]) {
				void generate(cardId);
			}
		} else {
			// Already AI — regenerate.
			void generate(cardId);
		}
	};

	// Execute the merge for a chosen survivor/duplicate with the resolved PM-link
	// action. Used directly for UC0/UC2/UC3-same and, after the link step, for
	// UC1/UC3-different. The AI ("true merge") content is passed through unchanged
	// in every path (FR-13).
	const performMerge = async (
		survivor: DuplicateLinkStory,
		duplicate: DuplicateLinkStory,
		useAi: boolean,
		proposal: Proposal | null,
		pmLink: "keep-survivor" | "transfer-from-duplicate",
	) => {
		const applyAi =
			useAi &&
			!!proposal &&
			!proposal.truncated &&
			proposal.description.trim().length > 0;
		setSubmitting({ kind: "merge", cardId: survivor.id });
		try {
			await orpcClient.projects.stories.mergeDuplicate({
				projectId,
				organizationId,
				survivorId: survivor.id,
				duplicateId: duplicate.id,
				pmLink,
				mergedDescription:
					applyAi && proposal ? proposal.description : undefined,
				mergedAcceptanceCriteria:
					applyAi &&
					proposal &&
					proposal.acceptanceCriteria.trim().length > 0
						? proposal.acceptanceCriteria
						: undefined,
			});
			toast.success(
				t("mergedTitle", {
					duplicate: duplicate.identifier,
					survivor: survivor.identifier,
				}),
				{
					description: applyAi
						? t("mergedCombinedDescription", {
								duplicate: duplicate.identifier,
								survivor: survivor.identifier,
							})
						: t("mergedDescription", {
								duplicate: duplicate.identifier,
							}),
				},
			);
			onResolved?.();
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to merge",
			);
		} finally {
			setSubmitting(null);
			setLinkStep(null);
		}
	};

	// Clicking "Merge — keep this" on a card chooses the survivor. Before firing,
	// classify the pair's PM-link state: UC1 and UC3-different open the in-dialog
	// link step (the final gate before the merge); the rest merge immediately,
	// keeping the survivor's link.
	const runMerge = (cardId: string) => {
		const mode = getMode(cardId);
		const survivor = cardId === link.storyA.id ? link.storyA : link.storyB;
		const duplicate = cardId === link.storyA.id ? link.storyB : link.storyA;
		const prop = proposalsByCard[cardId] ?? null;
		const useAi =
			mode === "ai" &&
			!!prop &&
			!prop.truncated &&
			prop.description.trim().length > 0;
		const scenario = classifyMergeLinkScenario(survivor, duplicate);
		if (scenario === "UC1") {
			setLinkStep({
				kind: "uc1",
				survivor,
				duplicate,
				useAi,
				proposal: prop,
			});
			return;
		}
		if (scenario === "UC3_DIFF") {
			setLinkStep({
				kind: "uc3",
				survivor,
				duplicate,
				useAi,
				proposal: prop,
				selected: null,
			});
			return;
		}
		// UC0 / UC2 / UC3-same: nothing to decide — keep the survivor's link.
		void performMerge(survivor, duplicate, useAi, prop, "keep-survivor");
	};

	// Link-step handlers. Cancel returns to the panels (no merge); the others
	// fire the deferred merge with the resolved pmLink.
	const handleStepAccept = () => {
		if (!linkStep) {
			return;
		}
		void performMerge(
			linkStep.survivor,
			linkStep.duplicate,
			linkStep.useAi,
			linkStep.proposal,
			"transfer-from-duplicate",
		);
	};
	const handleStepDecline = () => {
		if (!linkStep) {
			return;
		}
		void performMerge(
			linkStep.survivor,
			linkStep.duplicate,
			linkStep.useAi,
			linkStep.proposal,
			"keep-survivor",
		);
	};
	const handleStepSelect = (side: "survivor" | "duplicate") => {
		setLinkStep((prev) =>
			prev && prev.kind === "uc3" ? { ...prev, selected: side } : prev,
		);
	};
	const handleStepConfirm = () => {
		if (
			!linkStep ||
			linkStep.kind !== "uc3" ||
			linkStep.selected === null
		) {
			return;
		}
		void performMerge(
			linkStep.survivor,
			linkStep.duplicate,
			linkStep.useAi,
			linkStep.proposal,
			linkStep.selected === "duplicate"
				? "transfer-from-duplicate"
				: "keep-survivor",
		);
	};
	const handleStepCancel = () => {
		// Never abandon a merge in flight.
		if (submitting) {
			return;
		}
		setLinkStep(null);
	};

	const handleDismiss = async () => {
		setSubmitting({ kind: "dismiss" });
		try {
			await orpcClient.projects.stories.dismissDuplicate({
				projectId,
				organizationId,
				linkId: link.id,
			});
			toast.success(t("dismissedTitle"), {
				description: t("dismissedDescription"),
			});
			onResolved?.();
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to dismiss",
			);
		} finally {
			setSubmitting(null);
		}
	};

	const mergingCardId =
		submitting?.kind === "merge" ? submitting.cardId : null;

	const renderPanel = (
		story: DuplicateLinkStory,
		other: DuplicateLinkStory,
	) => (
		<TicketPanel
			story={story}
			other={other}
			storyHref={buildStoryDetailsRoute(basePath, projectId, story.id)}
			mode={getMode(story.id)}
			loading={Boolean(loadingByCard[story.id])}
			proposal={proposalsByCard[story.id] ?? null}
			onSetOriginal={() =>
				setModeByCard((prev) => ({ ...prev, [story.id]: "original" }))
			}
			onAiOrRegenerate={() => handleAiOrRegenerate(story.id)}
			onMerge={() => void runMerge(story.id)}
			merging={mergingCardId === story.id}
			disabled={isBusy}
			projectId={projectId}
			organizationId={organizationId}
			t={t}
		/>
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[95vh] max-w-[min(95vw,1180px)] flex-col overflow-hidden border border-border bg-card"
				onEscapeKeyDown={(e) => {
					// In the link step, Escape returns to the panels instead of
					// closing the dialog (FR-6); a merge in flight blocks both.
					if (isBusy) {
						e.preventDefault();
						return;
					}
					if (linkStep) {
						e.preventDefault();
						setLinkStep(null);
					}
				}}
				onInteractOutside={(e) => {
					if (isBusy) {
						e.preventDefault();
						return;
					}
					// Outside-click during the link step returns to the panels
					// rather than closing the dialog (FR-6).
					if (linkStep) {
						e.preventDefault();
						setLinkStep(null);
					}
				}}
			>
				<TooltipProvider delayDuration={200}>
					<DialogHeader className="space-y-1.5">
						{/* Compact header bar: smaller title + an (i) tooltip for the
						    instructions, with the "Why flagged?" hover and the
						    similarity score on the right — frees vertical room for the
						    ticket cards below. */}
						<div className="flex items-start justify-between gap-3 pr-8">
							<div className="flex min-w-0 items-center gap-2">
								<DialogTitle
									className="font-normal text-xl"
									style={{ fontFamily: "var(--font-serif)" }}
								>
									{t(
										isOverlap
											? "dialogTitleOverlap"
											: "dialogTitle",
									)}
								</DialogTitle>
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label={t("aboutAria")}
											className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
										>
											<InfoIcon
												className="size-4"
												aria-hidden="true"
											/>
										</button>
									</TooltipTrigger>
									<TooltipContent className="max-w-[320px] text-left">
										{t(
											isOverlap
												? "dialogDescriptionOverlap"
												: "dialogDescription",
										)}
									</TooltipContent>
								</Tooltip>
							</div>
							{linkStep ? null : (
								<div className="flex shrink-0 items-center gap-2.5 text-[11px] text-muted-foreground">
									{isOverlap ? (
										<Tooltip>
											<TooltipTrigger asChild>
												{/* A real button (like the sibling
												    "Why flagged?" trigger) so the
												    tooltip opens on keyboard focus,
												    not just hover. */}
												<button
													type="button"
													className="inline-flex items-center gap-1 rounded-full border border-highlight/40 bg-highlight/10 px-2.5 py-1 font-medium text-highlight-foreground dark:text-muted-foreground"
												>
													{t("overlapPillLabel")}
												</button>
											</TooltipTrigger>
											<TooltipContent className="max-w-[320px] text-left">
												{t("overlapPillHelp")}
											</TooltipContent>
										</Tooltip>
									) : null}
									{link.reasoning ? (
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 transition-colors hover:border-primary hover:text-foreground"
												>
													<InfoIcon
														className="size-3"
														aria-hidden="true"
													/>
													{t("whyFlaggedLabel")}
												</button>
											</TooltipTrigger>
											<TooltipContent className="max-w-[360px] text-left">
												{link.reasoning}
											</TooltipContent>
										</Tooltip>
									) : null}
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												aria-label={t(
													"similarConfidenceAria",
												)}
												className="whitespace-nowrap underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 transition-colors hover:text-foreground"
											>
												{t("similarConfidence", {
													similarity: similarityPct,
													confidence: confidencePct,
												})}
											</button>
										</TooltipTrigger>
										{/* Rich label/value rows: needs the popover
										    surface so text-foreground stays legible
										    in both themes (see TooltipContent). */}
										<TooltipContent
											surface="popover"
											className="max-w-[320px] space-y-2 text-left"
										>
											<div className="space-y-0.5">
												<p className="font-medium text-foreground">
													{t("similarHelpLabel")}
												</p>
												<p className="text-muted-foreground">
													{t("similarHelpBody")}
												</p>
											</div>
											<div className="space-y-0.5">
												<p className="font-medium text-foreground">
													{t("confidenceHelpLabel")}
												</p>
												<p className="text-muted-foreground">
													{t("confidenceHelpBody")}
												</p>
											</div>
										</TooltipContent>
									</Tooltip>
								</div>
							)}
						</div>
						<DialogDescription className="sr-only">
							{t(
								isOverlap
									? "dialogDescriptionOverlap"
									: "dialogDescription",
							)}
						</DialogDescription>
					</DialogHeader>

					{linkStep ? (
						<LinkResolveStep
							step={linkStep}
							merging={submitting?.kind === "merge"}
							onAccept={handleStepAccept}
							onDecline={handleStepDecline}
							onSelect={handleStepSelect}
							onConfirm={handleStepConfirm}
							onCancel={handleStepCancel}
							t={t}
						/>
					) : (
						<>
							{/* Two ticket panels — each chooses Original or AI-merged
							    content and has its own "Merge — keep this" action. */}
							{/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> is the semantic group element, but its intrinsic sizing prevents the flex panels from being height-bounded to the scroll area, which pushes the per-panel merge buttons off-screen (the bug being fixed). role="group" + aria-label preserves the grouping without that quirk. */}
							<div
								role="group"
								aria-label={t("keepLabel")}
								className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto md:flex-row md:overflow-hidden"
							>
								{renderPanel(link.storyA, link.storyB)}
								{renderPanel(link.storyB, link.storyA)}
							</div>

							{/* Global actions */}
							<div className="flex shrink-0 flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onOpenChange(false)}
									disabled={isBusy}
								>
									{t("cancel")}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => void handleDismiss()}
									disabled={isBusy}
								>
									{submitting?.kind === "dismiss"
										? t("dismissing")
										: t("notADuplicate")}
								</Button>
							</div>
						</>
					)}
				</TooltipProvider>
			</DialogContent>
		</Dialog>
	);
}

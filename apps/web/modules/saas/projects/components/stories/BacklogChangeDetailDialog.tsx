"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Markdown } from "@ui/components/markdown";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	InfoIcon,
	Loader2Icon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
	type ChangeItem,
	type ChangeItemKind,
	deriveDefaultKind,
} from "./BacklogChangeProposal";

/**
 * Slugify a label for use in an `id` / `aria-labelledby` reference. The
 * fields rendered here include "Acceptance criteria" — the space would
 * be valid HTML5 but is fragile across older a11y tooling. Lowercase +
 * hyphenate to be safe.
 */
function slugifyLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

const SOURCE_LABELS: Record<string, string> = {
	teams_messages: "Teams messages",
	meeting_transcript: "Meeting transcript",
	notion_page: "Notion page",
	multiple: "Multiple sources",
};

const TYPE_COLORS: Record<string, string> = {
	epic: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
	feature: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
	story: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
	bug: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

/**
 * Names of the long-form / scalar fields that can be diffed in an
 * update change. The detail dialog renders an Accept/Reject control
 * next to each one so the PM can stage field-level decisions, like
 * the document editor's per-mark accept/reject.
 */
export type SkippableField =
	| "title"
	| "description"
	| "acceptanceCriteria"
	| "priority"
	| "size";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	change: ChangeItem;
	/** 0-based position in the parent list — drives Prev/Next + the header counter. */
	index: number;
	totalCount: number;
	/** True when this index is in the parent's `selected` set (will be applied). */
	isSelected: boolean;
	/** Whether navigation buttons should be disabled (e.g. only one item). */
	canGoPrev: boolean;
	canGoNext: boolean;
	/** Toggle the selection state for the currently-open item. */
	onApprove: () => void;
	onReject: () => void;
	/** Open the previous / next item in the list. The parent is responsible
	 * for marking the current index reviewed before changing. */
	onPrev: () => void;
	onNext: () => void;
	/**
	 * Field-level skip state for the currently open change. Each entry
	 * marks a specific field as "rejected" — the parent will revert it
	 * to its `from` value (or omit it for optional fields) when applying.
	 * Empty / undefined means every field is accepted (current behavior).
	 */
	skippedFields: ReadonlySet<SkippableField>;
	onToggleField: (field: SkippableField) => void;
	/**
	 * Reviewer-selected kind for this create row. Mirrors the same control
	 * shown in the inline list so the PM can flip Bug ↔ Feature without
	 * closing the dialog. `undefined` means the analyzer's default is in
	 * effect. Hidden for update rows (kind is preserved from the existing
	 * item) and for epics (epics aren't a kind).
	 */
	kindOverride?: ChangeItemKind;
	onKindOverride?: (next: ChangeItemKind) => void;
	/**
	 * True while this row's body is being (re)drafted through the kind prompt
	 * (draft-on-open or a Bug/Feature switch). The reformat is an LLM call that
	 * can take up to ~a minute, so we surface a visible "drafting" banner —
	 * without it the dialog looks frozen and the switch reads as broken.
	 */
	reformatting?: boolean;
	/**
	 * Inbox persisted-draft extras. `draftStartedAt` is the server clock for the
	 * shared count-up counter (same in every tab). `draftStatus` drives the
	 * control state (Cancel while RUNNING; Draft/Re-draft otherwise).
	 * `onStartDraft`, when provided, surfaces the "Draft with AI" button (inbox
	 * flow only) — drafting is explicit, and the ticket is always created through
	 * the kind prompt regardless. Absent for the sidebar's in-memory reformat.
	 */
	draftStartedAt?: string;
	draftStatus?: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	onCancelDraft?: () => void;
	onStartDraft?: () => void;
};

/**
 * Full-detail review view for a single proposed backlog change.
 *
 * Solves the "approve before reviewed" UX gap: the AI-Update tray's
 * inline list shows ~200-char previews per item, which is not enough
 * to make an informed approval decision. This dialog opens from the
 * tray and renders the COMPLETE proposed change — full title, full
 * description, full acceptance criteria, full reasoning, parent
 * relationships, and (for updates) a stacked before/after diff that
 * does not truncate.
 *
 * Design notes:
 *   - Approve / Reject mutate the parent `selected` set so the user can
 *     toggle which items will be applied without leaving the dialog.
 *   - Prev / Next walk the list one item at a time. The parent records
 *     each visited index in `reviewedIndexes` so the user can see what
 *     they have already opened on returning to the list.
 *   - Mirrors the visual language of `PmSyncDiffModal` (header uses
 *     the serif `--font-serif`, identifying badges, monospace IDs) so
 *     the experience feels consistent across PM-sync and AI-Update
 *     diff flows.
 */
export function BacklogChangeDetailDialog({
	open,
	onOpenChange,
	change,
	index,
	totalCount,
	isSelected,
	canGoPrev,
	canGoNext,
	onApprove,
	onReject,
	onPrev,
	onNext,
	skippedFields,
	onToggleField,
	kindOverride,
	onKindOverride,
	reformatting = false,
	draftStartedAt,
	draftStatus,
	onCancelDraft,
	onStartDraft,
}: Props) {
	const showKindSelector =
		change.action === "create" &&
		change.type !== "epic" &&
		typeof onKindOverride === "function";
	const selectedKind: ChangeItemKind = showKindSelector
		? (kindOverride ?? deriveDefaultKind(change.type))
		: deriveDefaultKind(change.type);
	// Only flag "Type changed from AI suggestion" when the effective kind truly
	// differs from the analyzer's default — toggling BUG→FEATURE→BUG lands back
	// on the default and must NOT read as changed (matches the approve-time
	// override-stripping in BacklogChangeProposal).
	const isKindOverridden =
		showKindSelector && selectedKind !== deriveDefaultKind(change.type);
	const isCreate = change.action === "create";
	const sourceLabel =
		SOURCE_LABELS[change.sourceContext] ?? change.sourceContext;
	// Scroll the body back to the top when the user navigates Prev/Next.
	// Without this, scroll position from item N persists into item N+1
	// and the user lands mid-content. Resetting on index change makes
	// every navigation start at the title.
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bodyRef.current?.scrollTo({ top: 0, behavior: "auto" });
	}, [index]);

	// Count-up elapsed counter for the drafting banner. Ticks every 1s while a
	// draft is in flight; derived from the SERVER `draftStartedAt` so it reads
	// the same in every tab/user and survives refresh.
	const [nowTs, setNowTs] = useState(() => Date.now());
	useEffect(() => {
		if (!reformatting) {
			return;
		}
		setNowTs(Date.now());
		const t = setInterval(() => setNowTs(Date.now()), 1000);
		return () => clearInterval(t);
	}, [reformatting]);
	const elapsedSeconds = draftStartedAt
		? Math.max(
				0,
				Math.floor((nowTs - new Date(draftStartedAt).getTime()) / 1000),
			)
		: null;
	const elapsedLabel =
		elapsedSeconds !== null
			? `${Math.floor(elapsedSeconds / 60)}:${String(
					elapsedSeconds % 60,
				).padStart(2, "0")}`
			: null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* Layout: fixed header + scrollable body + fixed footer.
			    The dialog used to scroll as one element, which scrolled
			    the Approve/Prev/Next action bar out of view on long
			    proposals (acceptance criteria can be hundreds of lines).
			    Splitting the panel keeps the controls always reachable. */}
			<DialogContent
				className="max-w-3xl bg-card border border-border max-h-[90vh] flex flex-col gap-0 p-0"
				data-testid="backlog-change-detail-dialog"
			>
				{/* Position counter pinned to the dialog corner, immediately
				    left of the Radix close button (which sits at right-4 top-4).
				    Keeping the counter absolute means a long title can wrap
				    freely in the header without pushing the counter around. */}
				<span
					className="absolute right-12 top-4 text-xs text-muted-foreground tabular-nums select-none pointer-events-none"
					aria-label={`Item ${index + 1} of ${totalCount}`}
					data-testid="backlog-change-detail-counter"
				>
					{index + 1} of {totalCount}
				</span>
				<DialogHeader className="space-y-2 p-6 pb-4 pr-24 border-b shrink-0">
					<DialogTitle
						className="font-normal text-2xl"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						{isCreate ? "New" : "Update"}: {change.title.to}
					</DialogTitle>
					<div className="flex items-center gap-2 flex-wrap">
						<Badge
							variant="outline"
							className={cn(
								"text-xs capitalize",
								change.action === "create"
									? "border-green-500 text-green-700 dark:text-green-400"
									: "border-amber-500 text-amber-700 dark:text-amber-400",
							)}
						>
							{change.action}
						</Badge>
						{showKindSelector ? (
							<DetailKindSelector
								selected={selectedKind}
								overridden={isKindOverridden}
								onChange={(next) => onKindOverride?.(next)}
								itemTitle={change.title.to}
							/>
						) : change.action === "update" &&
							change.type !== "epic" ? (
							// UPDATE rows: surface kind as a readonly pill (same
							// visual language as the selector) — AI Update doesn't
							// change kind on existing items; the dedicated
							// "Convert kind" action on the story detail page does.
							<DetailReadOnlyKindBadge
								kind={selectedKind}
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
						{isSelected ? (
							<Badge
								variant="default"
								className="text-xs bg-success/15 text-success border-success/30"
							>
								<CheckIcon className="mr-1 size-3" />
								Approved
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="text-xs text-muted-foreground"
							>
								Excluded
							</Badge>
						)}
					</div>
					<DialogDescription className="sr-only">
						Review the full proposed change before approving.
					</DialogDescription>
				</DialogHeader>

				{/* Full content: every field rendered without truncation.
				    `flex-1 overflow-y-auto` makes only the body scroll —
				    the header above and the action bar below stay fixed. */}
				<div
					ref={bodyRef}
					className="space-y-6 px-6 py-4 flex-1 overflow-y-auto"
				>
					{/* Drafting banner: the reformat is an LLM call (can take up
					    to ~a minute), so make the wait visible (and cancellable)
					    — otherwise the dialog looks frozen and switching kind
					    reads as broken. Highlighted with the primary accent. */}
					{reformatting && (
						<div
							className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm text-foreground"
							role="status"
							aria-live="polite"
						>
							<Loader2Icon
								className="size-4 shrink-0 text-primary motion-safe:animate-spin"
								aria-hidden="true"
							/>
							<span className="flex-1">
								Drafting this proposal as a{" "}
								<span className="font-medium">
									{selectedKind === "BUG" ? "Bug" : "Feature"}
								</span>{" "}
								through your project's prompt — generated once
								and shared with your team. This can take up to a
								minute.
								{elapsedLabel ? (
									<span className="ml-1.5 font-medium tabular-nums text-primary">
										{elapsedLabel}
									</span>
								) : null}
							</span>
							{onCancelDraft ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 shrink-0"
									onClick={onCancelDraft}
								>
									Cancel
								</Button>
							) : null}
						</div>
					)}
					{/* Explicit "Draft with AI" control (inbox flow). Drafting is
					    optional — the ticket is ALWAYS created through the kind
					    prompt at apply; this just lets the reviewer preview the
					    exact wording first. Covers the no-draft, completed (→
					    Re-draft), and cancelled/failed states. */}
					{!reformatting && onStartDraft && isCreate ? (
						<div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
							<span className="flex flex-1 items-center gap-1.5 text-muted-foreground">
								{draftStatus === "COMPLETED" ? (
									<>
										<CheckIcon
											className="size-3.5 shrink-0 text-secondary"
											aria-hidden="true"
										/>
										Drafted as{" "}
										{selectedKind === "BUG"
											? "Bug"
											: "Feature"}{" "}
										via your project's prompt.
									</>
								) : draftStatus === "CANCELLED" ? (
									"Drafting was cancelled — the original content is shown below."
								) : draftStatus === "FAILED" ? (
									"The draft couldn't be generated — the original content is shown below."
								) : (
									<>
										Preview the{" "}
										{selectedKind === "BUG"
											? "Bug"
											: "Feature"}{" "}
										draft before creating.
									</>
								)}
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											className="text-muted-foreground/70 hover:text-foreground"
											aria-label="What does Draft with AI do?"
										>
											<InfoIcon
												className="size-3.5"
												aria-hidden="true"
											/>
										</button>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs">
										Generates the{" "}
										{selectedKind === "BUG"
											? "Bug"
											: "Feature"}{" "}
										draft now so you can review the exact
										wording. The ticket is always created
										through your project's{" "}
										{selectedKind === "BUG"
											? "Bug"
											: "Feature"}{" "}
										prompt — drafting here just lets you
										preview it first.
									</TooltipContent>
								</Tooltip>
							</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 shrink-0"
								onClick={onStartDraft}
							>
								<SparklesIcon
									className="mr-1.5 size-3.5"
									aria-hidden="true"
								/>
								{draftStatus === "COMPLETED"
									? "Re-draft"
									: "Draft with AI"}
							</Button>
						</div>
					) : null}

					{/* Title — for updates we always show the diff; for creates,
					    the new title is in the dialog header above. Title field
					    is required, so rejecting it means the existing title
					    stays (we revert `to` to `from` on apply). */}
					{!isCreate && change.title.from !== undefined && (
						<DetailDiffSection
							label="Title"
							from={change.title.from}
							to={change.title.to}
							isRejected={skippedFields.has("title")}
							onToggleAccept={
								isCreate
									? undefined
									: () => onToggleField("title")
							}
						/>
					)}

					{/* Description */}
					{change.description !== undefined && (
						<DetailDiffSection
							label="Description"
							from={change.description.from}
							to={change.description.to}
							placeholder={
								isCreate ? "(no description)" : undefined
							}
							isRejected={skippedFields.has("description")}
							onToggleAccept={
								isCreate
									? undefined
									: () => onToggleField("description")
							}
						/>
					)}

					{/* Acceptance criteria — typically the longest field; this
					    is the field that hurt most under the old line-clamp-2. */}
					{change.acceptanceCriteria !== undefined && (
						<DetailDiffSection
							label="Acceptance criteria"
							from={change.acceptanceCriteria.from}
							to={change.acceptanceCriteria.to}
							isRejected={skippedFields.has("acceptanceCriteria")}
							onToggleAccept={
								isCreate
									? undefined
									: () => onToggleField("acceptanceCriteria")
							}
						/>
					)}

					{/* Inline metadata: priority, size, parent relationships. */}
					{(change.priority !== undefined ||
						change.size !== undefined ||
						change.parentEpicIdentifier ||
						change.parentFeatureIdentifier) && (
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							{change.priority !== undefined && (
								<MetadataField
									label="Priority"
									from={change.priority.from}
									to={change.priority.to}
									isRejected={skippedFields.has("priority")}
									onToggleAccept={
										isCreate
											? undefined
											: () => onToggleField("priority")
									}
								/>
							)}
							{change.size !== undefined && (
								<MetadataField
									label="Size"
									from={change.size.from}
									to={change.size.to}
									isRejected={skippedFields.has("size")}
									onToggleAccept={
										isCreate
											? undefined
											: () => onToggleField("size")
									}
								/>
							)}
							{(change.parentEpicIdentifier ||
								change.parentEpicTitle) && (
								<MetadataField
									label="Parent epic"
									to={
										[
											change.parentEpicIdentifier,
											change.parentEpicTitle,
										]
											.filter(Boolean)
											.join(" — ") || "—"
									}
								/>
							)}
							{(change.parentFeatureIdentifier ||
								change.parentFeatureTitle) && (
								<MetadataField
									label="Parent feature"
									to={
										[
											change.parentFeatureIdentifier,
											change.parentFeatureTitle,
										]
											.filter(Boolean)
											.join(" — ") || "—"
									}
								/>
							)}
						</div>
					)}

					{/* Source + reasoning — context for why the AI proposed this. */}
					<div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-1">
						<p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
							Why this was proposed
						</p>
						<p className="text-xs text-muted-foreground">
							Source: {sourceLabel}
						</p>
						{change.reasoning && (
							<Markdown className="break-words">
								{change.reasoning}
							</Markdown>
						)}
					</div>
				</div>

				{/* Action bar: per-item Approve/Reject + Prev/Next navigation.
				    The Approve button toggles whether the item is in the
				    parent's `selected` set; it does NOT commit the change to
				    the database. Final commit happens from the list view's
				    "Apply Selected" button. Sticky footer (`shrink-0`) so
				    the controls are always reachable regardless of how long
				    the proposed content is. `flex-wrap` keeps the layout
				    sane on narrow viewports. */}
				<div className="flex items-center justify-between gap-2 flex-wrap border-t bg-card p-4 shrink-0">
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={onPrev}
							disabled={!canGoPrev}
							aria-label="Previous change"
						>
							<ChevronLeftIcon className="size-4" />
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={onNext}
							disabled={!canGoNext}
							aria-label="Next change"
						>
							Next
							<ChevronRightIcon className="size-4" />
						</Button>
					</div>
					<div className="flex items-center gap-2">
						{isSelected ? (
							<Button
								variant="outline"
								size="sm"
								onClick={onReject}
								className="text-destructive hover:bg-destructive/10 hover:text-destructive"
							>
								<XIcon className="mr-1 size-4" />
								Exclude this item
							</Button>
						) : (
							<Button
								size="sm"
								onClick={onApprove}
								className="bg-success text-success-foreground hover:bg-success/90"
							>
								<CheckIcon className="mr-1 size-4" />
								Approve this item
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Inline Feature/Bug toggle for the detail dialog header. Same visual contract
 * AND keyboard contract as the inline list's `KindSelector` so the PM sees
 * the same affordance in both contexts (roving tabindex, arrow keys move
 * selection, Home/End jump to ends).
 */
function DetailKindSelector({
	selected,
	overridden,
	onChange,
	itemTitle,
}: {
	selected: ChangeItemKind;
	overridden: boolean;
	onChange: (next: ChangeItemKind) => void;
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
		const i = options.findIndex((o) => o.value === selected);
		const next = options[(i + delta + options.length) % options.length]!;
		onChange(next.value);
		focusOption(next.value);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
				onKeyDown={onKeyDown}
				className="inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5"
			>
				{options.map((opt) => {
					const isActive = opt.value === selected;
					return (
						// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup-on-buttons pattern (mirrors the inline list's KindSelector and Radix's ToggleGroup).
						<button
							key={opt.value}
							type="button"
							role="radio"
							aria-checked={isActive}
							data-kind-value={opt.value}
							tabIndex={isActive ? 0 : -1}
							onClick={() => {
								if (!isActive) {
									onChange(opt.value);
								}
							}}
							className={cn(
								"px-2 py-0.5 text-xs rounded font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
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
 * Read-only kind pill for UPDATE rows in the detail dialog. Mirrors the
 * inline list's `ReadOnlyKindBadge` so the PM sees the same affordance
 * whether reviewing inline or in the dialog. AI Update never changes the
 * kind of an existing item — kind conversion lives on the story detail
 * page (see ConvertKindConfirmDialog).
 */
function DetailReadOnlyKindBadge({
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
						// Same border-opacity contract as the inline list pill.
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

/**
 * Render a labeled before/after diff for a long-form text field.
 *
 * Crucially, NO truncation — the whole point of this dialog is that the
 * user can see the entire proposed text before approving. `<Markdown>`
 * renders the LLM's paragraph/list structure; `break-words` keeps long URLs
 * from blowing out the layout.
 */
function DetailDiffSection({
	label,
	from,
	to,
	placeholder,
	isRejected,
	onToggleAccept,
}: {
	label: string;
	from?: string;
	to: string;
	placeholder?: string;
	/** When true, this field's change is staged-rejected — the parent
	 * will revert `to` to `from` (or omit) before applying. */
	isRejected?: boolean;
	/** When defined, render an inline "Accept / Reject this change"
	 * toggle next to the field heading. Undefined = no toggle (e.g.,
	 * for create changes where there is nothing to reject from). */
	onToggleAccept?: () => void;
}) {
	const showFrom = from !== undefined && from !== to;
	const headingId = `detail-${slugifyLabel(label)}`;
	return (
		<section
			className={cn(
				"space-y-2",
				// Visually mute the whole section when staged-rejected so
				// the PM can scan the dialog and see at a glance which
				// fields will and won't apply.
				isRejected && "opacity-60",
			)}
			aria-labelledby={headingId}
		>
			<div className="flex items-center justify-between gap-2">
				<h3
					id={headingId}
					className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
				>
					{label}
					{isRejected && (
						<span className="ml-2 normal-case tracking-normal text-[10px] text-muted-foreground/80">
							— field will be kept as-is
						</span>
					)}
				</h3>
				{showFrom && onToggleAccept && (
					<FieldAcceptToggle
						isRejected={!!isRejected}
						onToggle={onToggleAccept}
						fieldName={label}
					/>
				)}
			</div>
			{showFrom && (
				<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
					<p className="text-[10px] uppercase tracking-[0.18em] text-destructive/80 mb-1">
						Before
					</p>
					{/* Diff signal lives on the box chrome + Before/After
					    labels (and the section-level opacity when rejected),
					    NOT on the body text — so the body can render neutral
					    Markdown. Mirrors VersionDiffViewer / DiffPreviewPanes. */}
					{from && from.length > 0 ? (
						<Markdown className="break-words">{from}</Markdown>
					) : (
						<p className="text-sm text-muted-foreground">(empty)</p>
					)}
				</div>
			)}
			<div
				className={cn(
					"rounded-md border p-3",
					showFrom && !isRejected
						? "border-success/30 bg-success/5"
						: "border-border bg-muted/30",
				)}
			>
				{showFrom && (
					<p
						className={cn(
							"text-[10px] uppercase tracking-[0.18em] mb-1",
							isRejected
								? "text-muted-foreground"
								: "text-success/80",
						)}
					>
						After
					</p>
				)}
				{to.length > 0 ? (
					<Markdown className="break-words">{to}</Markdown>
				) : (
					<p className="text-sm text-muted-foreground">
						{placeholder ?? "(empty)"}
					</p>
				)}
			</div>
		</section>
	);
}

/**
 * Compact metadata field for short scalar values (priority, size,
 * parent identifiers). Renders inline `from → to` when changing.
 */
function MetadataField({
	label,
	from,
	to,
	isRejected,
	onToggleAccept,
}: {
	label: string;
	from?: string;
	to: string;
	isRejected?: boolean;
	onToggleAccept?: () => void;
}) {
	const changed = from !== undefined && from !== to;
	return (
		<div className={cn("space-y-1", isRejected && "opacity-60")}>
			<div className="flex items-center justify-between gap-2">
				<p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
					{label}
					{isRejected && changed && (
						<span className="ml-2 normal-case tracking-normal text-[10px] text-muted-foreground/80">
							— kept as-is
						</span>
					)}
				</p>
				{changed && onToggleAccept && (
					<FieldAcceptToggle
						isRejected={!!isRejected}
						onToggle={onToggleAccept}
						fieldName={label}
					/>
				)}
			</div>
			{changed ? (
				<p className="text-sm">
					<span className="line-through text-destructive/70">
						{from}
					</span>
					<span className="mx-2 text-muted-foreground">→</span>
					<span
						className={cn(
							isRejected
								? "text-muted-foreground line-through"
								: "text-success",
						)}
					>
						{to}
					</span>
				</p>
			) : (
				<p className="text-sm">{to || "—"}</p>
			)}
		</div>
	);
}

/**
 * Inline accept/reject control rendered next to each diffed field's
 * heading. Mirrors the document editor's per-mark accept/reject UX
 * but at the structured-field level (description, priority, etc.).
 *
 * "Accept" is the default; clicking once flips the field to "Reject"
 * which means the parent will revert the field's `to` to its `from`
 * (or omit the field for optionals) before sending to the backend.
 * Click again to flip back.
 */
function FieldAcceptToggle({
	isRejected,
	onToggle,
	fieldName,
}: {
	isRejected: boolean;
	onToggle: () => void;
	fieldName: string;
}) {
	const label = isRejected
		? `Restore ${fieldName} change`
		: `Reject ${fieldName} change`;
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={label}
			aria-pressed={isRejected}
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
				isRejected
					? "border-muted-foreground/30 bg-muted/40 text-muted-foreground hover:bg-muted/60"
					: "border-success/30 bg-success/10 text-success hover:bg-success/20",
			)}
		>
			{isRejected ? (
				<>
					<XIcon className="size-3" />
					Rejected
				</>
			) : (
				<>
					<CheckIcon className="size-3" />
					Accepted
				</>
			)}
		</button>
	);
}

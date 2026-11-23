"use client";

import type { UpdateBodies } from "@repo/utils/proposal-update-edits";
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
	ArchiveIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	InfoIcon,
	ListChecksIcon,
	Loader2Icon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { BacklogProposalPanel } from "../../../../analytics/events/backlog-open-existing";
import { DetailDiffSection, MetadataField } from "./BacklogChangeDetailFields";
import {
	type ChangeItem,
	type ChangeItemKind,
	deriveDefaultKind,
} from "./BacklogChangeProposal";
import {
	DetailKindSelector,
	DetailReadOnlyKindBadge,
} from "./DetailKindControls";
import { itemApproveLabel } from "./ProposalItemActions";
import { TargetChangedNote } from "./ProposalItemNotes";
import { ProposalUpdateSummary } from "./ProposalUpdateSummary";
import { StoryNewTabLink } from "./StoryNewTabLink";

/**
 * Inbox only: the dialog's Approve / Move to Rejected commit this item's
 * decision at once, the same as the item row's own actions, instead of
 * toggling the parent selection.
 */
export type DetailItemDecision = {
	onApprove: () => void;
	onMoveToRejected: () => void;
	/** Why Approve is unavailable (unfinished routing), or null. */
	approveBlockedReason: string | null;
	/** A proposal action is in flight. */
	busy: boolean;
	/**
	 * Offers line-by-line review on an update: opens its target ticket with
	 * the changes pending there, where only the accepted ones are applied.
	 */
	onReviewOnTicket?: () => void;
};

/** An item already applied or moved to Rejected, with its ticket if known. */
export type DetailItemResolution = {
	label: string;
	rejected: boolean;
	storyId?: string | null;
};

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
	/** Enables new-tab links to the target / resulting ticket. */
	projectId?: string;
	/**
	 * Whether an update's target may be linked (the board still lists it).
	 * Absent: every resolved target is linked.
	 */
	linkableTarget?: (storyId: string) => boolean;
	panel?: BacklogProposalPanel;
	itemDecision?: DetailItemDecision;
	resolution?: DetailItemResolution;
	/** The update's ticket changed after the proposal was made. */
	targetChanged?: boolean;
	/**
	 * The update's ticket bodies as they are now, when its body has no
	 * `from`: the summary counts its change against them.
	 */
	targetBodies?: UpdateBodies;
};

/**
 * Full-detail review view for a single proposed backlog change.
 *
 * Solves the "approve before reviewed"UX gap: the AI-Update tray's * inline list shows ~200-char previews per item, which is not enough * to make an informed approval decision. This dialog opens from the * tray and renders the COMPLETE proposed change — full title, full * description, full acceptance criteria, full reasoning, parent * relationships, and (for updates) a stacked before/after diff that * does not truncate. * * Design notes: * - Approve / Reject mutate the parent `selected` set so the user can * toggle which items will be applied without leaving the dialog. * - Prev / Next walk the list one item at a time. The parent records * each visited index in `reviewedIndexes` so the user can see what * they have already opened on returning to the list. * - Mirrors the visual language of `PmSyncDiffModal` (header uses * the serif `--font-semibold`, identifying badges, monospace IDs) so * the experience feels consistent across PM-sync and AI-Update * diff flows. */
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
	projectId,
	linkableTarget,
	panel,
	itemDecision,
	resolution,
	targetChanged = false,
	targetBodies,
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
	// A resolved update links to its target; a demoted or id-less update, or
	// one whose target left the board ("Ticket not found"), offers no link.
	const existingTargetId =
		change.action === "update" &&
		change.targetResolution?.demotedFromUpdate !== true &&
		change.existingId &&
		(linkableTarget?.(change.existingId) ?? true)
			? change.existingId
			: null;
	const approveReasonId = useId();
	const decisionBlockedReason = itemDecision?.approveBlockedReason ?? null;
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

	// Line-by-line review of an update the reviewer can commit here happens
	// on its ticket, the same review the AI assistant's edits get.
	const isUpdate = change.action === "update";
	const onReviewOnTicket = isUpdate
		? itemDecision?.onReviewOnTicket
		: undefined;
	const approveLabel = itemApproveLabel(
		change,
		onReviewOnTicket !== undefined,
		skippedFields,
	);
	const lineReviewHintId = useId();

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
					<DialogTitle className="font-semibold text-2xl">
						{isCreate ? "New" : "Update"}: {change.title.to}
					</DialogTitle>
					<div className="flex items-center gap-2 flex-wrap">
						<Badge
							variant="outline"
							className={cn(
								"text-xs capitalize",
								change.action === "create"
									? "border-green-500 text-green-800 dark:text-green-400"
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
							<span className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground">
								{change.existingIdentifier}
								{existingTargetId && projectId && (
									<StoryNewTabLink
										projectId={projectId}
										storyId={existingTargetId}
										panel={panel}
										label={`Open merge target ${change.existingIdentifier} for ${change.title.to} in a new tab`}
									/>
								)}
							</span>
						)}
						{resolution ? (
							<span className="inline-flex items-center gap-1">
								<Badge
									variant="outline"
									className="gap-1 text-xs"
								>
									{resolution.rejected ? (
										<ArchiveIcon
											className="size-3"
											aria-hidden="true"
										/>
									) : (
										<CheckIcon
											className="size-3"
											aria-hidden="true"
										/>
									)}
									{resolution.label}
								</Badge>
								{resolution.storyId && projectId && (
									<StoryNewTabLink
										projectId={projectId}
										storyId={resolution.storyId}
										panel={panel}
										label={`Open the ticket for ${change.title.to} in a new tab`}
									/>
								)}
							</span>
						) : itemDecision ? (
							<Badge
								variant="outline"
								className="text-xs text-muted-foreground"
							>
								Pending
							</Badge>
						) : isSelected ? (
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
								through your project's prompt
								{/* Only the server-persisted draft (it carries a
								    status) is stored and shared; any other row's
								    draft lives in this session and is drafted
								    again after a reload. */}
								{draftStatus
									? " — generated once and shared with your team."
									: "."}{" "}
								This can take up to a minute.
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
											className="size-3.5 shrink-0 text-success"
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
											className="text-muted-foreground hover:text-foreground"
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

					{isUpdate && targetChanged && <TargetChangedNote />}
					{isUpdate && (
						<ProposalUpdateSummary
							change={change}
							current={targetBodies}
							applied={
								resolution && !resolution.rejected
									? {
											projectId,
											storyId: resolution.storyId ?? null,
										}
									: undefined
							}
							panel={panel}
						/>
					)}
					{onReviewOnTicket && (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 shrink-0"
								onClick={onReviewOnTicket}
								disabled={
									itemDecision?.busy ||
									decisionBlockedReason !== null
								}
								aria-describedby={lineReviewHintId}
							>
								<ListChecksIcon
									className="mr-1.5 size-3.5"
									aria-hidden="true"
								/>
								Review line by line
							</Button>
							<p
								id={lineReviewHintId}
								className="text-xs text-muted-foreground"
							>
								Opens the ticket with each change marked. Accept
								or reject them there; only accepted changes are
								applied.
							</p>
						</div>
					)}

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

					{/* Description, then acceptance criteria — typically the
					    longest field; the one that hurt most under the old
					    line-clamp-2. */}
					{(
						[
							["description", "Description"],
							["acceptanceCriteria", "Acceptance criteria"],
						] as const
					).map(([field, label]) => {
						const value = change[field];
						if (value === undefined) {
							return null;
						}
						return (
							<div key={field} className="space-y-2">
								<DetailDiffSection
									label={label}
									from={value.from}
									to={value.to}
									placeholder={
										isCreate && field === "description"
											? "(no description)"
											: undefined
									}
									isRejected={skippedFields.has(field)}
									onToggleAccept={
										isCreate
											? undefined
											: () => onToggleField(field)
									}
								/>
							</div>
						);
					})}

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
						<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
							Why this was proposed
						</p>
						<p className="text-xs text-muted-foreground">
							Source: {sourceLabel}
						</p>
						{/* An update's reasoning leads the summary above. */}
						{change.reasoning && !isUpdate && (
							<Markdown className="break-words">
								{change.reasoning}
							</Markdown>
						)}
					</div>
				</div>

				{/* Action bar: per-item Approve/Reject + Prev/Next navigation.
				    Without `itemDecision` the Approve button toggles whether the
				    item is in the parent's `selected` set and the final commit
				    happens from the list view's "Apply Selected" button; with
				    it (inbox), Approve and Move to Rejected commit this item at
				    once. Sticky footer (`shrink-0`) so
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
					<div className="flex flex-wrap items-center justify-end gap-2">
						{resolution ? null : itemDecision ? (
							<>
								{decisionBlockedReason && (
									<p
										id={approveReasonId}
										className="text-muted-foreground text-xs"
									>
										{decisionBlockedReason}
									</p>
								)}
								<Button
									variant="outline"
									size="sm"
									onClick={itemDecision.onMoveToRejected}
									disabled={itemDecision.busy}
									aria-label={`Move ${change.title.to} to Rejected`}
								>
									<ArchiveIcon className="mr-1 size-4" />
									Move to Rejected
								</Button>
								<Button
									size="sm"
									onClick={itemDecision.onApprove}
									disabled={
										itemDecision.busy ||
										decisionBlockedReason !== null
									}
									aria-label={
										approveLabel === "Approve"
											? `Approve ${change.title.to}`
											: `${approveLabel} to ${change.title.to}`
									}
									aria-describedby={
										decisionBlockedReason
											? approveReasonId
											: undefined
									}
									className="bg-success text-success-foreground hover:bg-success/90"
								>
									<CheckIcon className="mr-1 size-4" />
									{approveLabel}
								</Button>
							</>
						) : isSelected ? (
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

"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ChevronRightIcon,
	CircleHelpIcon,
	ExternalLinkIcon,
	GripVerticalIcon,
	MessageSquareTextIcon,
	OctagonXIcon,
	PencilIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { memo, useId } from "react";
import type { StoryPriority, UserStory } from "../../../lib/stories/types";
import { HistoryTimestamp } from "../BacklogHistoryShared";
import { AiReprioritizeControl } from "./AiReprioritizeControl";
import { PriorityBand } from "./PriorityBand";
import { PriorityEditor } from "./PriorityEditor";
import { PriorityTrail } from "./PriorityTrail";

/**
 * The band's left-edge tint. Kept beside the row rather than in PriorityBand
 * because it colours the row container, not the chip.
 */
const BAND_EDGE: Record<StoryPriority, string> = {
	// Same hues as the chip (PriorityBand) so the edge and the badge read as one
	// tier. Decorative only — no text sits on it, so no contrast requirement.
	P0_CRITICAL: "border-l-red-500/60",
	P1_HIGH: "border-l-amber-500/60",
	P2_MEDIUM: "border-l-border",
	P3_LOW: "border-l-transparent",
};

/** One unanswered question on a feature, as the row shows it. */
type OpenQuestion = {
	id: string;
	summary: string | null;
	content: string | null;
};

type Props = {
	rank: number;
	total: number;
	story: UserStory;
	/** Exact number of open questions — may exceed `openQuestions.length`,
	 * which is capped for readability. */
	openDecisions: number;
	/** The first few questions themselves, newest first. */
	openQuestions: OpenQuestion[];
	decisionLogHref: string;
	/** Where the originating proposal lives. Null when this item has no recorded
	 * proposal — see `UserStory.createdFromProposalId`. */
	proposalHref: string | null;
	isComplete: boolean;
	detailsHref: string;
	/** False for read-only members, and while roadmap filters are narrowing the
	 * list (a partial list can't be pinned coherently). */
	canReorder: boolean;
	expanded: boolean;
	onToggleExpanded: (storyId: string) => void;
	projectId: string;
	organizationId: string | null;
	/** Whether this member may change the band. Independent of `canReorder`,
	 * which additionally goes false while filters are active — setting one
	 * item's priority is coherent on a filtered list, pinning an order is not. */
	canEdit: boolean;
	/** True while this row's own priority write is in flight. */
	isSavingPriority: boolean;
	onSavePriority: (
		storyId: string,
		priority: StoryPriority,
		comment: string,
	) => void;
	/** After a per-item AI pass applied (or confirmed) a band: refresh the
	 * list. Must be referentially stable — the row is memoised. */
	onAiApplied: (result: { changed: boolean }) => void;
};

function PriorityRowImpl({
	rank,
	total,
	story,
	openDecisions,
	openQuestions,
	decisionLogHref,
	proposalHref,
	isComplete,
	detailsHref,
	canReorder,
	expanded,
	onToggleExpanded,
	projectId,
	organizationId,
	canEdit,
	isSavingPriority,
	onSavePriority,
	onAiApplied,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const detailId = useId();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: story.id, disabled: !canReorder });

	// Every row now has a priority history behind the disclosure — even a row
	// whose band has never moved shows an explicit "never changed" state, which
	// is itself the answer to "why is this a P2?". So unlike before, the
	// disclosure always has something to open.

	// The badge says how many; this says how many are not shown, so the reader
	// knows the list is partial rather than assuming it is everything.
	const undisplayedQuestions = openDecisions - openQuestions.length;

	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				// A left edge tinted by the band: at a glance the list reads as
				// tiers rather than as one undifferentiated column of text, which
				// was the core complaint about the first cut.
				"border-border/40 border-b border-l-2 bg-card transition-colors last:border-b-0 hover:bg-accent/40",
				BAND_EDGE[story.priority],
				isDragging && "relative z-10 shadow-sm ring-1 ring-border",
				isComplete && "bg-muted/40",
			)}
		>
			<div className="flex items-start gap-2 px-2 py-2.5 sm:gap-2.5 sm:px-3">
				{canReorder ? (
					<button
						type="button"
						aria-label={`Reorder ${story.identifier}, position ${rank} of ${total}`}
						className="mt-0.5 hidden cursor-grab touch-none rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon aria-hidden className="size-4" />
					</button>
				) : (
					<span
						aria-hidden
						className="mt-0.5 hidden size-5 shrink-0 sm:block"
					/>
				)}

				{/* The rank is the point of this view, so it reads as a number
				    rather than as faint metadata. */}
				<span
					aria-hidden
					className="mt-px w-5 shrink-0 text-right font-semibold text-muted-foreground text-sm tabular-nums sm:w-7"
				>
					{rank}
				</span>

				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<Link
							href={detailsHref}
							className={cn(
								// `break-words`: a pasted URL or a space-less mega-
								// token can't push the row into horizontal scroll.
								"rounded-sm break-words font-medium text-foreground text-sm leading-snug hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								isComplete &&
									"text-muted-foreground line-through decoration-muted-foreground/40",
							)}
						>
							{story.title}
						</Link>
						{/* Full-strength muted-foreground: the /70 alpha dropped
						    this 11px text below AA contrast. Size does the
						    de-emphasis. */}
						<span className="text-[11px] text-muted-foreground tabular-nums">
							{story.identifier}
						</span>
					</div>

					<div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
						{canEdit ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-controls={detailId}
										onClick={() => {
											// The editor is permanently open in
											// the expanded detail, so make the
											// chip's promise real: open the row
											// if needed and land focus on the
											// editor's band picker. The rAF
											// waits out the expand render.
											if (!expanded) {
												onToggleExpanded(story.id);
											}
											requestAnimationFrame(() => {
												document
													.getElementById(detailId)
													?.querySelector<HTMLButtonElement>(
														"button[aria-pressed]",
													)
													?.focus();
											});
										}}
										className="inline-flex items-center gap-1 rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<PriorityBand
											priority={story.priority}
										/>
										<PencilIcon
											aria-hidden
											className="size-2.5 text-muted-foreground/70"
										/>
										<span className="sr-only">
											{t("changePriorityFor", {
												identifier: story.identifier,
											})}
										</span>
									</button>
								</TooltipTrigger>
								<TooltipContent>
									{t("changePriorityTooltip")}
								</TooltipContent>
							</Tooltip>
						) : (
							<PriorityBand priority={story.priority} />
						)}

						{story.priorityChangedAt && (
							<span className="whitespace-nowrap text-[11px] text-muted-foreground/70">
								{t("lastChangedPrefix")}{" "}
								<HistoryTimestamp
									value={story.priorityChangedAt}
									compact
								/>
							</span>
						)}

						{story.blocked && (
							<Badge status="error" className="text-[10px]">
								<OctagonXIcon aria-hidden />
								{t("blockedBadge")}
							</Badge>
						)}

						{openDecisions > 0 && (
							<Badge status="warning" className="text-[10px]">
								<CircleHelpIcon aria-hidden />
								{t("openQuestionsBadge", {
									count: openDecisions,
								})}
							</Badge>
						)}
					</div>

					{/* The note behind the newest change, shown even while the row
					    is collapsed so "why is this a P0?" is answered at a glance.
					    Denormalised onto the story (priorityChangeReason) so it
					    needs no per-row history fetch; the full trail — every
					    change's note — is one expand away. `line-clamp-2` keeps a
					    long note from stretching the row; the rest is in the
					    history. Null after a drag (which carries no note). */}
					{story.priorityChangeReason && (
						<p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground/80">
							<MessageSquareTextIcon
								aria-hidden
								className="mt-px size-3 shrink-0"
							/>
							<span className="line-clamp-2 break-words">
								<span className="sr-only">
									{t("latestNoteLabel")}:{" "}
								</span>
								{story.priorityChangeReason}
							</span>
						</p>
					)}
				</div>

				<button
					type="button"
					onClick={() => onToggleExpanded(story.id)}
					aria-expanded={expanded}
					aria-controls={detailId}
					aria-label={`Details for ${story.identifier}`}
					className="mt-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRightIcon
						aria-hidden
						className={cn(
							"size-4 transition-transform motion-reduce:transition-none",
							expanded && "rotate-90",
						)}
					/>
				</button>
			</div>

			{/* Always rendered so `aria-controls` resolves; `hidden` keeps it out of
			    the accessibility tree while collapsed. */}
			<div
				id={detailId}
				hidden={!expanded}
				className="space-y-2 border-border/50 border-l-2 pr-3 pb-2.5 pl-3 text-xs ml-[4.25rem]"
			>
				{story.blocked && story.blockedReason && (
					<p className="text-muted-foreground">
						<span className="font-medium text-foreground">
							{t("blockedBadge")}:{" "}
						</span>
						{story.blockedReason}
					</p>
				)}

				{openQuestions.length > 0 && (
					<div className="space-y-1">
						<p className="font-medium text-foreground">
							{t("openQuestionsHeading")}
						</p>
						<ul className="space-y-0.5">
							{openQuestions.map((question) => (
								<li
									key={question.id}
									// AI-authored text: an unbroken URL or a
									// long backticked identifier would
									// otherwise push the row into horizontal
									// page scroll, and these are previews —
									// the full text lives in the Decision Log.
									className="line-clamp-2 break-words text-muted-foreground"
								>
									{/* Agent-authored roots sometimes fill only
										    `content`, so fall back the same way the
										    Decision Log and Summary panels do. */}
									{question.summary ??
										question.content ??
										t("untitledQuestion")}
								</li>
							))}
						</ul>
						<Link
							href={decisionLogHref}
							className="inline-block rounded-sm text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{undisplayedQuestions > 0
								? t("answerInDecisionLogMore", {
										count: undisplayedQuestions,
									})
								: t("answerInDecisionLog")}
							{/* Every row emits a link with the same text, so a
								    screen-reader link list would be a wall of
								    identical names. The identifier disambiguates
								    without adding visible noise. */}
							<span className="sr-only">
								{" "}
								for {story.identifier}
							</span>
						</Link>
					</div>
				)}

				{story.source === "approved_proposal" &&
					(story.createdFromProposalId && proposalHref ? (
						<Link
							href={proposalHref}
							className="inline-flex items-center gap-1 rounded-sm text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{t("createdFromProposal")}
							{/* Chevron, not an up-right arrow: this navigates
								    in-app. The arrow is reserved for the
								    target="_blank" ticket link below, and using it
								    here made an internal link read as external. */}
							<ChevronRightIcon aria-hidden className="size-3" />
						</Link>
					) : (
						/* Items created before the proposal id was recorded
							   keep the provenance without a destination — a dead
							   link would be worse than plain text. */
						<p className="text-muted-foreground">
							{t("createdFromProposalPlain")}
						</p>
					))}

				{story.externalUrl && (
					<a
						href={story.externalUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 rounded-sm text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{t("openLinkedTicket")}
						<ExternalLinkIcon aria-hidden className="size-3" />
					</a>
				)}

				<div className="space-y-2 border-border/50 border-t pt-2">
					{/* The editor is a permanent fixture of the expanded row — no
					    "Change priority" link to find first, and nothing to cancel
					    back to. No key on the band: the editor syncs itself to an
					    external move (see PriorityEditor), because a remount here
					    would wipe a comment draft mid-keystroke when a refetch
					    lands. Mounted only while open, same as the trail below —
					    the detail div renders hidden on every collapsed row, and
					    hundreds of idle editors would be pure overhead. */}
					{canEdit && expanded && (
						<PriorityEditor
							current={story.priority}
							isSaving={isSavingPriority}
							onSave={(priority, comment) =>
								onSavePriority(story.id, priority, comment)
							}
							aiSlot={
								// Completed, hidden and declined items are not re-prioritized — the
								// server refuses them, so no dead sparkle.
								isComplete ||
								story.draftingStage === "CLOSED" ||
								story.draftingStage === "DECLINED" ? null : (
									<AiReprioritizeControl
										projectId={projectId}
										organizationId={organizationId}
										storyId={story.id}
										identifier={story.identifier}
										onApplied={onAiApplied}
									/>
								)
							}
						/>
					)}

					{/* Mounted only while open: a project can carry hundreds
						    of rows, and each one would otherwise issue its own
						    history request on first paint. */}
					{expanded && (
						<PriorityTrail
							projectId={projectId}
							organizationId={organizationId}
							storyId={story.id}
							identifier={story.identifier}
							currentPriority={story.priority}
							enabled={expanded}
						/>
					)}
				</div>
			</div>
		</li>
	);
}

/** Memoised: a list of this can run to hundreds of rows, and expanding one row
 * must not re-render the rest. Requires a stable `onToggleExpanded`. */
export const PriorityRow = memo(PriorityRowImpl);

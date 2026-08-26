"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { HistoryIcon, PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { StoryPriority } from "../../../lib/stories/types";
import { HistoryTimestamp } from "../BacklogHistoryShared";
import { AiReprioritizeControl } from "./AiReprioritizeControl";
import { PriorityBand, priorityBandLabel } from "./PriorityBand";
import { PriorityEditor } from "./PriorityEditor";
import { PriorityHistoryDialog } from "./PriorityHistoryDialog";
import { useAiReassessEligibility } from "./useAiReassessEligibility";
import { useSetStoryPriority } from "./useSetStoryPriority";

type Props = {
	projectId: string;
	organizationId: string | null;
	storyId: string;
	/** F-XXX — names the item in the full-history dialog. */
	identifier: string;
	priority: StoryPriority;
	/** When the band last moved (denormalised); null if never changed. */
	priorityChangedAt?: Date | string | null;
	/** The newest change's comment/rationale (denormalised on the story, same
	 * as the Priority view's inline note); null when it carried none. */
	priorityChangeReason?: string | null;
	/** Read-only members see the chip + info but can't open the editor. */
	canEdit: boolean;
	/** Feed the AI-reassess eligibility check — completed / hidden / declined
	 * items get no sparkle (the server refuses them anyway). */
	draftingStage: string | null;
	statusId: string;
};

/**
 * The work item's priority as an editable chip, for surfaces outside the
 * roadmap Priority view — chiefly the feature detail header.
 *
 * It is the same band chip and the same `PriorityEditor` the Priority view
 * uses, writing through the same `setPriority` path, so a change made here is
 * indistinguishable from one made there: it lands in the item's priority
 * history and re-ranks the Priority list. Before this existed, the detail page
 * showed priority read-only and the only way to change it was to navigate back
 * to the roadmap — the one place a reader of a feature couldn't act on what
 * they were reading.
 *
 * The "set <when> · why" summary reads the two denormalised story columns
 * (`priorityChangedAt`, `priorityChangeReason`) instead of fetching history —
 * zero extra requests per page view — and the full trail is one click away
 * through the same {@link PriorityHistoryDialog} the Priority view opens, so
 * "how did this end up P0?" is answerable where the feature is read.
 */
export function StoryPriorityControl({
	projectId,
	organizationId,
	storyId,
	identifier,
	priority,
	priorityChangedAt,
	priorityChangeReason,
	canEdit,
	draftingStage,
	statusId,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const [open, setOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const queryClient = useQueryClient();

	const aiReassessEligible = useAiReassessEligibility({
		projectId,
		organizationId,
		draftingStage,
		statusId,
	});

	const mutation = useSetStoryPriority({
		projectId,
		organizationId,
		onSaved: () => {
			setOpen(false);
			// Re-fetch this surface's own views: the story (its band + stamp +
			// note) and the roadmap list. Priority-history caches are refreshed
			// by the hook itself.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.get.key(),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.list.key(),
			});
		},
	});

	// The hover card: when the band last moved and why. Deliberately NOT the
	// band label — it already leads the button's aria-label, and the tooltip
	// becomes the focus-time description, so repeating it here read the band
	// twice back-to-back for screen-reader users.
	const infoContent = (
		<div className="space-y-0.5">
			{priorityChangedAt ? (
				<p className="text-muted-foreground text-xs">
					{t("lastChangedPrefix")}{" "}
					<HistoryTimestamp value={priorityChangedAt} compact />
				</p>
			) : (
				<p className="text-muted-foreground text-xs">
					{t("detailNeverChanged")}
				</p>
			)}
			{priorityChangeReason && (
				<p className="max-w-xs break-words text-muted-foreground text-xs italic">
					“{priorityChangeReason}”
				</p>
			)}
		</div>
	);

	const historyDialog = (
		<PriorityHistoryDialog
			open={historyOpen}
			onOpenChange={setHistoryOpen}
			projectId={projectId}
			organizationId={organizationId}
			storyId={storyId}
			identifier={identifier}
			currentPriority={priority}
		/>
	);

	if (!canEdit) {
		// Read-only members can't edit, but "how did this end up P0?" is
		// exactly the reader's question — so the chip opens the full history.
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							// The value first: this chip is where a reader learns
							// the item's priority, so the name can't be verb-only.
							aria-label={`${priorityBandLabel(priority)} — ${t("viewFullHistory")}`}
							onClick={() => setHistoryOpen(true)}
							className="inline-flex items-center gap-1 rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<PriorityBand
								priority={priority}
								responsive={false}
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent>{infoContent}</TooltipContent>
				</Tooltip>
				{historyDialog}
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider>
			<Popover open={open} onOpenChange={setOpen}>
				<Tooltip>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>
							<button
								type="button"
								// The value first — a verb-only name would leave
								// the header's one priority-bearing element silent
								// about what the priority IS.
								aria-label={`${priorityBandLabel(priority)} — ${t("changePriority")}`}
								className="inline-flex items-center gap-1 rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<PriorityBand
									priority={priority}
									responsive={false}
								/>
								<PencilIcon
									aria-hidden
									className="size-2.5 text-muted-foreground/70"
								/>
							</button>
						</PopoverTrigger>
					</TooltipTrigger>
					{/* Hidden while the editor is open — the popover carries the same
				    info, so two overlapping surfaces would just fight. */}
					{!open && <TooltipContent>{infoContent}</TooltipContent>}
				</Tooltip>
				<PopoverContent align="start" className="w-72 space-y-2 p-3">
					{(priorityChangedAt || priorityChangeReason) && (
						<div className="border-border/60 border-b pb-2 text-xs">
							{priorityChangedAt && (
								<p className="text-muted-foreground">
									{t("lastChangedPrefix")}{" "}
									<HistoryTimestamp
										value={priorityChangedAt}
										compact
									/>
								</p>
							)}
							{priorityChangeReason && (
								<p className="mt-0.5 break-words text-muted-foreground italic">
									“{priorityChangeReason}”
								</p>
							)}
						</div>
					)}
					<PriorityEditor
						current={priority}
						isSaving={mutation.isPending}
						onCancel={() => setOpen(false)}
						onSave={(next, comment) =>
							mutation.mutate({
								storyId,
								priority: next,
								comment,
							})
						}
						aiSlot={
							aiReassessEligible && (
								<AiReprioritizeControl
									projectId={projectId}
									organizationId={organizationId}
									storyId={storyId}
									identifier={identifier}
									// Same refresh as a manual save: this surface's
									// views close and re-read. The band may not have
									// moved — refetching an unchanged story is cheap.
									onApplied={() => {
										setOpen(false);
										queryClient.invalidateQueries({
											queryKey:
												orpc.projects.stories.get.key(),
										});
										queryClient.invalidateQueries({
											queryKey:
												orpc.projects.stories.list.key(),
										});
									}}
								/>
							)
						}
					/>
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							setHistoryOpen(true);
						}}
						className="inline-flex items-center gap-1 rounded-sm text-primary-ink text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<HistoryIcon aria-hidden className="size-3" />
						{t("viewFullHistory")}
					</button>
				</PopoverContent>
			</Popover>
			{historyDialog}
		</TooltipProvider>
	);
}

"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftRightIcon,
	CheckIcon,
	CircleSlashIcon,
	ExternalLink,
	FlagIcon,
	MoreHorizontalIcon,
	RotateCcwIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import { PRIORITY_OPTIONS, type UserStory } from "../../lib/stories/types";
import { ConvertKindConfirmDialog } from "./ConvertKindConfirmDialog";
import { useAiReassessEligibility } from "./priority/useAiReassessEligibility";
import { useAiReprioritizeStory } from "./priority/useAiReprioritizeStory";
import { StoryKindRegenerationBadge } from "./StoryKindRegenerationBadge";
import {
	useInvalidateStoryAfterRegeneration,
	useStoryKindRegeneration,
	watchStoryKindRegeneration,
} from "./useStoryKindRegeneration";

/**
 * Shared quick-actions kebab for a roadmap work item. Self-contained: it owns
 * its own priority / convert-kind / hide-unhide mutations and the convert
 * confirmation dialog, so it can be dropped into any surface (currently the
 * Board tile) without threading mutation wiring through props.
 *
 * The table row (StoryCard) keeps its own richer inline menu (Download, Kanban,
 * Weave, PM push/pull) which depends on row-level context; this menu covers the
 * core triage actions that make sense on a compact board card.
 */
export function StoryActionsMenu({
	story,
	projectId,
	organizationId,
	basePath = "/app",
	onOpenDetails,
	onDelete,
	align = "end",
	triggerClassName,
}: {
	story: UserStory;
	projectId: string;
	organizationId?: string | null;
	basePath?: string;
	onOpenDetails?: (id: string) => void;
	onDelete?: (id: string) => void;
	align?: "start" | "center" | "end";
	triggerClassName?: string;
}) {
	const queryClient = useQueryClient();
	const tConvert = useTranslations("projects.stories.convertKind");
	const isClosed = story.draftingStage === "CLOSED";
	const targetKind: "BUG" | "FEATURE" =
		story.kind === "BUG" ? "FEATURE" : "BUG";
	const [convertDialogOpen, setConvertDialogOpen] = useState(false);
	const storiesListQueryKey = orpc.projects.stories.list.queryKey({
		input: { projectId, organizationId: organizationId ?? null },
	});

	// Fizzy #2048: the conversion returns before the body redraft has started,
	// so the progress this menu shows comes from the persisted job row rather
	// than from a local flag — a flag would be gone the moment the board
	// re-renders or the user navigates away, and the redraft takes ~a minute.
	const invalidateAfterRegeneration = useInvalidateStoryAfterRegeneration(
		projectId,
		story.id,
		organizationId ?? null,
	);
	const regeneration = useStoryKindRegeneration({
		projectId,
		storyId: story.id,
		organizationId: organizationId ?? null,
		onCompleted: invalidateAfterRegeneration,
		onFailed: invalidateAfterRegeneration,
	});

	// Open the story in a real new browser tab (programmatic anchor so a PWA
	// install opens a tab rather than navigating in place). Matches StoryCard.
	const openInNewTab = () => {
		const url = buildStoryDetailsRoute(basePath, projectId, story.id);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	};

	const convertKindMutation = useMutation({
		mutationFn: async () =>
			orpcClient.projects.stories.convertKind({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetKind,
			}),
		onSuccess: (result) => {
			// The mutation resolves once the KIND has flipped — the body
			// redraft has not run yet, so the old "Converted to bug" toast
			// asserted a finished conversion that had barely started.
			toast.success(
				targetKind === "BUG"
					? tConvert("startedBug")
					: tConvert("startedFeature"),
				{ description: tConvert("startedDescription") },
			);
			setConvertDialogOpen(false);
			// A workflow id means a job row exists to follow; its absence is
			// the no-op same-kind answer, which starts nothing to watch.
			if (result?.regeneration?.workflowId) {
				watchStoryKindRegeneration(story.id);
			}
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to convert",
			);
		},
	});

	const changePriorityMutation = useMutation({
		mutationFn: async (
			newPriority: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW",
		) =>
			orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				priority: newPriority,
			}),
		onSuccess: (_data, newPriority) => {
			const label =
				PRIORITY_OPTIONS.find((p) => p.value === newPriority)?.label ??
				newPriority;
			toast.success(`Priority changed to ${label}`);
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
		onError: (error) => {
			toast.error("Failed to change priority", {
				description: (error as Error).message,
			});
		},
	});

	// The per-item AI pass — shared hook, so the toast (band move + rationale)
	// and history-cache refresh match the Priority view's sparkle exactly.
	const aiReassessEligible = useAiReassessEligibility({
		projectId,
		organizationId: organizationId ?? null,
		draftingStage: story.draftingStage,
		statusId: story.statusId,
	});
	const aiReprioritizeMutation = useAiReprioritizeStory({
		projectId,
		organizationId: organizationId ?? null,
		onApplied: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
	});

	const closeReopenMutation = useMutation({
		mutationFn: async (targetStage: "CLOSED" | "DRAFT") =>
			orpcClient.projects.stories.updateDraftingStage({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetStage,
			}),
		onMutate: async (targetStage) => {
			await queryClient.cancelQueries({ queryKey: storiesListQueryKey });
			const previousList = queryClient.getQueryData(storiesListQueryKey);
			queryClient.setQueryData<{ stories: UserStory[] } | undefined>(
				storiesListQueryKey,
				(old) => {
					if (!old || !Array.isArray(old.stories)) {
						return old;
					}
					return {
						...old,
						stories: old.stories.map((s) =>
							s.id === story.id
								? { ...s, draftingStage: targetStage }
								: s,
						),
					};
				},
			);
			return { previousList };
		},
		onError: (error, _vars, context) => {
			if (context?.previousList !== undefined) {
				queryClient.setQueryData(
					storiesListQueryKey,
					context.previousList,
				);
			}
			toast.error(
				error instanceof Error
					? error.message
					: `Failed to update ${story.kind === "BUG" ? "bug" : "feature"}`,
			);
		},
		onSuccess: (_data, targetStage) => {
			toast.success(
				targetStage === "CLOSED"
					? `${story.kind === "BUG" ? "Bug" : "Feature"} hidden`
					: `${story.kind === "BUG" ? "Bug" : "Feature"} unhidden`,
			);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
	});

	return (
		<>
			{/* Card-level state for the redraft. This menu has no body region
			    to cover, so the chip rides beside the kebab on the card. */}
			<StoryKindRegenerationBadge state={regeneration} />

			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className={cn(
									"size-6 shrink-0 rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground",
									triggerClassName,
								)}
								onClick={(e) => e.stopPropagation()}
								onMouseDown={(e) => {
									if (e.button === 1) {
										e.stopPropagation();
									}
								}}
								aria-label="Story actions"
							>
								<MoreHorizontalIcon className="size-3.5" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>More actions</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align={align}>
					{onOpenDetails && (
						<DropdownMenuItem
							onClick={() => onOpenDetails(story.id)}
						>
							<ExternalLink className="mr-2 size-4" />
							Open details
						</DropdownMenuItem>
					)}
					<DropdownMenuItem
						onClick={(e) => {
							e.stopPropagation();
							openInNewTab();
						}}
					>
						<ExternalLink className="mr-2 size-4" />
						Open in new tab
					</DropdownMenuItem>

					<DropdownMenuSeparator />

					<DropdownMenuSub>
						<DropdownMenuSubTrigger
							onClick={(e) => e.stopPropagation()}
						>
							<FlagIcon className="mr-2 size-4" />
							Change priority
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							{PRIORITY_OPTIONS.map((opt) => {
								const isCurrent = story.priority === opt.value;
								return (
									<DropdownMenuItem
										key={opt.value}
										disabled={
											isCurrent ||
											changePriorityMutation.isPending
										}
										onClick={(e) => {
											e.stopPropagation();
											changePriorityMutation.mutate(
												opt.value,
											);
										}}
									>
										<span
											className="mr-2 size-2 shrink-0 rounded-full"
											style={{
												backgroundColor: opt.color,
											}}
										/>
										<span>{opt.label}</span>
										{isCurrent ? (
											<CheckIcon className="ml-auto size-4" />
										) : null}
									</DropdownMenuItem>
								);
							})}
							{/* The per-item AI pass — applies immediately, this
							    item only (never weighed against the list; that is
							    the roadmap's Re-prioritize button). Hidden,
							    declined and completed items can't be re-assessed
							    (the server refuses them), so no dead entry. */}
							{aiReassessEligible && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										disabled={
											aiReprioritizeMutation.isPending
										}
										onClick={(e) => {
											e.stopPropagation();
											aiReprioritizeMutation.mutate({
												storyId: story.id,
												withListContext: false,
											});
										}}
									>
										<SparklesIcon className="mr-2 size-4 text-secondary" />
										<span>Re-assess priority with AI</span>
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuSubContent>
					</DropdownMenuSub>

					<DropdownMenuItem
						onClick={(e) => {
							e.stopPropagation();
							setConvertDialogOpen(true);
						}}
					>
						<ArrowLeftRightIcon className="mr-2 size-4" />
						{story.kind === "BUG"
							? "Change to feature"
							: "Change to bug"}
					</DropdownMenuItem>

					<DropdownMenuItem
						disabled={closeReopenMutation.isPending}
						onClick={(e) => {
							e.stopPropagation();
							closeReopenMutation.mutate(
								isClosed ? "DRAFT" : "CLOSED",
							);
						}}
					>
						{isClosed ? (
							<RotateCcwIcon className="mr-2 size-4" />
						) : (
							<CircleSlashIcon className="mr-2 size-4" />
						)}
						{isClosed
							? story.kind === "BUG"
								? "Unhide bug"
								: "Unhide feature"
							: story.kind === "BUG"
								? "Hide bug"
								: "Hide feature"}
					</DropdownMenuItem>

					{onDelete && (
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								onDelete(story.id);
							}}
							className="text-destructive"
						>
							<Trash2Icon className="mr-2 size-4" />
							Delete
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<ConvertKindConfirmDialog
				open={convertDialogOpen}
				onOpenChange={setConvertDialogOpen}
				targetKind={targetKind}
				isPending={convertKindMutation.isPending}
				onConfirm={() => convertKindMutation.mutate()}
			/>
		</>
	);
}

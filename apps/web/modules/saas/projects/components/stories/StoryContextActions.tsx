"use client";

import { useAnalytics } from "@analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ui/components/context-menu";
import {
	CircleSlashIcon,
	ExternalLinkIcon,
	FlagIcon,
	GitBranchIcon,
	RotateCcwIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { BACKLOG_CONTEXT_MENU_EVENT } from "../../../../analytics/events/backlog-context-menu";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import {
	coverageBlockedToastMessage,
	MATURATION_STATUS_META,
	MATURATION_STATUS_OPTIONS,
	type MaturationStatus,
	PRIORITY_OPTIONS,
	type UserStory,
} from "../../lib/stories/types";
import { useAiReassessEligibility } from "./priority/useAiReassessEligibility";
import { useAiReprioritizeStory } from "./priority/useAiReprioritizeStory";

type PriorityValue = "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";

/** Bulk operations on the CURRENT selection, applied when this row is one of a
 * multi-selection (the right-click then targets the whole selection). */
export type StoryBulkActions = {
	setPriority: (priority: PriorityValue) => void;
	setStage: (stage: MaturationStatus) => void;
	hide: () => void;
	show: () => void;
	requestDelete: () => void;
};

/**
 * The right-click (context) menu for a roadmap work item, shared by the table
 * row and the board tile. Self-contained: it owns its single-item priority /
 * stage / hide-show mutations, so any surface can drop it inside a
 * `<ContextMenu>` without threading mutation wiring through props.
 *
 * When `bulkMode` is true (this row is part of a multi-selection) every action
 * runs against the whole selection via `bulkActions`; otherwise it acts on this
 * one story.
 */
export function StoryContextActions({
	story,
	projectId,
	organizationId,
	basePath = "/app",
	onDelete,
	bulkMode = false,
	selectedCount = 0,
	bulkActions,
}: {
	story: UserStory;
	projectId: string;
	organizationId?: string | null;
	basePath?: string;
	onDelete?: (id: string) => void;
	bulkMode?: boolean;
	selectedCount?: number;
	bulkActions?: StoryBulkActions;
}) {
	const queryClient = useQueryClient();
	const analytics = useAnalytics();
	const isClosed = story.draftingStage === "CLOSED";
	const storiesListQueryKey = orpc.projects.stories.list.queryKey({
		input: { projectId, organizationId: organizationId ?? null },
	});

	const patchStage = (targetStage: MaturationStatus) => {
		queryClient.setQueryData<{ stories: UserStory[] } | undefined>(
			storiesListQueryKey,
			(old) =>
				!old || !Array.isArray(old.stories)
					? old
					: {
							...old,
							stories: old.stories.map((s) =>
								s.id === story.id
									? { ...s, maturationStatus: targetStage }
									: s,
							),
						},
		);
	};

	const changePriorityMutation = useMutation({
		mutationFn: async (priority: PriorityValue) =>
			orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				priority,
			}),
		onSuccess: (_d, priority) => {
			toast.success(
				`Priority changed to ${
					PRIORITY_OPTIONS.find((p) => p.value === priority)?.label ??
					priority
				}`,
			);
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
		onError: (error) =>
			toast.error("Failed to change priority", {
				description: (error as Error).message,
			}),
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

	const changeStageMutation = useMutation({
		mutationFn: async (targetStage: MaturationStatus) =>
			orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				maturationStatus: targetStage,
			}),
		onMutate: async (targetStage: MaturationStatus) => {
			await queryClient.cancelQueries({ queryKey: storiesListQueryKey });
			const previousList = queryClient.getQueryData(storiesListQueryKey);
			patchStage(targetStage);
			return { previousList };
		},
		onError: (error, _vars, context) => {
			if (context?.previousList !== undefined) {
				queryClient.setQueryData(
					storiesListQueryKey,
					context.previousList,
				);
			}
			const coverageMessage = coverageBlockedToastMessage(error);
			if (coverageMessage) {
				toast.error("Can't mark Requirements Complete yet", {
					description: coverageMessage,
				});
			} else {
				toast.error("Failed to update", {
					description: (error as Error).message,
				});
			}
		},
		onSuccess: (_d, targetStage) => {
			toast.success(
				`Moved to ${MATURATION_STATUS_META[targetStage]?.label ?? targetStage}`,
			);
		},
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey }),
	});

	const toggleHiddenMutation = useMutation({
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
				(old) =>
					!old || !Array.isArray(old.stories)
						? old
						: {
								...old,
								stories: old.stories.map((s) =>
									s.id === story.id
										? { ...s, draftingStage: targetStage }
										: s,
								),
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
			toast.error("Failed to update visibility", {
				description: (error as Error).message,
			});
		},
		onSuccess: (_d, targetStage) => {
			toast.success(
				targetStage === "CLOSED"
					? "Feature hidden"
					: "Feature unhidden",
			);
		},
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey }),
	});

	const openInNewTab = () => {
		// Silent no-op until inputs resolve (FR-13) + emit the same context-menu
		// analytics the table/board middle-click path does. Uses the about:blank
		// PWA workaround (mirrors StoryCard): open a blank same-origin tab first so
		// the URL isn't captured into the installed PWA window, null the opener for
		// security, then navigate. Silent if popup-blocked (window.open === null).
		if (!projectId || !story.id) {
			return;
		}
		const url = buildStoryDetailsRoute(basePath, projectId, story.id);
		const w = window.open("about:blank", "_blank");
		if (!w) {
			return;
		}
		w.opener = null;
		w.location.href = url;
		analytics.trackEvent(BACKLOG_CONTEXT_MENU_EVENT, {
			trigger: "context-menu",
		});
	};

	const pickPriority = (p: PriorityValue) =>
		bulkMode
			? bulkActions?.setPriority(p)
			: changePriorityMutation.mutate(p);
	const pickStage = (s: MaturationStatus) =>
		bulkMode ? bulkActions?.setStage(s) : changeStageMutation.mutate(s);

	return (
		<ContextMenuContent className="w-56">
			{bulkMode ? (
				<>
					<ContextMenuLabel className="text-muted-foreground">
						{selectedCount} selected
					</ContextMenuLabel>
					<ContextMenuSeparator />
				</>
			) : (
				<>
					<ContextMenuItem onSelect={openInNewTab}>
						<ExternalLinkIcon className="mr-2 size-4" />
						Open in new tab
					</ContextMenuItem>
					<ContextMenuSeparator />
				</>
			)}

			<ContextMenuSub>
				<ContextMenuSubTrigger>
					<FlagIcon className="mr-2 size-4" />
					Priority
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					{PRIORITY_OPTIONS.map((opt) => (
						<ContextMenuItem
							key={opt.value}
							onSelect={() => pickPriority(opt.value)}
						>
							<span
								className="mr-2 size-2 shrink-0 rounded-full"
								style={{ backgroundColor: opt.color }}
							/>
							{opt.label}
						</ContextMenuItem>
					))}
					{/* The per-item AI pass — this item only (never weighed
					    against the list; that is the roadmap's Re-prioritize
					    button). Single-item semantics, so hidden in bulk mode;
					    hidden, declined and completed items can't be re-assessed
					    (the server refuses them), so no dead entry. */}
					{!bulkMode && aiReassessEligible && (
						<>
							<ContextMenuSeparator />
							<ContextMenuItem
								disabled={aiReprioritizeMutation.isPending}
								onSelect={() =>
									aiReprioritizeMutation.mutate({
										storyId: story.id,
										withListContext: false,
									})
								}
							>
								<SparklesIcon className="mr-2 size-4 text-secondary" />
								Re-assess priority with AI
							</ContextMenuItem>
						</>
					)}
				</ContextMenuSubContent>
			</ContextMenuSub>

			<ContextMenuSub>
				<ContextMenuSubTrigger>
					<GitBranchIcon className="mr-2 size-4" />
					Stage
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					{MATURATION_STATUS_OPTIONS.map((s) => (
						<ContextMenuItem key={s} onSelect={() => pickStage(s)}>
							<span
								className="mr-2 size-2 shrink-0 rounded-full"
								style={{
									backgroundColor:
										MATURATION_STATUS_META[s]?.color,
								}}
							/>
							{MATURATION_STATUS_META[s]?.label ?? s}
						</ContextMenuItem>
					))}
				</ContextMenuSubContent>
			</ContextMenuSub>

			{bulkMode ? (
				<>
					<ContextMenuItem onSelect={() => bulkActions?.hide()}>
						<CircleSlashIcon className="mr-2 size-4" />
						Hide
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => bulkActions?.show()}>
						<RotateCcwIcon className="mr-2 size-4" />
						Show
					</ContextMenuItem>
				</>
			) : (
				<ContextMenuItem
					onSelect={() =>
						toggleHiddenMutation.mutate(
							isClosed ? "DRAFT" : "CLOSED",
						)
					}
				>
					{isClosed ? (
						<RotateCcwIcon className="mr-2 size-4" />
					) : (
						<CircleSlashIcon className="mr-2 size-4" />
					)}
					{isClosed ? "Show" : "Hide"}
				</ContextMenuItem>
			)}

			<ContextMenuSeparator />

			<ContextMenuItem
				className="text-destructive focus:text-destructive"
				onSelect={() =>
					bulkMode
						? bulkActions?.requestDelete()
						: onDelete?.(story.id)
				}
			>
				<Trash2Icon className="mr-2 size-4" />
				Delete{bulkMode ? ` ${selectedCount}` : ""}
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

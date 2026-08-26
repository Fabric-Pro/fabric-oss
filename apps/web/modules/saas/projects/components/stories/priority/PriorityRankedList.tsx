"use client";

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	type Modifier,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	BugIcon,
	RotateCcwIcon,
	WandSparklesIcon,
	ZapIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../../shared/lib/orpc-client";
import {
	hasManualOrder,
	hasNoRankingSignal,
	rankStories,
	toPriorityRankInput,
} from "../../../lib/priority-ranking";
import {
	buildProjectProposalRoute,
	buildStoryDecisionLogRoute,
	buildStoryDetailsRoute,
} from "../../../lib/stories/routes";
import type {
	StoryKind,
	StoryPriority,
	UserStory,
} from "../../../lib/stories/types";
import { Segmented } from "../Segmented";
import { PriorityHelp } from "./PriorityHelp";
import { PriorityRow } from "./PriorityRow";
import { type PriorityRunChange, PriorityRunDigest } from "./PriorityRunDigest";
import {
	REPRIORITIZE_ASK_THRESHOLD,
	ReprioritizeScopeDialog,
} from "./ReprioritizeScopeDialog";
import { useSetStoryPriority } from "./useSetStoryPriority";

/**
 * Mirrors the batched procedure's own limit. Anything past this is ranked as if
 * it had zero open questions, which is indistinguishable from genuinely having
 * none — so when it bites, the list says so rather than quietly mis-ranking the
 * tail. Raised from 500 once the server stopped computing counts by fetching
 * every open row's text.
 */
const MAX_DECISION_COUNT_IDS = 2000;

/**
 * Mirrors the server's `STORY_UPDATE` gate (EDITOR and above). `getProjectRole`
 * lowercases what it returns, but a couple of call sites see the raw enum, so
 * compare case-insensitively — same set the rest of ProjectDetails uses.
 */
const EDIT_ROLES: ReadonlySet<string> = new Set([
	"owner",
	"admin",
	"project_admin",
	"editor",
]);

function canEditStories(userRole: string | null | undefined): boolean {
	return (
		typeof userRole === "string" && EDIT_ROLES.has(userRole.toLowerCase())
	);
}

/** The list is strictly vertical, so horizontal drift is only ever noise.
 * Inline rather than pulling in `@dnd-kit/modifiers` for four lines. */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
	...transform,
	x: 0,
});

/** Shared fallback for rows with no open questions — the common case. An
 * inline `?? []` would mint a fresh array per row per render and defeat every
 * row's memo through the shallow prop compare. */
const NO_QUESTIONS: never[] = [];

type Props = {
	projectId: string;
	organizationId: string | null;
	basePath: string;
	/** Roadmap-filtered stories, so the layout composes with the filter panel. */
	stories: UserStory[];
	/** All active roadmap items (declined/hidden excluded), IGNORING filters —
	 * the "entire roadmap" set the re-prioritize scope dialog offers when the
	 * view is filtered. Same shape as `stories`; the parent passes both. */
	allStories: UserStory[];
	/** Reordering while filtered would pin a partial list — the roadmap blocks
	 * the same gesture for the same reason. */
	hasActiveFilters: boolean;
};

export function PriorityRankedList({
	projectId,
	organizationId,
	basePath,
	stories,
	allStories,
	hasActiveFilters,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const queryClient = useQueryClient();
	const [kind, setKind] = useState<StoryKind>("FEATURE");
	const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	/** Open when a list-wide run needs a scope choice (filters active) or a
	 * cap caution (>100 items) before it fires. */
	const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
	/** The last re-prioritization run's moves, shown as a review-and-revert
	 * digest right after the run. Null = no digest open. */
	const [runDigest, setRunDigest] = useState<{
		changes: PriorityRunChange[];
		considered: number;
		truncated: boolean;
	} | null>(null);
	/** Stable focus target when "Restore suggested order" unmounts itself. */
	const reprioritizeButtonRef = useRef<HTMLButtonElement>(null);

	// Reordering is STORY_UPDATE server-side. Mirror that in the UI from the
	// project's own role — showing a read-only member a grab handle that always
	// snaps back with a FORBIDDEN toast is a broken affordance, not a safeguard.
	// Shares `projects.get`'s query key with the roadmap, so no extra request.
	const { data: projectData } = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const canEdit = canEditStories(projectData?.project?.userRole);
	// A partial list cannot be pinned coherently: the write assigns 1..n over
	// what is visible, so hidden peers would inherit meaningless ranks.
	const canReorder = canEdit && !hasActiveFilters;

	// Ranking is by whole days, so a fixed timestamp keeps the order stable for
	// the life of the view instead of re-sorting on every render.
	const [now] = useState(() => Date.now());

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	// Completion mirrors the work item's real status rather than a separate
	// marker — a story in a final status IS done. Shares the roadmap's query
	// key, so React Query dedupes this into the request already in flight.
	const { data: statusesData } = useQuery(
		orpc.projects.stories.statuses.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const finalStatusIds = useMemo(
		() =>
			new Set(
				(statusesData?.statuses ?? [])
					.filter((status) => status.isFinal)
					.map((status) => status.id),
			),
		[statusesData?.statuses],
	);

	const storiesOfKind = useMemo(
		() => stories.filter((story) => story.kind === kind),
		[stories, kind],
	);
	/** The unfiltered "entire roadmap" set for the current kind — the alternative
	 * scope the dialog offers when filters are narrowing the view. */
	const allOfKind = useMemo(
		() => allStories.filter((story) => story.kind === kind),
		[allStories, kind],
	);

	// Sorted so the React Query key is keyed on the id SET, not the order.
	// `stories` arrives in the roadmap's display order, so without this a
	// re-sort mints a new key for an identical set — re-running the query and
	// blanking the counts, which transiently re-ranks every row at zero. The
	// response is a record keyed by story id, so order carries no meaning.
	// Same fix as `insightsKey` below, one layer down.
	const decisionCountIds = useMemo(
		() =>
			storiesOfKind
				.slice(0, MAX_DECISION_COUNT_IDS)
				.map((s) => s.id)
				.sort(),
		[storiesOfKind],
	);

	const decisionCountsTruncated =
		storiesOfKind.length > MAX_DECISION_COUNT_IDS;

	const { data: decisionData } = useQuery({
		...orpc.projects.stories.openDecisions.queryOptions({
			input: { projectId, organizationId, storyIds: decisionCountIds },
		}),
		enabled: decisionCountIds.length > 0,
		staleTime: 60 * 1000,
	});

	const ranked = useMemo(() => {
		const counts = decisionData?.counts ?? {};
		return rankStories(
			storiesOfKind.map((story) =>
				toPriorityRankInput(story, {
					isComplete: finalStatusIds.has(story.statusId),
					openDecisions: counts[story.id] ?? 0,
				}),
			),
			now,
		);
	}, [storiesOfKind, decisionData, finalStatusIds, now]);

	// Memoised because it anchors useCallback deps below — `queryKey` mints a
	// fresh array per call, and an unstable key would ripple a new identity
	// into every callback that lists it, defeating the rows' memo.
	const storiesQueryKey = useMemo(
		() =>
			orpc.projects.stories.list.queryKey({
				input: { projectId, organizationId },
			}),
		[projectId, organizationId],
	);

	const reorderMutation = useMutation({
		mutationFn: (storyOrders: { id: string; priorityOrder: number }[]) =>
			orpcClient.projects.stories.reorderPriority({
				projectId,
				organizationId,
				storyOrders,
			}),
		onMutate: async (storyOrders) => {
			await queryClient.cancelQueries({ queryKey: storiesQueryKey });
			const previous = queryClient.getQueryData(storiesQueryKey);
			const pinned = new Map(
				storyOrders.map((o) => [o.id, o.priorityOrder]),
			);
			queryClient.setQueryData(storiesQueryKey, (old) => {
				if (!old) {
					return old;
				}
				return {
					...old,
					stories: old.stories.map((story) =>
						pinned.has(story.id)
							? {
									...story,
									priorityOrder: pinned.get(story.id) ?? null,
								}
							: story,
					),
				};
			});
			return { previous };
		},
		onError: (error, _vars, context) => {
			queryClient.setQueryData(storiesQueryKey, context?.previous);
			toast.error(t("reorderFailed"), {
				description: (error as Error).message,
			});
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: storiesQueryKey });
		},
	});

	const resetMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.stories.resetPriorityOrder({
				projectId,
				organizationId,
				kind,
			}),
		onSuccess: (result) => {
			toast.success(
				result.cleared === 0
					? t("resetAlreadySuggested")
					: t("resetRestored"),
			);
			// This button unmounts once the refetch lands (nothing is pinned any
			// more) — park keyboard focus on its stable neighbor first.
			reprioritizeButtonRef.current?.focus();
			queryClient.invalidateQueries({ queryKey: storiesQueryKey });
		},
		onError: (error) => {
			toast.error(t("resetFailed"), {
				description: (error as Error).message,
			});
		},
	});

	/** Invalidate everything a band change can have moved: the list itself (the
	 * band and its `priorityChangedAt` stamp) and every open row's history. */
	const invalidateAfterPriorityWrite = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: storiesQueryKey });
		queryClient.invalidateQueries({
			queryKey: orpc.projects.stories.priorityHistory.key(),
		});
	}, [queryClient, storiesQueryKey]);

	/** After a row's AI sparkle applied a band: only this view's list — the
	 * hook already refreshed the priority-history caches, and re-invalidating
	 * them here would cancel-and-reissue every open trail's request. Stable by
	 * construction (memoised key), which the rows' memo depends on. */
	const handleAiApplied = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: storiesQueryKey });
	}, [queryClient, storiesQueryKey]);

	const setPriorityMutation = useSetStoryPriority({
		projectId,
		organizationId,
		onSaved: () => {
			// Only this view's list — the hook already refreshed the
			// priority-history caches.
			queryClient.invalidateQueries({ queryKey: storiesQueryKey });
		},
	});

	const reprioritizeMutation = useMutation({
		mutationFn: (storyIds: string[]) =>
			orpcClient.projects.stories.reprioritize({
				projectId,
				organizationId,
				storyIds,
			}),
		onSuccess: (result) => {
			if (result.changed.length === 0) {
				// "Nothing changed" is a real, common and GOOD outcome here — the
				// prompt tells the model to leave well-set priorities alone.
				// Saying so plainly stops it reading as a silent failure.
				toast.success(
					t("reprioritizeNoChanges", { count: result.considered }),
					result.truncated
						? { description: t("reprioritizeTruncated") }
						: undefined,
				);
			} else {
				// Moves get the digest instead of a toast: which items, from
				// what to what, why — each revertible on the spot. A toast
				// saying "changed 5" while leaving the which/why to a chip
				// hunt was the review's core trust complaint.
				setRunDigest({
					changes: result.changed,
					considered: result.considered,
					truncated: result.truncated,
				});
			}
			invalidateAfterPriorityWrite();
		},
		onError: (error) => {
			toast.error(t("reprioritizeFailed"), {
				description: (error as Error).message,
			});
		},
	});

	/** Fire the list-wide run over the chosen scope's ids, then close the
	 * dialog. Guarded on pending for the same focus-retention reason as the
	 * button below. */
	const runReprioritize = useCallback(
		(scope: "filtered" | "entire") => {
			if (reprioritizeMutation.isPending) {
				return;
			}
			const ids = (scope === "entire" ? allOfKind : storiesOfKind).map(
				(story) => story.id,
			);
			reprioritizeMutation.mutate(ids);
			setScopeDialogOpen(false);
		},
		[
			reprioritizeMutation.mutate,
			reprioritizeMutation.isPending,
			allOfKind,
			storiesOfKind,
		],
	);

	/** The Re-prioritize button's entry point: run straight away only when the
	 * choice is unambiguous and the list is small (no filters, at/below the ask
	 * threshold). Otherwise defer to the dialog to confirm the whole-list run,
	 * offer the filtered-vs-entire choice, and/or show the ceiling caution. */
	const handleReprioritizeClick = useCallback(() => {
		if (reprioritizeMutation.isPending) {
			return;
		}
		if (
			!hasActiveFilters &&
			storiesOfKind.length <= REPRIORITIZE_ASK_THRESHOLD
		) {
			reprioritizeMutation.mutate(storiesOfKind.map((story) => story.id));
			return;
		}
		setScopeDialogOpen(true);
	}, [
		reprioritizeMutation.mutate,
		reprioritizeMutation.isPending,
		hasActiveFilters,
		storiesOfKind,
	]);

	const handleSavePriority = useCallback(
		(storyId: string, priority: StoryPriority, comment: string) => {
			setPriorityMutation.mutate({ storyId, priority, comment });
		},
		// `.mutate` — NOT the mutation object. useMutation returns a fresh
		// object every render, which would give every memoised row a new
		// callback identity and re-render the whole list on any state change;
		// `mutate` itself is referentially stable.
		[setPriorityMutation.mutate],
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id || !canReorder) {
			return;
		}

		const ids = ranked.map((item) => item.id);
		const from = ids.indexOf(String(active.id));
		const to = ids.indexOf(String(over.id));
		if (from < 0 || to < 0) {
			return;
		}

		// Pin the whole list, not just the moved row: a hand-placed sequence is
		// only meaningful if the items around it hold still too. "Restore
		// suggested order" clears every pin in one action.
		reorderMutation.mutate(
			arrayMove(ids, from, to).map((id, index) => ({
				id,
				priorityOrder: index + 1,
			})),
		);
	};

	// Stable identity so the memoised rows don't all re-render on every expand.
	const toggleExpanded = useCallback((storyId: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (!next.delete(storyId)) {
				next.add(storyId);
			}
			return next;
		});
	}, []);

	// One pass for the counts instead of two per render; and the derived flags
	// and the SortableContext id array all keep stable identities so a chevron
	// click doesn't walk the whole list several times over.
	const { featureCount, bugCount } = useMemo(() => {
		let features = 0;
		for (const story of stories) {
			if (story.kind === "FEATURE") {
				features += 1;
			}
		}
		return { featureCount: features, bugCount: stories.length - features };
	}, [stories]);

	const isPinned = useMemo(() => hasManualOrder(ranked), [ranked]);
	const noSignal = useMemo(() => hasNoRankingSignal(ranked), [ranked]);
	const sortableIds = useMemo(() => ranked.map((item) => item.id), [ranked]);

	// identifier/title lookup for the run digest — over ALL stories, so a
	// digest opened for features survives a switch to the bugs tab.
	const storyMeta = useMemo(
		() =>
			new Map(
				stories.map((story) => [
					story.id,
					{ identifier: story.identifier, title: story.title },
				]),
			),
		[stories],
	);

	// dnd-kit's defaults interpolate the raw ids, which here are cuids — a
	// screen-reader user would hear "picked up draggable item cmr6sg…".
	const dndAccessibility = useMemo(() => {
		const describe = (id: string | number | undefined) => {
			const index = ranked.findIndex((item) => item.id === String(id));
			if (index < 0) {
				return "item";
			}
			return `${ranked[index].story.identifier}, position ${index + 1} of ${ranked.length}`;
		};
		return {
			screenReaderInstructions: {
				draggable:
					"Press Space to pick up this work item, arrow keys to move it, Space to drop, Escape to cancel.",
			},
			announcements: {
				onDragStart: ({
					active,
				}: {
					active: { id: string | number };
				}) => `Picked up ${describe(active.id)}.`,
				onDragOver: ({
					over,
				}: {
					over: { id: string | number } | null;
				}) =>
					over
						? `Now over ${describe(over.id)}.`
						: "No longer over a position.",
				onDragEnd: ({
					over,
				}: {
					over: { id: string | number } | null;
				}) =>
					over
						? `Dropped at ${describe(over.id)}.`
						: "Dropped. Order unchanged.",
				onDragCancel: ({
					active,
				}: {
					active: { id: string | number };
				}) =>
					`Cancelled. ${describe(active.id)} returned to its position.`,
			},
		};
	}, [ranked]);

	return (
		<div className="p-3">
			<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
				<div className="w-full sm:w-[260px]">
					<Segmented<StoryKind>
						label={t("typeLabel")}
						value={kind}
						onChange={setKind}
						options={[
							{
								value: "FEATURE",
								label: t("featuresOption", {
									count: featureCount,
								}),
								icon: <ZapIcon className="size-3.5" />,
							},
							{
								value: "BUG",
								label: t("bugsOption", { count: bugCount }),
								icon: <BugIcon className="size-3.5" />,
							},
						]}
					/>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<PriorityHelp />
					{canEdit && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									ref={reprioritizeButtonRef}
									type="button"
									size="sm"
									// Guard-not-disable while pending: disabling the
									// focused element drops keyboard focus to
									// <body>. The label change + aria-busy carry
									// the state. Click opens the scope dialog, or
									// runs straight away when unambiguous.
									onClick={handleReprioritizeClick}
									aria-busy={reprioritizeMutation.isPending}
									disabled={storiesOfKind.length === 0}
								>
									<WandSparklesIcon
										aria-hidden
										className="mr-1.5 size-3.5"
									/>
									{reprioritizeMutation.isPending
										? t("reprioritizing")
										: t("reprioritize")}
								</Button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{t("reprioritizeTooltip", {
									count: storiesOfKind.length,
								})}
							</TooltipContent>
						</Tooltip>
					)}
					{isPinned && canEdit && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="sm"
									// Guard, not `disabled`: this button UNMOUNTS
									// when the reset lands (isPinned flips), so a
									// disable-then-unmount would strand keyboard
									// focus on <body> twice over. On success,
									// focus moves to the stable Re-prioritize
									// neighbor before the unmount.
									aria-busy={resetMutation.isPending}
									onClick={() => {
										if (resetMutation.isPending) {
											return;
										}
										resetMutation.mutate();
									}}
									// Label collapses below `sm`; without this the
									// icon-only button announces as just "button".
									aria-label={t("restoreSuggestedOrder")}
								>
									<RotateCcwIcon
										aria-hidden
										className="mr-1.5 size-3.5"
									/>
									<span className="hidden sm:inline">
										{t("restoreSuggestedOrder")}
									</span>
								</Button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{t("restoreSuggestedOrderTooltip")}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Pending-window announcement for the AI run: the button's name swap
			    alone is not reliably spoken (JAWS), and the digest then opens
			    unprompted seconds later — this ties the two together. */}
			<p aria-live="polite" className="sr-only">
				{reprioritizeMutation.isPending ? t("reprioritizing") : ""}
			</p>

			{/* A missing count is indistinguishable from a real zero, so past the
			    cap the tail would sink with no way to tell. Say so rather than
			    let the ranking quietly lie. */}
			{decisionCountsTruncated && (
				<p className="mb-2 text-muted-foreground text-xs">
					{t("countsTruncated", {
						cap: MAX_DECISION_COUNT_IDS.toLocaleString(),
						total: storiesOfKind.length.toLocaleString(),
					})}
				</p>
			)}

			{isPinned && (
				<p className="mb-2 text-muted-foreground text-xs">
					{t("pinnedNote")}
				</p>
			)}

			{noSignal && !isPinned && (
				<p className="mb-2 text-muted-foreground text-xs">
					{t("noSignalNote")}
				</p>
			)}

			{/* Say why the handles are gone, rather than letting a drag fail. */}
			{canEdit && hasActiveFilters && ranked.length > 0 && (
				<p className="mb-2 text-muted-foreground text-xs">
					{t("filteredReorderNote")}
				</p>
			)}

			{runDigest && (
				<PriorityRunDigest
					open
					onOpenChange={(open) => {
						if (!open) {
							setRunDigest(null);
						}
					}}
					changes={runDigest.changes}
					considered={runDigest.considered}
					truncated={runDigest.truncated}
					pinned={isPinned}
					storyMeta={storyMeta}
					projectId={projectId}
					organizationId={organizationId}
					onReverted={invalidateAfterPriorityWrite}
				/>
			)}

			<ReprioritizeScopeDialog
				open={scopeDialogOpen}
				onOpenChange={setScopeDialogOpen}
				filteredCount={storiesOfKind.length}
				entireCount={allOfKind.length}
				hasActiveFilters={hasActiveFilters}
				onConfirm={runReprioritize}
			/>

			{ranked.length === 0 ? (
				<div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
					<p className="max-w-sm text-muted-foreground text-sm">
						{kind === "BUG" ? t("emptyBugs") : t("emptyFeatures")}
					</p>
					{(kind === "BUG" ? featureCount : bugCount) > 0 && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() =>
								setKind(kind === "BUG" ? "FEATURE" : "BUG")
							}
						>
							{kind === "BUG"
								? t("emptySwitchToFeatures", {
										count: featureCount,
									})
								: t("emptySwitchToBugs", { count: bugCount })}
						</Button>
					)}
				</div>
			) : (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragEnd={handleDragEnd}
					accessibility={dndAccessibility}
					modifiers={[restrictToVerticalAxis]}
				>
					<SortableContext
						items={sortableIds}
						strategy={verticalListSortingStrategy}
					>
						<ol
							aria-label={
								kind === "BUG"
									? "Bugs by priority"
									: "Features by priority"
							}
							// No `overflow-hidden`: a dragged row is positioned, and
							// would be clipped against the container edge exactly
							// when it leaves the list.
							className="rounded-lg border border-border/60 [&>li:first-child]:rounded-t-lg [&>li:last-child]:rounded-b-lg"
						>
							{ranked.map((item, index) => (
								<PriorityRow
									key={item.id}
									rank={index + 1}
									total={ranked.length}
									story={item.story}
									openDecisions={item.openDecisions}
									isComplete={item.isComplete}
									detailsHref={buildStoryDetailsRoute(
										basePath,
										projectId,
										item.id,
									)}
									openQuestions={
										decisionData?.questions?.[item.id] ??
										NO_QUESTIONS
									}
									decisionLogHref={buildStoryDecisionLogRoute(
										basePath,
										projectId,
										item.id,
									)}
									proposalHref={
										item.story.createdFromProposalId
											? buildProjectProposalRoute(
													basePath,
													projectId,
													item.story
														.createdFromProposalId,
												)
											: null
									}
									canReorder={canReorder}
									expanded={expandedIds.has(item.id)}
									onToggleExpanded={toggleExpanded}
									projectId={projectId}
									organizationId={organizationId}
									canEdit={canEdit}
									isSavingPriority={
										setPriorityMutation.isPending &&
										setPriorityMutation.variables
											?.storyId === item.id
									}
									onSavePriority={handleSavePriority}
									onAiApplied={handleAiApplied}
								/>
							))}
						</ol>
					</SortableContext>
				</DndContext>
			)}
		</div>
	);
}

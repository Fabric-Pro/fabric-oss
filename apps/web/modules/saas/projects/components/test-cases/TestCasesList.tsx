"use client";

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
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
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CircleXIcon,
	DownloadIcon,
	InboxIcon,
	MinusCircleIcon,
	PlusIcon,
	SparklesIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AiDraftDialog } from "./AiDraftDialog";
import {
	BULK_ID_LIMIT,
	BulkActionsBar,
	type BulkSelection,
} from "./BulkActionsBar";
import {
	CasesEmpty,
	CasesNoMatches,
	CasesPagination,
	CasesTableHeader,
	CasesTableSkeleton,
} from "./CasesTable";
import { CasesToolbar } from "./CasesToolbar";
import {
	buildReorderPayload,
	canReorderCases,
	reorderBlocker,
} from "./case-reorder";
import { pageCount } from "./cases-table";
import { FeatureCoverageList } from "./FeatureCoverageList";
import { OpenQuestionsPanel } from "./OpenQuestionsPanel";
import { PmImportDialog } from "./PmImportDialog";
import { AgenticRunsPanel } from "./pipeline/AgenticRunsPanel";
import { PipelineRunsPanel } from "./pipeline/PipelineRunsPanel";
import { PullRequestReviewsPanel } from "./pr-review/PullRequestReviewsPanel";
import { SavedViewsMenu } from "./SavedViewsMenu";
import { SegmentAbout } from "./SegmentAbout";
import { SortableCaseRow } from "./SortableCaseRow";
import {
	clearSelection as clearSelectionState,
	escalateToAllMatching,
	isAllVisibleSelected,
	type SelectionState,
	toggleAllVisible,
	toggleSelection,
} from "./selection";
import { TableDisplayControls } from "./TableDisplayControls";
import { TestCaseEditorSheet } from "./TestCaseEditorSheet";
import { type CaseItem, TestCaseRow } from "./TestCaseRow";
import { TestingHealthLine } from "./TestingHealthLine";
import { TestPlanDetail } from "./TestPlanDetail";
import { TestPlansList } from "./TestPlansList";
import { attentionBuckets } from "./test-case-summary";
import { useActiveFilterChips } from "./use-active-filter-chips";
import { useMeasuredHeight } from "./use-measured-height";
import { useSavedViews } from "./use-saved-views";
import { useTableDisplay } from "./use-table-display";
import { useTestCaseSyncCapability } from "./use-test-case-sync-capability";
import {
	ALL,
	SEGMENTS,
	type Segment,
	toBulkFilter,
	useTestCasesView,
} from "./use-test-cases-view";

/** Icon per "needs attention" bucket, and the tone its chip wears. */
const ATTENTION_META = {
	failing: { Icon: CircleXIcon, tone: "text-destructive" },
	blocked: { Icon: TriangleAlertIcon, tone: "text-highlight" },
	proposed: { Icon: InboxIcon, tone: "text-primary" },
	notRun: { Icon: MinusCircleIcon, tone: "text-muted-foreground" },
} as const;

type Props = {
	projectId: string;
	/** Authorisation is resolved once by `ProjectDetails` and passed down, so the
	 * tab doesn't re-fetch the project just to gate its own controls. */
	canEdit: boolean;
	canDelete: boolean;
	/**
	 * Project-level "Generate manual test cases" switch. When off, the AI draft
	 * button is disabled here so the off-state reads as policy rather than as a
	 * server error. The server rejects a draft run regardless. Defaults on to
	 * match the schema.
	 */
	generateManualTestCases?: boolean;
};

export function TestCasesList({
	projectId,
	canEdit,
	canDelete,
	generateManualTestCases = true,
}: Props) {
	const t = useTranslations("projects.testCases");
	// On org routes the context yields `undefined` while loading; normalise to
	// `null` for the XOR-scoped queries (personal context is `null`).
	const { organizationId: orgIdRaw } = useOrganizationContext();
	const organizationId = orgIdRaw ?? null;

	const view = useTestCasesView(projectId, organizationId);
	const filterChips = useActiveFilterChips(view);
	// Row height + which columns this reader wants. Per-browser, not in the URL
	// — see the note in `use-table-display.ts`.
	const display = useTableDisplay(projectId);
	// Named filter/sort combinations, recalled in one click. Stored per browser
	// for the same reason the display preferences are — see `use-saved-views.ts`.
	const savedViews = useSavedViews(projectId);

	// The page head is sticky and its height changes with viewport width as the
	// title row wraps; the table's column header pins directly under it.
	const [headRef, headHeight] = useMeasuredHeight(160);

	// Native test-case sync capability — gates the bulk "Sync" control on whether
	// the connected tool holds native test cases (ADO / Xray / Zephyr / GitLab),
	// not merely generic work-item CRUD.
	const capability = useTestCaseSyncCapability(projectId);

	// Whether the connected PM tool can PULL native test cases AND a board is
	// selected — gates the "Import from PM" browse dialog.
	const { data: pmCaps } = useQuery({
		...orpc.projects.testCases.sync.pmCapabilities.queryOptions({
			input: { projectId },
		}),
		staleTime: 5 * 60_000,
		retry: false,
	});
	// The project's testing policy — read only for the coverage target the health
	// line and rings are measured against.
	const { data: qaSettings } = useQuery({
		...orpc.projects.qaSettings.get.queryOptions({ input: { projectId } }),
		staleTime: 5 * 60_000,
		retry: false,
	});
	const coverageTarget = qaSettings?.indexCoverageEnabled
		? qaSettings.coverageTarget
		: undefined;

	// One query for all six section badges rather than one per panel — see
	// `testingSectionCountsProcedure`.
	const { data: sectionCounts } = useQuery({
		...orpc.projects.testCases.sectionCounts.queryOptions({
			input: { projectId, organizationId },
		}),
		staleTime: 60_000,
	});

	const canImportFromPm =
		pmCaps?.capabilities?.supportsPull === true && !!pmCaps?.containerId;

	// Selected plan (Plans segment master/detail).
	const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

	// Editor + AI dialog.
	const [editorOpen, setEditorOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [aiOpen, setAiOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);

	// Deep-link: `?case=<id>` (e.g. from a work item's coverage popover) opens
	// that case's editor on arrival. Runs once for the initial param so later
	// manual opens/closes aren't fought by it.
	const searchParams = useSearchParams();
	useEffect(() => {
		const caseId = searchParams.get("case");
		if (caseId) {
			setEditingId(caseId);
			setEditorOpen(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Bulk selection. `selectAllMatching` escalates the ticked rows to "every row
	// the current filters match", including rows this browser never loaded.
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [selectAllMatching, setSelectAllMatching] = useState(false);

	// Rows render in SERVER order and from a SERVER page: sort and offset are
	// query params, so both hold across the whole result set. Sorting or slicing
	// the loaded rows here would only ever have described one page.
	const listQuery = useQuery(
		orpc.projects.testCases.list.queryOptions({
			input: {
				...view.listInput,
				limit: view.pageSize,
				offset: (view.page - 1) * view.pageSize,
				// Server-computed, state-independent summary (state mix /
				// automation / results) for the health line and the attention
				// chips — accurate across pagination, not just this page.
				includeSummary: true,
			},
			// Keeps the previous page on screen while the next one loads, so
			// paging does not flash an empty table between two full ones.
			placeholderData: (prev) => prev,
		}),
	);
	const items: CaseItem[] = listQuery.data?.items ?? [];
	const isLoading = listQuery.isLoading;
	const isError = listQuery.isError;

	const summary = listQuery.data?.summary;
	const totalAllStates = summary?.total ?? 0;
	/** How many rows match the ACTIVE filters (state included) — the "all N". */
	const total = listQuery.data?.total ?? 0;
	const stateCounts = summary?.stateCounts ?? {
		PROPOSED: 0,
		READY: 0,
		DRAFT: 0,
		CLOSED: 0,
	};

	/**
	 * A page past the end of the result set. Happens when the reader is on page 5
	 * and a case is deleted, or when a shared link outlives the rows it pointed
	 * at. Showing an empty table there reads as "no cases" for a project full of
	 * them, so send them back to the last real page instead.
	 */
	const pages = pageCount(total, view.pageSize);
	const { page, setPage } = view;
	const isFetching = listQuery.isFetching;
	useEffect(() => {
		if (!isFetching && total > 0 && page > pages) {
			setPage(pages);
		}
	}, [isFetching, total, pages, page, setPage]);

	// The predicate behind the current list, and a stable identity for it. Sort
	// is excluded by `toBulkFilter`, so re-ordering never counts as a new
	// predicate.
	const bulkFilter = useMemo(
		() => toBulkFilter(view.listInput),
		[view.listInput],
	);
	const filterKey = useMemo(() => JSON.stringify(bulkFilter), [bulkFilter]);

	// A selection must not outlive the predicate it was made under. The ticked
	// ids are no longer on screen, and — worse — "all N matching" would re-resolve
	// server-side against the NEW filters, applying to rows the reader never saw.
	// Keyed on the serialised predicate, so re-sorting (same matching set) does
	// NOT clear what the reader picked.
	useEffect(() => {
		setSelected(new Set());
		setSelectAllMatching(false);
	}, [filterKey]);

	const queryClient = useQueryClient();
	const visibleIds = useMemo(() => items.map((i) => i.id), [items]);

	// Manual reordering: only in the one view where a drag means what it looks
	// like. `order` is a single global column and this list is paginated and
	// filterable, so every gate matters — see `case-reorder.ts`.
	const reorderGate = {
		sort: view.sort,
		direction: view.direction,
		hasActiveFilters: view.hasActiveFilters,
		// With numbered pages, "there is more than this page" is the same gate
		// the infinite list expressed as `hasNextPage`.
		hasNextPage: pages > 1,
		canEdit,
	};
	const dragBlocker =
		canEdit && view.sort === "order" ? reorderBlocker(reorderGate) : null;

	const reorderMutation = useMutation(
		orpc.projects.testCases.reorder.mutationOptions({
			// Both outcomes re-read, and success needs it as much as failure.
			// There is no optimistic update here: rows render in SERVER order
			// from the query cache, and dnd-kit drops its transform on release.
			// So without this the row visibly SNAPS BACK while the write quietly
			// succeeds — the new order appearing later, on some unrelated
			// refetch. A correct backend behind a UI that looks broken is worse
			// than a visible failure.
			onSettled: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.list.key(),
				});
			},
			onError: (e) =>
				toast.error(t("toasts.reorderFailed", { error: e.message })),
		}),
	);

	// Locked while a reorder is in flight. There is no optimistic write, so the
	// cache still holds the PRE-drag order until the mutation settles — a second
	// drag started in that window renumbers the whole list from stale ids and
	// silently overwrites the first. No error, no toast, no rollback: the earlier
	// move just disappears. Locking removes the window rather than racing in it.
	const canDrag = canReorderCases(reorderGate) && !reorderMutation.isPending;

	const dragSensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		const from = visibleIds.indexOf(String(active.id));
		const to = visibleIds.indexOf(String(over.id));
		if (from === -1 || to === -1) {
			return;
		}
		reorderMutation.mutate({
			projectId,
			organizationId,
			orders: buildReorderPayload(arrayMove(visibleIds, from, to)),
		});
	};

	const allSelected = isAllVisibleSelected(
		{ selected, selectAllMatching },
		visibleIds,
	);
	const someSelected =
		selectAllMatching || visibleIds.some((id) => selected.has(id));

	const openCreate = () => {
		setEditingId(null);
		setEditorOpen(true);
	};
	const openEdit = (id: string) => {
		setEditingId(id);
		setEditorOpen(true);
	};

	/**
	 * Narrow the Cases list to one predicate and show it — pick a thing
	 * elsewhere, then read the cases that belong to it, landing on a toolbar chip
	 * the reader can remove.
	 *
	 * The plan detail's "View in Cases" is the only caller. The Coverage segment
	 * used to be the other, but its rows now open the work item itself; filtering
	 * the list by feature moved to the toolbar's own Feature filter.
	 */
	const showCasesFilteredBy = <K extends "linkedStoryId" | "planId">(
		key: K,
		id: string,
	) => {
		view.setFilters({ [key]: id });
		view.setSegment("cases");
	};

	// Every path that narrows or clears the selection drops the escalation: it
	// only ever describes "everything matching", never "everything but that one".
	// Transitions live in `selection.ts` so the escalation rules are unit-tested
	// without rendering the list.
	const applySelection = (next: SelectionState) => {
		setSelected(next.selected);
		setSelectAllMatching(next.selectAllMatching);
	};
	const clearSelection = () => applySelection(clearSelectionState());
	const toggleSelected = (id: string) =>
		applySelection(
			toggleSelection(
				{ selected, selectAllMatching },
				{ id, visibleIds },
			),
		);
	const toggleSelectAll = (checked: boolean) =>
		applySelection(toggleAllVisible({ visibleIds, checked }));

	const selection: BulkSelection = selectAllMatching
		? { mode: "filter", filter: bulkFilter }
		: { mode: "ids", ids: [...selected] };
	const selectionCount = selectAllMatching ? total : selected.size;
	// Offered when there is more to reach than the reader has loaded — and also
	// when the ticked set has outgrown the id cap, where escalating to the
	// predicate is the only way to express it at all.
	const canOfferSelectAllMatching =
		allSelected &&
		!selectAllMatching &&
		(total > items.length || selected.size > BULK_ID_LIMIT);

	const isCases = view.segment === "cases";
	const attention = summary ? attentionBuckets(summary) : [];

	/** The count badge for a section tab, or undefined when we have no number. */
	const segmentCount = (seg: Segment): number | undefined => {
		if (!sectionCounts) {
			return undefined;
		}
		switch (seg) {
			case "cases":
				return sectionCounts.cases;
			case "plans":
				return sectionCounts.plans;
			case "features":
				return sectionCounts.uncoveredFeatures;
			case "runs":
				return sectionCounts.runs;
			case "reviews":
				return sectionCounts.pullRequests;
			case "questions":
				return sectionCounts.questions;
			default: {
				const exhaustive: never = seg;
				return exhaustive;
			}
		}
	};

	/**
	 * Apply one attention bucket as a filter. Each is a real predicate the server
	 * understands, so the chip lands the reader on a page of exactly those rows
	 * rather than on a highlighted subset of the page they were on. Set as ONE
	 * navigation — result and state are both cleared so two chips pressed in
	 * turn don't compound into a predicate matching nothing.
	 */
	const applyAttention = (id: (typeof attention)[number]["id"]) => {
		if (id === "proposed") {
			view.setFilters({ state: "PROPOSED", currentResult: ALL });
			return;
		}
		view.setFilters({
			state: ALL,
			currentResult:
				id === "failing"
					? "FAILED"
					: id === "blocked"
						? "BLOCKED"
						: "NOT_RUN",
		});
	};

	return (
		<div
			className={cn(
				"min-h-[70vh]",
				// The bulk bar is fixed to the bottom of the viewport. Without
				// room reserved for it, scrolling to the end of a long table on a
				// short window puts it straight over the pagination controls.
				selectionCount > 0 && canEdit && "pb-24",
			)}
		>
			{/*
			 * Head + section tabs + toolbar pin as ONE block. They are the
			 * controls for the table below, and a reader scrolled to row 40 who
			 * wants to change a filter should not have to scroll back up to find
			 * one. Its measured height is what the table's column header pins to.
			 */}
			<div
				ref={headRef}
				className="sticky top-0 z-30 -mx-4 border-border border-b bg-background/92 px-4 backdrop-blur-sm sm:-mx-6 sm:px-6"
			>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
					<div className="flex items-center gap-1.5">
						<h2 className="font-serif text-2xl font-normal">
							{t("title")}
						</h2>
						<PageTourButton pageId="test-cases" />
					</div>

					{summary && summary.total > 0 && (
						<TestingHealthLine
							data-onboarding-target="test-cases-health"
							summary={summary}
							stateFiltered={view.filters.state !== ALL}
							coverageTarget={coverageTarget}
						/>
					)}

					{isCases && canEdit && (
						<div className="ml-auto flex flex-wrap items-center gap-2">
							{canImportFromPm && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => setImportOpen(true)}
								>
									<DownloadIcon
										className="mr-2 size-4"
										aria-hidden="true"
									/>
									{t("actions.importFromPm")}
								</Button>
							)}
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="inline-flex">
										<Button
											data-onboarding-target="test-cases-generate-ai"
											variant="outline"
											size="sm"
											onClick={() => setAiOpen(true)}
											disabled={!generateManualTestCases}
										>
											<SparklesIcon
												className="mr-2 size-4"
												aria-hidden="true"
											/>
											{t("actions.generateWithAi")}
										</Button>
									</span>
								</TooltipTrigger>
								{!generateManualTestCases && (
									<TooltipContent className="max-w-xs">
										{t("actions.generateWithAiOff")}
									</TooltipContent>
								)}
							</Tooltip>
							<Button
								data-onboarding-target="test-cases-new"
								size="sm"
								onClick={openCreate}
							>
								<PlusIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
								{t("actions.new")}
							</Button>
						</div>
					)}
				</div>

				{/* Section tabs. An underlined tab bar rather than a pill group:
				    six labels with counts do not fit a segmented control, and the
				    counts are the reason to look. The About sits at the far end —
				    it explains whichever section is selected, so it belongs beside
				    the control that selects it. */}
				<div className="flex items-center gap-2">
					{/*
					 * Buttons with `aria-pressed`, NOT role="tab". The ARIA tabs
					 * pattern promises arrow-key navigation and a tabpanel wired
					 * by aria-controls; announcing tab semantics without either
					 * puts a screen-reader user into a widget mode where the
					 * arrow keys they are told to use do nothing. Plain buttons
					 * in natural tab order are fully keyboard-operable and
					 * describe themselves honestly.
					 */}
					{/* biome-ignore lint/a11y/useSemanticElements: <fieldset> groups form controls; these are view switches */}
					<div
						data-onboarding-target="test-cases-segment"
						// A named group, not a tablist. `aria-label` on an element
						// with no role is dropped, so the name below was going
						// nowhere; `group` gives it somewhere to land without
						// promising the arrow-key navigation a tablist implies.
						//
						// The rule wants <fieldset>, which groups form CONTROLS.
						// These are view switches, not fields — a fieldset would
						// misdescribe them to exactly the readers the name is for.
						role="group"
						aria-label={t("segmentsAria")}
						className="-mb-px flex min-w-0 items-center gap-0.5 overflow-x-auto"
					>
						{SEGMENTS.map((seg) => {
							const active = view.segment === seg;
							const count = segmentCount(seg);
							return (
								// The same copy the About popover shows, on hover.
								// One source: a section cannot describe itself
								// differently in two places.
								<Tooltip key={seg}>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-pressed={active}
											onClick={() => {
												view.setSegment(seg);
												setSelectedPlanId(null);
											}}
											className={cn(
												"inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
												active
													? "border-primary text-foreground"
													: "border-transparent text-muted-foreground hover:text-foreground",
											)}
										>
											{t(`segments.${seg}`)}
											{count !== undefined && (
												<span
													className={cn(
														"rounded-full px-1.5 py-px text-[11px] tabular-nums",
														active
															? "bg-primary/12 text-primary"
															: "bg-muted text-muted-foreground",
													)}
												>
													{count}
												</span>
											)}
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="bottom"
										className="max-w-sm"
									>
										<span className="font-medium">
											{t(`about.${seg}.title`)}
										</span>
										<span className="mt-1 block text-muted-foreground leading-relaxed">
											{t(`about.${seg}.body`)}
										</span>
										{count !== undefined && (
											<span className="mt-1.5 block text-muted-foreground">
												{t(`segmentCountHint.${seg}`, {
													count,
												})}
											</span>
										)}
									</TooltipContent>
								</Tooltip>
							);
						})}
					</div>
					<SegmentAbout segment={view.segment} />
				</div>

				{isCases && (
					<div className="pt-1 pb-2.5">
						<div className="flex items-start gap-2">
							<div className="min-w-0 flex-1">
								<CasesToolbar
									view={view}
									projectId={projectId}
									organizationId={organizationId}
									stateCounts={stateCounts}
									totalAllStates={totalAllStates}
									shown={items.length}
									total={total}
								/>
							</div>
							<SavedViewsMenu
								controls={savedViews}
								currentSearch={searchParams.toString()}
								hasActiveFilters={view.hasActiveFilters}
								onApply={view.applyQuery}
								className="h-9 shrink-0"
							/>
							{/* Display preferences sit apart from the filters:
							    these change how the table LOOKS, not which rows
							    it matches, and only the filters belong in a
							    shared link. */}
							<TableDisplayControls
								controls={display}
								className="flex shrink-0 items-center gap-1.5"
							/>
						</div>
						{filterChips.length > 0 && (
							<div className="mt-2 flex flex-wrap items-center gap-1.5">
								{filterChips.map((chip) => (
									<span
										key={chip.id}
										className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/[0.08] py-0.5 pr-0.5 pl-2.5 text-sm"
									>
										<span className="text-muted-foreground text-xs">
											{chip.field}
										</span>
										<b className="font-medium">
											{chip.value}
										</b>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-5 text-muted-foreground"
											aria-label={t("filters.removeOne", {
												filter: chip.label,
											})}
											onClick={chip.onRemove}
										>
											<XIcon
												aria-hidden="true"
												className="size-3"
											/>
										</Button>
									</span>
								))}
								<Button
									type="button"
									variant="link"
									size="sm"
									className="h-auto p-0 text-muted-foreground text-xs"
									onClick={view.resetFilters}
								>
									{t("filters.clearAll")}
								</Button>
							</div>
						)}
					</div>
				)}
			</div>

			<div className="pt-4">
				{view.segment === "plans" ? (
					selectedPlanId ? (
						<TestPlanDetail
							projectId={projectId}
							organizationId={organizationId}
							planId={selectedPlanId}
							canEdit={canEdit}
							onBack={() => setSelectedPlanId(null)}
							onOpenCase={openEdit}
							onViewInCases={(planId) =>
								showCasesFilteredBy("planId", planId)
							}
						/>
					) : (
						<TestPlansList
							projectId={projectId}
							organizationId={organizationId}
							canEdit={canEdit}
							onSelectPlan={setSelectedPlanId}
						/>
					)
				) : view.segment === "features" ? (
					<FeatureCoverageList projectId={projectId} />
				) : view.segment === "reviews" ? (
					<PullRequestReviewsPanel
						projectId={projectId}
						canEdit={canEdit}
					/>
				) : view.segment === "questions" ? (
					<OpenQuestionsPanel
						projectId={projectId}
						organizationId={organizationId}
						canEdit={canEdit}
					/>
				) : view.segment === "runs" ? (
					<div className="space-y-6">
						{/*
						 * Fabric's own runs first, then the CI runs it ingested. Two
						 * panels rather than one list: "did Fabric's run of my cases
						 * pass" and "did the customer's pipeline pass" are different
						 * questions, and merging them would leave the provider column
						 * as the only thing telling them apart.
						 *
						 * Selection is reused from the Cases segment rather than
						 * duplicated — the cases someone ticked there are the ones they
						 * mean here.
						 */}
						<AgenticRunsPanel
							projectId={projectId}
							selection={selection}
							selectionCount={selectionCount}
							canRun={canEdit}
						/>
						<PipelineRunsPanel
							projectId={projectId}
							organizationId={organizationId}
							onSelectCase={(caseId) => {
								setEditingId(caseId);
								setEditorOpen(true);
							}}
						/>
					</div>
				) : (
					<>
						{/* Needs attention. The work that was previously only
						    findable by knowing which filter to reach for. */}
						{attention.length > 0 && (
							<div
								data-onboarding-target="test-cases-attention"
								className="mb-3.5 flex flex-wrap items-center gap-2"
							>
								<span className="app-editorial-label">
									{t("attention.label")}
								</span>
								{attention.map(({ id, count }) => {
									const { Icon, tone } = ATTENTION_META[id];
									return (
										<Tooltip key={id}>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="h-7 gap-1.5 rounded-full text-xs"
													onClick={() =>
														applyAttention(id)
													}
												>
													<Icon
														aria-hidden="true"
														className={cn(
															"size-3.5",
															tone,
														)}
													/>
													{t(`attention.${id}`)}
													<b className="font-semibold tabular-nums">
														{count}
													</b>
												</Button>
											</TooltipTrigger>
											<TooltipContent className="max-w-xs">
												{t(`attention.${id}Hint`, {
													count,
												})}
											</TooltipContent>
										</Tooltip>
									);
								})}
							</div>
						)}

						{/*
						 * No horizontal-scroll wrapper here, deliberately. An
						 * element with `overflow-x: auto` computes `overflow-y`
						 * to `auto` as well, which makes it the nearest scroll
						 * container for the sticky column header inside it — the
						 * header then pins to a box that never scrolls and rides
						 * away with the rows. The grid is sized to fit at `lg`
						 * instead, and stacks below it, so nothing overflows.
						 */}
						{/*
						 * `@container`: the table's tiers key off THIS box, not the
						 * viewport. Sizing them against `lg` was wrong by the width
						 * of the sidebar — at a 1085px window the card is 800px wide
						 * while the row wanted 938px, so the last two columns were
						 * laid out past the card's right edge and clipped, with no
						 * scrollbar to reach them.
						 */}
						<div className="@container rounded-xl border bg-card">
							<div>
								<CasesTableHeader
									stickyTop={headHeight}
									selectable={canEdit}
									allSelected={allSelected}
									someSelected={someSelected}
									onToggleAll={toggleSelectAll}
									sort={view.sort}
									direction={view.direction}
									onSort={view.selectSort}
									onToggleDirection={() =>
										view.setDirection(
											view.direction === "asc"
												? "desc"
												: "asc",
										)
									}
									isHidden={display.isHidden}
									compact={display.density === "compact"}
								/>

								{isLoading ? (
									<CasesTableSkeleton />
								) : isError ? (
									<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
										<p className="text-muted-foreground text-sm">
											{t("errors.listFailed")}
										</p>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => listQuery.refetch()}
										>
											{t("errors.retry")}
										</Button>
									</div>
								) : items.length === 0 ? (
									view.hasActiveFilters ? (
										<CasesNoMatches
											totalInProject={
												sectionCounts?.cases ?? 0
											}
											activeFilters={filterChips}
											onClearAll={view.resetFilters}
										/>
									) : (
										<CasesEmpty
											canEdit={canEdit}
											onCreate={openCreate}
											onDraft={() => setAiOpen(true)}
											onImport={
												canImportFromPm
													? () => setImportOpen(true)
													: undefined
											}
										/>
									)
								) : (
									<DndContext
										sensors={dragSensors}
										collisionDetection={closestCenter}
										onDragEnd={handleDragEnd}
									>
										<SortableContext
											items={visibleIds}
											strategy={
												verticalListSortingStrategy
											}
											disabled={!canDrag}
										>
											<ul
												// Dims while the next page loads, so
												// a slow page reads as "loading"
												// rather than as the wrong rows.
												className={cn(
													"transition-opacity",
													listQuery.isFetching &&
														"opacity-60",
												)}
											>
												{items.map((item) =>
													canDrag ? (
														<SortableCaseRow
															key={item.id}
															id={item.id}
															label={t(
																"reorder.handleAria",
																{
																	identifier:
																		item.identifier,
																},
															)}
															item={item}
															selectable={canEdit}
															selected={
																selectAllMatching ||
																selected.has(
																	item.id,
																)
															}
															onToggleSelected={() =>
																toggleSelected(
																	item.id,
																)
															}
															canEdit={canEdit}
															canDelete={
																canDelete
															}
															onOpen={() =>
																openEdit(
																	item.id,
																)
															}
															projectId={
																projectId
															}
															organizationId={
																organizationId
															}
															compact={
																display.density ===
																"compact"
															}
															isHidden={
																display.isHidden
															}
														/>
													) : (
														<TestCaseRow
															key={item.id}
															item={item}
															selectable={canEdit}
															selected={
																selectAllMatching ||
																selected.has(
																	item.id,
																)
															}
															onToggleSelected={() =>
																toggleSelected(
																	item.id,
																)
															}
															canEdit={canEdit}
															canDelete={
																canDelete
															}
															onOpen={() =>
																openEdit(
																	item.id,
																)
															}
															projectId={
																projectId
															}
															organizationId={
																organizationId
															}
															compact={
																display.density ===
																"compact"
															}
															isHidden={
																display.isHidden
															}
														/>
													),
												)}
											</ul>
										</SortableContext>
									</DndContext>
								)}
							</div>

							{!isLoading && !isError && total > 0 && (
								<CasesPagination
									page={view.page}
									pageSize={view.pageSize}
									total={total}
									onPage={view.setPage}
									onPageSize={view.setPageSize}
								/>
							)}
						</div>

						{dragBlocker && (
							// Said out loud, and ANNOUNCED. Without the live region
							// a reader who chose "manual order" and sees no grips
							// concludes the feature is broken rather than that
							// their filter or direction is in the way — and a
							// screen-reader user gets nothing at all, because the
							// text simply appears.
							<output className="mt-2 block text-muted-foreground text-xs">
								{t(`reorder.blocked.${dragBlocker}`)}
							</output>
						)}

						<p className="mt-2.5 text-muted-foreground text-xs">
							{t("shareableViewHint")}
						</p>

						{/* `<output>` carries an implicit role="status", so
						    escalating to (or dropping) "all N matching" is
						    announced. */}
						{(canOfferSelectAllMatching || selectAllMatching) && (
							<output className="mt-2 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
								{selectAllMatching ? (
									<>
										<span>
											{t("bulk.allMatchingSelected", {
												total,
											})}
										</span>
										<Button
											variant="link"
											size="sm"
											className="h-auto p-0"
											onClick={clearSelection}
										>
											{t("bulk.clearSelection")}
										</Button>
									</>
								) : (
									<>
										<span>
											{t("bulk.loadedSelected", {
												count: items.length,
											})}
										</span>
										<Button
											variant="link"
											size="sm"
											className="h-auto p-0"
											onClick={() =>
												applySelection(
													escalateToAllMatching(),
												)
											}
										>
											{t("bulk.selectAllMatching", {
												total,
											})}
										</Button>
									</>
								)}
							</output>
						)}
					</>
				)}
			</div>

			{/*
			 * Bulk bar, pinned. It used to sit above the table, which meant a
			 * selection made at row 40 scrolled out of sight along with the only
			 * controls that could act on it — so the reader ticked rows and then
			 * had to scroll back up to find out what they could do with them.
			 */}
			{selectionCount > 0 && canEdit && (
				<div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
					<div className="pointer-events-auto max-w-full overflow-x-auto rounded-2xl border bg-card shadow-lg">
						<BulkActionsBar
							projectId={projectId}
							organizationId={organizationId}
							selection={selection}
							count={selectionCount}
							canDelete={canDelete}
							canPush={capability.canPush}
							unsupportedCopy={capability.unsupportedCopy}
							onDone={clearSelection}
						/>
					</div>
				</div>
			)}

			<TestCaseEditorSheet
				projectId={projectId}
				organizationId={organizationId}
				testCaseId={editingId}
				open={editorOpen}
				onOpenChange={setEditorOpen}
				canEdit={canEdit}
			/>
			<AiDraftDialog
				projectId={projectId}
				organizationId={organizationId}
				open={aiOpen}
				onOpenChange={setAiOpen}
			/>
			<PmImportDialog
				projectId={projectId}
				open={importOpen}
				onOpenChange={setImportOpen}
			/>

			{/* Paging keeps the old rows on screen, so the only signal a
			    screen-reader user would otherwise get is the row content
			    changing under them. */}
			{listQuery.isFetching && !isLoading && (
				<output className="sr-only">{t("loadingCases")}</output>
			)}
		</div>
	);
}

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
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { SearchInput } from "@ui/components/search-input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ChevronLeftIcon,
	GripVerticalIcon,
	ListFilterIcon,
	Loader2Icon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { STATE_I18N_KEY, type TestCaseState } from "./constants";
import { PlanFormDialog } from "./PlanFormDialog";
import { TestCaseStatusChip } from "./TestCaseStatusChip";
import { TestPlanRunner } from "./TestPlanRunner";

type CaseLink = {
	id: string;
	testCaseId: string;
	section: string | null;
	order: number;
	testCase: {
		id: string;
		identifier: string;
		title: string;
		state: string;
	};
};

type Props = {
	projectId: string;
	organizationId: string | null;
	planId: string;
	canEdit: boolean;
	onBack: () => void;
	/** Opens a case in the editor drawer the cases tab already owns. */
	onOpenCase: (testCaseId: string) => void;
	/** Shows the Cases segment narrowed to this plan. */
	onViewInCases: (planId: string) => void;
};

export function TestPlanDetail({
	projectId,
	organizationId,
	planId,
	canEdit,
	onBack,
	onOpenCase,
	onViewInCases,
}: Props) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();

	const planKey = orpc.projects.testCases.plans.get.queryKey({
		input: { projectId, planId, organizationId },
	});

	const { data, isLoading } = useQuery(
		orpc.projects.testCases.plans.get.queryOptions({
			input: { projectId, planId, organizationId },
		}),
	);
	type PlanGetData = typeof data;
	const plan = data?.plan;
	const caseLinks = useMemo<CaseLink[]>(
		() => (plan?.caseLinks ?? []) as CaseLink[],
		[plan?.caseLinks],
	);

	const refresh = () => queryClient.invalidateQueries({ queryKey: planKey });

	// Optimistically write a new case ordering into the plan cache so the rows
	// stay put on drop instead of snapping back to the server order until the
	// refetch lands. The row list renders by array index, so reordering the
	// cached array is enough. Returns the pre-change snapshot for rollback.
	const applyCaseLinksOptimistically = (
		nextLinks: CaseLink[],
	): PlanGetData => {
		const previous = queryClient.getQueryData<PlanGetData>(planKey);
		queryClient.setQueryData<PlanGetData>(planKey, (old) =>
			old?.plan
				? {
						...old,
						plan: {
							...old.plan,
							caseLinks: nextLinks as typeof old.plan.caseLinks,
						},
					}
				: old,
		);
		return previous;
	};

	const reorderMutation = useMutation(
		orpc.projects.testCases.plans.reorderCases.mutationOptions({
			onSuccess: refresh,
		}),
	);
	const removeMutation = useMutation(
		orpc.projects.testCases.plans.removeCase.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.removedFromPlan"));
				refresh();
			},
		}),
	);

	const { confirm } = useConfirmationAlert();
	const [editOpen, setEditOpen] = useState(false);
	const [runOpen, setRunOpen] = useState(false);

	// Delete the whole plan (not its cases). Confirm first — it's destructive and
	// drops every case membership; the test cases themselves are untouched. On
	// success, pop back to the plans list (the detail no longer exists).
	const deleteMutation = useMutation(
		orpc.projects.testCases.plans.delete.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.planDeleted"));
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.plans.list.key(),
				});
				onBack();
			},
			onError: (e) =>
				toast.error(t("toasts.planDeleteFailed", { error: e.message })),
		}),
	);

	const handleDelete = () => {
		if (!plan) {
			return;
		}
		confirm({
			title: t("plans.deleteTitle"),
			message: t("plans.deleteConfirm", { name: plan.name }),
			confirmLabel: t("plans.deleteCta"),
			cancelLabel: t("actions.cancel"),
			destructive: true,
			// `.mutate()` (not `mutateAsync`): the confirm provider does
			// `await onConfirm(); close()` with no try/catch, so a rejecting
			// mutateAsync would leave the dialog stuck open + log an unhandled
			// rejection on a failed delete. `.mutate()` never throws here — the
			// mutation's onError toasts the failure. Matches the app convention.
			onConfirm: () => {
				deleteMutation.mutate({
					projectId,
					organizationId,
					planId,
				});
			},
		});
	};

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		const from = caseLinks.findIndex((c) => c.id === active.id);
		const to = caseLinks.findIndex((c) => c.id === over.id);
		if (from === -1 || to === -1) {
			return;
		}
		const next = arrayMove(caseLinks, from, to);
		const previous = applyCaseLinksOptimistically(next);
		reorderMutation.mutate(
			{
				projectId,
				organizationId,
				planId,
				orders: next.map((c, i) => ({ id: c.id, order: i })),
			},
			{
				onError: (e) => {
					queryClient.setQueryData(planKey, previous);
					toast.error(
						t("toasts.reorderFailed", { error: e.message }),
					);
				},
			},
		);
	};

	// Remove a case from the plan optimistically; roll the cache back and toast
	// on failure so a rejected removal doesn't leave the row missing.
	const handleRemove = (link: CaseLink) => {
		const previous = applyCaseLinksOptimistically(
			caseLinks.filter((c) => c.id !== link.id),
		);
		removeMutation.mutate(
			{
				projectId,
				organizationId,
				planId,
				testCaseId: link.testCaseId,
			},
			{
				onError: (e) => {
					queryClient.setQueryData(planKey, previous);
					toast.error(
						t("toasts.removeFromPlanFailed", { error: e.message }),
					);
				},
			},
		);
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-16 text-muted-foreground">
				<Loader2Icon className="size-5 animate-spin" />
			</div>
		);
	}

	if (!plan) {
		return (
			<div className="space-y-4">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ChevronLeftIcon
						className="mr-1 size-4"
						aria-hidden="true"
					/>
					{t("planDetail.back")}
				</Button>
				<p className="text-muted-foreground text-sm">
					{t("planDetail.notFound")}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-5">
			<div>
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ChevronLeftIcon
						className="mr-1 size-4"
						aria-hidden="true"
					/>
					{t("planDetail.back")}
				</Button>
			</div>

			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="font-mono text-muted-foreground text-xs tabular-nums">
							{plan.identifier}
						</span>
						<TestCaseStatusChip
							status={
								plan.state === "ACTIVE" ? "READY" : "CLOSED"
							}
							label={
								plan.state === "ACTIVE"
									? t("plans.active")
									: t("plans.inactive")
							}
						/>
					</div>
					<h2 className="mt-1 break-words font-serif text-2xl font-normal leading-tight">
						{plan.name}
					</h2>
					{plan.description && (
						<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
							{plan.description}
						</p>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{/* Available to readers too: it only narrows a list. */}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onViewInCases(planId)}
					>
						<ListFilterIcon
							className="mr-2 size-4"
							aria-hidden="true"
						/>
						{t("planDetail.viewInCases")}
					</Button>
					{canEdit && (
						<>
							{/* A run records results, so it needs write access — and
							    an empty plan has nothing to step through. */}
							{caseLinks.length > 0 && (
								<Button
									type="button"
									size="sm"
									onClick={() => setRunOpen(true)}
								>
									<PlayIcon
										className="mr-2 size-4"
										aria-hidden="true"
									/>
									{t("planDetail.runPlan")}
								</Button>
							)}
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setEditOpen(true)}
							>
								<PencilIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
								{t("actions.editPlan")}
							</Button>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										onClick={handleDelete}
										disabled={deleteMutation.isPending}
										aria-label={t("actions.deletePlan")}
										className="text-muted-foreground hover:text-destructive"
									>
										<Trash2Icon
											className="size-4"
											aria-hidden="true"
										/>
									</Button>
								</TooltipTrigger>
								<TooltipContent surface="popover">
									{t("actions.deletePlan")}
								</TooltipContent>
							</Tooltip>
							<AddCaseToPlanButton
								projectId={projectId}
								organizationId={organizationId}
								planId={planId}
								existingCaseIds={caseLinks.map(
									(c) => c.testCaseId,
								)}
								onAdded={refresh}
							/>
						</>
					)}
				</div>
			</div>

			{caseLinks.length === 0 ? (
				<div className="rounded-lg border border-dashed bg-muted/20 py-12 text-center">
					<p className="text-muted-foreground text-sm">
						{t("planDetail.empty")}
					</p>
				</div>
			) : (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={caseLinks.map((c) => c.id)}
						strategy={verticalListSortingStrategy}
					>
						<ol className="space-y-1.5">
							{caseLinks.map((link, index) => (
								<SortablePlanCaseRow
									key={link.id}
									link={link}
									index={index}
									canEdit={canEdit}
									onOpen={() => onOpenCase(link.testCaseId)}
									onRemove={() => handleRemove(link)}
								/>
							))}
						</ol>
					</SortableContext>
				</DndContext>
			)}

			{canEdit && (
				<>
					<EditPlanDialog
						projectId={projectId}
						organizationId={organizationId}
						planId={planId}
						initialName={plan.name}
						initialDescription={plan.description ?? ""}
						initialState={plan.state as "ACTIVE" | "INACTIVE"}
						open={editOpen}
						onOpenChange={setEditOpen}
						onSaved={refresh}
					/>
					{/* The run walks the plan's cases in the order shown above. */}
					<TestPlanRunner
						projectId={projectId}
						organizationId={organizationId}
						planId={planId}
						planName={plan.name}
						cases={caseLinks.map((link) => ({
							testCaseId: link.testCaseId,
							identifier: link.testCase.identifier,
							title: link.testCase.title,
						}))}
						open={runOpen}
						onOpenChange={setRunOpen}
					/>
				</>
			)}
		</div>
	);
}

/**
 * One case in the plan: drag to reorder, click to open it in the editor, remove
 * it from the plan.
 *
 * The three controls sit SIDE BY SIDE, never nested — a button inside a button
 * is invalid HTML (React would warn, and hydration can rearrange it) and would
 * leave the grip and the X unreachable by keyboard. The open target is the
 * title, stretched over the row via `after:inset-0`; the grip and the X are
 * raised above that overlay with `relative z-10` so they keep their own hit
 * area and their own accessible names. Same pattern the plan cards use.
 */
function SortablePlanCaseRow({
	link,
	index,
	canEdit,
	onOpen,
	onRemove,
}: {
	link: CaseLink;
	index: number;
	canEdit: boolean;
	onOpen: () => void;
	onRemove: () => void;
}) {
	const t = useTranslations("projects.testCases");
	const tTooltip = useTranslations("tooltips.testCases");
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: link.id, disabled: !canEdit });

	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				"relative flex items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-colors hover:border-primary/40 hover:bg-accent/50",
				isDragging && "z-10 opacity-80 shadow-sm",
			)}
		>
			{canEdit && (
				<button
					type="button"
					aria-label={t("planDetail.reorderAria", {
						identifier: link.testCase.identifier,
					})}
					className="relative z-10 cursor-grab touch-none rounded text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
					{...attributes}
					{...listeners}
				>
					<GripVerticalIcon className="size-4" aria-hidden="true" />
				</button>
			)}
			<span className="w-6 text-center font-mono text-muted-foreground text-xs tabular-nums">
				{index + 1}
			</span>
			<span className="shrink-0 font-mono text-xs">
				{link.testCase.identifier}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={onOpen}
							// No `aria-label` on purpose — see the note in
							// FeatureCoverageList.tsx. It would replace the test case title in
							// the accessible name with just "Open TC-123" (WCAG 2.5.3).
							className="block w-full truncate text-left after:absolute after:inset-0 after:rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{link.testCase.title}
						</button>
					</TooltipTrigger>
					<TooltipContent>{tTooltip("openCase")}</TooltipContent>
				</Tooltip>
			</span>
			{link.section && (
				<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
					{link.section}
				</span>
			)}
			<TestCaseStatusChip
				status={link.testCase.state as TestCaseState}
				label={t(STATE_I18N_KEY[link.testCase.state as TestCaseState])}
			/>
			{canEdit && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onRemove}
							aria-label={t("planDetail.removeFromPlanAria", {
								identifier: link.testCase.identifier,
							})}
							className="relative z-10 text-muted-foreground hover:text-destructive"
						>
							<XIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent surface="popover">
						{t("planDetail.removeFromPlan")}
					</TooltipContent>
				</Tooltip>
			)}
		</li>
	);
}

function AddCaseToPlanButton({
	projectId,
	organizationId,
	planId,
	existingCaseIds,
	onAdded,
}: {
	projectId: string;
	organizationId: string | null;
	planId: string;
	existingCaseIds: string[];
	onAdded: () => void;
}) {
	const t = useTranslations("projects.testCases");
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [section, setSection] = useState("");

	// The picker fetches the first page (200 is the procedure max); a project
	// with more cases surfaces the honest "search to narrow" hint below rather
	// than silently hiding the overflow.
	// Search SERVER-side. Filtering a single fetched page client-side meant the
	// picker only ever searched the first 200 cases: on a 640-case project,
	// typing "TC-500" returned "No matches" for a case that plainly exists.
	const [debouncedQuery] = useDebounceValue(query.trim(), 300);
	const { data } = useQuery({
		...orpc.projects.testCases.list.queryOptions({
			input: {
				projectId,
				organizationId,
				limit: 200,
				...(debouncedQuery ? { search: debouncedQuery } : {}),
			},
		}),
		enabled: open,
	});
	const fetched = data?.items?.length ?? 0;
	const total = data?.total ?? 0;

	const addMutation = useMutation(
		orpc.projects.testCases.plans.addCase.mutationOptions({
			onSuccess: () => {
				setQuery("");
				onAdded();
			},
			onError: (e) =>
				toast.error(t("toasts.addToPlanFailed", { error: e.message })),
		}),
	);

	const existing = useMemo(() => new Set(existingCaseIds), [existingCaseIds]);
	const options = useMemo(() => {
		// The server has already applied the search; this only drops cases
		// already in the plan and caps what the popover renders.
		const items = data?.items ?? [];
		return items.filter((c) => !existing.has(c.id)).slice(0, 50);
	}, [data?.items, existing]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm">
					<PlusIcon className="mr-2 size-4" aria-hidden="true" />
					{t("planDetail.addCase")}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-2">
				<div className="relative mb-2">
					<SearchIcon
						aria-hidden="true"
						className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground"
					/>
					<SearchInput
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("planDetail.searchCasesPlaceholder")}
						aria-label={t("planDetail.searchCasesAria")}
						className="h-9 pl-8"
					/>
				</div>
				<Input
					value={section}
					onChange={(e) => setSection(e.target.value)}
					placeholder={t("planDetail.sectionPlaceholder")}
					aria-label={t("planDetail.sectionAria")}
					className="mb-2 h-8 text-xs"
				/>
				<ul className="max-h-60 overflow-y-auto">
					{options.length === 0 ? (
						<li className="px-2 py-3 text-center text-muted-foreground text-sm">
							{t("planDetail.noMatches")}
						</li>
					) : (
						options.map((c) => (
							<li key={c.id}>
								<button
									type="button"
									disabled={addMutation.isPending}
									onClick={() =>
										addMutation.mutate({
											projectId,
											organizationId,
											planId,
											testCaseId: c.id,
											section: section.trim() || null,
										})
									}
									className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
								>
									<PlusIcon
										aria-hidden="true"
										className="size-3.5 shrink-0 text-muted-foreground"
									/>
									<span className="shrink-0 font-mono text-xs">
										{c.identifier}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{c.title}
									</span>
								</button>
							</li>
						))
					)}
				</ul>
				{fetched < total && (
					<p className="border-t px-2 pt-2 pb-1 text-muted-foreground text-xs">
						{t("planDetail.showingOfTotal", {
							shown: fetched,
							total,
						})}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}

/**
 * Edit a plan's name, description, and Active/Inactive state (backed by
 * `plans.update`). Mirrors the create dialog's form; the form re-seeds from the
 * current plan each time it opens so a cancelled edit never leaks stale values.
 */
function EditPlanDialog({
	projectId,
	organizationId,
	planId,
	initialName,
	initialDescription,
	initialState,
	open,
	onOpenChange,
	onSaved,
}: {
	projectId: string;
	organizationId: string | null;
	planId: string;
	initialName: string;
	initialDescription: string;
	initialState: "ACTIVE" | "INACTIVE";
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();

	const updateMutation = useMutation(
		orpc.projects.testCases.plans.update.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.planUpdated"));
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.plans.list.key(),
				});
				onOpenChange(false);
				onSaved();
			},
			onError: (e) =>
				toast.error(t("toasts.planUpdateFailed", { error: e.message })),
		}),
	);

	return (
		<PlanFormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t("plans.editTitle")}
			dialogDescription={t("plans.editDescription")}
			submitLabel={t("plans.save")}
			initialName={initialName}
			initialDescription={initialDescription}
			initialState={initialState}
			showState
			pending={updateMutation.isPending}
			onSubmit={(v) =>
				updateMutation.mutate({
					projectId,
					organizationId,
					planId,
					name: v.name,
					description: v.description,
					state: v.state,
				})
			}
		/>
	);
}

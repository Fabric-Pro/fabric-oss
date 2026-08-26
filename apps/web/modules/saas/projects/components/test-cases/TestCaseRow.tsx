"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { buildStoryDetailsRoute } from "@saas/projects/lib/stories/routes";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	CheckIcon,
	CopyIcon,
	GitBranchIcon,
	MoreVerticalIcon,
	Trash2Icon,
	UnlinkIcon,
	XIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { isAutomatedWithRef } from "./automation-link";
import {
	CASES_COL_COVERS,
	CASES_COL_LASTRUN,
	CASES_GRID_ROW,
	CASES_ROW_HEIGHT,
	CASES_ROW_HEIGHT_COMPACT,
} from "./cases-table";
import {
	type AutomationStatus,
	PRIORITY_I18N_KEY,
	RESULT_I18N_KEY,
	type RecordableResult,
	STATE_I18N_KEY,
	type TestCasePriority,
	type TestCaseState,
	type TestResult,
} from "./constants";
import { EditablePriorityChip } from "./EditablePriorityChip";
import { EditableStateChip } from "./EditableStateChip";
import { OwnerAvatar } from "./OwnerAvatar";
import { TestCaseResultPill } from "./TestCaseResultPill";

/** The list-item fields the row + stat strip read (subset of the procedure output). */
export type CaseItem = {
	id: string;
	identifier: string;
	title: string;
	state: TestCaseState;
	priority: TestCasePriority;
	ownerId: string | null;
	tags: string[];
	automationStatus: AutomationStatus;
	/**
	 * The linked automation identifier. The row's automated mark needs BOTH this
	 * and an AUTOMATED status — the same conjunction the Automation % counts — so
	 * the mark and the percentage can never tell the reader different stories.
	 */
	automationRef: string | null;
	currentResult: TestResult;
	lastRunAt: Date | string | null;
	/** PIPELINE when a CI run produced the current result; MANUAL when a person did. */
	lastRunSource: string | null;
	lastRunByLabel: string | null;
	order: number;
	_count: { steps: number; workItemLinks: number };
	workItemLinks: {
		acceptanceCriterionRefs: string[];
		userStory: {
			id: string;
			identifier: string;
			title: string;
			kind: string | null;
		} | null;
	}[];
};

/** The per-row inline result-mark order (best → worst → not-run). */
const ROW_RESULTS: RecordableResult[] = [
	"PASSED",
	"FAILED",
	"BLOCKED",
	"NOT_RUN",
];

export function TestCaseRow({
	item,
	selectable,
	selected,
	onToggleSelected,
	canEdit,
	canDelete,
	onOpen,
	projectId,
	organizationId,
	compact = false,
	isHidden,
	dragHandle,
	rowRef,
	rowStyle,
	dragging = false,
}: {
	item: CaseItem;
	selectable: boolean;
	selected: boolean;
	onToggleSelected: () => void;
	canEdit: boolean;
	canDelete: boolean;
	onOpen: () => void;
	projectId: string;
	organizationId: string | null;
	/** Reader's row-height preference. */
	compact?: boolean;
	/** Columns the reader has switched off, by column id. */
	isHidden?: (column: string) => boolean;
	/**
	 * Reorder grip, supplied by the sortable wrapper. The row owns
	 * its own `<li>`, so a wrapper cannot add a handle from outside without
	 * nesting one list item inside another — it hands the grip in instead.
	 */
	dragHandle?: ReactNode;
	rowRef?: (node: HTMLLIElement | null) => void;
	rowStyle?: CSSProperties;
	dragging?: boolean;
}) {
	const t = useTranslations("projects.testCases");
	const tTooltips = useTranslations("tooltips.testCases");
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();

	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.list.key(),
		});

	// Which inline field is mid-write — drives the per-chip spinner.
	const [pendingField, setPendingField] = useState<
		"state" | "priority" | null
	>(null);

	const updateMutation = useMutation(
		orpc.projects.testCases.update.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.saved"));
				invalidate();
			},
			onError: (e) =>
				toast.error(t("toasts.saveFailed", { error: e.message })),
			onSettled: () => setPendingField(null),
		}),
	);
	const resultMutation = useMutation(
		orpc.projects.testCases.recordResult.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.resultRecorded"));
				invalidate();
			},
			onError: (e) =>
				toast.error(t("toasts.resultFailed", { error: e.message })),
		}),
	);
	const cloneMutation = useMutation(
		orpc.projects.testCases.clone.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.cloned"));
				invalidate();
			},
			onError: (e) =>
				toast.error(t("toasts.cloneFailed", { error: e.message })),
		}),
	);
	const deleteMutation = useMutation(
		orpc.projects.testCases.delete.mutationOptions({
			onSuccess: () => {
				toast.success(t("toasts.deleted"));
				invalidate();
			},
			onError: (e) =>
				toast.error(t("toasts.deleteFailed", { error: e.message })),
		}),
	);

	const changeState = (state: TestCaseState) => {
		setPendingField("state");
		updateMutation.mutate({
			projectId,
			testCaseId: item.id,
			organizationId,
			state,
		});
	};
	const changePriority = (priority: TestCasePriority) => {
		setPendingField("priority");
		updateMutation.mutate({
			projectId,
			testCaseId: item.id,
			organizationId,
			priority,
		});
	};
	const markResult = (result: RecordableResult) => {
		resultMutation.mutate({
			projectId,
			testCaseId: item.id,
			organizationId,
			result,
		});
	};

	const firstLink = item.workItemLinks.find((l) => l.userStory)?.userStory;
	const extraLinks = item._count.workItemLinks - 1;
	const currentResult = item.currentResult;

	/**
	 * The left edge carries the one fact worth spotting while scrolling: this
	 * row wants something from you. Red for a failure, amber for a blocked run,
	 * brand for a case an adversarial lens proposed and nobody has ruled on.
	 * Colour alone never carries it — the result pill and state chip both say it
	 * in words on the same row.
	 */
	const accent =
		currentResult === "FAILED"
			? "before:bg-destructive"
			: currentResult === "BLOCKED"
				? "before:bg-highlight"
				: item.state === "PROPOSED"
					? "before:bg-primary"
					: "before:bg-transparent";

	/** `hidden` wins over the container-query tier — a reader who switched a
	 *  column off should not see it reappear when the window widens. */
	const hidden = (column: string) =>
		isHidden?.(column) ? "!hidden" : undefined;

	return (
		<li
			ref={rowRef}
			style={rowStyle}
			className={cn(
				CASES_GRID_ROW,
				compact ? CASES_ROW_HEIGHT_COMPACT : CASES_ROW_HEIGHT,
				"relative border-border/55 border-b px-3 py-3 transition-colors last:border-b-0 hover:bg-accent/40 md:py-0",
				"before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
				accent,
				selected && "bg-primary/[0.06]",
				dragging && "z-10 bg-card shadow-md",
			)}
		>
			{/* Grip + select. One cell, so the template stays constant whether or
			    not this list can be reordered right now. */}
			<span className="flex shrink-0 items-center gap-1">
				<span className="flex w-5 justify-center">{dragHandle}</span>
				{selectable && (
					<Checkbox
						checked={selected}
						onCheckedChange={onToggleSelected}
						aria-label={t("row.selectAria", {
							identifier: item.identifier,
						})}
					/>
				)}
			</span>

			<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
				{item.identifier}
			</span>

			{/* Title. The only thing that opens the drawer — the coverage cell
			    carries its own link, and an anchor inside a button is neither
			    valid nor reachable by keyboard. */}
			<span className="flex min-w-0 flex-1 items-center gap-2 @[670px]:flex-none">
				<button
					type="button"
					onClick={onOpen}
					// The column is ~150px and a title routinely needs three times
					// that, so most rows show a fragment. `title` is what makes the
					// rest reachable — a native tooltip rather than a Radix one
					// because there are up to 100 of these on screen and each Radix
					// tooltip is its own portal and listener set.
					title={item.title}
					className="min-w-0 truncate rounded text-left font-medium text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{item.title}
				</button>
				{/* Called inline, not hoisted to a const: `isAutomatedWithRef` is a
				    type predicate over `ref`, and that narrowing is what lets the
				    label below carry the ref without a non-null assertion. */}
				{isAutomatedWithRef(
					item.automationStatus,
					item.automationRef,
				) && (
					// role="img" + aria-label so the mark reads as one thing and
					// carries the ref itself, rather than as a bare icon.
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								role="img"
								aria-label={t("row.automatedAria", {
									ref: item.automationRef,
								})}
								className="shrink-0 text-muted-foreground"
							>
								<ZapIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							</span>
						</TooltipTrigger>
						<TooltipContent>
							{tTooltips("automationRef", {
								ref: item.automationRef,
							})}
						</TooltipContent>
					</Tooltip>
				)}
				{item.lastRunSource === "PIPELINE" && (
					// The result on this row came from CI, not a person — which
					// changes what "failed" means and who can re-run it.
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								role="img"
								aria-label={t("row.fromCiAria", {
									by:
										item.lastRunByLabel ??
										t("row.unknownActor"),
								})}
								className="shrink-0 text-muted-foreground"
							>
								<GitBranchIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							</span>
						</TooltipTrigger>
						<TooltipContent>
							{item.lastRunByLabel ?? t("row.unknownActor")}
						</TooltipContent>
					</Tooltip>
				)}
				{item.tags.length > 0 && (
					<span className="hidden shrink-0 gap-1 xl:flex">
						{item.tags.slice(0, 2).map((tag) => (
							<span
								key={tag}
								className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
							>
								{tag}
							</span>
						))}
					</span>
				)}
			</span>

			{/* Covers — dropped by the grid below 820px of container. */}
			<span
				className={cn(
					"min-w-0 items-center text-muted-foreground text-xs",
					CASES_COL_COVERS,
					hidden("covers"),
				)}
			>
				{firstLink ? (
					<CoverageLink
						projectId={projectId}
						story={firstLink}
						extraLinks={extraLinks}
					/>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="inline-flex items-center gap-1.5 text-destructive">
								<UnlinkIcon
									aria-hidden="true"
									className="size-3"
								/>
								{t("row.uncovered")}
							</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							{tTooltips("uncovered")}
						</TooltipContent>
					</Tooltip>
				)}
			</span>

			{/* Run result — editable when the user can edit. */}
			<ResultMarkControl
				className={hidden("result")}
				result={currentResult}
				resultLabel={t(RESULT_I18N_KEY[currentResult])}
				lastRunByLabel={item.lastRunByLabel}
				hasRun={Boolean(item.lastRunAt)}
				canEdit={canEdit}
				pending={resultMutation.isPending}
				identifier={item.identifier}
				onMark={markResult}
			/>

			<span className={cn("flex min-w-0 items-center", hidden("state"))}>
				<EditableStateChip
					value={item.state}
					onChange={changeState}
					labelFor={(s) => t(STATE_I18N_KEY[s])}
					ariaLabel={t("row.stateChangeAria", {
						identifier: item.identifier,
					})}
					disabled={!canEdit}
					pending={
						pendingField === "state" && updateMutation.isPending
					}
				/>
			</span>

			<span
				className={cn("flex min-w-0 items-center", hidden("priority"))}
			>
				<EditablePriorityChip
					value={item.priority}
					onChange={changePriority}
					labelFor={(p) => t(PRIORITY_I18N_KEY[p])}
					ariaLabel={t("row.priorityChangeAria", {
						identifier: item.identifier,
					})}
					disabled={!canEdit}
					// Bars only. The full chip needed more than twice this
					// column's width and drew its label straight over the cells
					// beside it; the bars carry the value, the words stay in the
					// accessible name and the hover title.
					compact
					pending={
						pendingField === "priority" && updateMutation.isPending
					}
				/>
			</span>

			{/* Owner. The list payload carries only `ownerId`. */}
			<span className={cn("flex items-center", hidden("owner"))}>
				<OwnerAvatar
					assigned={Boolean(item.ownerId)}
					label={
						item.ownerId
							? t("row.ownerAssigned")
							: t("row.unassigned")
					}
				/>
			</span>

			{/* Last run — the first column the grid drops, below 940px. */}
			<span
				className={cn(
					"min-w-0 items-center truncate text-muted-foreground text-xs",
					CASES_COL_LASTRUN,
					hidden("lastRun"),
				)}
				title={
					item.lastRunAt
						? new Date(item.lastRunAt).toLocaleString()
						: undefined
				}
			>
				{item.lastRunAt
					? formatDistanceToNow(new Date(item.lastRunAt), {
							addSuffix: true,
						})
					: t("row.neverRunShort")}
			</span>

			<span className="flex items-center justify-end">
				{(canEdit || canDelete) && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("row.actionsAria", {
									identifier: item.identifier,
								})}
							>
								<MoreVerticalIcon
									className="size-4"
									aria-hidden="true"
								/>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{/*
							 * The review gate. A PROPOSED case is one an
							 * adversarial lens invented and nobody has agreed to
							 * yet, so it needs an explicit decision rather than
							 * being left to whoever notices the chip. It lives in
							 * the menu rather than as two permanent buttons: at
							 * this row density they would be noise on every case
							 * that needs no decision.
							 *
							 * Accept lands on DRAFT, not READY — accepting says
							 * "this belongs in the suite", which is a different
							 * judgement from "this is finished". Reject lands on
							 * CLOSED so the suggestion stays auditable instead of
							 * vanishing.
							 */}
							{item.state === "PROPOSED" && canEdit && (
								<>
									<DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
										{t("row.proposedReview")}
									</DropdownMenuLabel>
									<DropdownMenuItem
										disabled={updateMutation.isPending}
										onSelect={() => changeState("DRAFT")}
									>
										<CheckIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("row.acceptProposed")}
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={updateMutation.isPending}
										onSelect={() => changeState("CLOSED")}
									>
										<XIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("row.rejectProposed")}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
								</>
							)}
							{canEdit && (
								<DropdownMenuItem
									onSelect={() =>
										cloneMutation.mutate({
											projectId,
											testCaseId: item.id,
											organizationId,
										})
									}
								>
									<CopyIcon
										className="mr-2 size-4"
										aria-hidden="true"
									/>
									{t("actions.clone")}
								</DropdownMenuItem>
							)}
							{canDelete && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										className="text-destructive focus:text-destructive"
										onSelect={() =>
											confirm({
												title: t("confirm.deleteTitle"),
												message: t(
													"confirm.deleteMessage",
													{
														identifier:
															item.identifier,
													},
												),
												confirmLabel:
													t("actions.delete"),
												cancelLabel:
													t("actions.cancel"),
												destructive: true,
												// `.mutate()` (not mutateAsync): the confirm
												// provider awaits onConfirm without a try/catch,
												// so a rejecting delete would leave the dialog
												// stuck open. onError toasts the failure.
												onConfirm: () => {
													deleteMutation.mutate({
														projectId,
														testCaseId: item.id,
														organizationId,
													});
												},
											})
										}
									>
										<Trash2Icon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("actions.delete")}
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</span>
		</li>
	);
}

/**
 * The covered work item, as a link to it.
 *
 * Story identifiers are plain decimals shared by features and bugs, so "Covers
 * 177" says nothing about what 177 is. The kind chip and the title carry that;
 * the identifier stays mono/tabular so it reads as an identifier, matching how
 * the backlog renders it.
 */
function CoverageLink({
	projectId,
	story,
	extraLinks,
}: {
	projectId: string;
	story: {
		id: string;
		identifier: string;
		title: string;
		kind: string | null;
	};
	extraLinks: number;
}) {
	const t = useTranslations("projects.testCases");
	const { basePath } = useOrganizationContext();

	const kind = story.kind === "BUG" ? t("row.kindBug") : t("row.kindFeature");

	// The column header already says "Covers", and the kind + extra-link count
	// are in the accessible name rather than on screen — at this density the row
	// has ~180px for the whole answer, and the identifier plus the title is the
	// part a reader scans for.
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<Link
				href={buildStoryDetailsRoute(basePath, projectId, story.id)}
				aria-label={t("row.coversAria", {
					kind,
					identifier: story.identifier,
					title: story.title,
				})}
				// Same reason as the case title: 140px rarely holds a feature
				// name, so the full one has to be reachable without opening it.
				title={`${kind} ${story.identifier}: ${story.title}`}
				className="inline-flex min-w-0 items-center gap-1.5 rounded transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="shrink-0 font-mono text-primary tabular-nums">
					{story.identifier}
				</span>
				<span className="min-w-0 truncate text-muted-foreground">
					{story.title}
				</span>
			</Link>
			{extraLinks > 0 && (
				<span className="shrink-0 text-muted-foreground/70 tabular-nums">
					{t("row.coversMore", { count: extraLinks })}
				</span>
			)}
		</span>
	);
}

function ResultMarkControl({
	result,
	resultLabel,
	lastRunByLabel,
	hasRun,
	canEdit,
	pending,
	identifier,
	className,
	onMark,
}: {
	result: TestResult;
	resultLabel: string;
	lastRunByLabel: string | null;
	hasRun: boolean;
	canEdit: boolean;
	pending: boolean;
	identifier: string;
	/** Column-visibility class from the row. */
	className?: string;
	onMark: (result: RecordableResult) => void;
}) {
	const t = useTranslations("projects.testCases");

	if (!canEdit) {
		return (
			<span className={cn("flex min-w-0 items-center", className)}>
				<TestCaseResultPill result={result} label={resultLabel} />
			</span>
		);
	}

	return (
		<span className={cn("flex min-w-0 items-center", className)}>
			<DropdownMenu>
				<DropdownMenuTrigger asChild disabled={pending}>
					<button
						type="button"
						aria-label={t("row.resultMarkAria", { identifier })}
						className="rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
					>
						<TestCaseResultPill
							result={result}
							label={resultLabel}
						/>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-[11rem]">
					<DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
						{hasRun
							? t("row.lastRunProvenance", {
									by: lastRunByLabel ?? t("row.unknownActor"),
								})
							: t("row.neverRun")}
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{ROW_RESULTS.map((r) => (
						<DropdownMenuItem
							key={r}
							onSelect={() => {
								if (r !== result) {
									onMark(r);
								}
							}}
							className="gap-2"
						>
							<TestCaseResultPill
								result={r}
								label={t(RESULT_I18N_KEY[r])}
								plain
							/>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	);
}

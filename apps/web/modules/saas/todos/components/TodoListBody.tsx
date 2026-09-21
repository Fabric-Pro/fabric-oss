"use client";

import { buildDigestDeepLink } from "@saas/meeting-digest/lib/digest-deep-link";
import { useBasePath } from "@saas/organizations/hooks";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	FolderIcon,
	ListFilterIcon,
	PencilLineIcon,
	SearchXIcon,
	UserRoundIcon,
	UsersRoundIcon,
	XIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
	applyTodoOverride,
	assigneeOptionKey,
	assigneeOptions,
	formatTodoDate,
	groupTodos,
	groupUnassigned,
	isUnassigned,
	projectOptions,
	TODO_SCOPES,
	type TodoAssigneeOption,
	type TodoListData,
	type TodoProjectOption,
	type TodoScope,
	visibleTodos,
} from "../lib/todo-list-model";
import {
	pendingMeetingKey,
	usePendingProposalMeetings,
} from "../lib/todo-proposals-api";
import { useTodoRowActions } from "../lib/todo-row-actions";
import { useJustCompletedTodoIds } from "../lib/todos-api";
import { TodoAgeHiddenView } from "./TodoAgeHiddenView";
import { TodoAssigneeDialog } from "./TodoAssigneeDialog";
import { TodoFilterCombobox } from "./TodoFilterCombobox";
import { TodoMeetingProposalsBadge } from "./TodoMeetingProposalsBadge";
import { TodoNewContactDialog } from "./TodoNewContactDialog";
import { TodoRow } from "./TodoRow";
import { TodoSnoozeDialog } from "./TodoSnoozeDialog";

const T = "todos.list";

/**
 * The filter bar's two unbounded-set selections, and what it may offer.
 *
 * Supplied by whoever owns the READ, because that is what these are: `project`
 * and `assignee` travel to `todos.list` as `projectId` / `assigneeUserId` /
 * `assigneeContactId`, so a selection made here changes which rows the server
 * sends rather than which loaded rows survive. `projects` and `assignees` come
 * from the owner too — while a filter is on, the response holds only matching
 * rows, so options derived from THIS response would collapse to the value
 * already chosen.
 */
export interface TodoFilterBar {
	project: TodoProjectOption | null;
	assignee: TodoAssigneeOption | null;
	projects: TodoProjectOption[];
	assignees: TodoAssigneeOption[];
	onProjectChange: (project: TodoProjectOption | null) => void;
	onAssigneeChange: (assignee: TodoAssigneeOption | null) => void;
}

/** What the read has left to give, and how to ask for it. */
export interface TodoListPaging {
	hasMore: boolean;
	isLoadingMore: boolean;
	onLoadMore: () => void;
}

/**
 * The list itself: filters, rows, the Unassigned bucket, the age-hidden line
 * (Fizzy #2340).
 *
 * WHAT IT READS. Only what the page already fetched — the pages of its one
 * list read, flattened and deduplicated before they arrive here. It does not
 * issue a second read, and it re-derives none of the server's judgements —
 * which buckets open, what an orphan's text is, what age hid — it renders
 * them.
 *
 * SHAPE OF THE FILTER BAR. Scope is three fixed values and stays a pill row.
 * Project and assignee are unbounded and are comboboxes whose selections
 * reappear as removable chips above the list; `TodoFilterCombobox` records why.
 *
 * ALL THREE ARE ARGUMENTS TO THE READ, and none of them is a sieve over its
 * answer. Scope never could be: the default view removes snoozed rows in SQL
 * before ranking anything and keeps only the two most recently completed, so
 * filtering that answer for "snoozed" can only ever yield nothing. Project and
 * assignee once were, and that was a defect — the read returns one PAGE, so
 * narrowing it here meant a filter over fifty rows presented as a filter over
 * the workspace. Their state therefore lives on the page too, and this
 * component reports the click and renders what comes back.
 *
 * The local narrowing below stays, and is not a second filter: it applies the
 * same two selections to the rows THIS SESSION has edited optimistically, so a
 * row reassigned under an assignee filter leaves the view at once instead of
 * waiting for the refetch that will remove it anyway.
 *
 * NO COUNTS ON THE PILLS. The default read carries open rows plus only the two
 * most recently completed, so a "Completed (2)" pill would be a confident lie
 * about a workspace with two hundred finished to-dos.
 */
export function TodoListBody({
	data,
	/**
	 * The organization every write names -- THE SAME ONE THE ROWS CAME FROM.
	 *
	 * Threaded down rather than re-derived here. Resolving it again from the
	 * session would read the ACTIVE organization, which is not necessarily the
	 * one in the URL: follow a link to another workspace's To Do page, or
	 * switch workspace in a second tab, and the page renders A's rows while
	 * every complete, snooze, assign and bulk resolve names B. Each of those
	 * writes then loads by `{ id, organizationId }`, finds nothing, and fails
	 * with "To-do not found" -- a page that looks alive where nothing works.
	 */
	organizationId,
	/**
	 * Which of the server's views is on screen. CONTROLLED, because the scope
	 * is an argument to the READ and not a filter over it: the default view
	 * drops snoozed rows in SQL before ranking anything and keeps only the two
	 * most recent completed ones, so a pill that narrowed the loaded page could
	 * only ever show an empty Snoozed tab and a two-row archive -- and with no
	 * snoozed row on screen, nothing could be un-snoozed again.
	 */
	scope,
	onScopeChange,
	/**
	 * The two unbounded filters, owned by whoever owns the read.
	 *
	 * OPTIONAL, and the fallback is deliberate rather than a convenience: with
	 * no owner listening there is nothing to send the selection to, so the bar
	 * holds it locally and narrows only what is loaded. That is what a body
	 * mounted beside a single-page read (a harness, an embed) can honestly
	 * offer; the page supplies this prop and gets a filter over the workspace.
	 */
	filters,
	/**
	 * What the read has left to give. Absent means "this list is all there
	 * is" — which is a claim only a caller that pages can make, so the
	 * load-more affordance appears only when one does.
	 */
	paging,
}: {
	data: TodoListData;
	organizationId: string | null;
	scope: TodoScope;
	onScopeChange: (scope: TodoScope) => void;
	filters?: TodoFilterBar;
	paging?: TodoListPaging;
}) {
	const t = useTranslations();
	const formatter = useFormatter();
	const basePath = useBasePath() || "/app";

	// The uncontrolled fallback for the filter bar. Held unconditionally
	// because hooks must be, and read only when no owner supplied `filters`.
	const [localProject, setLocalProject] = useState<TodoProjectOption | null>(
		null,
	);
	const [localAssignee, setLocalAssignee] =
		useState<TodoAssigneeOption | null>(null);
	/**
	 * Buckets the reader opened or closed by hand, by project.
	 * Absent means "take the server's default", so a refetch that changes the
	 * viewer's projects is respected while an explicit toggle is not undone.
	 */
	const [bucketOverrides, setBucketOverrides] = useState<
		Record<string, boolean>
	>({});
	const [ageHiddenOpen, setAgeHiddenOpen] = useState(false);

	const {
		actions,
		overrides,
		assigneeFor,
		snoozeFor,
		newContactFor,
		closeAssignee,
		closeSnooze,
		closeNewContact,
	} = useTodoRowActions({ organizationId });
	const justCompletedIds = useJustCompletedTodoIds();

	/**
	 * The server's rows with this session's claims laid over them.
	 *
	 * Applied HERE, above the filtering and the grouping, so an optimistic
	 * change moves the row the way the real answer will: a snooze drops it out
	 * of the open view immediately, and a confirmed suggestion lifts it out of
	 * the Unassigned bucket. Applying it inside the row would leave the row
	 * looking assigned while still sitting in the pile of work nobody owns.
	 */
	const items = useMemo(
		() =>
			data.items.map((item) =>
				applyTodoOverride(item, overrides[item.id]),
			),
		[data.items, overrides],
	);

	const localProjects = useMemo(() => projectOptions(items), [items]);
	const localAssignees = useMemo(() => assigneeOptions(items), [items]);

	const bar: TodoFilterBar = filters ?? {
		project: localProject,
		assignee: localAssignee,
		projects: localProjects,
		assignees: localAssignees,
		onProjectChange: setLocalProject,
		onAssigneeChange: setLocalAssignee,
	};
	const { project, assignee, projects, assignees } = bar;

	const justCompleted = useMemo(
		() => new Set(justCompletedIds),
		[justCompletedIds],
	);

	const visible = useMemo(
		() =>
			visibleTodos(
				items,
				{ scope, project, assignee },
				Date.now(),
				justCompleted,
			),
		[items, scope, project, assignee, justCompleted],
	);

	const groups = useMemo(
		() => groupTodos(visible.filter((item) => !isUnassigned(item))),
		[visible],
	);
	const buckets = useMemo(
		() =>
			groupUnassigned(
				visible.filter(isUnassigned),
				data.unassignedExpandedProjectIds,
			),
		[visible, data.unassignedExpandedProjectIds],
	);

	/**
	 * The meetings the headings above actually render.
	 *
	 * ASKED ONCE, FOR THE WHOLE PAGE. The indicator is a statement about a
	 * meeting, so the question is "which of THESE meetings have proposals
	 * waiting" — one request whatever the page holds, rather than one per
	 * group. Derived from the groups rather than from `items` so it can never
	 * ask about a meeting the filters have taken off screen.
	 */
	const meetingTranscriptRefs = useMemo(
		() =>
			groups
				.filter((group) => group.kind === "meeting")
				.map((group) => group.meetingTranscriptRef)
				.filter((ref): ref is string => Boolean(ref)),
		[groups],
	);
	const pendingProposals = usePendingProposalMeetings({
		organizationId,
		transcriptRefs: meetingTranscriptRefs,
	});

	const formatDate = (value: string) => formatTodoDate(formatter, value);

	return (
		<section aria-label={t("todos.title")} className="space-y-4">
			<div className="flex flex-col gap-3">
				<div
					role="group"
					aria-label={t(`${T}.scope.label`)}
					data-testid="todo-scope-pills"
					className="flex flex-wrap gap-2"
				>
					{TODO_SCOPES.map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={scope === value}
							onClick={() => onScopeChange(value)}
							className={cn(
								"rounded-[6px] px-3.5 py-1.5 text-sm transition-colors",
								scope === value
									? "border border-border bg-accent text-foreground"
									: "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							{t(`${T}.scope.${value}`)}
						</button>
					))}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<TodoFilterCombobox
						label={t(`${T}.filters.project.label`)}
						placeholder={t(`${T}.filters.project.placeholder`)}
						searchPlaceholder={t(`${T}.filters.project.search`)}
						emptyMessage={t(`${T}.filters.project.empty`)}
						ariaLabel={t(`${T}.filters.project.ariaLabel`)}
						icon={
							<FolderIcon
								aria-hidden="true"
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
						}
						options={projects}
						optionKey={(option) => option.id}
						optionLabel={(option) => option.name}
						selectedKey={project?.id ?? null}
						onSelect={bar.onProjectChange}
						testId="todo-project-filter"
					/>

					<TodoFilterCombobox
						label={t(`${T}.filters.assignee.label`)}
						placeholder={t(`${T}.filters.assignee.placeholder`)}
						searchPlaceholder={t(`${T}.filters.assignee.search`)}
						emptyMessage={t(`${T}.filters.assignee.empty`)}
						ariaLabel={t(`${T}.filters.assignee.ariaLabel`)}
						icon={
							<UserRoundIcon
								aria-hidden="true"
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
						}
						options={assignees}
						optionKey={(option) => `${option.kind}:${option.id}`}
						optionLabel={(option) => option.name}
						renderOption={(option) => (
							<span className="flex min-w-0 items-center gap-2">
								<span className="min-w-0 truncate">
									{option.name}
								</span>
								{option.kind === "contact" ? (
									<Badge
										variant="outline"
										className="shrink-0"
									>
										{t(
											"organizations.settings.members.contacts.noAccountBadge",
										)}
									</Badge>
								) : null}
							</span>
						)}
						selectedKey={
							assignee ? assigneeOptionKey(assignee) : null
						}
						onSelect={bar.onAssigneeChange}
						testId="todo-assignee-filter"
					/>
				</div>

				{project || assignee ? (
					<ul
						data-testid="todo-active-filters"
						aria-label={t(`${T}.filters.active`)}
						className="flex flex-wrap items-center gap-2"
					>
						{project ? (
							<FilterChip
								testId="todo-project-chip"
								icon={
									<FolderIcon
										aria-hidden="true"
										className="size-3 shrink-0"
									/>
								}
								label={project.name}
								removeLabel={t(`${T}.filters.project.remove`, {
									name: project.name,
								})}
								onRemove={() => bar.onProjectChange(null)}
							/>
						) : null}
						{assignee ? (
							<FilterChip
								testId="todo-assignee-chip"
								icon={
									<UserRoundIcon
										aria-hidden="true"
										className="size-3 shrink-0"
									/>
								}
								label={assignee.name}
								removeLabel={t(`${T}.filters.assignee.remove`, {
									name: assignee.name,
								})}
								onRemove={() => bar.onAssigneeChange(null)}
							/>
						) : null}
					</ul>
				) : null}
			</div>

			{visible.length === 0 ? (
				<EmptyState>
					<EmptyStateIcon>
						<SearchXIcon className="size-8" />
					</EmptyStateIcon>
					<EmptyStateTitle>
						{t(`${T}.noMatches.title`)}
					</EmptyStateTitle>
					<EmptyStateDescription>
						{t(`${T}.noMatches.description`)}
					</EmptyStateDescription>
				</EmptyState>
			) : (
				<div className="space-y-6">
					{groups.map((group) => {
						const meetingHref =
							group.projectId && group.meetingTranscriptRef
								? buildDigestDeepLink({
										basePath,
										projectId: group.projectId,
										transcriptRef:
											group.meetingTranscriptRef,
										itemKey: "",
									})
								: null;
						const meetingLabel =
							group.meetingTitle ??
							t(`${T}.meetingGroup.fallback`, {
								date: formatDate(group.sourceDate),
							});
						/*
						 * The meeting's own review queue, or null. Looked up on the
						 * (meeting, project) PAIR because two projects can monitor the
						 * same meeting and their inboxes are separate queues reviewed
						 * by different people.
						 */
						const pending =
							group.projectId && group.meetingTranscriptRef
								? (pendingProposals.get(
										pendingMeetingKey(
											group.meetingTranscriptRef,
											group.projectId,
										),
									) ?? null)
								: null;

						return (
							<section
								key={group.key}
								data-testid={
									group.kind === "meeting"
										? "todo-meeting-group"
										: "todo-manual-group"
								}
								className="space-y-2"
							>
								<header className="flex min-w-0 flex-wrap items-center gap-2">
									{group.kind === "meeting" ? (
										<>
											<UsersRoundIcon
												aria-hidden="true"
												className="size-4 shrink-0 text-muted-foreground"
											/>
											{meetingHref ? (
												<a
													href={meetingHref}
													data-testid="todo-meeting-group-link"
													className="min-w-0 truncate font-medium text-primary text-sm underline-offset-2 hover:underline"
												>
													{meetingLabel}
												</a>
											) : (
												<span className="min-w-0 truncate font-medium text-sm">
													{meetingLabel}
												</span>
											)}
											{group.meetingTitle ? (
												<span className="shrink-0 text-muted-foreground text-xs">
													{formatDate(
														group.sourceDate,
													)}
												</span>
											) : null}
										</>
									) : (
										<>
											<PencilLineIcon
												aria-hidden="true"
												className="size-4 shrink-0 text-muted-foreground"
											/>
											<span className="min-w-0 truncate font-medium text-sm">
												{t(`${T}.manualGroup.title`)}
											</span>
										</>
									)}
									{group.projectName ? (
										<span className="min-w-0 max-w-40 truncate text-muted-foreground text-xs">
											{group.projectName}
										</span>
									) : null}
									{/*
									 * SEAM — the per-meeting "proposals pending"
									 * indicator mounts here in its own unit. It
									 * is a statement about the MEETING, not
									 * about any one row, which is why the
									 * grouping above it exists now rather than
									 * later.
									 */}
									<span
										data-testid="todo-meeting-group-slot"
										className="ml-auto shrink-0"
									>
										{pending ? (
											<TodoMeetingProposalsBadge
												pending={pending}
												basePath={basePath}
											/>
										) : null}
									</span>
								</header>
								<ul className="space-y-2">
									{group.items.map((item) => (
										<TodoRow
											key={item.id}
											item={item}
											basePath={basePath}
											organizationId={organizationId}
											actions={actions}
										/>
									))}
								</ul>
							</section>
						);
					})}

					{buckets.map((bucket) => {
						const open =
							bucketOverrides[bucket.key] ??
							bucket.expandedByDefault;
						return (
							<section
								key={bucket.key}
								data-testid="todo-unassigned-bucket"
								data-project-id={bucket.projectId ?? ""}
								className="rounded-lg border border-dashed"
							>
								<button
									type="button"
									aria-expanded={open}
									onClick={() =>
										setBucketOverrides((current) => ({
											...current,
											[bucket.key]: !open,
										}))
									}
									className="flex w-full min-w-0 items-center gap-2 p-3 text-left"
								>
									{open ? (
										<ChevronDownIcon
											aria-hidden="true"
											className="size-4 shrink-0 text-muted-foreground"
										/>
									) : (
										<ChevronRightIcon
											aria-hidden="true"
											className="size-4 shrink-0 text-muted-foreground"
										/>
									)}
									<span className="min-w-0 truncate font-medium text-sm">
										{bucket.projectName
											? t(
													`${T}.unassigned.titleInProject`,
													{
														project:
															bucket.projectName,
													},
												)
											: t(`${T}.unassigned.title`)}
									</span>
									<Badge
										variant="outline"
										className="ml-auto shrink-0"
									>
										{bucket.items.length}
									</Badge>
								</button>
								{open ? (
									<ul className="space-y-2 p-3 pt-0">
										{bucket.items.map((item) => (
											<TodoRow
												key={item.id}
												item={item}
												basePath={basePath}
												organizationId={organizationId}
												actions={actions}
											/>
										))}
									</ul>
								) : null}
							</section>
						);
					})}
				</div>
			)}

			{/*
			 * THE REST OF THE LIST.
			 *
			 * A page that stops at fifty rows looks finished: there is no
			 * ellipsis, no count, nothing between the last row and the end of
			 * the page to say otherwise. This button exists whenever the read
			 * says `hasMore`, and it sits OUTSIDE the empty branch above on
			 * purpose — when this session has narrowed every loaded row away,
			 * asking for the next page is the one useful thing left to do.
			 *
			 * The label carries the wait rather than a spinner beside it: the
			 * control that is working is the one the person just pressed, which
			 * is the treatment the hidden view settled on for the same button.
			 *
			 * Its own keys, not the hidden view's. The two buttons read the same
			 * today, and sharing a key would mean rewording one of them silently
			 * rewords the other — they answer different questions ("the rest of
			 * your list" against "the rest of what the age cutoff removed") and
			 * will not stay identical forever.
			 */}
			{paging?.hasMore ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					data-testid="todo-load-more"
					aria-busy={paging.isLoadingMore}
					disabled={paging.isLoadingMore}
					onClick={paging.onLoadMore}
				>
					{paging.isLoadingMore
						? t(`${T}.loadingMore`)
						: t(`${T}.loadMore`)}
				</Button>
			) : null}

			{/*
			 * Age hiding is the one rule on this page a reader cannot see
			 * working. A list that stops at ten rows looks complete; without
			 * this line, the thirty commitments behind the cutoff are
			 * indistinguishable from thirty that were silently deleted. Absent
			 * only when there is genuinely nothing behind it.
			 */}
			{data.ageHiddenCount > 0 || ageHiddenOpen ? (
				<div className="space-y-2 border-t pt-3">
					{/*
					 * STAYS MOUNTED WHILE IT IS OPEN, even once the count
					 * reaches zero. Clearing the last hidden row drops
					 * `ageHiddenCount`, and unmounting on that would delete the
					 * box out from under the person in the same beat as their
					 * own batch — taking the summary of what just happened with
					 * it. The line then says the backlog is gone and collapses
					 * on click, which is when the section really leaves.
					 */}
					<Button
						variant="link"
						size="sm"
						type="button"
						className="h-auto p-0 text-muted-foreground text-sm"
						aria-expanded={ageHiddenOpen}
						data-testid="todo-age-hidden-line"
						onClick={() => setAgeHiddenOpen((current) => !current)}
					>
						<ListFilterIcon
							aria-hidden="true"
							className="mr-1 size-3.5"
						/>
						{data.ageHiddenCount > 0
							? t(`${T}.ageHidden.line`, {
									count: data.ageHiddenCount,
									days: data.ageThresholdDays,
								})
							: t(`${T}.ageHidden.lineCleared`)}
					</Button>
					{ageHiddenOpen ? (
						<div
							data-testid="todo-age-hidden-view"
							className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm"
						>
							{data.ageHiddenCount > 0
								? t(`${T}.ageHidden.description`, {
										count: data.ageHiddenCount,
										days: data.ageThresholdDays,
									})
								: null}
							{/*
							 * The hidden rows themselves, on their OWN read
							 * (`view: "ageHidden"`) rather than out of the
							 * response above: the page's one list read is the
							 * default view, and the rows behind the cutoff are
							 * precisely the ones it left out. Mounted only
							 * while the box is open, so nobody pays for a
							 * second call to a list they did not ask to see.
							 */}
							<TodoAgeHiddenView
								organizationId={organizationId}
							/>
						</div>
					) : null}
				</div>
			) : null}

			{/*
			 * ONE DIALOG FOR THE WHOLE LIST, mounted only while it is open and
			 * told which row it is for. Per row they would be a hundred closed
			 * dialogs on a busy workspace, and two could end up open at once —
			 * the arrangement `ActionItemList` settled on for the same reason.
			 * Mounting them lazily also keeps their reads (members, contacts)
			 * from being set up for a list nobody is assigning from.
			 */}
			{assigneeFor ? (
				<TodoAssigneeDialog
					item={assigneeFor}
					organizationId={organizationId}
					actions={actions}
					onClose={closeAssignee}
				/>
			) : null}
			{snoozeFor ? (
				<TodoSnoozeDialog
					item={snoozeFor}
					onConfirm={actions.snooze}
					onClose={closeSnooze}
				/>
			) : null}
			{newContactFor ? (
				<TodoNewContactDialog
					request={newContactFor}
					organizationId={organizationId}
					actions={actions}
					onClose={closeNewContact}
				/>
			) : null}
		</section>
	);
}

/** An active unbounded-set filter, shown where the reader is looking. */
function FilterChip({
	icon,
	label,
	removeLabel,
	onRemove,
	testId,
}: {
	icon: React.ReactNode;
	label: string;
	removeLabel: string;
	onRemove: () => void;
	testId: string;
}) {
	return (
		<li
			data-testid={testId}
			className="flex min-w-0 items-center gap-1.5 rounded-full border bg-muted/50 py-1 pr-1 pl-2.5 text-sm"
		>
			{icon}
			<span className="min-w-0 max-w-48 truncate">{label}</span>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={removeLabel}
				onClick={onRemove}
				className="size-5 shrink-0 rounded-full"
			>
				<XIcon aria-hidden="true" className="size-3" />
			</Button>
		</li>
	);
}

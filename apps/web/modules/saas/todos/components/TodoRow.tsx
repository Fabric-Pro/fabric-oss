"use client";

import { buildDigestDeepLink } from "@saas/meeting-digest/lib/digest-deep-link";
import { UserAvatar } from "@shared/components/UserAvatar";
import { Badge } from "@ui/components/badge";
import { Checkbox } from "@ui/components/checkbox";
import { cn } from "@ui/lib";
import {
	CalendarClockIcon,
	ContactRoundIcon,
	ExternalLinkIcon,
	HistoryIcon,
	PencilLineIcon,
	UsersRoundIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import {
	formatTodoDate,
	isSnoozed,
	isSuggestedAssignment,
	type TodoListItem,
	wasPreviouslyCompleted,
} from "../lib/todo-list-model";
import type { TodoRowActionsApi } from "../lib/todo-row-actions";
import { TodoRowActions } from "./TodoRowActions";
import { TodoSuggestionChips } from "./TodoSuggestionChips";
import { TodoWorkItemLinks } from "./TodoWorkItemLinks";

const T = "todos.list";

/**
 * One commitment, as the consolidated list shows it (Fizzy #2340).
 *
 * Three things are on every row, because without any one of them the reader
 * cannot tell what they are looking at:
 *
 *  - WHERE IT CAME FROM. A line pulled out of a meeting and a line someone
 *    typed carry very different authority, and a meeting-sourced row links
 *    back to the digest so the wording can be checked against what was said.
 *  - WHEN. The source date is the date the age rules key off, so the row shows
 *    that one date rather than a created/updated pair nobody can act on.
 *  - WHO. A member, a contact with no account, or nobody — and "nobody" is
 *    stated rather than left as an empty column, because an unowned commitment
 *    that looks owned is the failure this page exists to end.
 *
 * ORPHANS. A row whose meeting was re-extracted no longer resolves to a live
 * action item. The server already fell back to the stored text snapshot, so
 * this renders `title` as usual and adds what that costs: the wording is what
 * was captured, and whoever it names is a suggestion, not a fact. An orphan is
 * still completable — a commitment you can never close is worse than one whose
 * wording drifted — and one that had ALREADY been completed before the
 * rewording says so, because the completion it carried went with the item that
 * was rewritten and the row would otherwise look like work nobody ever did.
 *
 * THE CHECKBOX IS THE PAGE. Completion is the act people come here to perform,
 * so it costs one click at the start of the row, at every width, and it is the
 * one control that does not live behind the menu.
 *
 * DENSITY. Everything here is text that grows — a title, a project name, a
 * person's name — so the row stacks below `sm` and every text node sits in a
 * `min-w-0` box with `truncate`. At phone width a row that cannot shrink is a
 * row that pushes the whole page sideways.
 */
export function TodoRow({
	item,
	basePath,
	organizationId,
	actions,
}: {
	item: TodoListItem;
	/** `/app/<slug>` — where the meeting deep link is rooted. */
	basePath: string;
	/**
	 * The tenant the row came from. Threaded from the list rather than read
	 * again here: every write a row can make has to name the same organization
	 * the rows were fetched for, and a second resolution per row is a second
	 * chance for the two to disagree.
	 */
	organizationId: string | null;
	/** What this row can do, owned by the list so state outlives a re-render. */
	actions: TodoRowActionsApi;
}) {
	const t = useTranslations();
	const formatter = useFormatter();
	const busy = actions.isBusy(item.id);

	const formatDate = (value: string) => formatTodoDate(formatter, value);

	const snoozed = isSnoozed(item, Date.now());
	const digestHref =
		item.source === "MEETING_DIGEST" &&
		item.projectId &&
		item.meetingTranscriptRef
			? buildDigestDeepLink({
					basePath,
					projectId: item.projectId,
					transcriptRef: item.meetingTranscriptRef,
					itemKey: item.meetingItemKey ?? "",
				})
			: null;

	return (
		<li
			data-testid="todo-row"
			data-todo-id={item.id}
			className="flex flex-col gap-2 rounded-lg border bg-card p-3 sm:flex-row sm:items-start sm:gap-3"
		>
			{/*
			 * Disabled while a call for this row is in flight, which is half of
			 * the double-click guard: the other half is a ref checked in the
			 * same turn as the click, because two clicks inside one React batch
			 * both read the pre-render value of this flag.
			 */}
			<Checkbox
				className="mt-0.5 shrink-0"
				data-testid="todo-row-complete"
				checked={item.isCompleted}
				disabled={busy}
				aria-label={t(
					item.isCompleted
						? `${T}.actions.reopenRow`
						: `${T}.actions.completeRow`,
					{ title: item.title },
				)}
				onCheckedChange={() =>
					actions.setCompleted(item, !item.isCompleted)
				}
			/>

			<div className="min-w-0 flex-1 space-y-1">
				<p
					className={cn(
						"truncate font-medium text-sm",
						item.isCompleted &&
							"text-muted-foreground line-through",
					)}
					title={item.title}
				>
					{item.title}
				</p>

				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
					<span className="inline-flex items-center gap-1">
						{item.source === "MEETING_DIGEST" ? (
							<UsersRoundIcon
								aria-hidden="true"
								className="size-3.5"
							/>
						) : (
							<PencilLineIcon
								aria-hidden="true"
								className="size-3.5"
							/>
						)}
						{t(
							item.source === "MEETING_DIGEST"
								? `${T}.source.meeting`
								: `${T}.source.manual`,
						)}
					</span>

					<span aria-hidden="true">·</span>
					<span data-testid="todo-row-source-date">
						{formatDate(item.sourceDate)}
					</span>

					{item.projectName ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="min-w-0 max-w-40 truncate">
								{item.projectName}
							</span>
						</>
					) : null}

					{digestHref ? (
						<>
							<span aria-hidden="true">·</span>
							<a
								href={digestHref}
								data-testid="todo-row-digest-link"
								className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
							>
								<ExternalLinkIcon
									aria-hidden="true"
									className="size-3.5"
								/>
								{t(`${T}.openInDigest`)}
							</a>
						</>
					) : null}

					{item.isCompleted && item.completedAt ? (
						<>
							<span aria-hidden="true">·</span>
							<span>
								{t(`${T}.completedOn`, {
									date: formatDate(item.completedAt),
								})}
							</span>
						</>
					) : null}
				</div>

				{snoozed && item.snoozedUntil ? (
					<p
						data-testid="todo-row-snoozed-until"
						className="inline-flex items-center gap-1 text-muted-foreground text-xs"
					>
						<CalendarClockIcon
							aria-hidden="true"
							className="size-3.5"
						/>
						{t(`${T}.snoozedUntil`, {
							date: formatDate(item.snoozedUntil),
						})}
					</p>
				) : null}

				{item.isOrphaned ? (
					<p
						data-testid="todo-row-orphaned"
						className="text-muted-foreground text-xs"
					>
						{t(`${T}.orphaned.description`)}
					</p>
				) : null}

				{/*
				 * "You did this once." `lastKnownCompletedAt` is the snapshot a
				 * meeting-sourced row takes when it is completed, and it is
				 * cleared when the row is reopened — so a row that is not
				 * completed and still carries one was completed and then
				 * reworded out from under its completion. Without this line
				 * that row is indistinguishable from work nobody ever started.
				 */}
				{wasPreviouslyCompleted(item) && item.lastKnownCompletedAt ? (
					<p
						data-testid="todo-row-previously-completed"
						className="inline-flex items-center gap-1 text-muted-foreground text-xs"
					>
						<HistoryIcon aria-hidden="true" className="size-3.5" />
						{t(`${T}.previouslyCompleted`, {
							date: formatDate(item.lastKnownCompletedAt),
						})}
					</p>
				) : null}

				<TodoSuggestionChips item={item} actions={actions} />

				{/*
				 * WHAT THIS TO-DO BECAME — features and bugs an approved
				 * proposal produced from its meeting item. Only on a
				 * meeting-sourced row: a to-do somebody typed has no meeting
				 * item, so there is nothing a proposal could have been filed
				 * from and the read would answer empty for every one of them.
				 * Closed until asked, so the page does not issue one request
				 * per row on first paint.
				 */}
				{item.source === "MEETING_DIGEST" ? (
					<TodoWorkItemLinks
						item={item}
						basePath={basePath}
						organizationId={organizationId}
					/>
				) : null}
			</div>

			<div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
				<TodoAssignee item={item} />
				<div data-testid="todo-row-actions" className="shrink-0">
					<TodoRowActions item={item} actions={actions} />
				</div>
			</div>
		</li>
	);
}

/**
 * Who owes this — and, for a contact, the fact that they have no account.
 *
 * The dashed mark and the "no account" badge are deliberately the SAME
 * treatment the contact register uses in organization settings
 * (`OrganizationContactsList`), down to the badge's copy: a person reading one
 * surface and then the other must not have to work out that the two are the
 * same kind of person. A member leads with their real avatar; a contact never
 * can, because there is no account behind them.
 */
function TodoAssignee({ item }: { item: TodoListItem }) {
	const t = useTranslations();
	const suggested = isSuggestedAssignment(item);

	const suggestionBadge = suggested ? (
		<Badge
			variant="outline"
			className="shrink-0"
			data-testid="todo-assignee-suggested"
		>
			{t(`${T}.assignee.suggested`)}
		</Badge>
	) : null;

	if (item.assigneeUser) {
		return (
			<div
				data-testid="todo-assignee"
				className="flex min-w-0 items-center gap-2"
			>
				<UserAvatar
					className="size-6 shrink-0"
					name={item.assigneeUser.name}
					avatarUrl={item.assigneeUser.image}
				/>
				<span className="min-w-0 truncate text-sm">
					{item.assigneeUser.name}
				</span>
				{suggestionBadge}
			</div>
		);
	}

	if (item.assigneeContact) {
		return (
			<div
				data-testid="todo-assignee"
				className="flex min-w-0 items-center gap-2"
			>
				<span
					aria-hidden="true"
					data-testid="contact-no-account-mark"
					className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border border-dashed bg-muted text-muted-foreground"
				>
					<ContactRoundIcon className="size-3.5" />
				</span>
				<span className="min-w-0 truncate text-sm">
					{item.assigneeContact.name}
				</span>
				<Badge variant="outline" className="shrink-0">
					{t(
						"organizations.settings.members.contacts.noAccountBadge",
					)}
				</Badge>
				{suggestionBadge}
			</div>
		);
	}

	return (
		<div
			data-testid="todo-assignee"
			className="flex min-w-0 items-center gap-2 text-muted-foreground"
		>
			<span
				aria-hidden="true"
				className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border border-dashed"
			>
				<ContactRoundIcon className="size-3.5" />
			</span>
			<span className="truncate text-sm">
				{t(`${T}.assignee.unassigned`)}
			</span>
		</div>
	);
}

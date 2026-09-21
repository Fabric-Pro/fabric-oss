"use client";

import { buildStoryDetailsRoute } from "@saas/projects/lib/stories/routes";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	Link2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { TodoListItem } from "../lib/todo-list-model";
import {
	type TodoWorkItem,
	useTodoWorkItemLinks,
} from "../lib/todo-work-item-links";

const T = "todos.list";

/**
 * What became of this to-do — the features and bugs its meeting item produced
 * (Fizzy #2340).
 *
 * SOMEBODY ASKED FOR A TICKET AND WANTS TO KNOW IF THEY GOT ONE. That is the
 * whole job: an action item was filed into the Feature Proposals inbox,
 * somebody approved it, and until now the person who raised it had no way to
 * find the work item from the to-do that caused it.
 *
 * CLOSED UNTIL ASKED. The read is mounted with the panel, not with the row, so
 * a page of two hundred rows issues zero of these on first paint. That is the
 * difference between one request and two hundred on a list built to span every
 * project someone can reach.
 *
 * LINKING OFF IS A NORMAL STATE. `MEETING_ACTION_ITEM_LINKING` defaults off,
 * and with it off there are no links to show — none were ever written. The
 * answer then carries `linkingEnabled: false`, and this renders NOTHING: not
 * an error, not an empty box that reads like a failed load, and not a toggle
 * that opens onto nothing. The meeting's pending-proposals indicator is not
 * behind that flag and stays where it is.
 *
 * REJECTING IS DURABLE AND SHARED, which is why it asks first. It writes the
 * same DISMISSED tombstone the meeting digest writes, so the pair counts as
 * decided and the next matching run leaves it alone — the link does not come
 * back on Tuesday. That is a decision about two surfaces, not a tidy-up of
 * this one.
 *
 * AN ORPHAN CAN BE READ BUT NOT ANSWERED FOR. Once a re-extraction reworded
 * the meeting item, there is no key a link row can be addressed by, and the
 * write refuses. The work items are still shown — they are real — with the
 * controls absent and the reason said out loud.
 */
export function TodoWorkItemLinks({
	item,
	basePath,
	organizationId,
}: {
	item: TodoListItem;
	/** `/app/<slug>` — where a work item's route is rooted. */
	basePath: string;
	/** The tenant the row came from, and the one every write names. */
	organizationId: string | null;
}) {
	const t = useTranslations();
	const [open, setOpen] = useState(false);
	/** The one work item a confirmation is open for, or null. */
	const [rejecting, setRejecting] = useState<TodoWorkItem | null>(null);

	const { data, isPending, isError, isBusy, accept, reject } =
		useTodoWorkItemLinks({
			organizationId,
			todoId: item.id,
			enabled: open,
		});

	// Learned only from the answer, so the toggle is offered until the row
	// knows better and then disappears with everything under it.
	if (data && !data.linkingEnabled) {
		return null;
	}

	const workItems = data?.items ?? [];
	const projectId = data?.projectId ?? null;
	/** An orphan's links cannot be addressed, so it is not offered controls. */
	const canManage = Boolean(data && !data.isOrphaned && projectId);

	return (
		<div className="space-y-1">
			<Button
				type="button"
				variant="link"
				size="sm"
				aria-expanded={open}
				data-testid="todo-row-work-items-toggle"
				className="h-auto p-0 text-muted-foreground text-xs"
				onClick={() => setOpen((current) => !current)}
			>
				{open ? (
					<ChevronDownIcon aria-hidden="true" className="size-3.5" />
				) : (
					<ChevronRightIcon aria-hidden="true" className="size-3.5" />
				)}
				<Link2Icon aria-hidden="true" className="size-3.5" />
				{t(`${T}.proposals.links.toggle`)}
			</Button>

			{open ? (
				<div
					data-testid="todo-row-work-items"
					className="space-y-1 border-border border-l pl-3"
				>
					{isPending ? (
						// `<output>` carries role="status" implicitly, so the
						// wait is announced without an ARIA attribute to keep
						// in step with it.
						<output className="block space-y-1">
							<span className="sr-only">
								{t(`${T}.proposals.links.loading`)}
							</span>
							<Skeleton className="h-4 w-56" />
						</output>
					) : isError ? (
						<p
							data-testid="todo-work-items-error"
							className="text-destructive text-xs"
						>
							{t(`${T}.proposals.links.loadFailed`)}
						</p>
					) : workItems.length === 0 ? (
						<p
							data-testid="todo-work-items-empty"
							className="text-muted-foreground text-xs"
						>
							{t(`${T}.proposals.links.empty`)}
						</p>
					) : (
						<>
							{data?.isOrphaned ? (
								<p
									data-testid="todo-work-items-orphaned"
									className="text-muted-foreground text-xs"
								>
									{t(`${T}.proposals.links.orphaned`)}
								</p>
							) : null}
							<ul
								data-testid="todo-work-item-list"
								className="space-y-1"
							>
								{workItems.map((workItem) => (
									<WorkItemRow
										key={workItem.storyId}
										workItem={workItem}
										href={
											projectId
												? buildStoryDetailsRoute(
														basePath,
														projectId,
														workItem.storyId,
													)
												: null
										}
										busy={isBusy(workItem.storyId)}
										canManage={canManage}
										onAccept={() =>
											accept(workItem.storyId)
										}
										onReject={() => setRejecting(workItem)}
									/>
								))}
							</ul>
						</>
					)}
				</div>
			) : null}

			{/*
			 * ONE CONFIRMATION FOR THE PANEL, mounted only while it is open and
			 * told which work item it is about — the arrangement the list's own
			 * dialogs settled on, for the same reason: per row they would be a
			 * pile of closed dialogs, and two could end up open at once.
			 */}
			{rejecting ? (
				<AlertDialog
					open
					onOpenChange={(next) => {
						if (!next) {
							setRejecting(null);
						}
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{t(`${T}.proposals.links.confirm.title`)}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{t(`${T}.proposals.links.confirm.description`, {
									identifier: rejecting.identifier,
								})}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>
								{t(`${T}.proposals.links.confirm.cancel`)}
							</AlertDialogCancel>
							<AlertDialogAction
								data-testid="todo-work-item-reject-confirm"
								onClick={() => {
									reject(rejecting.storyId);
									setRejecting(null);
								}}
							>
								{t(`${T}.proposals.links.confirm.confirm`)}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</div>
	);
}

/**
 * One work item: what it is, where it stands, and the tie this to-do has to it.
 *
 * A work item with no live link is NOT hidden. It is the ordinary shape of a
 * ticket an approved proposal produced while the linking flag was off, and of
 * one whose link was just rejected — the ticket is real either way, and saying
 * so is the difference between "there is no ticket" and "there is a ticket
 * this to-do is no longer tied to".
 */
function WorkItemRow({
	workItem,
	href,
	busy,
	canManage,
	onAccept,
	onReject,
}: {
	workItem: TodoWorkItem;
	href: string | null;
	busy: boolean;
	canManage: boolean;
	onAccept: () => void;
	onReject: () => void;
}) {
	const t = useTranslations();
	const label = `${workItem.identifier} ${workItem.title}`;

	return (
		<li
			data-testid="todo-work-item"
			data-story-id={workItem.storyId}
			data-linked={workItem.linkId ? "true" : "false"}
			className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
		>
			{href ? (
				<a
					href={href}
					data-testid="todo-work-item-link"
					className="inline-flex min-w-0 items-center gap-1.5 underline-offset-2 hover:underline"
				>
					<span className="shrink-0 font-mono text-primary">
						{workItem.identifier}
					</span>
					<span className="min-w-0 max-w-64 truncate">
						{workItem.title}
					</span>
				</a>
			) : (
				<span className="inline-flex min-w-0 items-center gap-1.5">
					<span className="shrink-0 font-mono">
						{workItem.identifier}
					</span>
					<span className="min-w-0 max-w-64 truncate">
						{workItem.title}
					</span>
				</span>
			)}

			{workItem.statusName ? (
				<Badge
					variant={workItem.isDone ? "success" : "outline"}
					data-testid="todo-work-item-status"
				>
					{workItem.statusName}
				</Badge>
			) : null}

			{workItem.linkId ? null : (
				<span
					data-testid="todo-work-item-unlinked"
					className="text-muted-foreground"
				>
					{t(`${T}.proposals.links.unlinked`)}
				</span>
			)}

			{/*
			 * EXACTLY ONE CONTROL, chosen by whether a live tie exists. A
			 * "reject" on an item that is already untied would write a
			 * tombstone and change nothing on screen — a control whose click
			 * looks like a miss is how a page teaches people to click twice.
			 */}
			{canManage ? (
				<span className="ml-auto flex shrink-0 items-center gap-1">
					{workItem.linkId ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							data-testid="todo-work-item-reject"
							aria-label={t(`${T}.proposals.links.rejectLabel`, {
								item: label,
							})}
							className="h-6 px-2 text-xs"
							onClick={onReject}
						>
							<XIcon aria-hidden="true" className="size-3.5" />
							{t(`${T}.proposals.links.reject`)}
						</Button>
					) : (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							data-testid="todo-work-item-accept"
							aria-label={t(`${T}.proposals.links.acceptLabel`, {
								item: label,
							})}
							className="h-6 px-2 text-xs"
							onClick={onAccept}
						>
							<CheckIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							{t(`${T}.proposals.links.accept`)}
						</Button>
					)}
				</span>
			) : null}
		</li>
	);
}

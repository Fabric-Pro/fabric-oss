"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	AlarmClockOffIcon,
	CalendarClockIcon,
	CalendarRangeIcon,
	CircleCheckIcon,
	MoreVerticalIcon,
	RotateCcwIcon,
	UserRoundPlusIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	isSnoozed,
	snoozePresetDate,
	TODO_SNOOZE_PRESETS,
	type TodoListItem,
} from "../lib/todo-list-model";
import type { TodoRowActionsApi } from "../lib/todo-row-actions";

const T = "todos.list";

/**
 * One row's menu: finish it, push it out, hand it to someone (Fizzy #2340).
 *
 * WHY A MENU AND NOT A ROW OF BUTTONS. Completion has its own checkbox on the
 * row, because it is the act people come to this page to perform and it must
 * cost one click. Everything else is occasional, and four more controls on
 * every row is what turns a list you can scan into a wall of affordances —
 * at phone width they would take more space than the to-do's own text.
 *
 * SNOOZE IS PRESETS FIRST. A day, a week, a month cover almost every reason to
 * defer something, and each is one click; the calendar is there for the date
 * someone actually has in mind. The presets are computed from the click's own
 * clock rather than from a date the list was rendered with, so "a week" means
 * a week from now on a page that has been open since yesterday.
 *
 * UNSNOOZE LIVES HERE TOO, on a row that is currently asleep. It is the same
 * decision being taken back, and putting it anywhere else would mean finding a
 * second surface to bring one row forward.
 */
export function TodoRowActions({
	item,
	actions,
}: {
	item: TodoListItem;
	actions: TodoRowActionsApi;
}) {
	const t = useTranslations();
	const busy = actions.isBusy(item.id);
	const snoozed = isSnoozed(item, Date.now());

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					disabled={busy}
					aria-label={t(`${T}.actions.menu`, { title: item.title })}
					data-testid="todo-row-menu"
					className="size-8 shrink-0"
				>
					<MoreVerticalIcon aria-hidden="true" className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuItem
					data-testid="todo-menu-completion"
					onClick={() =>
						actions.setCompleted(item, !item.isCompleted)
					}
				>
					{item.isCompleted ? (
						<RotateCcwIcon
							aria-hidden="true"
							className="mr-2 size-4"
						/>
					) : (
						<CircleCheckIcon
							aria-hidden="true"
							className="mr-2 size-4"
						/>
					)}
					{t(
						item.isCompleted
							? `${T}.actions.reopen`
							: `${T}.actions.complete`,
					)}
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<DropdownMenuLabel>
					{t(`${T}.actions.snooze.label`)}
				</DropdownMenuLabel>
				{TODO_SNOOZE_PRESETS.map((preset) => (
					<DropdownMenuItem
						key={preset}
						data-testid={`todo-menu-snooze-${preset}`}
						onClick={() =>
							actions.snooze(
								item,
								snoozePresetDate(preset, new Date()),
							)
						}
					>
						<CalendarClockIcon
							aria-hidden="true"
							className="mr-2 size-4"
						/>
						{t(`${T}.actions.snooze.${preset}`)}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem
					data-testid="todo-menu-snooze-custom"
					onClick={() => actions.openSnooze(item)}
				>
					<CalendarRangeIcon
						aria-hidden="true"
						className="mr-2 size-4"
					/>
					{t(`${T}.actions.snooze.custom`)}
				</DropdownMenuItem>
				{snoozed ? (
					<DropdownMenuItem
						data-testid="todo-menu-unsnooze"
						onClick={() => actions.unsnooze(item)}
					>
						<AlarmClockOffIcon
							aria-hidden="true"
							className="mr-2 size-4"
						/>
						{t(`${T}.actions.unsnooze`)}
					</DropdownMenuItem>
				) : null}

				<DropdownMenuSeparator />

				{/*
				 * ON EVERY ROW, not only on rows the matcher had a guess for.
				 * The confirm chip can only offer names the extraction found,
				 * so when it found nobody — the common case for a client's
				 * staff — this is the only way the row is ever assignable.
				 */}
				<DropdownMenuItem
					data-testid="todo-menu-assign"
					onClick={() => actions.openAssignee(item)}
				>
					<UserRoundPlusIcon
						aria-hidden="true"
						className="mr-2 size-4"
					/>
					{t(`${T}.actions.assign`)}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

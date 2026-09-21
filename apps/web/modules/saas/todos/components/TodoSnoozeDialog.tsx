"use client";

import { Button } from "@ui/components/button";
import { Calendar } from "@ui/components/calendar";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { TodoListItem } from "../lib/todo-list-model";

const T = "todos.list";

/** Midnight at the start of tomorrow, in the reader's own timezone. */
function startOfTomorrow(from: Date): Date {
	const date = new Date(from);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + 1);
	return date;
}

/**
 * "Not this, not yet — until this date" (Fizzy #2340).
 *
 * TODAY IS NOT OFFERED, and that is the server's rule showing through rather
 * than a design choice. `todos.snooze` refuses a date at or before now,
 * because the read treats an elapsed snooze as no snooze at all: accepting
 * "until today" would report success and leave the row exactly where it was.
 * Disabling those days is how the refusal is explained BEFORE it happens
 * instead of as an error afterwards.
 *
 * ONE DIALOG FOR THE WHOLE LIST. It is mounted once by the list body and told
 * which row it is for, so a hundred rows do not each carry a closed dialog —
 * and so the calendar cannot end up open for two rows at once.
 */
export function TodoSnoozeDialog({
	item,
	onConfirm,
	onClose,
}: {
	/** The row being deferred, or `null` while the dialog is closed. */
	item: TodoListItem | null;
	onConfirm: (item: TodoListItem, until: Date) => void;
	onClose: () => void;
}) {
	const t = useTranslations();
	const [selected, setSelected] = useState<Date | undefined>(undefined);

	// A date chosen for one row must not arrive pre-selected on the next: the
	// second row would show a date nobody picked for it and one click would
	// commit it.
	const itemId = item?.id ?? null;
	useEffect(() => {
		setSelected(undefined);
	}, [itemId]);

	return (
		<Dialog
			open={item !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent data-testid="todo-snooze-dialog">
				<DialogHeader>
					<DialogTitle>
						{t(`${T}.actions.snoozeDialog.title`)}
					</DialogTitle>
					<DialogDescription>
						{t(`${T}.actions.snoozeDialog.description`)}
					</DialogDescription>
				</DialogHeader>

				<Calendar
					mode="single"
					selected={selected}
					onSelect={setSelected}
					disabled={{ before: startOfTomorrow(new Date()) }}
					data-testid="todo-snooze-calendar"
				/>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						{t(`${T}.actions.snoozeDialog.cancel`)}
					</Button>
					<Button
						type="button"
						disabled={!selected}
						data-testid="todo-snooze-confirm"
						onClick={() => {
							if (!item || !selected) {
								return;
							}
							onConfirm(item, selected);
							onClose();
						}}
					>
						{t(`${T}.actions.snoozeDialog.confirm`)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

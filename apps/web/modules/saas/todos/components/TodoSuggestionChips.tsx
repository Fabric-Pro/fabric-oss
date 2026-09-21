"use client";

import { Button } from "@ui/components/button";
import { SparklesIcon, UserRoundPlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	isUnassigned,
	parseSuggestionCandidates,
	type TodoListItem,
} from "../lib/todo-list-model";
import type { TodoRowActionsApi } from "../lib/todo-row-actions";

const T = "todos.list";

/**
 * The matcher's guess, offered for one click — or, when it guessed nobody, a
 * way out of that dead end (Fizzy #2340).
 *
 * ONE CONTROL PER CANDIDATE, not a single "confirm" button. The matcher hands
 * back everyone it could not rule out, and two people at one client really do
 * share a first name; a single button would have to pick one of them silently,
 * which is the assignment nobody made and nobody can see was made.
 *
 * WHEN NOTHING MATCHED, the row is the dead end this feature exists to remove.
 * The transcript said a name, the register has no such person, and every other
 * route out of that state asks the reader to leave the page, find the settings
 * screen, add a contact and come back to a row they will have lost. So the
 * offer is made HERE, seeded with the name that was said, and the register
 * fills itself at the moment of need instead of in advance.
 *
 * Confirming is an ASSIGNMENT, not an acknowledgement: it sets
 * `assignedManually`, which is the flag the next re-extraction checks before
 * re-guessing. Without it the machine's guess would overwrite the person's
 * decision on the next run of the meeting.
 */
export function TodoSuggestionChips({
	item,
	actions,
}: {
	item: TodoListItem;
	actions: TodoRowActionsApi;
}) {
	const t = useTranslations();
	const busy = actions.isBusy(item.id);

	// A row someone already decided, or already finished, is not asking a
	// question — and `assignedManually` is that decision, whatever the stale
	// suggestion columns still hold.
	if (item.isCompleted || item.assignedManually || !isUnassigned(item)) {
		return null;
	}

	const candidates = parseSuggestionCandidates(item.suggestionCandidates);

	if (candidates.length > 0) {
		return (
			<ul
				data-testid="todo-suggestion-chips"
				className="flex min-w-0 flex-wrap items-center gap-2"
			>
				{candidates.map((candidate) => (
					<li key={`${candidate.kind}:${candidate.id}`}>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							data-testid="todo-suggestion-confirm"
							data-candidate-id={candidate.id}
							className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
							onClick={() => actions.assign(item, candidate)}
						>
							<SparklesIcon
								aria-hidden="true"
								className="size-3"
							/>
							{t(`${T}.suggestion.confirm`, {
								name: candidate.name,
							})}
						</Button>
					</li>
				))}
			</ul>
		);
	}

	// A hand-written row never had a transcript to match against, so there is
	// no failed match to explain — its assignee comes from the row's own menu.
	if (item.source !== "MEETING_DIGEST") {
		return null;
	}

	const ownerName = item.tentativeOwnerName?.trim() ?? "";

	return (
		<div
			data-testid="todo-suggestion-chips"
			className="flex min-w-0 flex-wrap items-center gap-2"
		>
			<span className="text-muted-foreground text-xs">
				{ownerName
					? t(`${T}.suggestion.noMatchNamed`, { name: ownerName })
					: t(`${T}.suggestion.noMatch`)}
			</span>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={busy}
				data-testid="todo-suggestion-create-contact"
				className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
				onClick={() => actions.openNewContact(item, ownerName)}
			>
				<UserRoundPlusIcon aria-hidden="true" className="size-3" />
				{t(`${T}.suggestion.createContact`)}
			</Button>
		</div>
	);
}

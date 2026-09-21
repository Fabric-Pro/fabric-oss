/**
 * Binds a transcript's live action items to their durable to-do rows (#2340).
 *
 * Why this exists: `extractMeetingInsightsActivity` replaces a transcript's
 * action items with `deleteMany` + `createMany` on every run, so
 * `ProjectMeetingActionItem.id` is not stable. Everything a person invests in a
 * to-do — a hand-picked assignee, a snooze, a confirmed suggestion — would be
 * destroyed by the next re-extraction if the to-do held that id. `TodoItem`
 * therefore binds on `(transcriptId, itemKey, occurrenceIndex)`, and this module
 * is the one place that turns a live item into that triple and back.
 *
 * Lives in @repo/database because @repo/temporal (the matcher activity) and
 * @repo/api (the list and mutation procedures) both need the same binding and
 * neither depends on the other — the same reason `normalizeItemText` lives
 * beside it in `../projects/meeting-action-item-keys.ts`. The binding itself is
 * a pure function over plain rows, with no Prisma import and no database
 * access, so every rebinding rule below is unit-testable without a database.
 */
import { createHash } from "node:crypto";
import { normalizeItemText } from "../projects/meeting-action-item-keys";

/**
 * The to-do binding's own key version, deliberately NOT `ACTION_ITEM_LINK_VERSION`.
 *
 * That constant belongs to the action-item *linking* feature (#1902), whose keys
 * address idempotent links: invalidating them costs one re-match run and nothing
 * a person typed. A to-do key addresses an assignment, a snooze and a confirmed
 * suggestion — state a human entered by hand. If the two shared one constant,
 * someone bumping it for a linking reason would, in a single commit, turn every
 * to-do assignment and snooze in every organization into an unconfirmed
 * suggestion sitting in the Unassigned bucket. The two features are free to
 * invalidate their own keys on their own schedule; bumping THIS one is an
 * explicit, reviewed decision to re-derive every to-do binding.
 *
 * BUMPING IT IS NOT A ONE-LINE CHANGE, and the fact that nothing throws is the
 * least useful thing that can be said about it. A bump requires a migration
 * that recomputes `ProjectMeetingActionItem.itemKey` for every stored row, plus
 * a re-match of every transcript. Without that migration, a bump does this:
 *
 *  - The stored column keeps its v1 digests, because only extraction ever
 *    writes it and there is no backfill. The matcher computes v2 digests, so
 *    every stored to-do orphans AND the rows it creates under the new key join
 *    to nothing in `live_action_item` — they are orphaned on arrival. Each
 *    live item therefore shows TWICE, both copies with no live text and no live
 *    completion.
 *  - `findProposalsForTodo` and `readActionItemKeyFromMetadata` both require
 *    `actionItemKeyVersion` to equal this constant, so every proposal ever
 *    stamped under the old version stops resolving by key at the same instant
 *    and falls back to the action item row id — the one address a re-extraction
 *    destroys. Work-item links disappear from the To Do page.
 *
 * None of that raises an error anywhere, which is precisely what makes it worth
 * writing down. Treat a bump as a migration, not as a constant edit.
 */
export const TODO_BINDING_VERSION = 1;

/**
 * A to-do's half-key for one action item: sha256 over the version-prefixed
 * normalized text.
 *
 * The normalization rule is imported, never restated. It is already shared
 * between the link keys and the completion carry-over in `buildActionItemRows`;
 * a third copy that drifted would rebind a to-do to an item the extraction
 * activity considers different (or the reverse), which is exactly the class of
 * bug this feature exists to avoid.
 *
 * NOTE for the stored column: `ProjectMeetingActionItem.itemKey` is documented
 * as "the same key the to-do layer binds on" and the To Do list query joins live
 * action items on it, so that column must be written with THIS function. The two
 * version constants are equal today and the digests therefore coincide, but that
 * is a coincidence the constants are explicitly allowed to end — writing the
 * column from `computeActionItemKey` would silently break the join the first
 * time either version moves.
 */
export function computeTodoItemKey(text: string): string {
	// The `todo:` domain prefix is load-bearing, not decoration. Without it this
	// digest is byte-identical to `computeActionItemKey` while both versions sit
	// at 1, which would make the two features look interchangeable right up to
	// the moment one constant moves — and then break silently. The prefix makes
	// the independence real from the first row written.
	return createHash("sha256")
		.update(`todo:v${TODO_BINDING_VERSION}\n${normalizeItemText(text)}`)
		.digest("hex");
}

/** The minimum a caller must read off a live `ProjectMeetingActionItem`. */
export type BindableActionItem = {
	id: string;
	orderIndex: number;
	text: string;
	completedAt: Date | null;
};

/**
 * The minimum a caller must read off a stored `TodoItem`.
 *
 * Both binding columns are nullable because a manual to-do has no meeting behind
 * it. A row with either column null is not a binding at all and is skipped
 * entirely — it appears in none of the three result sets, because a manual to-do
 * is neither matched, nor missing, nor orphaned by a re-extraction.
 */
export type BindableTodo = {
	id: string;
	itemKey: string | null;
	occurrenceIndex: number | null;
};

/** A live item and the stored to-do that already carries its durable state. */
export type MatchedActionItem<
	TItem extends BindableActionItem,
	TTodo extends BindableTodo,
> = {
	item: TItem;
	itemKey: string;
	occurrenceIndex: number;
	todo: TTodo;
};

/** A live item with no to-do yet: the caller creates one at this exact slot. */
export type UnmatchedActionItem<TItem extends BindableActionItem> = {
	item: TItem;
	itemKey: string;
	occurrenceIndex: number;
};

export type ActionItemBinding<
	TItem extends BindableActionItem,
	TTodo extends BindableTodo,
> = {
	matched: Array<MatchedActionItem<TItem, TTodo>>;
	unmatched: Array<UnmatchedActionItem<TItem>>;
	/**
	 * Stored bindings that address nothing in this run: a reworded item, a
	 * dropped item, a surplus duplicate, or every binding at once after a
	 * `TODO_BINDING_VERSION` bump.
	 *
	 * The whole row is carried, not just its id, because this set is what keeps a
	 * hand-set assignee alive: the caller re-offers it as an unconfirmed
	 * suggestion, and reads `lastKnownCompletedAt` off it to say the item had
	 * been completed before its text changed (R18, R41). An orphan is a
	 * suggestion to resolve, never a row to delete on sight.
	 */
	orphaned: TTodo[];
};

/** The compound unique the caller upserts on — one spelling, in one place. */
export type TodoBindingWhere = {
	transcriptId_itemKey_occurrenceIndex: {
		transcriptId: string;
		itemKey: string;
		occurrenceIndex: number;
	};
};

/**
 * The other direction: from a computed binding back to the row that holds it.
 *
 * Kept here so the `(transcriptId, itemKey, occurrenceIndex)` triple — which is
 * also the table's unique constraint — is spelled once. A caller that hand-built
 * this object with the columns in a different order would still compile and
 * would still be wrong the first time a column is added.
 */
export function todoBindingWhere(
	transcriptId: string,
	binding: { itemKey: string; occurrenceIndex: number },
): TodoBindingWhere {
	return {
		transcriptId_itemKey_occurrenceIndex: {
			transcriptId,
			itemKey: binding.itemKey,
			occurrenceIndex: binding.occurrenceIndex,
		},
	};
}

function slotOf(itemKey: string, occurrenceIndex: number): string {
	return `${itemKey}#${occurrenceIndex}`;
}

/**
 * Pairs a transcript's live action items with its stored to-dos.
 *
 * Occurrence assignment: when several live items normalize to one key, they take
 * `occurrenceIndex` 0, 1, 2... in ascending `orderIndex`. The occurrence is a
 * POSITION in a list an LLM regenerates, not an identity — so a run that emits
 * fewer same-key items than the last one orphans the surplus rather than
 * rebinding it to the survivor. Rebinding would be the worse failure: it would
 * hand one commitment's assignee and snooze to a different commitment that
 * merely reads the same, silently and with no way for anyone to notice. An
 * orphan, by contrast, surfaces as an unconfirmed suggestion a person resolves.
 *
 * Generic over both row shapes so a caller selects the columns it needs (the
 * matcher wants the assignee, the list wants the snooze) without this module
 * knowing about either. Pure by construction: no Prisma import, no I/O.
 */
export function bindActionItemsToTodos<
	TItem extends BindableActionItem,
	TTodo extends BindableTodo,
>(params: {
	actionItems: readonly TItem[];
	todos: readonly TTodo[];
}): ActionItemBinding<TItem, TTodo> {
	// Ascending orderIndex decides which duplicate is occurrence 0. The input
	// array's own order is the tie-break, so a caller that forgot to order its
	// query still gets a deterministic answer rather than an engine-dependent one.
	const ordered = params.actionItems
		.map((item, inputIndex) => ({ item, inputIndex }))
		.sort(
			(a, b) =>
				a.item.orderIndex - b.item.orderIndex ||
				a.inputIndex - b.inputIndex,
		);

	// A manual to-do has no binding columns and must never be matched, orphaned
	// or otherwise touched by a re-extraction, so it is filtered out up front.
	const bindable: Array<{ todo: TTodo; slot: string }> = [];
	const todoBySlot = new Map<string, TTodo>();
	for (const todo of params.todos) {
		if (todo.itemKey === null || todo.occurrenceIndex === null) {
			continue;
		}
		const slot = slotOf(todo.itemKey, todo.occurrenceIndex);
		bindable.push({ todo, slot });
		// The database's unique constraint makes a second row on one slot
		// impossible; if one ever exists, the first wins and the rest orphan
		// rather than being silently dropped from every set.
		if (!todoBySlot.has(slot)) {
			todoBySlot.set(slot, todo);
		}
	}

	const matched: Array<MatchedActionItem<TItem, TTodo>> = [];
	const unmatched: Array<UnmatchedActionItem<TItem>> = [];
	// Identity, not id: a caller could hand us two objects claiming one id, and a
	// row is orphaned exactly when THAT object was not paired with a live item.
	const matchedTodos = new Set<TTodo>();
	const occurrenceByKey = new Map<string, number>();

	for (const { item } of ordered) {
		const itemKey = computeTodoItemKey(item.text);
		const occurrenceIndex = occurrenceByKey.get(itemKey) ?? 0;
		occurrenceByKey.set(itemKey, occurrenceIndex + 1);

		const slot = slotOf(itemKey, occurrenceIndex);
		const todo = todoBySlot.get(slot);
		if (todo) {
			matchedTodos.add(todo);
			matched.push({ item, itemKey, occurrenceIndex, todo });
		} else {
			unmatched.push({ item, itemKey, occurrenceIndex });
		}
	}

	// Input order is preserved so a caller's `orderBy` decides how orphans are
	// presented, and so the result is stable across runs.
	const orphaned = bindable
		.filter(({ todo }) => !matchedTodos.has(todo))
		.map(({ todo }) => todo);

	return { matched, unmatched, orphaned };
}

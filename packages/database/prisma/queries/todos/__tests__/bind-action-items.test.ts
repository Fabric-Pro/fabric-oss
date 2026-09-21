import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	computeActionItemKey,
	normalizeItemText,
} from "../../projects/meeting-action-item-keys";
import {
	type BindableActionItem,
	type BindableTodo,
	bindActionItemsToTodos,
	computeTodoItemKey,
	TODO_BINDING_VERSION,
	todoBindingWhere,
} from "../bind-action-items";

/**
 * The key rule restated at an ARBITRARY version, so the version-bump case can
 * build a binding this build would never produce. It is pinned to the real
 * function at the current version by the first test below; if the composition
 * changes and this helper is not updated, that anchor fails rather than the
 * bump case silently passing for the wrong reason.
 */
function keyAtVersion(version: number, text: string): string {
	return createHash("sha256")
		.update(`todo:v${version}\n${normalizeItemText(text)}`)
		.digest("hex");
}

type TestTodo = BindableTodo & {
	assigneeUserId: string | null;
	assignedManually: boolean;
	lastKnownCompletedAt: Date | null;
};

function item(
	overrides: Partial<BindableActionItem> & {
		text: string;
		orderIndex: number;
	},
): BindableActionItem {
	return {
		id: `item-${overrides.orderIndex}`,
		completedAt: null,
		...overrides,
	};
}

function todo(overrides: Partial<TestTodo> & { id: string }): TestTodo {
	return {
		itemKey: null,
		occurrenceIndex: null,
		assigneeUserId: null,
		assignedManually: false,
		lastKnownCompletedAt: null,
		...overrides,
	};
}

/** A to-do already bound to `text` at `occurrenceIndex`, as a prior run wrote it. */
function boundTodo(
	id: string,
	text: string,
	occurrenceIndex: number,
	overrides: Partial<TestTodo> = {},
): TestTodo {
	return todo({
		id,
		itemKey: computeTodoItemKey(text),
		occurrenceIndex,
		...overrides,
	});
}

describe("computeTodoItemKey", () => {
	it("never equals the action-item link key for the same text", () => {
		// The whole point of the `todo:` domain prefix. Without it both digests
		// are sha256("v1\n" + normalized) and are byte-identical while the two
		// version constants happen to agree — which would read as one shared key
		// right up to the moment either constant moves.
		for (const text of ["Ship the digest", "  SEND   the report ", "x"]) {
			expect(computeTodoItemKey(text)).not.toBe(
				computeActionItemKey(text),
			);
		}
	});

	it("composes sha256 over the current version prefix and the shared normalization", () => {
		expect(computeTodoItemKey("Ship the digest")).toBe(
			keyAtVersion(TODO_BINDING_VERSION, "Ship the digest"),
		);
	});

	it("ignores case and whitespace, because it imports the shared rule", () => {
		expect(computeTodoItemKey("  Ship   the DIGEST ")).toBe(
			computeTodoItemKey("ship the digest"),
		);
	});

	it("gives a rewording a different key", () => {
		expect(computeTodoItemKey("Ship the digest by Friday")).not.toBe(
			computeTodoItemKey("Ship the digest"),
		);
	});
});

describe("bindActionItemsToTodos", () => {
	it("keeps an unchanged item's to-do", () => {
		const live = item({ text: "Ship the digest", orderIndex: 0 });
		const existing = boundTodo("todo-1", "Ship the digest", 0, {
			assigneeUserId: "user-a",
			assignedManually: true,
		});

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [existing],
		});

		expect(result.matched).toEqual([
			{
				item: live,
				itemKey: computeTodoItemKey("Ship the digest"),
				occurrenceIndex: 0,
				todo: existing,
			},
		]);
		expect(result.unmatched).toEqual([]);
		expect(result.orphaned).toEqual([]);
	});

	it("matches through whitespace and case drift in the re-extracted text", () => {
		const live = item({ text: "  ship   THE digest ", orderIndex: 0 });
		const existing = boundTodo("todo-1", "Ship the digest", 0);

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [existing],
		});

		expect(result.matched).toHaveLength(1);
		expect(result.matched[0]?.todo.id).toBe("todo-1");
		expect(result.orphaned).toEqual([]);
	});

	it("orphans a reworded item's to-do with its assignee intact and offers the new text as unmatched", () => {
		const live = item({
			text: "Ship the digest by Friday",
			orderIndex: 0,
		});
		const existing = boundTodo("todo-1", "Ship the digest", 0, {
			assigneeUserId: "user-a",
			assignedManually: true,
		});

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [existing],
		});

		expect(result.matched).toEqual([]);
		expect(result.unmatched).toEqual([
			{
				item: live,
				itemKey: computeTodoItemKey("Ship the digest by Friday"),
				occurrenceIndex: 0,
			},
		]);
		// R18: the orphan carries the row, so the caller can re-offer the person
		// who was assigned by hand as an unconfirmed suggestion.
		expect(result.orphaned).toHaveLength(1);
		expect(result.orphaned[0]?.assigneeUserId).toBe("user-a");
		expect(result.orphaned[0]?.assignedManually).toBe(true);
	});

	it("binds two identically normalizing items to two distinct to-dos by occurrence", () => {
		const first = item({ text: "Send the report", orderIndex: 0 });
		const second = item({ text: "send the  report", orderIndex: 1 });
		const todoZero = boundTodo("todo-0", "Send the report", 0, {
			assigneeUserId: "user-a",
		});
		const todoOne = boundTodo("todo-1", "Send the report", 1, {
			assigneeUserId: "user-b",
		});

		const result = bindActionItemsToTodos({
			actionItems: [second, first],
			todos: [todoOne, todoZero],
		});

		expect(result.unmatched).toEqual([]);
		expect(result.orphaned).toEqual([]);
		// Occurrence follows ascending orderIndex, not the order either array
		// happened to arrive in.
		expect(
			result.matched.map((m) => [
				m.item.id,
				m.occurrenceIndex,
				m.todo.id,
			]),
		).toEqual([
			["item-0", 0, "todo-0"],
			["item-1", 1, "todo-1"],
		]);
		// R40: each occurrence keeps its own assignee.
		expect(result.matched[0]?.todo.assigneeUserId).toBe("user-a");
		expect(result.matched[1]?.todo.assigneeUserId).toBe("user-b");
	});

	it("orphans the surplus when a run emits one item where two shared a key", () => {
		const survivor = item({ text: "Send the report", orderIndex: 0 });
		const todoZero = boundTodo("todo-0", "Send the report", 0, {
			assigneeUserId: "user-a",
		});
		const todoOne = boundTodo("todo-1", "Send the report", 1, {
			assigneeUserId: "user-b",
		});

		const result = bindActionItemsToTodos({
			actionItems: [survivor],
			todos: [todoZero, todoOne],
		});

		expect(result.matched).toHaveLength(1);
		expect(result.matched[0]?.todo.id).toBe("todo-0");
		expect(result.unmatched).toEqual([]);
		// The occurrence is a position in a regenerated list, not an identity, so
		// user-b's to-do must NOT be rebound onto the survivor.
		expect(result.orphaned.map((t) => t.id)).toEqual(["todo-1"]);
		expect(result.orphaned[0]?.assigneeUserId).toBe("user-b");
	});

	it("orphans an item that was completed before it was reworded", () => {
		const completedAt = new Date("2026-09-01T10:00:00.000Z");
		const live = item({
			text: "Ship the digest on Monday",
			orderIndex: 0,
			completedAt: null,
		});
		const existing = boundTodo("todo-1", "Ship the digest", 0, {
			lastKnownCompletedAt: completedAt,
		});

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [existing],
		});

		// R41: the caller reads the snapshot off the orphan to say the returning
		// item had been completed before its text changed.
		expect(result.orphaned).toHaveLength(1);
		expect(result.orphaned[0]?.lastKnownCompletedAt).toEqual(completedAt);
		expect(result.unmatched).toHaveLength(1);
		expect(result.unmatched[0]?.item.completedAt).toBeNull();
	});

	it("keeps binding a completed item that was not reworded", () => {
		const live = item({
			text: "Ship the digest",
			orderIndex: 0,
			completedAt: new Date("2026-09-01T10:00:00.000Z"),
		});
		const existing = boundTodo("todo-1", "Ship the digest", 0);

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [existing],
		});

		expect(result.matched).toHaveLength(1);
		expect(result.orphaned).toEqual([]);
	});

	it("orphans every binding after a TODO_BINDING_VERSION bump rather than throwing", () => {
		const live = [
			item({ text: "Ship the digest", orderIndex: 0 }),
			item({ text: "Send the report", orderIndex: 1 }),
		];
		// Rows written by a build carrying a different version constant.
		const stale = [
			todo({
				id: "todo-0",
				itemKey: keyAtVersion(
					TODO_BINDING_VERSION - 1,
					"Ship the digest",
				),
				occurrenceIndex: 0,
				assigneeUserId: "user-a",
			}),
			todo({
				id: "todo-1",
				itemKey: keyAtVersion(
					TODO_BINDING_VERSION - 1,
					"Send the report",
				),
				occurrenceIndex: 0,
				assigneeUserId: "user-b",
			}),
		];

		const result = bindActionItemsToTodos({
			actionItems: live,
			todos: stale,
		});

		expect(result.matched).toEqual([]);
		expect(result.unmatched).toHaveLength(2);
		// Every assignee survives as a suggestion; a bump costs confirmation, not
		// data.
		expect(result.orphaned.map((t) => t.id)).toEqual(["todo-0", "todo-1"]);
		expect(result.orphaned.map((t) => t.assigneeUserId)).toEqual([
			"user-a",
			"user-b",
		]);
	});

	it("never places a manual to-do in any of the three sets", () => {
		const live = item({ text: "Ship the digest", orderIndex: 0 });
		const manual = todo({ id: "manual-1", assigneeUserId: "user-a" });
		const halfBound = todo({
			id: "half-1",
			itemKey: computeTodoItemKey("Ship the digest"),
			occurrenceIndex: null,
		});

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [manual, halfBound],
		});

		expect(result.matched).toEqual([]);
		expect(result.unmatched).toHaveLength(1);
		expect(result.orphaned).toEqual([]);
	});

	it("returns three empty sets for empty input", () => {
		expect(bindActionItemsToTodos({ actionItems: [], todos: [] })).toEqual({
			matched: [],
			unmatched: [],
			orphaned: [],
		});
	});

	it("orphans every to-do when a run emits no items at all", () => {
		const existing = boundTodo("todo-1", "Ship the digest", 0);

		const result = bindActionItemsToTodos({
			actionItems: [],
			todos: [existing],
		});

		expect(result.orphaned.map((t) => t.id)).toEqual(["todo-1"]);
	});

	it("treats whitespace-only items as one key disambiguated by occurrence", () => {
		const blankFirst = item({ text: "   ", orderIndex: 0 });
		const blankSecond = item({ text: "\t\n", orderIndex: 1 });
		const existing = boundTodo("todo-blank", "", 1);

		const result = bindActionItemsToTodos({
			actionItems: [blankFirst, blankSecond],
			todos: [existing],
		});

		// Both normalize to the empty string, so they share a key and are told
		// apart by occurrence — no throw, no collapse into one binding.
		expect(result.unmatched).toEqual([
			{
				item: blankFirst,
				itemKey: computeTodoItemKey(""),
				occurrenceIndex: 0,
			},
		]);
		expect(result.matched).toHaveLength(1);
		expect(result.matched[0]?.item.id).toBe("item-1");
		expect(result.matched[0]?.occurrenceIndex).toBe(1);
		expect(result.orphaned).toEqual([]);
	});

	it("leaves unrelated to-dos of the same transcript alone", () => {
		const live = item({ text: "Ship the digest", orderIndex: 0 });
		const bound = boundTodo("todo-1", "Ship the digest", 0);
		const other = boundTodo("todo-2", "A retired commitment", 0);

		const result = bindActionItemsToTodos({
			actionItems: [live],
			todos: [bound, other],
		});

		expect(result.matched.map((m) => m.todo.id)).toEqual(["todo-1"]);
		expect(result.orphaned.map((t) => t.id)).toEqual(["todo-2"]);
	});
});

describe("todoBindingWhere", () => {
	it("spells the compound unique the to-do table is keyed on", () => {
		const { unmatched } = bindActionItemsToTodos({
			actionItems: [item({ text: "Ship the digest", orderIndex: 0 })],
			todos: [],
		});
		const binding = unmatched[0];
		if (!binding) {
			throw new Error("expected exactly one unmatched binding");
		}

		expect(todoBindingWhere("transcript-1", binding)).toEqual({
			transcriptId_itemKey_occurrenceIndex: {
				transcriptId: "transcript-1",
				itemKey: computeTodoItemKey("Ship the digest"),
				occurrenceIndex: 0,
			},
		});
	});
});

/**
 * The To Do list's pure rules (Fizzy #2340).
 *
 * These are the edges the rendered suite cannot reach cheaply — a snooze
 * expiring on the exact millisecond, a row completed while it slept, a project
 * the server did not name. Each one has a matching rule on the server side,
 * and the point of pinning them here is that the two answers stay the same.
 */

import {
	applyTodoOverride,
	assigneeOptionKey,
	dedupeTodos,
	groupUnassigned,
	isSnoozed,
	isSuggestedAssignment,
	matchesFilters,
	matchesNarrowingFilters,
	parseSuggestionCandidates,
	rememberOptions,
	snoozePresetDate,
	type TodoListItem,
	type TodoProjectOption,
	todoScope,
	todoServerFilters,
	visibleTodos,
	wasPreviouslyCompleted,
} from "@saas/todos/lib/todo-list-model";
import { describe, expect, it } from "vitest";

function item(overrides: Partial<TodoListItem> & { id: string }): TodoListItem {
	return {
		source: "MANUAL",
		title: "A to-do",
		projectId: null,
		projectName: null,
		assigneeUserId: null,
		assigneeUser: null,
		assigneeContactId: null,
		assigneeContact: null,
		suggestedUserId: null,
		suggestedContactId: null,
		assignedManually: false,
		snoozedUntil: null,
		sourceDate: "2026-09-10T09:00:00.000Z",
		completedAt: null,
		isCompleted: false,
		isOrphaned: false,
		...overrides,
	};
}

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

describe("snooze", () => {
	it("treats a deadline that has exactly arrived as elapsed", () => {
		// The read's own boundary is `snoozedUntil <= now`; a row the server
		// considers awake must not be filed under Snoozed here.
		const wakingNow = item({
			id: "a",
			snoozedUntil: new Date(NOW).toISOString(),
		});
		expect(isSnoozed(wakingNow, NOW)).toBe(false);
		expect(todoScope(wakingNow, NOW)).toBe("open");
	});

	it("keeps a row asleep until then", () => {
		const asleep = item({
			id: "b",
			snoozedUntil: new Date(NOW + 1000).toISOString(),
		});
		expect(todoScope(asleep, NOW)).toBe("snoozed");
	});

	it("files a row completed while it slept under Completed", () => {
		// Listing it as snoozed would offer to wake work that no longer exists.
		const done = item({
			id: "c",
			isCompleted: true,
			completedAt: "2026-09-17T09:00:00.000Z",
			snoozedUntil: new Date(NOW + 1000).toISOString(),
		});
		expect(todoScope(done, NOW)).toBe("completed");
	});
});

describe("suggested assignment", () => {
	const ada = { id: "user-ada", name: "Ada Member", image: null };

	it("is a suggestion when nobody confirmed it", () => {
		expect(
			isSuggestedAssignment(
				item({
					id: "d",
					assigneeUserId: ada.id,
					assigneeUser: ada,
					suggestedUserId: ada.id,
				}),
			),
		).toBe(true);
	});

	it("is a suggestion for an orphan whatever the extraction proposed", () => {
		expect(
			isSuggestedAssignment(
				item({
					id: "e",
					isOrphaned: true,
					assigneeUserId: ada.id,
					assigneeUser: ada,
				}),
			),
		).toBe(true);
	});

	it("is not a suggestion once a person chose", () => {
		expect(
			isSuggestedAssignment(
				item({
					id: "f",
					assigneeUserId: ada.id,
					assigneeUser: ada,
					suggestedUserId: "user-other",
					assignedManually: true,
				}),
			),
		).toBe(false);
	});

	it("says nothing about a row with no assignee at all", () => {
		// The bucket already says "unassigned"; a "suggested" badge with no
		// name beside it tells the reader nothing they can act on.
		expect(
			isSuggestedAssignment(item({ id: "g", suggestedUserId: "user-x" })),
		).toBe(false);
	});
});

describe("unassigned buckets", () => {
	it("opens exactly the projects the server named", () => {
		const buckets = groupUnassigned(
			[
				item({ id: "h", projectId: "p1", projectName: "Apollo" }),
				item({ id: "i", projectId: "p2", projectName: "Borealis" }),
				item({ id: "j", projectId: null }),
			],
			["p1"],
		);

		expect(
			buckets.map((bucket) => [
				bucket.projectId,
				bucket.expandedByDefault,
			]),
		).toEqual([
			["p1", true],
			["p2", false],
			// "Expanded" is a statement about a PROJECT's owner, so a row with
			// no project can never be in that list and stays closed.
			[null, false],
		]);
	});
});

const OPEN_VIEW = { scope: "open" as const, project: null, assignee: null };

describe("what a view shows", () => {
	const now = Date.parse("2026-09-18T12:00:00.000Z");

	it("keeps a row completed in this session in the open view", () => {
		const done = item({ id: "a", isCompleted: true });
		const other = item({ id: "b" });

		// Without the session set this row belongs to the Completed view, and
		// ticking it off would make it vanish under the cursor.
		expect(matchesFilters(done, OPEN_VIEW, now)).toBe(false);
		expect(
			visibleTodos([done, other], OPEN_VIEW, now, new Set(["a"])).map(
				(row) => row.id,
			),
		).toEqual(["a", "b"]);
	});

	it("does not pin one into a view its filters exclude", () => {
		const done = item({
			id: "a",
			isCompleted: true,
			projectId: "p1",
			projectName: "Apollo",
		});
		const filters = {
			...OPEN_VIEW,
			project: { id: "p2", name: "Borealis" },
		};

		// Staying put is about the SCOPE. A row that ignored the project chip
		// above it would read as the filter having stopped working.
		expect(matchesNarrowingFilters(done, filters)).toBe(false);
		expect(visibleTodos([done], filters, now, new Set(["a"]))).toEqual([]);
	});

	it("does not pin one that is also snoozed", () => {
		const done = item({
			id: "a",
			isCompleted: true,
			snoozedUntil: "2026-10-01T09:00:00.000Z",
		});

		// Completion wins over snooze for SCOPE, but a row deliberately hidden
		// until October has no business being shown in the open view today.
		expect(visibleTodos([done], OPEN_VIEW, now, new Set(["a"]))).toEqual(
			[],
		);
	});

	it("pins nothing into the completed or snoozed views", () => {
		const done = item({ id: "a", isCompleted: true });
		const completedView = { ...OPEN_VIEW, scope: "completed" as const };

		expect(
			visibleTodos([done], completedView, now, new Set(["a"])).map(
				(row) => row.id,
			),
		).toEqual(["a"]);
		expect(
			visibleTodos(
				[item({ id: "b" })],
				completedView,
				now,
				new Set(["b"]),
			),
		).toEqual([]);
	});
});

describe("a row's claims while a write is in flight", () => {
	it("lays the claim over the server's row without editing it", () => {
		const row = item({ id: "a" });
		const claimed = applyTodoOverride(row, { isCompleted: true });

		expect(claimed.isCompleted).toBe(true);
		expect(row.isCompleted).toBe(false);
		// No claim, no copy: the response's own object flows straight through.
		expect(applyTodoOverride(row, undefined)).toBe(row);
	});
});

describe("the matcher's shortlist", () => {
	it("keeps the entries that name somebody and drops the rest", () => {
		expect(
			parseSuggestionCandidates([
				{ kind: "user", id: "u1", name: "Ada Member" },
				{ kind: "contact", id: "c1", name: "Cleo Client" },
				// Every one of these has been written by some run of the
				// matcher or another, and a chip labelled `undefined` — or a
				// render that throws and takes the whole list with it — is a
				// worse answer than no chip.
				{ kind: "user", id: "u1", name: "Ada Member" },
				{ kind: "alien", id: "x", name: "X" },
				{ kind: "user", id: "", name: "Nameless" },
				{ kind: "user", id: "u2", name: "   " },
				"a bare string",
				null,
			]),
		).toEqual([
			{ kind: "user", id: "u1", name: "Ada Member" },
			{ kind: "contact", id: "c1", name: "Cleo Client" },
		]);
	});

	it("answers nothing for a column that was never written", () => {
		expect(parseSuggestionCandidates(null)).toEqual([]);
		expect(parseSuggestionCandidates(undefined)).toEqual([]);
		expect(parseSuggestionCandidates({ candidates: [] })).toEqual([]);
	});
});

describe("a completion that outlived its wording", () => {
	it("is claimed only by a row that is not completed now", () => {
		// The snapshot is cleared when a row is reopened, so a row holding one
		// while reading as incomplete was completed and then reworded.
		expect(
			wasPreviouslyCompleted(
				item({
					id: "a",
					isOrphaned: true,
					lastKnownCompletedAt: "2026-08-02T09:00:00.000Z",
				}),
			),
		).toBe(true);
		// Currently completed: the row already says so in its own line, and
		// repeating it as history would read as two separate completions.
		expect(
			wasPreviouslyCompleted(
				item({
					id: "b",
					isCompleted: true,
					completedAt: "2026-08-02T09:00:00.000Z",
					lastKnownCompletedAt: "2026-08-02T09:00:00.000Z",
				}),
			),
		).toBe(false);
		expect(wasPreviouslyCompleted(item({ id: "c" }))).toBe(false);
	});
});

describe("snooze presets", () => {
	it("counts in calendar units, and always lands in the future", () => {
		const from = new Date("2026-02-27T23:30:00.000Z");

		expect(snoozePresetDate("day", from).toISOString()).toBe(
			"2026-02-28T23:30:00.000Z",
		);
		expect(snoozePresetDate("week", from).toISOString()).toBe(
			"2026-03-06T23:30:00.000Z",
		);
		// A month is not thirty days: `todos.snooze` refuses anything at or
		// before now, and arithmetic that drifts is how "next month" lands on
		// a date the server rejects.
		expect(snoozePresetDate("month", from).toISOString()).toBe(
			"2026-03-27T23:30:00.000Z",
		);
		for (const preset of ["day", "week", "month"] as const) {
			expect(snoozePresetDate(preset, from).getTime()).toBeGreaterThan(
				from.getTime(),
			);
		}
	});
});

describe("the read's own filters", () => {
	const apollo: TodoProjectOption = { id: "proj-1", name: "Apollo" };

	it("sends nothing when nothing is selected", () => {
		// An empty object, not `{ projectId: undefined }`: the page spreads
		// this into the read's input, and an explicit `undefined` is a key the
		// query cache sees change when nothing has.
		expect(todoServerFilters(null, null)).toEqual({});
	});

	it("names a member and a contact by the field each one has", () => {
		expect(
			todoServerFilters(apollo, {
				kind: "user",
				id: "user-ada",
				name: "Ada Member",
			}),
		).toEqual({ projectId: "proj-1", assigneeUserId: "user-ada" });

		expect(
			todoServerFilters(null, {
				kind: "contact",
				id: "contact-bo",
				name: "Bo Client",
			}),
		).toEqual({ assigneeContactId: "contact-bo" });
	});

	it("never sends both assignee fields at once", () => {
		// A to-do carries `assigneeUserId` XOR `assigneeContactId`, and the
		// read REFUSES both — they could only ever match nothing. One
		// combobox holding one selection is what keeps that true.
		for (const kind of ["user", "contact"] as const) {
			const sent = todoServerFilters(null, {
				kind,
				id: "someone",
				name: "Someone",
			});
			expect(
				["assigneeUserId", "assigneeContactId"].filter(
					(key) => key in sent,
				),
			).toHaveLength(1);
		}
	});
});

describe("flattening the pages", () => {
	it("keeps the first copy of a row two pages both served", () => {
		// The keyset pages a live list: a cursor row whose sort key moved
		// between two fetches comes back under the next cursor. Appended
		// blindly it is a repeated React key and a row with two sets of
		// actions, so the page renders it once — in the place the reader has
		// already been looking at.
		const first = item({ id: "a", title: "As first served" });
		const again = item({ id: "a", title: "Reworded since" });
		const second = item({ id: "b" });

		expect(dedupeTodos([first, second, again])).toEqual([first, second]);
	});

	it("leaves a list with no repeats exactly as it was", () => {
		const rows = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
		expect(dedupeTodos(rows)).toEqual(rows);
	});
});

describe("remembering the filter options", () => {
	const apollo: TodoProjectOption = { id: "proj-1", name: "Apollo" };
	const borealis: TodoProjectOption = { id: "proj-2", name: "Borealis" };
	const byId = (option: TodoProjectOption) => option.id;

	it("keeps an option on offer after the response stops carrying it", () => {
		const seen = new Map<string, TodoProjectOption>();
		rememberOptions(seen, [apollo, borealis], byId);

		// The filtered read answers with Borealis rows only. Derived fresh,
		// the combobox would collapse to Borealis and the reader could not
		// return to Apollo without first clearing the filter.
		expect(rememberOptions(seen, [borealis], byId)).toEqual([
			apollo,
			borealis,
		]);
	});

	it("adds each option once, in the order it was first offered", () => {
		const seen = new Map<string, TodoProjectOption>();
		rememberOptions(seen, [apollo], byId);
		expect(
			rememberOptions(
				seen,
				[{ ...apollo, name: "Apollo (renamed)" }, borealis],
				byId,
			),
		).toEqual([apollo, borealis]);
	});

	it("tells two people of different kinds apart", () => {
		// A member and a contact can share an id; keyed on the id alone, one
		// of them would silently disappear from the assignee list.
		expect(
			assigneeOptionKey({ kind: "user", id: "x", name: "Ada" }),
		).not.toBe(assigneeOptionKey({ kind: "contact", id: "x", name: "Bo" }));
	});
});

/**
 * Consolidated To Do list — assignment matcher (Fizzy #2340).
 *
 * The behaviour under test is almost entirely about what the matcher REFUSES to
 * do. `tentativeOwnerName` is a free-text guess an LLM read off a transcript
 * that carries no participant email, so a confident-looking near-match is not
 * evidence of anything. These cases pin the line between an assignment (exactly
 * one candidate's full name, normalized, across members and contacts together)
 * and a suggestion (everything weaker), and pin the three ways a person's own
 * work survives a re-extraction: a manual assignee is never overwritten, an
 * orphaned row is never deleted, and an unchanged run never writes at all.
 *
 * Prisma is mocked the way `link-action-items.test.ts` beside this file mocks
 * it: the pure helpers (`bindActionItemsToTodos`, `computeTodoItemKey`,
 * `normalizeItemText`) run for real, because the binding rules they encode are
 * exactly what the matcher is being tested against, and only the client is
 * faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	DB_NULL,
	mockIsFeatureEnabled,
	mockFindFirstTranscript,
	mockUpsertTodo,
	mockUpdateManyTodo,
	mockUpdateManyTranscript,
	mockFindUniqueTranscript,
	mockBackfillItemKey,
	mockFindManyMembers,
	mockFindManyContacts,
} = vi.hoisted(() => ({
	DB_NULL: Symbol("Prisma.DbNull"),
	mockIsFeatureEnabled: vi.fn(),
	mockFindFirstTranscript: vi.fn(),
	mockUpsertTodo: vi.fn(),
	mockUpdateManyTodo: vi.fn(),
	mockUpdateManyTranscript: vi.fn(),
	mockFindUniqueTranscript: vi.fn(),
	mockBackfillItemKey: vi.fn(),
	mockFindManyMembers: vi.fn(),
	mockFindManyContacts: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	ApplicationFailure: {
		nonRetryable: (message: string, type: string) => {
			const err = new Error(message);
			err.name = type;
			return err;
		},
	},
}));

vi.mock("@repo/database", async () => {
	// Keep the real binding and normalization running: the occurrence rules and
	// the item key are the contract this activity is built on, and a fake would
	// let a broken binding pass.
	const binding = await vi.importActual<
		typeof import("@repo/database/prisma/queries/todos/bind-action-items")
	>("@repo/database/prisma/queries/todos/bind-action-items");
	const keys = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/meeting-action-item-keys")
	>("@repo/database/prisma/queries/projects/meeting-action-item-keys");
	return {
		...binding,
		...keys,
		isFeatureEnabled: mockIsFeatureEnabled,
		Prisma: { DbNull: DB_NULL },
		db: {
			projectMeetingTranscript: {
				findFirst: mockFindFirstTranscript,
				// updateMany, not update: the stamp carries a WHERE on the
				// extraction revision it was taken against, and `update` cannot
				// express a conditional write.
				updateMany: mockUpdateManyTranscript,
				// Read only when the stamp matched nothing, to tell a re-extraction
				// apart from a deleted transcript rather than logging a guess.
				findUnique: mockFindUniqueTranscript,
			},
			// Both to-do writers are `updateMany` now, for the same reason: the
			// assignment write and the orphan carry each re-check
			// `assignedManually` in the WHERE so Postgres, not a stale snapshot,
			// decides whether a person's choice is overwritten.
			todoItem: {
				upsert: mockUpsertTodo,
				updateMany: mockUpdateManyTodo,
			},
			projectMeetingActionItem: { updateMany: mockBackfillItemKey },
			member: { findMany: mockFindManyMembers },
			nonMemberContact: { findMany: mockFindManyContacts },
		},
	};
});

import { computeTodoItemKey, TODO_BINDING_VERSION } from "@repo/database";
import { matchMeetingActionItemOwnersActivity } from "../match-action-item-owners";

const MEETING_DATE = new Date("2026-09-10T09:00:00Z");
const SYNCED_AT = new Date("2026-09-10T11:00:00Z");
/** The extraction revision the matcher reads and stamps against. */
const EXTRACTED_AT = new Date("2026-09-10T11:05:00Z");

const baseInput = {
	projectId: "proj-1",
	organizationId: "org-1",
	transcriptCuid: "tr-1",
};

const ANNA = { id: "user-anna", name: "Anna Petrova" };
const SAM_MEMBER = { id: "user-sam", name: "Sam Carter" };

interface StoredTodo {
	id: string;
	itemKey: string | null;
	occurrenceIndex: number | null;
	projectId: string | null;
	itemTextSnapshot: string | null;
	sourceDate: Date;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	assignedManually: boolean;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	suggestionCandidates: unknown;
}

/**
 * A live action item, in the shape the activity selects.
 *
 * `itemKey` defaults to the key its own text hashes to, which is what a
 * post-#2340 extraction stores. A test about a meeting extracted BEFORE the
 * column existed passes `itemKey: null` explicitly — that is the only state in
 * which the matcher repairs the row, so defaulting to it would hide the
 * repair's guard behind every unrelated test.
 */
function item(
	text: string,
	tentativeOwnerName: string | null,
	order = 0,
	itemKey: string | null = computeTodoItemKey(text),
) {
	return {
		id: `ai-${order}`,
		orderIndex: order,
		text,
		completedAt: null,
		tentativeOwnerName,
		itemKey,
	};
}

/** A stored to-do bound to `text`, with everything else unset by default. */
function todo(text: string, overrides: Partial<StoredTodo> = {}): StoredTodo {
	return {
		id: "todo-1",
		itemKey: computeTodoItemKey(text),
		occurrenceIndex: 0,
		projectId: "proj-1",
		itemTextSnapshot: text,
		sourceDate: MEETING_DATE,
		assigneeUserId: null,
		assigneeContactId: null,
		assignedManually: false,
		suggestedUserId: null,
		suggestedContactId: null,
		suggestionCandidates: null,
		...overrides,
	};
}

function arrangeTranscript(
	actionItems: ReturnType<typeof item>[],
	todoItems: StoredTodo[] = [],
) {
	mockFindFirstTranscript.mockResolvedValue({
		id: "tr-1",
		projectId: "proj-1",
		meetingDate: MEETING_DATE,
		syncedAt: SYNCED_AT,
		userId: "user-owner",
		organizationId: "org-1",
		insightsExtractedAt: EXTRACTED_AT,
		actionItems,
		todoItems,
	});
}

/**
 * Applies a guarded write's `where` to a fixture row, the way Postgres would.
 *
 * Asserting the SHAPE of a `where` clause only proves we typed what we typed —
 * the trap written up in
 * docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md
 * (§4). What proves the guard is evaluating it against a row a person has just
 * claimed and watching the write match nothing.
 */
function whereMatches(
	where: Record<string, unknown>,
	row: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([column, expected]) => {
		const actual = row[column];
		return actual instanceof Date && expected instanceof Date
			? actual.getTime() === expected.getTime()
			: actual === expected;
	});
}

/**
 * The orphan-carry writes, addressed by row id.
 *
 * Both the assignment write and the orphan carry go through
 * `todoItem.updateMany`, so a bare `toHaveBeenCalled` can no longer tell which
 * path ran. They are distinguishable by their address: the orphan carry knows
 * the row's id, the assignment write knows only the binding triple.
 */
function orphanCarryCalls() {
	return mockUpdateManyTodo.mock.calls.filter(
		(call) => call[0].where.id !== undefined,
	);
}

/** The assignment writes, addressed by the binding triple. */
function assignmentCalls() {
	return mockUpdateManyTodo.mock.calls.filter(
		(call) => call[0].where.itemKey !== undefined,
	);
}

/** The `create` payload of the nth upsert. */
function createArg(call = 0) {
	return mockUpsertTodo.mock.calls[call][0].create;
}

/** The row the previous run would have left behind, fed back for a re-run. */
function storedFromCreate(create: Record<string, unknown>): StoredTodo {
	return {
		id: "todo-1",
		itemKey: create.itemKey as string,
		occurrenceIndex: create.occurrenceIndex as number,
		projectId: create.projectId as string,
		itemTextSnapshot: create.itemTextSnapshot as string,
		sourceDate: create.sourceDate as Date,
		assigneeUserId: (create.assigneeUserId as string) ?? null,
		assigneeContactId: (create.assigneeContactId as string) ?? null,
		assignedManually: false,
		suggestedUserId: (create.suggestedUserId as string) ?? null,
		suggestedContactId: (create.suggestedContactId as string) ?? null,
		suggestionCandidates:
			create.suggestionCandidates === DB_NULL
				? null
				: create.suggestionCandidates,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockFindManyMembers.mockResolvedValue([{ user: ANNA }]);
	mockFindManyContacts.mockResolvedValue([]);
	mockUpsertTodo.mockResolvedValue({});
	// `{ count: 1 }` is "the WHERE still matched" — the ordinary case. A test
	// about losing a race overrides it with `{ count: 0 }`.
	mockUpdateManyTodo.mockResolvedValue({ count: 1 });
	mockUpdateManyTranscript.mockResolvedValue({ count: 1 });
	mockFindUniqueTranscript.mockResolvedValue({
		insightsExtractedAt: new Date("2026-09-10T11:09:00Z"),
	});
	mockBackfillItemKey.mockResolvedValue({ count: 1 });
	arrangeTranscript([item("Send the coverage report", "Anna Petrova")]);
});

describe("rollout gate", () => {
	it("writes nothing at all when TODO_LIST is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.skipped).toBe("flag-off");
		expect(mockFindFirstTranscript).not.toHaveBeenCalled();
		expect(mockUpsertTodo).not.toHaveBeenCalled();
		expect(mockUpdateManyTodo).not.toHaveBeenCalled();
	});

	it("reads the gate for THIS organization, not globally", async () => {
		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith("TODO_LIST", "org-1");
	});
});

describe("tenancy", () => {
	it("refuses a run with no organizationId instead of falling back", async () => {
		await expect(
			matchMeetingActionItemOwnersActivity({
				...baseInput,
				organizationId: null,
			}),
		).rejects.toThrow(/refusing to match without an organizationId/);

		// Refused BEFORE the gate read: there is no organization to resolve the
		// gate for either, and nothing may be read on a caller's behalf.
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
		expect(mockFindFirstTranscript).not.toHaveBeenCalled();
	});

	it("scopes the transcript lookup by project AND organization", async () => {
		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockFindFirstTranscript).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "tr-1",
					projectId: "proj-1",
					project: { organizationId: "org-1" },
				},
			}),
		);
	});

	it("never considers a same-named contact from another organization", async () => {
		// The register query carries the organization in its WHERE, so the
		// other organization's "Anna Petrova" is not ranked lower — it is never
		// read. The mock returns only this organization's rows, which is the
		// whole point of the assertion below.
		mockFindManyMembers.mockResolvedValue([]);
		mockFindManyContacts.mockResolvedValue([]);
		arrangeTranscript([item("Send the report", "Anna Petrova")]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockFindManyMembers).toHaveBeenCalledWith(
			expect.objectContaining({ where: { organizationId: "org-1" } }),
		);
		expect(mockFindManyContacts).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", redactedAt: null },
			}),
		);
		expect(result.assigned).toBe(0);
		expect(createArg()).toMatchObject({
			assigneeUserId: null,
			assigneeContactId: null,
			suggestedUserId: null,
			suggestedContactId: null,
		});
	});

	it("throws when the transcript is not in this project and organization", async () => {
		mockFindFirstTranscript.mockResolvedValue(null);

		await expect(
			matchMeetingActionItemOwnersActivity(baseInput),
		).rejects.toThrow(/not found in project/);
	});
});

describe("owner matching", () => {
	it("assigns when exactly one candidate's full name matches", async () => {
		arrangeTranscript([
			item("Send the coverage report", "  anna   PETROVA "),
		]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result).toMatchObject({ todosCreated: 1, assigned: 1 });
		expect(createArg()).toMatchObject({
			source: "MEETING_DIGEST",
			transcriptId: "tr-1",
			itemKey: computeTodoItemKey("Send the coverage report"),
			occurrenceIndex: 0,
			itemTextSnapshot: "Send the coverage report",
			sourceDate: MEETING_DATE,
			projectId: "proj-1",
			organizationId: "org-1",
			assigneeUserId: "user-anna",
			assigneeContactId: null,
			suggestedUserId: null,
		});
		expect(createArg().suggestionCandidates).toBe(DB_NULL);
	});

	it("assigns a contact, not only a member", async () => {
		mockFindManyMembers.mockResolvedValue([{ user: ANNA }]);
		mockFindManyContacts.mockResolvedValue([
			{ id: "contact-dana", name: "Dana Fox" },
		]);
		arrangeTranscript([item("Return the signed SOW", "Dana Fox")]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.assigned).toBe(1);
		expect(createArg()).toMatchObject({
			assigneeContactId: "contact-dana",
			assigneeUserId: null,
		});
	});

	it("leaves an item unassigned when two people carry the name, recording both", async () => {
		// One member and one contact, deliberately: ambiguity spans the whole
		// pool, so a member match is not "more exact" than a contact one.
		mockFindManyMembers.mockResolvedValue([
			{ user: { id: "user-dana", name: "Dana Fox" } },
		]);
		mockFindManyContacts.mockResolvedValue([
			{ id: "contact-dana", name: "Dana Fox" },
		]);
		arrangeTranscript([item("Return the signed SOW", "Dana Fox")]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result).toMatchObject({ assigned: 0, suggested: 1 });
		const create = createArg();
		expect(create).toMatchObject({
			assigneeUserId: null,
			assigneeContactId: null,
			// Neither is pointed at: picking one would be a coin flip shown as a
			// fact.
			suggestedUserId: null,
			suggestedContactId: null,
		});
		expect(create.suggestionCandidates).toEqual([
			{ kind: "contact", id: "contact-dana", name: "Dana Fox" },
			{ kind: "user", id: "user-dana", name: "Dana Fox" },
		]);
	});

	it("turns a first-name-only overlap into a suggestion, never an assignment", async () => {
		mockFindManyMembers.mockResolvedValue([{ user: SAM_MEMBER }]);
		arrangeTranscript([item("Book the retro room", "Sam")]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result).toMatchObject({ assigned: 0, suggested: 1 });
		const create = createArg();
		expect(create.assigneeUserId).toBeNull();
		expect(create.assigneeContactId).toBeNull();
		expect(create.suggestedUserId).toBe("user-sam");
		expect(create.suggestionCandidates).toEqual([
			{ kind: "user", id: "user-sam", name: "Sam Carter" },
		]);
	});

	it("leaves an item unassigned with no suggestion when nothing overlaps", async () => {
		mockFindManyMembers.mockResolvedValue([{ user: ANNA }]);
		arrangeTranscript([item("Book the retro room", "Kwame Mensah")]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result).toMatchObject({ assigned: 0, suggested: 0 });
		const create = createArg();
		expect(create.assigneeUserId).toBeNull();
		expect(create.suggestedUserId).toBeNull();
		expect(create.suggestedContactId).toBeNull();
		expect(create.suggestionCandidates).toBe(DB_NULL);
	});

	it("leaves an item with no owner guess untouched by matching", async () => {
		arrangeTranscript([item("Book the retro room", null)]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result).toMatchObject({ assigned: 0, suggested: 0 });
		expect(createArg().suggestionCandidates).toBe(DB_NULL);
	});
});

describe("idempotence", () => {
	it("writes nothing on a second run over unchanged text", async () => {
		await matchMeetingActionItemOwnersActivity(baseInput);
		const stored = storedFromCreate(createArg());

		// Both writers are cleared, not just the upsert: the assignment write
		// is a second statement now, and the first run's call would otherwise
		// be counted against the second run this test is actually about.
		mockUpsertTodo.mockClear();
		mockUpdateManyTodo.mockClear();
		arrangeTranscript(
			[item("Send the coverage report", "Anna Petrova")],
			[stored],
		);

		const second = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockUpsertTodo).not.toHaveBeenCalled();
		expect(mockUpdateManyTodo).not.toHaveBeenCalled();
		expect(second).toMatchObject({
			itemsConsidered: 1,
			todosCreated: 0,
			todosUpdated: 0,
			skipped: "unchanged",
		});
	});

	it("reports a fully matched transcript as a no-op, the stand-in for a stamp", async () => {
		// There is no `todosMatchedAt` column on the transcript, so "already
		// done" is derived from the rows themselves rather than read off a
		// stamp. A completed run therefore costs two reads and no writes.
		const text = "Send the coverage report";
		arrangeTranscript(
			[item(text, "Anna Petrova")],
			[todo(text, { assigneeUserId: "user-anna" })],
		);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.skipped).toBe("unchanged");
		expect(mockUpsertTodo).not.toHaveBeenCalled();
		expect(mockUpdateManyTodo).not.toHaveBeenCalled();
	});

	it("addresses a re-run through the binding triple, so a retry cannot duplicate a row", async () => {
		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockUpsertTodo.mock.calls[0][0].where).toEqual({
			transcriptId_itemKey_occurrenceIndex: {
				transcriptId: "tr-1",
				itemKey: computeTodoItemKey("Send the coverage report"),
				occurrenceIndex: 0,
			},
		});
	});
});

describe("a person's own choice", () => {
	it("never overwrites an assignee a person picked by hand", async () => {
		const text = "Send the coverage report";
		arrangeTranscript(
			[item(text, "Anna Petrova")],
			[
				todo(text, {
					assigneeUserId: "user-someone-else",
					assignedManually: true,
				}),
			],
		);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockUpsertTodo).not.toHaveBeenCalled();
		expect(result.todosUpdated).toBe(0);
	});

	it("keeps a manual assignee even when the item is reworded away", async () => {
		arrangeTranscript(
			[item("Send the Q3 coverage report", "Anna Petrova")],
			[
				todo("Send the coverage report", {
					assigneeUserId: "user-someone-else",
					assignedManually: true,
				}),
			],
		);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.todosOrphaned).toBe(1);
		// The orphan is left completely alone — confirming a suggestion on it
		// would otherwise be undone by the next extraction. Asked of the
		// orphan path specifically, because the assignment path now shares
		// the same `updateMany` method.
		expect(orphanCarryCalls()).toHaveLength(0);
	});
});

describe("orphans", () => {
	it("retains a reworded item's to-do and offers its assignee back", async () => {
		arrangeTranscript(
			[item("Send the Q3 coverage report", "Anna Petrova", 0)],
			[
				todo("Send the coverage report", {
					id: "todo-old",
					assigneeUserId: "user-anna",
				}),
			],
		);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		// The reworded item gets its own fresh row...
		expect(result.todosCreated).toBe(1);
		expect(createArg().itemKey).toBe(
			computeTodoItemKey("Send the Q3 coverage report"),
		);

		// ...and the old row survives, unassigned, with the same person offered
		// back as a suggestion rather than silently dropped.
		expect(result.todosOrphaned).toBe(1);
		// The WHERE carries `assignedManually: false`: the check that chose to
		// carry this orphan read a snapshot taken before candidate resolution,
		// so Postgres re-decides it at write time. Without that predicate a
		// person who claimed this very row in between would find the product
		// had quietly un-assigned them.
		expect(orphanCarryCalls()[0][0]).toEqual({
			where: { id: "todo-old", assignedManually: false },
			data: {
				assigneeUserId: null,
				assigneeContactId: null,
				suggestedUserId: "user-anna",
				suggestedContactId: null,
				suggestionCandidates: [
					{ kind: "user", id: "user-anna", name: "Anna Petrova" },
				],
			},
		});
	});

	it("leaves an unassigned orphan alone rather than rewriting the same nothing", async () => {
		arrangeTranscript(
			[item("Send the Q3 coverage report", null)],
			[todo("Send the coverage report", { id: "todo-old" })],
		);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.todosOrphaned).toBe(1);
		// The orphan path, not every write: the reworded item's fresh row does
		// take an assignment write through the same method.
		expect(orphanCarryCalls()).toHaveLength(0);
	});
});

describe("row provenance", () => {
	it("stamps the meeting's date, the digest source and a readable snapshot", async () => {
		arrangeTranscript([item("Send the coverage report", null)]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(createArg()).toMatchObject({
			source: "MEETING_DIGEST",
			sourceDate: MEETING_DATE,
			itemTextSnapshot: "Send the coverage report",
			userId: "user-owner",
			organizationId: "org-1",
		});
	});

	it("falls back to ingest time when the meeting carries no date", async () => {
		mockFindFirstTranscript.mockResolvedValue({
			id: "tr-1",
			projectId: "proj-1",
			meetingDate: null,
			syncedAt: SYNCED_AT,
			userId: "user-owner",
			organizationId: "org-1",
			actionItems: [item("Send the coverage report", null)],
			todoItems: [],
		});

		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(createArg().sourceDate).toBe(SYNCED_AT);
	});

	it("gives two identically worded items two rows, by occurrence", async () => {
		arrangeTranscript([
			item("Follow up with legal", null, 0),
			item("follow up with LEGAL", null, 1),
		]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.todosCreated).toBe(2);
		expect(createArg(0).occurrenceIndex).toBe(0);
		expect(createArg(1).occurrenceIndex).toBe(1);
		expect(createArg(0).itemKey).toBe(createArg(1).itemKey);
	});
});

describe("matcher stamp (#2340)", () => {
	it("stamps the transcript with the binding version after a run", async () => {
		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockUpdateManyTranscript).toHaveBeenCalledTimes(1);
		const call = mockUpdateManyTranscript.mock.calls[0][0];
		expect(call.data.todoMatchVersion).toBe(TODO_BINDING_VERSION);
		expect(call.data.todosMatchedAt).toBeInstanceOf(Date);
		// Addressed by id AND by the extraction revision this run read, so a
		// re-extraction landing mid-run cannot be reported as matched.
		expect(call.where).toEqual({
			id: "tr-1",
			insightsExtractedAt: EXTRACTED_AT,
		});
	});

	it("does not stamp its own field onto the linker's pair", () => {
		// Sharing a stamp would make each feature believe the other's work was
		// already done, which is why these are two columns rather than one.
		const call = mockUpdateManyTranscript.mock.calls.at(-1);
		if (call) {
			expect(call[0].data).not.toHaveProperty("actionItemsLinkedAt");
			expect(call[0].data).not.toHaveProperty("actionItemsLinkVersion");
		}
	});

	it("writes no stamp when the rollout gate is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockUpdateManyTranscript).not.toHaveBeenCalled();
	});

	it("leaves the transcript unstamped when the run throws part-way", async () => {
		// The stamp is written last on purpose: a partial run must stay visible
		// to the catch-up path rather than reading as finished.
		mockUpsertTodo.mockRejectedValueOnce(new Error("boom"));

		await expect(
			matchMeetingActionItemOwnersActivity(baseInput),
		).rejects.toThrow();
		expect(mockUpdateManyTranscript).not.toHaveBeenCalled();
	});
});

describe("meetings extracted before the key column existed (#2340)", () => {
	// The three tests below are about the seam `todos.catchUp` opened. Before
	// catch-up nothing reached a meeting extracted before `itemKey` existed, so
	// the column's documented "no backfill, filled going forward" decision cost
	// nothing. Catch-up reaches exactly those meetings, which turns a null key
	// into a to-do that renders as orphaned work and completes without moving
	// the digest.
	it("writes the derived key onto a historical action item", async () => {
		arrangeTranscript([
			item("Send the coverage report", "Anna Petrova", 0, null),
		]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockBackfillItemKey).toHaveBeenCalledWith({
			where: {
				id: "ai-0",
				organizationId: "org-1",
				// Guarded, so a retry is a no-op and a concurrent extraction's
				// fresh key wins over this repair instead of losing to it.
				itemKey: null,
			},
			data: { itemKey: computeTodoItemKey("Send the coverage report") },
		});
	});

	it("gives the action item the same key the to-do binds by", async () => {
		// The whole point: the read joins the two on equal keys, so a repair that
		// derived the key differently from the binding would leave the row just
		// as orphaned as no repair at all.
		arrangeTranscript([item("Send the coverage report", null, 0, null)]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockBackfillItemKey.mock.calls[0][0].data.itemKey).toBe(
			createArg().itemKey,
		);
	});

	it("leaves a key extraction already wrote alone", async () => {
		arrangeTranscript([item("Send the coverage report", null)]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		// Overwriting a stored key is either a no-op or a TODO_BINDING_VERSION
		// change, and a version change is a migration that recomputes every key
		// — never a silent per-row rewrite from the matcher.
		expect(mockBackfillItemKey).not.toHaveBeenCalled();
	});

	it("reports how many keys it repaired", async () => {
		arrangeTranscript([item("Send the coverage report", null, 0, null)]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		const { logger } = await import("@repo/logs");
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("run complete"),
			expect.objectContaining({ keysBackfilled: 1 }),
		);
	});
});

describe("a person's assignment beats a stale snapshot (#2340)", () => {
	it("re-checks assignedManually in the WHERE, not against the snapshot", async () => {
		arrangeTranscript([item("Send the coverage report", "Anna Petrova")]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		// The snapshot that decided this write was read before candidate
		// resolution — the slowest step here — so the predicate has to be
		// evaluated by Postgres at write time. Otherwise a person who confirms a
		// suggestion inside that window is overwritten AND left with
		// `assignedManually` true, which freezes the matcher's guess as if they
		// had chosen it.
		//
		// Evaluated against two rows rather than compared as a shape: the guard
		// has to admit the row nobody touched and refuse the one somebody
		// claimed, and only running it proves that.
		expect(assignmentCalls()).toHaveLength(1);
		const guard = assignmentCalls()[0][0].where;
		const address = {
			transcriptId: "tr-1",
			itemKey: computeTodoItemKey("Send the coverage report"),
			occurrenceIndex: 0,
			organizationId: "org-1",
		};
		expect(
			whereMatches(guard, { ...address, assignedManually: false }),
		).toBe(true);
		expect(
			whereMatches(guard, { ...address, assignedManually: true }),
		).toBe(false);
	});

	it("survives losing the race without claiming the row", async () => {
		// `{ count: 0 }` is the race actually happening: the guard matched
		// nothing because the row stopped being unassigned. The run must finish
		// normally — the person's choice standing is the correct outcome, not an
		// error — and must not have touched their assignee.
		arrangeTranscript([item("Send the coverage report", "Anna Petrova")]);
		mockUpdateManyTodo.mockResolvedValue({ count: 0 });

		await expect(
			matchMeetingActionItemOwnersActivity(baseInput),
		).resolves.toMatchObject({ itemsConsidered: 1 });
	});

	it("does not report an assignment the guard refused", async () => {
		// The counter used to be taken from the verdict, which was the same
		// number as the write until the guard existed. Now the write can match
		// nothing, and a verdict-shaped counter would tell an operator the
		// matcher assigned an owner while a person's own choice stood instead.
		// `assigned` is the first number anyone checks when the page looks
		// wrong, so it has to count rows rather than intentions.
		arrangeTranscript([item("Send the coverage report", "Anna Petrova")]);
		mockUpdateManyTodo.mockResolvedValue({ count: 0 });

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.assigned).toBe(0);
	});

	it("reports an assignment the guard let through", async () => {
		// The other half of the pair: a counter that is always 0 would also
		// satisfy the test above.
		arrangeTranscript([item("Send the coverage report", "Anna Petrova")]);

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		expect(result.assigned).toBe(1);
	});

	it("logs a refusal so a matcher racing people is visible", async () => {
		arrangeTranscript([item("Send the coverage report", "Anna Petrova")]);
		mockUpdateManyTodo.mockResolvedValue({ count: 0 });

		await matchMeetingActionItemOwnersActivity(baseInput);

		const { logger } = await import("@repo/logs");
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("run complete"),
			expect.objectContaining({ assignmentsRefused: 1 }),
		);
	});

	it("writes no assignment at all onto a hand-assigned row", async () => {
		arrangeTranscript(
			[item("Send the coverage report", "Anna Petrova")],
			[
				todo("Send the coverage report", {
					assigneeUserId: "user-someone-else",
					assignedManually: true,
				}),
			],
		);

		await matchMeetingActionItemOwnersActivity(baseInput);

		// Not "writes the same values back": writing a snapshot back is how a
		// stale read turns itself into a fact.
		expect(assignmentCalls()).toHaveLength(0);
	});
});

describe("the stamp names the revision it read (#2340)", () => {
	it("does not report a transcript matched once its extraction moved", async () => {
		// The sequence this guards: this run reads extraction A; extraction B
		// commits new items and clears the stamp; B's matcher start is refused
		// because A is still RUNNING; A then stamps the transcript current
		// having never seen B's items. `todos.catchUp` selects on an unset or
		// superseded stamp, so it would never schedule B either — B's
		// commitments would stay missing until some later extraction ran.
		arrangeTranscript([item("Send the coverage report", null)]);
		mockUpdateManyTranscript.mockResolvedValue({ count: 0 });

		const result = await matchMeetingActionItemOwnersActivity(baseInput);

		// The run still succeeds: the to-dos it wrote are correct for the items
		// it saw. Only the claim "this transcript is matched" is withheld.
		expect(result.itemsConsidered).toBe(1);
		const { logger } = await import("@repo/logs");
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("stamp declined"),
			expect.objectContaining({ reason: "re-extracted-mid-run" }),
		);
	});

	it("does not call a vanished transcript re-extracted", async () => {
		// A zero count is every reason the WHERE failed collapsed into one
		// number. Resolving it is what keeps the log from asserting the wrong
		// one — the trap written up in
		// docs/solutions/architecture-patterns/a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md
		// (§3).
		arrangeTranscript([item("Send the coverage report", null)]);
		mockUpdateManyTranscript.mockResolvedValue({ count: 0 });
		mockFindUniqueTranscript.mockResolvedValue(null);

		await matchMeetingActionItemOwnersActivity(baseInput);

		const { logger } = await import("@repo/logs");
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("stamp declined"),
			expect.objectContaining({ reason: "transcript-gone" }),
		);
	});

	it("carries the revision into the WHERE so Postgres decides", async () => {
		arrangeTranscript([item("Send the coverage report", null)]);

		await matchMeetingActionItemOwnersActivity(baseInput);

		expect(mockUpdateManyTranscript.mock.calls[0][0].where).toEqual({
			id: "tr-1",
			insightsExtractedAt: EXTRACTED_AT,
		});
	});
});

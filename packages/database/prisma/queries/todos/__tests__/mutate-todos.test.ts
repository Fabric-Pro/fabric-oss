/**
 * The To Do list's writes (#2340).
 *
 * What this file proves, stated plainly. Prisma's model delegates are mocked,
 * so it pins WHICH ROW each write addresses and WITH WHAT SCOPE — which is
 * where every interesting bug in this module would live:
 *
 *  - A meeting-sourced completion goes to `ProjectMeetingActionItem`, never to
 *    the to-do. That is not a stylistic preference: `list-todos.ts` reads
 *    completion off the action item for those rows, and the meeting-digest
 *    surface reads the same column, so a write that landed on the to-do would
 *    tick a box that neither page ever looks at.
 *  - A manual completion goes to the to-do and touches no action item at all.
 *  - `lastKnownCompletedAt` is stamped in the SAME transaction as the
 *    completion it snapshots, because that snapshot is the only record that
 *    survives the rewording which will eventually orphan the binding.
 *  - The occurrence lookup indexes the partition the read's window function
 *    produces — same filters, same order — so position N here is position N
 *    there.
 *
 * It cannot prove what Postgres returns; that needs a database.
 *
 * Run with:
 *   pnpm --filter @repo/database test mutate-todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	todoItem: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(),
		create: vi.fn(),
	},
	actionItem: {
		findMany: vi.fn(),
		updateMany: vi.fn(),
	},
	member: { findFirst: vi.fn() },
	contact: { findFirst: vi.fn() },
	/** Records what the transaction callback did, in order. */
	tx: {
		todoItem: { updateMany: vi.fn() },
		projectMeetingActionItem: { updateMany: vi.fn() },
		/** The locking read. A tagged template: SQL parts, then the values. */
		$queryRaw: vi.fn(),
	},
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			todoItem: mocks.todoItem,
			projectMeetingActionItem: mocks.actionItem,
			member: mocks.member,
			nonMemberContact: mocks.contact,
			// Runs the callback against a tx whose delegates are separately
			// observable, so "inside the transaction" is an assertion this file
			// can actually make rather than a comment.
			$transaction: (
				fn: (tx: typeof mocks.tx) => Promise<unknown>,
			): Promise<unknown> => fn(mocks.tx),
		},
	};
});

const { Prisma } = await import("../../../client");
const {
	createManualTodo,
	isAssignableContact,
	isAssignableOrganizationMember,
	loadTodoForMutation,
	loadTodosForMutation,
	resolveBoundActionItem,
	setTodoAssignee,
	setTodoCompletion,
	setTodoSnooze,
} = await import("../mutate-todos");

const ORG = "org-acme";
const OTHER_ORG = "org-other";
const USER = "user-dana";
const NOW = new Date("2026-09-18T12:00:00.000Z");

function meetingTodo(overrides: Record<string, unknown> = {}) {
	return {
		id: "todo-meeting",
		source: "MEETING_DIGEST" as const,
		transcriptId: "transcript-1",
		itemKey: "key-1",
		occurrenceIndex: 0,
		itemTextSnapshot: "Send the revised scope",
		title: null,
		projectId: "project-1",
		userId: "user-transcript-owner",
		organizationId: ORG,
		assigneeUserId: null,
		assigneeContactId: null,
		assignedManually: false,
		snoozedUntil: null,
		completedAt: null,
		completedById: null,
		lastKnownCompletedAt: null,
		sourceDate: new Date("2026-09-10T09:00:00.000Z"),
		createdAt: new Date("2026-09-10T09:00:00.000Z"),
		updatedAt: new Date("2026-09-10T09:00:00.000Z"),
		...overrides,
	};
}

function manualTodo(overrides: Record<string, unknown> = {}) {
	return meetingTodo({
		id: "todo-manual",
		source: "MANUAL" as const,
		transcriptId: null,
		itemKey: null,
		occurrenceIndex: null,
		itemTextSnapshot: null,
		title: "Chase the signed SOW",
		projectId: null,
		userId: USER,
		...overrides,
	});
}

beforeEach(() => {
	for (const fn of [
		mocks.todoItem.findFirst,
		mocks.todoItem.findMany,
		mocks.todoItem.updateMany,
		mocks.todoItem.create,
		mocks.actionItem.findMany,
		mocks.actionItem.updateMany,
		mocks.member.findFirst,
		mocks.contact.findFirst,
		mocks.tx.todoItem.updateMany,
		mocks.tx.projectMeetingActionItem.updateMany,
		mocks.tx.$queryRaw,
	]) {
		fn.mockReset();
	}
	// A live contact, unless a case says otherwise.
	mocks.tx.$queryRaw.mockResolvedValue([{ id: "contact-1" }]);
	mocks.tx.projectMeetingActionItem.updateMany.mockResolvedValue({
		count: 1,
	});
	mocks.tx.todoItem.updateMany.mockResolvedValue({ count: 1 });
	mocks.todoItem.updateMany.mockResolvedValue({ count: 1 });
});

describe("loadTodoForMutation", () => {
	it("makes the organization part of the match, not a check after it", async () => {
		mocks.todoItem.findFirst.mockResolvedValue(null);

		await loadTodoForMutation({ todoId: "todo-1", organizationId: ORG });

		// `findUnique` on the id alone would reach another tenant's row and
		// leave the org as an afterthought.
		expect(mocks.todoItem.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "todo-1", organizationId: ORG },
			}),
		);
	});
});

describe("loadTodosForMutation", () => {
	it("costs nothing for an empty batch", async () => {
		await expect(
			loadTodosForMutation({ todoIds: [], organizationId: ORG }),
		).resolves.toEqual([]);
		expect(mocks.todoItem.findMany).not.toHaveBeenCalled();
	});

	it("scopes the whole batch to one organization", async () => {
		mocks.todoItem.findMany.mockResolvedValue([]);

		await loadTodosForMutation({
			todoIds: ["a", "b"],
			organizationId: ORG,
		});

		expect(mocks.todoItem.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["a", "b"] }, organizationId: ORG },
			}),
		);
	});
});

describe("resolveBoundActionItem", () => {
	it("indexes the partition the read's window function produces", async () => {
		// Three items normalizing to one key. Occurrence 1 is the SECOND in
		// ascending orderIndex — the identical rule `bindActionItemsToTodos`
		// applies and the read's ROW_NUMBER reproduces.
		mocks.actionItem.findMany.mockResolvedValue([
			{ id: "item-a", completedAt: null, text: "Send it" },
			{ id: "item-b", completedAt: null, text: "Send it" },
			{ id: "item-c", completedAt: null, text: "Send it" },
		]);

		const resolved = await resolveBoundActionItem({
			todo: meetingTodo({ occurrenceIndex: 1 }),
			organizationId: ORG,
		});

		expect(resolved?.id).toBe("item-b");
		expect(mocks.actionItem.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					transcriptId: "transcript-1",
					itemKey: "key-1",
					organizationId: ORG,
					// The scope guard, the way `applyActionItemCompletion` uses
					// it: these rows have no projectId column of their own.
					transcript: { projectId: "project-1" },
				},
				orderBy: [{ orderIndex: "asc" }],
			}),
		);
	});

	it("reports an orphan rather than falling back to a neighbour", async () => {
		// A run that emitted fewer same-key items than the last one. Rebinding
		// to the survivor would hand one commitment's state to a different one
		// that merely reads the same.
		mocks.actionItem.findMany.mockResolvedValue([
			{ id: "item-a", completedAt: null, text: "Send it" },
		]);

		await expect(
			resolveBoundActionItem({
				todo: meetingTodo({ occurrenceIndex: 1 }),
				organizationId: ORG,
			}),
		).resolves.toBeNull();
	});

	it("is null for a row with no binding at all", async () => {
		await expect(
			resolveBoundActionItem({
				todo: manualTodo(),
				organizationId: ORG,
			}),
		).resolves.toBeNull();
		expect(mocks.actionItem.findMany).not.toHaveBeenCalled();
	});
});

describe("setTodoCompletion — meeting-sourced", () => {
	beforeEach(() => {
		mocks.actionItem.findMany.mockResolvedValue([
			{ id: "item-a", completedAt: null, text: "Send it" },
		]);
	});

	it("writes completion to the ACTION ITEM, which is what both surfaces read", async () => {
		const result = await setTodoCompletion({
			todo: meetingTodo(),
			organizationId: ORG,
			completed: true,
			userId: USER,
			now: NOW,
		});

		expect(result).toMatchObject({
			target: "action_item",
			actionItemId: "item-a",
			completedAt: NOW,
		});
		expect(
			mocks.tx.projectMeetingActionItem.updateMany,
		).toHaveBeenCalledWith({
			where: {
				id: "item-a",
				organizationId: ORG,
				transcript: { projectId: "project-1" },
			},
			data: { completedAt: NOW, completedById: USER },
		});
	});

	it("stamps lastKnownCompletedAt in the same transaction", async () => {
		await setTodoCompletion({
			todo: meetingTodo(),
			organizationId: ORG,
			completed: true,
			userId: USER,
			now: NOW,
		});

		// The snapshot is the only record that survives a rewording: once the
		// item's text changes the binding orphans and the row that carried the
		// completion is gone. Split from the completion, a failure between the
		// two leaves an orphan that cannot say it was ever completed.
		expect(mocks.tx.todoItem.updateMany).toHaveBeenCalledWith({
			where: { id: "todo-meeting", organizationId: ORG },
			// The bound row's own completion columns are cleared in the same
			// write. For a bound row the completion lives on the action item, and
			// this is what makes that invariant hold by construction rather than
			// by convention — the orphan branch is what can break it.
			data: {
				lastKnownCompletedAt: NOW,
				completedAt: null,
				completedById: null,
			},
		});
		// And nothing was written outside the transaction.
		expect(mocks.todoItem.updateMany).not.toHaveBeenCalled();
	});

	it("clears the snapshot when the completion is taken back", async () => {
		// A stale snapshot would let an orphan claim a completion the person
		// had since undone.
		await setTodoCompletion({
			todo: meetingTodo({ lastKnownCompletedAt: NOW }),
			organizationId: ORG,
			completed: false,
			userId: USER,
			now: NOW,
		});

		expect(mocks.tx.todoItem.updateMany).toHaveBeenCalledWith({
			where: { id: "todo-meeting", organizationId: ORG },
			// `completedAt` is cleared with it. A row completed while orphaned
			// carries the completion in its OWN column, and the read's COALESCE
			// would fall through to that stale value once the binding re-resolved
			// — leaving a row that reports itself completed however often it is
			// reopened.
			data: {
				lastKnownCompletedAt: null,
				completedAt: null,
				completedById: null,
			},
		});
		expect(
			mocks.tx.projectMeetingActionItem.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { completedAt: null, completedById: null },
			}),
		);
	});

	it("lets an orphan carry its own completion", async () => {
		// Re-extraction reworded the item out from under this row, but the
		// commitment the person is tracking is still real. Refusing the write
		// would leave a to-do that can never be closed, which is worse than a
		// row holding its own completion — and with no live action item there
		// is no second place for it to disagree with.
		mocks.actionItem.findMany.mockResolvedValue([]);
		mocks.todoItem.updateMany.mockResolvedValue({ count: 1 });

		await expect(
			setTodoCompletion({
				todo: meetingTodo(),
				organizationId: ORG,
				completed: true,
				userId: USER,
				now: NOW,
			}),
		).resolves.toMatchObject({ target: "todo", actionItemId: null });

		expect(
			mocks.tx.projectMeetingActionItem.updateMany,
		).not.toHaveBeenCalled();
		expect(mocks.todoItem.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ completedAt: NOW }),
			}),
		);
	});

	it("writes no snapshot for an orphan", async () => {
		// `lastKnownCompletedAt` caches a BOUND row's completion so an orphan can
		// say it had been completed before its text changed. An orphan writing
		// it would be caching its own completion and then reading it back as
		// evidence of a previous one.
		mocks.actionItem.findMany.mockResolvedValue([]);
		mocks.todoItem.updateMany.mockResolvedValue({ count: 1 });

		await setTodoCompletion({
			todo: meetingTodo(),
			organizationId: ORG,
			completed: true,
			userId: USER,
			now: NOW,
		});

		const written = mocks.todoItem.updateMany.mock.calls.at(-1)?.[0];
		expect(written.data).not.toHaveProperty("lastKnownCompletedAt");
	});

	it("leaves no snapshot behind when the action-item write matches nothing", async () => {
		mocks.tx.projectMeetingActionItem.updateMany.mockResolvedValue({
			count: 0,
		});

		await expect(
			setTodoCompletion({
				todo: meetingTodo(),
				organizationId: ORG,
				completed: true,
				userId: USER,
				now: NOW,
			}),
		).resolves.toBeNull();

		expect(mocks.tx.todoItem.updateMany).not.toHaveBeenCalled();
	});
});

describe("setTodoCompletion — manual", () => {
	it("writes the row's own column and touches no action item", async () => {
		const result = await setTodoCompletion({
			todo: manualTodo(),
			organizationId: ORG,
			completed: true,
			userId: USER,
			now: NOW,
		});

		expect(result).toMatchObject({
			target: "todo",
			actionItemId: null,
			completedAt: NOW,
		});
		expect(mocks.todoItem.updateMany).toHaveBeenCalledWith({
			where: {
				id: "todo-manual",
				organizationId: ORG,
				// Re-asserted, so a concurrent write cannot turn a manual
				// completion into one silently landing on a bound row.
				transcriptId: null,
			},
			data: { completedAt: NOW, completedById: USER },
		});
		expect(mocks.actionItem.findMany).not.toHaveBeenCalled();
		expect(mocks.actionItem.updateMany).not.toHaveBeenCalled();
		expect(
			mocks.tx.projectMeetingActionItem.updateMany,
		).not.toHaveBeenCalled();
	});

	it("never writes lastKnownCompletedAt — that cache belongs to bound rows", async () => {
		await setTodoCompletion({
			todo: manualTodo(),
			organizationId: ORG,
			completed: true,
			userId: USER,
			now: NOW,
		});

		const data = mocks.todoItem.updateMany.mock.calls[0]?.[0]?.data ?? {};
		expect(data).not.toHaveProperty("lastKnownCompletedAt");
	});

	it("is null when the row vanished between load and write", async () => {
		mocks.todoItem.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			setTodoCompletion({
				todo: manualTodo(),
				organizationId: ORG,
				completed: true,
				userId: USER,
				now: NOW,
			}),
		).resolves.toBeNull();
	});
});

describe("setTodoSnooze", () => {
	it("scopes the write by organization", async () => {
		const until = new Date("2026-09-25T09:00:00.000Z");

		await expect(
			setTodoSnooze({
				todoId: "todo-1",
				organizationId: ORG,
				snoozedUntil: until,
			}),
		).resolves.toBe(true);

		expect(mocks.todoItem.updateMany).toHaveBeenCalledWith({
			where: { id: "todo-1", organizationId: ORG },
			data: { snoozedUntil: until },
		});
	});

	it("ends a snooze by clearing the column, not by backdating it", async () => {
		// The read's boundary is `snoozedUntil <= now`, so absent and elapsed
		// are one state. Writing "now" would also drag the age clock —
		// GREATEST(sourceDate, snoozedUntil) — to today for an old item.
		await setTodoSnooze({
			todoId: "todo-1",
			organizationId: ORG,
			snoozedUntil: null,
		});

		expect(mocks.todoItem.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { snoozedUntil: null } }),
		);
	});

	it("reports false when nothing matched", async () => {
		mocks.todoItem.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			setTodoSnooze({
				todoId: "todo-1",
				organizationId: OTHER_ORG,
				snoozedUntil: null,
			}),
		).resolves.toBe(false);
	});
});

describe("setTodoAssignee", () => {
	it("sets assignedManually and clears the suggestion in one write", async () => {
		await setTodoAssignee({
			todoId: "todo-1",
			organizationId: ORG,
			assigneeUserId: "user-pat",
			assigneeContactId: null,
		});

		expect(mocks.todoItem.updateMany).toHaveBeenCalledWith({
			where: { id: "todo-1", organizationId: ORG },
			data: {
				assigneeUserId: "user-pat",
				// Written as a PAIR: the model stores one or the other, and a
				// write that left the old column alone would name two people.
				assigneeContactId: null,
				// The flag the re-extraction matcher checks before touching an
				// assignee — without it the next run replaces a person's choice
				// with the machine's guess.
				assignedManually: true,
				suggestedUserId: null,
				suggestedContactId: null,
				suggestionCandidates: Prisma.DbNull,
			},
		});
	});

	it("unassigns by writing both columns null, still manually", async () => {
		await setTodoAssignee({
			todoId: "todo-1",
			organizationId: ORG,
			assigneeUserId: null,
			assigneeContactId: null,
		});

		expect(mocks.todoItem.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					assigneeUserId: null,
					assigneeContactId: null,
					assignedManually: true,
				}),
			}),
		);
	});

	it("says which of the two nothings happened", async () => {
		mocks.todoItem.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			setTodoAssignee({
				todoId: "todo-gone",
				organizationId: ORG,
				assigneeUserId: "user-pat",
				assigneeContactId: null,
			}),
		).resolves.toEqual({ assigned: false, reason: "todo_not_found" });
	});

	it("locks the contact row and writes in the SAME transaction", async () => {
		const result = await setTodoAssignee({
			todoId: "todo-1",
			organizationId: ORG,
			assigneeUserId: null,
			assigneeContactId: "contact-1",
		});

		expect(result).toEqual({ assigned: true });

		// A plain read followed by a write is the bug this replaces: the
		// erasure in `redactNonMemberContact` is a transaction that can commit
		// between the two, and the write would then re-attach a person that
		// erasure had just detached — with `assignedManually` set, so nothing
		// later clears it.
		const [parts, ...values] = mocks.tx.$queryRaw.mock.calls[0] as [
			string[],
			...unknown[],
		];
		const sql = parts.join("?");
		expect(sql).toContain('FROM "non_member_contact"');
		expect(sql).toContain('"redactedAt" IS NULL');
		// A shared lock, not an exclusive one: this transaction does not modify
		// the contact, and two assignments to the same contact have no reason
		// to queue. It still conflicts with the redaction's `FOR UPDATE`.
		expect(sql).toContain("FOR SHARE");
		expect(values).toEqual(["contact-1", ORG]);

		// The write is the transaction's, not the bare client's — outside it
		// the lock would be released before the row was touched.
		expect(mocks.tx.todoItem.updateMany).toHaveBeenCalledWith({
			where: { id: "todo-1", organizationId: ORG },
			data: expect.objectContaining({
				assigneeContactId: "contact-1",
				assigneeUserId: null,
				assignedManually: true,
			}),
		});
		expect(mocks.todoItem.updateMany).not.toHaveBeenCalled();
	});

	it("writes nothing when the locked contact is gone or redacted", async () => {
		// What the locking read returns after it has waited out a concurrent
		// redaction: Postgres re-checks `redactedAt IS NULL` against the
		// updated row, and the row drops out of the result.
		mocks.tx.$queryRaw.mockResolvedValue([]);

		await expect(
			setTodoAssignee({
				todoId: "todo-1",
				organizationId: ORG,
				assigneeUserId: null,
				assigneeContactId: "contact-1",
			}),
		).resolves.toEqual({
			assigned: false,
			reason: "contact_not_assignable",
		});

		expect(mocks.tx.todoItem.updateMany).not.toHaveBeenCalled();
		expect(mocks.todoItem.updateMany).not.toHaveBeenCalled();
	});
});

describe("assignability checks", () => {
	it("asks for membership of THIS organization", async () => {
		mocks.member.findFirst.mockResolvedValue(null);

		await expect(
			isAssignableOrganizationMember({
				organizationId: ORG,
				userId: "user-outsider",
			}),
		).resolves.toBe(false);

		expect(mocks.member.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: ORG, userId: "user-outsider" },
			}),
		);
	});

	it("refuses a redacted contact as well as a foreign one", async () => {
		mocks.contact.findFirst.mockResolvedValue(null);

		await expect(
			isAssignableContact({
				organizationId: ORG,
				contactId: "contact-1",
			}),
		).resolves.toBe(false);

		// `redactedAt: null` is load-bearing: assigning work to a tombstone
		// walks an erased person back into the obligations that
		// `redactNonMemberContact` detached them from.
		expect(mocks.contact.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "contact-1",
					organizationId: ORG,
					redactedAt: null,
				},
			}),
		);
	});
});

describe("createManualTodo", () => {
	it("leaves every meeting column null and dates the row now", async () => {
		mocks.todoItem.create.mockResolvedValue(manualTodo());

		await createManualTodo({
			organizationId: ORG,
			userId: USER,
			title: "Chase the signed SOW",
			now: NOW,
		});

		const data = mocks.todoItem.create.mock.calls[0]?.[0]?.data;
		expect(data).toEqual({
			source: "MANUAL",
			title: "Chase the signed SOW",
			projectId: null,
			// Both the age cutoff and the recency ordering key off this one
			// field; without it a manual row sorts as though it were ancient.
			sourceDate: NOW,
			createdById: USER,
			// What the read's MANUAL-owner arm matches, and the column
			// `user_owned` RLS keys on — so the author keeps their own row
			// readable and writable however it is later assigned.
			userId: USER,
			organizationId: ORG,
		});
		// A stray transcriptId would send the read looking for completion on an
		// action item this row has no binding to.
		expect(data).not.toHaveProperty("transcriptId");
		expect(data).not.toHaveProperty("itemKey");
		expect(data).not.toHaveProperty("assignedManually");
	});

	it("keeps a project when one is given", async () => {
		mocks.todoItem.create.mockResolvedValue(
			manualTodo({ projectId: "project-1" }),
		);

		await createManualTodo({
			organizationId: ORG,
			userId: USER,
			title: "Chase the signed SOW",
			projectId: "project-1",
			now: NOW,
		});

		expect(mocks.todoItem.create.mock.calls[0]?.[0]?.data).toMatchObject({
			projectId: "project-1",
		});
	});
});

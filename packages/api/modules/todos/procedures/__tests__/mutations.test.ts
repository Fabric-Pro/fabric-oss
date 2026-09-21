/**
 * The To Do list's write procedures (#2340): `complete`, `snooze`, `unsnooze`,
 * `assign`, `create` and `bulkResolve`.
 *
 * Two seams, the split this repository uses for procedures (see
 * `../list.test.ts` and `modules/function-tags/procedures/__tests__/project.test.ts`):
 *
 *  1. **Schema level.** `.input()` is a no-op in the stubbed procedure chain
 *     below, so each input schema is parsed directly. The assignee XOR, the
 *     non-blank title and the batch bounds live there.
 *  2. **Handler level.** `@repo/database` is mocked, so what is asserted is
 *     which row each handler LOADS, whether it decides to write, what it asks
 *     the query layer for, and what it puts in the ledger. Where the write
 *     actually lands — the action item for a meeting-sourced row, the to-do's
 *     own column for a manual one, and `lastKnownCompletedAt` beside the first —
 *     is pinned in
 *     `packages/database/prisma/queries/todos/__tests__/mutate-todos.test.ts`.
 *
 * WHAT THE AUTHORIZATION TESTS HERE ARE FOR. The permission GATE cannot run,
 * because `.use()` is a no-op in the stub; what this file pins about it is the
 * DECLARATION — `TODO_UPDATE` (or `TODO_CREATE`) with
 * `requireOrganization: true` — for the same reason the read pins its own.
 * Everything else in this file is the SECOND half of the rule, which is not the
 * middleware's job and is where the real risk sits: these mutations are keyed by
 * to-do id, and organization membership answers nothing about one row.
 *
 * THE SECOND HALF IS THE READ'S OWN PREDICATE (`isTodoVisibleTo`), which is why
 * the cases below are row SHAPES rather than one refusal repeated. The rule
 * used to be "the caller owns the row OR can reach its project", and since
 * every project of an organization is reachable by every member of it, a to-do
 * assigned to a colleague was absent from the caller's list and still
 * completable, snoozable and reassignable by id. Only the project-less shape
 * was ever refused, so only the project-less shape was ever tested. Each arm
 * now has a case, and so does the row that matches none.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	loadTodoForMutation: vi.fn(),
	loadTodosForMutation: vi.fn(),
	setTodoCompletion: vi.fn(),
	setTodoSnooze: vi.fn(),
	setTodoAssignee: vi.fn(),
	createManualTodo: vi.fn(),
	isAssignableOrganizationMember: vi.fn(),
	isAssignableContact: vi.fn(),
	dbMock: {
		project: { findFirst: vi.fn(), findMany: vi.fn() },
		// `resolveTodoVisibility` reads the confirmed function tags; the write
		// rule is the read's, so the write path asks for them too.
		projectUserFunctionTag: { findMany: vi.fn() },
	},
	recordAuditFromRequest: vi.fn(),
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
	declared: {} as Record<
		string,
		{ permission: string; options?: { requireOrganization?: boolean } }[]
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: mocks.dbMock,
		isFeatureEnabled: mocks.isFeatureEnabled,
		loadTodoForMutation: mocks.loadTodoForMutation,
		loadTodosForMutation: mocks.loadTodosForMutation,
		setTodoCompletion: mocks.setTodoCompletion,
		setTodoSnooze: mocks.setTodoSnooze,
		setTodoAssignee: mocks.setTodoAssignee,
		createManualTodo: mocks.createManualTodo,
		isAssignableOrganizationMember: mocks.isAssignableOrganizationMember,
		isAssignableContact: mocks.isAssignableContact,
	};
});

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mocks.recordAuditFromRequest(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	let pendingKey = "";
	const chainable: any = {
		use: (declaration: {
			permission: string;
			options?: { requireOrganization?: boolean };
		}) => {
			mocks.declared[pendingKey] ??= [];
			mocks.declared[pendingKey].push(declaration);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured[pendingKey] = fn as any;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		// Mirrors the real resolver: an explicit string wins, an explicit null
		// means "no organization" and deliberately does NOT fall back to the
		// session, and `undefined` falls back.
		resolveOrganizationId: vi.fn(
			(
				organizationId: string | null | undefined,
				session?: { activeOrganizationId?: string | null },
			) => {
				if (organizationId) {
					return organizationId;
				}
				if (organizationId === null) {
					return undefined;
				}
				return session?.activeOrganizationId ?? undefined;
			},
		),
		requireInputOrgPermission: vi.fn(
			(
				permission: string,
				options?: { requireOrganization?: boolean },
			) => ({ permission, options }),
		),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

const procedures = await import("../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as { __setPendingHandlerKey: (key: string) => void }
).__setPendingHandlerKey;

// Imported AFTER each slot is set: the stubbed chain files the handler under
// whichever slot is pending, so a static import would file it under no name.
setSlot("complete");
const { completeTodoInputSchema } = await import("../complete");
setSlot("snooze");
const { snoozeTodoInputSchema } = await import("../snooze");
setSlot("unsnooze");
const { unsnoozeTodoInputSchema } = await import("../unsnooze");
setSlot("assign");
const { assignTodoInputSchema } = await import("../assign");
setSlot("create");
const { createTodoInputSchema } = await import("../create");
setSlot("bulkResolve");
const { bulkResolveTodosInputSchema } = await import("../bulk-resolve");

// ---------------------------------------------------------------------------
// Schema level — the real guard behind `.input(...)`
// ---------------------------------------------------------------------------

describe("input schemas", () => {
	it("completion needs a to-do and a direction", () => {
		expect(
			completeTodoInputSchema.safeParse({ todoId: "t1" }).success,
		).toBe(false);
		expect(
			completeTodoInputSchema.safeParse({ todoId: "", completed: true })
				.success,
		).toBe(false);
		expect(
			completeTodoInputSchema.safeParse({
				todoId: "t1",
				completed: false,
			}).success,
		).toBe(true);
	});

	it("a snooze coerces the client's ISO string to a date", () => {
		const parsed = snoozeTodoInputSchema.parse({
			todoId: "t1",
			snoozedUntil: "2026-09-25T09:00:00.000Z",
		});
		expect(parsed.snoozedUntil).toBeInstanceOf(Date);
		expect(parsed.snoozedUntil.toISOString()).toBe(
			"2026-09-25T09:00:00.000Z",
		);
	});

	it("a snooze does NOT decide in the schema whether the date is in the past", () => {
		// The schema would have to sample its own clock to judge that, and two
		// clocks in one request is how an instant gets refused and applied in
		// the same breath. The handler decides, against the one `now` it uses
		// for the membership-expiry check as well.
		expect(
			snoozeTodoInputSchema.safeParse({
				todoId: "t1",
				snoozedUntil: "1999-01-01T00:00:00.000Z",
			}).success,
		).toBe(true);
	});

	it("unsnooze needs nothing but the to-do", () => {
		expect(
			unsnoozeTodoInputSchema.safeParse({ todoId: "t1" }).success,
		).toBe(true);
	});

	it("assign refuses a member and a contact at once", () => {
		// A to-do carries one or the other. Silently preferring one would
		// assign the item to somebody the caller did not choose.
		expect(
			assignTodoInputSchema.safeParse({
				todoId: "t1",
				assigneeUserId: "u1",
				assigneeContactId: "c1",
			}).success,
		).toBe(false);
	});

	it("assign accepts either alone, and neither", () => {
		for (const input of [
			{ todoId: "t1", assigneeUserId: "u1" },
			{ todoId: "t1", assigneeContactId: "c1" },
			{ todoId: "t1" },
			{ todoId: "t1", assigneeUserId: null, assigneeContactId: null },
		]) {
			expect(assignTodoInputSchema.safeParse(input).success).toBe(true);
		}
	});

	it("create trims the title and refuses a blank one", () => {
		expect(createTodoInputSchema.safeParse({ title: "   " }).success).toBe(
			false,
		);
		expect(
			createTodoInputSchema.parse({ title: "  Chase it  " }).title,
		).toBe("Chase it");
	});

	it("create leaves the project optional", () => {
		const parsed = createTodoInputSchema.parse({ title: "Chase it" });
		expect(parsed.projectId).toBeUndefined();
	});

	it("bulk resolve is bounded at both ends", () => {
		expect(
			bulkResolveTodosInputSchema.safeParse({ todoIds: [] }).success,
		).toBe(false);
		expect(
			bulkResolveTodosInputSchema.safeParse({
				todoIds: Array.from({ length: 101 }, (_, i) => `t${i}`),
			}).success,
		).toBe(false);
		expect(
			bulkResolveTodosInputSchema.safeParse({
				todoIds: Array.from({ length: 100 }, (_, i) => `t${i}`),
			}).success,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Handler level
// ---------------------------------------------------------------------------

const VIEWER = "user-viewer";
const OTHER_MEMBER = "user-other";
const SESSION_ORG = "org-session";
const ORG = "org-named-in-input";
const PROJECT = "project-1";

/** A person whose name and email must never reach the ledger. */
const CONTACT = {
	id: "contact-1",
	name: "Robin Vasquez",
	email: "robin@example.com",
};

const baseCtx = {
	user: { id: VIEWER, email: "dana@example.com", name: "Dana" },
	session: {
		id: "sess-1",
		activeOrganizationId: SESSION_ORG,
		impersonatedBy: null,
	},
	headers: new Headers(),
};

function meetingTodo(overrides: Record<string, unknown> = {}) {
	return {
		id: "todo-meeting",
		source: "MEETING_DIGEST",
		transcriptId: "transcript-1",
		itemKey: "key-1",
		occurrenceIndex: 0,
		itemTextSnapshot: "Send the revised scope",
		title: null,
		projectId: PROJECT,
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

/**
 * Another member's manual to-do: no project for any project-shaped check to ask
 * about, written by them and ASSIGNED to them.
 *
 * The assignment is not decoration. An unassigned to-do with no project is an
 * organization-level commitment that the read shows to every member through its
 * Unassigned arm — so it is writable by them too, and a fixture without an
 * assignee would be testing the opposite of what these cases claim. What makes
 * this row theirs is that it is spoken for.
 */
function foreignProjectlessManualTodo(overrides: Record<string, unknown> = {}) {
	return meetingTodo({
		id: "todo-private",
		source: "MANUAL",
		transcriptId: null,
		itemKey: null,
		occurrenceIndex: null,
		itemTextSnapshot: null,
		title: "Book the flights",
		projectId: null,
		userId: OTHER_MEMBER,
		assigneeUserId: OTHER_MEMBER,
		...overrides,
	});
}

function auditCalls() {
	return mocks.recordAuditFromRequest.mock.calls.map(
		(call: any[]) => call[1],
	);
}

beforeEach(() => {
	for (const fn of [
		mocks.isFeatureEnabled,
		mocks.loadTodoForMutation,
		mocks.loadTodosForMutation,
		mocks.setTodoCompletion,
		mocks.setTodoSnooze,
		mocks.setTodoAssignee,
		mocks.createManualTodo,
		mocks.isAssignableOrganizationMember,
		mocks.isAssignableContact,
		mocks.dbMock.project.findFirst,
		mocks.dbMock.project.findMany,
		mocks.dbMock.projectUserFunctionTag.findMany,
		mocks.recordAuditFromRequest,
	]) {
		fn.mockReset();
	}

	mocks.isFeatureEnabled.mockResolvedValue(true);
	// `todos.create` verifies a NAMED project with the read's predicate; the
	// tests that care flip it.
	mocks.dbMock.project.findFirst.mockResolvedValue({ id: PROJECT });
	// The caller's visibility scope, resolved once per request by every write
	// path. The shape is `resolveTodoVisibility`'s select, not a bare id list.
	mocks.dbMock.project.findMany.mockResolvedValue([
		{ id: PROJECT, userId: "user-creator", members: [] },
	]);
	// No confirmed function tags unless a case grants them: an unconfirmed row
	// is a guess and grants nothing.
	mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([]);
	mocks.setTodoCompletion.mockResolvedValue({
		todoId: "todo-meeting",
		target: "action_item",
		completedAt: new Date("2026-09-18T12:00:00.000Z"),
		actionItemId: "item-a",
	});
	mocks.setTodoSnooze.mockResolvedValue(true);
	mocks.setTodoAssignee.mockResolvedValue({ assigned: true });
	mocks.isAssignableOrganizationMember.mockResolvedValue(true);
	mocks.isAssignableContact.mockResolvedValue(true);
});

describe("the gates they declare", () => {
	it("asks for TODO_UPDATE against the organization named in the input", () => {
		for (const key of [
			"complete",
			"snooze",
			"unsnooze",
			"assign",
			"bulkResolve",
		]) {
			expect(mocks.declared[key]).toEqual([
				{
					permission: "TODO_UPDATE",
					// Not decoration: without it, `organizationId: null`
					// resolves to nothing and the role check never runs.
					options: { requireOrganization: true },
				},
			]);
		}
	});

	it("asks for TODO_CREATE on the one procedure that creates", () => {
		expect(mocks.declared.create).toEqual([
			{
				permission: "TODO_CREATE",
				options: { requireOrganization: true },
			},
		]);
	});
});

describe("todos.complete", () => {
	it("refuses a request that names no organization at all", async () => {
		const error = await mocks.captured
			.complete({
				context: baseCtx,
				input: {
					organizationId: null,
					todoId: "todo-meeting",
					completed: true,
				},
			})
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
		expect(mocks.loadTodoForMutation).not.toHaveBeenCalled();
	});

	it("is absent rather than inert while the rollout gate is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			mocks.captured.complete({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					completed: true,
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
	});

	it("writes a meeting-sourced completion where the meeting digest reads it", async () => {
		// This surface and the meeting-digest surface show the SAME column:
		// `ProjectMeetingActionItem.completedAt`. What is asserted here is that
		// the handler routes the write through `setTodoCompletion` and reports
		// the action item it landed on; that the write then goes to the action
		// item, scoped through the transcript relation exactly as
		// `projects.setActionItemCompleted` scopes its own, is pinned in
		// `queries/todos/__tests__/mutate-todos.test.ts`.
		mocks.loadTodoForMutation.mockResolvedValue(meetingTodo());

		const result = await mocks.captured.complete({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-meeting",
				completed: true,
			},
		});

		expect(mocks.loadTodoForMutation).toHaveBeenCalledWith({
			todoId: "todo-meeting",
			// Read against the organization NAMED IN THE INPUT, not the
			// session's — a member of one tenant must not borrow their own role
			// to act on another's.
			organizationId: ORG,
		});
		expect(mocks.setTodoCompletion).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				completed: true,
				userId: VIEWER,
			}),
		);
		expect(result).toMatchObject({
			completionTarget: "action_item",
			actionItemId: "item-a",
			completed: true,
		});
	});

	it("refuses a row in a project the caller cannot reach", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(meetingTodo());
		// The read's own scope contains no such project for this viewer, so
		// the gate every arm sits inside refuses before any arm is asked.
		mocks.dbMock.project.findMany.mockResolvedValue([]);

		await expect(
			mocks.captured.complete({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					completed: true,
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("asks the READ's project predicate, org-pinned and soft-delete aware", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(meetingTodo());

		await mocks.captured.complete({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-meeting",
				completed: true,
			},
		});

		const where = mocks.dbMock.project.findMany.mock.calls[0]?.[0]?.where;
		expect(where).toMatchObject({
			organizationId: ORG,
			// A soft delete fires no cascade, so without this a deleted
			// project's to-dos stay writable after they leave every list.
			deletedAt: null,
		});
		// And it is the caller's whole scope, asked once — not a lookup of the
		// one project this row happens to name.
		expect(where.id).toBeUndefined();
	});

	it("will not let a member complete another member's project-less manual to-do", async () => {
		// The row this whole module is arranged around. There is no project, so
		// no project-shaped check can answer for it, and organization
		// membership has already been proven by the gate. It is spoken for by
		// somebody else, and the caller matches no arm of the read: the row was
		// never on their page.
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo(),
		);

		await expect(
			mocks.captured.complete({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-private",
					completed: true,
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
		// And no per-row project lookup was issued. That lookup was the shape
		// of the old bug twice over: it returned nothing for a row with no
		// project, and it returned SOMETHING for every project of the
		// organization, which is every project a member can reach.
		expect(mocks.dbMock.project.findFirst).not.toHaveBeenCalled();
	});

	it("lets the owner complete their own project-less manual to-do", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo({ userId: VIEWER }),
		);
		mocks.setTodoCompletion.mockResolvedValue({
			todoId: "todo-private",
			target: "todo",
			completedAt: new Date("2026-09-18T12:00:00.000Z"),
			actionItemId: null,
		});

		const result = await mocks.captured.complete({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-private",
				completed: true,
			},
		});

		expect(result).toMatchObject({
			completionTarget: "todo",
			actionItemId: null,
		});
	});

	it("completes an orphaned to-do rather than refusing it", async () => {
		// A row whose wording changed under it still represents a real
		// commitment. Refusing would leave it impossible to close; with no live
		// action item there is no second place for the completion to disagree
		// with, so it lands on the row itself.
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ id: "todo-orphaned" }),
		);
		mocks.setTodoCompletion.mockResolvedValue({
			todoId: "todo-orphaned",
			target: "todo",
			completedAt: new Date("2026-09-18T12:00:00.000Z"),
			actionItemId: null,
		});

		const result = await mocks.captured.complete({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-orphaned",
				completed: true,
			},
		});

		expect(result).toMatchObject({
			completionTarget: "todo",
			actionItemId: null,
		});
	});

	it("reports a to-do of another organization as simply absent", async () => {
		// The load is org-scoped, so a foreign row never comes back. Saying
		// FORBIDDEN instead would confirm the id exists somewhere.
		mocks.loadTodoForMutation.mockResolvedValue(null);

		await expect(
			mocks.captured.complete({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-elsewhere",
					completed: true,
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

/**
 * The write rule IS the read rule, shape by shape.
 *
 * Exercised through `todos.complete` because the rule is shared by every write
 * — `complete`, `snooze`, `unsnooze`, `assign` and `bulkResolve` all call the
 * same `requireTodoMutationAccess` — so one procedure proves the predicate and
 * the others are left to prove their own behaviour. The batch path gets its own
 * case at the end, since it evaluates the predicate itself.
 */
describe("a write may only touch a row the read would have shown", () => {
	/** Confirmed function tags; unconfirmed ones never reach the scope. */
	function confirm(tags: Array<{ userId: string; tags: string[] }>) {
		mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue(
			tags.map((tag) => ({ projectId: PROJECT, ...tag })),
		);
	}

	function complete(todoId: string) {
		return mocks.captured.complete({
			context: baseCtx,
			input: { organizationId: ORG, todoId, completed: true },
		});
	}

	it("refuses a to-do on a shared project that is assigned to another member", async () => {
		// THE VULNERABILITY, in one row. Every project of an organization is
		// reachable by every member of it, so the old "owner or project reach"
		// rule said yes; the read shows this row to its assignee and to nobody
		// else, so the caller could not see the item they were completing —
		// and assigning it to themselves would have made it readable.
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ assigneeUserId: OTHER_MEMBER }),
		);

		await expect(complete("todo-meeting")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("allows that same row for the project's Product Owner when the assignee is its stakeholder", async () => {
		// Arm 4, and the reason the refusal above is not simply "never touch
		// someone else's row": a confirmed Product Owner sees and therefore
		// works the commitments of the stakeholders OF THAT PROJECT.
		confirm([
			{ userId: VIEWER, tags: ["PRODUCT_OWNER"] },
			{ userId: OTHER_MEMBER, tags: ["STAKEHOLDER"] },
		]);
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ assigneeUserId: OTHER_MEMBER }),
		);

		await expect(complete("todo-meeting")).resolves.toMatchObject({
			completed: true,
		});
	});

	it("allows a contact-assigned row on a project the caller is Product Owner of", async () => {
		// Arm 3. A contact has no account to act for themselves, so their
		// obligations are worked by whoever owns the project.
		confirm([{ userId: VIEWER, tags: ["PRODUCT_OWNER"] }]);
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ assigneeContactId: CONTACT.id }),
		);

		await expect(complete("todo-meeting")).resolves.toMatchObject({
			completed: true,
		});
	});

	it("allows an unassigned row on a project the caller can reach", async () => {
		// Arm 2. The Unassigned bucket is a triage surface; a page that listed
		// rows nobody present could tick would be a page of dead controls.
		mocks.loadTodoForMutation.mockResolvedValue(meetingTodo());

		await expect(complete("todo-meeting")).resolves.toMatchObject({
			completed: true,
		});
	});

	it("keeps a MANUAL to-do with its author after they hand it to someone else", async () => {
		// Arm 5, and the reason narrowing the write to the read needed the read
		// to grow an arm: the assignee arm alone would have taken a person's
		// own to-do away from them the moment they delegated it, leaving nobody
		// able to correct it but the assignee.
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo({
				id: "todo-mine",
				userId: VIEWER,
				assigneeUserId: OTHER_MEMBER,
			}),
		);
		mocks.setTodoCompletion.mockResolvedValue({
			todoId: "todo-mine",
			target: "todo",
			completedAt: new Date("2026-09-18T12:00:00.000Z"),
			actionItemId: null,
		});

		await expect(complete("todo-mine")).resolves.toMatchObject({
			completionTarget: "todo",
		});
	});

	it("does not extend that arm to a meeting the caller merely hosted", async () => {
		// `TodoItem.userId` on a meeting-sourced row is copied from
		// `transcript.userId` — whose MEETING it was, not who owes the work.
		// An owner arm that ignored `source` would hand every host their whole
		// meeting's action items regardless of assignment, which is a widening
		// nobody asked for and which no test would have caught.
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ userId: VIEWER, assigneeUserId: OTHER_MEMBER }),
		);

		await expect(complete("todo-meeting")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
	});

	it("refuses another member's project-less to-do even while nobody is assigned", async () => {
		// The Unassigned bucket belongs to a PROJECT. A row with no project is
		// always MANUAL and belongs to the person who wrote it, so "nobody has
		// picked it up yet" is not an invitation for the rest of the
		// organization to complete it, snooze it or hand it to someone. Were it
		// otherwise, every member's private list would be writable by every
		// other member for as long as its rows stayed unassigned — which is
		// most of their life.
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo({ assigneeUserId: null }),
		);

		await expect(complete("todo-private")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
	});

	it("applies the same rule inside a batch, which cannot pool rights across ids", async () => {
		const assignedElsewhere = meetingTodo({
			id: "todo-theirs",
			assigneeUserId: OTHER_MEMBER,
		});
		const unassigned = meetingTodo({ id: "todo-open" });
		mocks.loadTodosForMutation.mockResolvedValue([
			assignedElsewhere,
			unassigned,
		]);
		mocks.setTodoCompletion.mockImplementation(async ({ todo }: any) => ({
			todoId: todo.id,
			target: "action_item",
			completedAt: new Date(),
			actionItemId: "item-a",
		}));

		const result = await mocks.captured.bulkResolve({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoIds: ["todo-theirs", "todo-open"],
			},
		});

		expect(result.results).toEqual([
			{ todoId: "todo-theirs", outcome: "forbidden" },
			{ todoId: "todo-open", outcome: "completed" },
		]);
		// One scope for the batch, no per-row lookup — the property the batch
		// path exists to keep.
		expect(mocks.dbMock.project.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.dbMock.project.findFirst).not.toHaveBeenCalled();
	});
});

describe("todos.snooze", () => {
	beforeEach(() => {
		mocks.loadTodoForMutation.mockResolvedValue(meetingTodo());
	});

	it("refuses a date in the past and writes nothing", async () => {
		await expect(
			mocks.captured.snooze({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					snoozedUntil: new Date("1999-01-01T00:00:00.000Z"),
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Accepting one would report success and change nothing: the read's
		// boundary treats an elapsed snooze as no snooze.
		expect(mocks.setTodoSnooze).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a deadline that has exactly arrived", async () => {
		// The read's boundary is `snoozedUntil <= now`, so this one would be
		// ignored by the very next query.
		await expect(
			mocks.captured.snooze({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					snoozedUntil: new Date(),
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("writes a future date and records it", async () => {
		const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

		const result = await mocks.captured.snooze({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-meeting",
				snoozedUntil: until,
			},
		});

		expect(mocks.setTodoSnooze).toHaveBeenCalledWith({
			todoId: "todo-meeting",
			organizationId: ORG,
			snoozedUntil: until,
		});
		expect(result.snoozedUntil).toBe(until.toISOString());
		expect(auditCalls()[0]).toMatchObject({
			action: "org.todo.snoozed",
			organizationId: ORG,
			resource: { type: "todo_item", id: "todo-meeting" },
		});
	});

	it("will not let a member snooze another member's project-less manual to-do", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo(),
		);

		await expect(
			mocks.captured.snooze({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-private",
					snoozedUntil: new Date(Date.now() + 86_400_000),
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.setTodoSnooze).not.toHaveBeenCalled();
	});
});

describe("todos.unsnooze", () => {
	it("returns the row to the open view by clearing the column", async () => {
		const snoozedUntil = new Date("2026-10-01T09:00:00.000Z");
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ snoozedUntil }),
		);

		const result = await mocks.captured.unsnooze({
			context: baseCtx,
			input: { organizationId: ORG, todoId: "todo-meeting" },
		});

		expect(mocks.setTodoSnooze).toHaveBeenCalledWith({
			todoId: "todo-meeting",
			organizationId: ORG,
			// Cleared, not backdated: writing "now" would drag the age clock —
			// GREATEST(sourceDate, snoozedUntil) — to today for an old item.
			snoozedUntil: null,
		});
		expect(result).toMatchObject({ snoozedUntil: null, wasSnoozed: true });
		expect(auditCalls()[0]).toMatchObject({
			// Its own key, not a `snoozed` row with a null date: a filter for
			// "who hid this" must not also match whoever brought it back.
			action: "org.todo.unsnoozed",
			organizationId: ORG,
			metadata: { previousSnoozedUntil: snoozedUntil.toISOString() },
		});
	});

	it("succeeds on a row that was not snoozed, and says so", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(meetingTodo());

		const result = await mocks.captured.unsnooze({
			context: baseCtx,
			input: { organizationId: ORG, todoId: "todo-meeting" },
		});

		expect(result.wasSnoozed).toBe(false);
	});

	it("will not let a member unsnooze another member's project-less manual to-do", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo({ snoozedUntil: new Date() }),
		);

		await expect(
			mocks.captured.unsnooze({
				context: baseCtx,
				input: { organizationId: ORG, todoId: "todo-private" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.setTodoSnooze).not.toHaveBeenCalled();
	});
});

describe("todos.assign", () => {
	beforeEach(() => {
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({
				suggestedUserId: "user-guess",
				assigneeUserId: null,
			}),
		);
	});

	it("marks the choice manual and clears the suggestion", async () => {
		const result = await mocks.captured.assign({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-meeting",
				assigneeUserId: OTHER_MEMBER,
			},
		});

		expect(mocks.setTodoAssignee).toHaveBeenCalledWith({
			todoId: "todo-meeting",
			organizationId: ORG,
			assigneeUserId: OTHER_MEMBER,
			assigneeContactId: null,
		});
		// `assignedManually` is what survives the next re-extraction; without
		// it the matcher replaces a person's choice with its own guess.
		expect(result).toMatchObject({
			assignedManually: true,
			assigneeKind: "member",
		});
	});

	it("verifies the member against THIS organization", async () => {
		mocks.isAssignableOrganizationMember.mockResolvedValue(false);

		await expect(
			mocks.captured.assign({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					assigneeUserId: "user-outsider",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.isAssignableOrganizationMember).toHaveBeenCalledWith({
			organizationId: ORG,
			userId: "user-outsider",
		});
		expect(mocks.setTodoAssignee).not.toHaveBeenCalled();
	});

	it("refuses a contact belonging to another organization", async () => {
		// The register is org-only with no owning user, so the organization
		// filter is its entire tenant boundary. Accepting the id verbatim would
		// leak that organization's person into this one's list the moment the
		// page hydrated the name.
		mocks.isAssignableContact.mockResolvedValue(false);

		await expect(
			mocks.captured.assign({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					assigneeContactId: "contact-of-another-org",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.isAssignableContact).toHaveBeenCalledWith({
			organizationId: ORG,
			contactId: "contact-of-another-org",
		});
		expect(mocks.setTodoAssignee).not.toHaveBeenCalled();
	});

	it("answers a contact erased between the check and the write with the same refusal", async () => {
		// `contacts.delete` is a transaction, and it can commit in the gap
		// between the check above and the write below. The write settles
		// liveness again under a row lock and reports
		// `contact_not_assignable`; what this procedure must NOT do is let the
		// caller see that it was a race. The two refusals are compared here
		// word for word, because a difference between them is a way to learn
		// that an id exists in a register the caller has no claim to.
		mocks.isAssignableContact.mockResolvedValue(false);
		const foreign = await mocks.captured
			.assign({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					assigneeContactId: "contact-elsewhere",
				},
			})
			.catch(
				(error: unknown) => error as { code: string; message: string },
			);

		mocks.isAssignableContact.mockResolvedValue(true);
		mocks.setTodoAssignee.mockResolvedValue({
			assigned: false,
			reason: "contact_not_assignable",
		});
		const raced = await mocks.captured
			.assign({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					assigneeContactId: "contact-erased-mid-request",
				},
			})
			.catch(
				(error: unknown) => error as { code: string; message: string },
			);

		expect(raced.code).toBe("NOT_FOUND");
		expect(raced.code).toBe(foreign.code);
		expect(raced.message).toBe(foreign.message);
		// And nothing is logged as an assignment that did not happen.
		expect(auditCalls()).toEqual([]);
	});

	it("still reports a missing to-do as a missing to-do", async () => {
		mocks.setTodoAssignee.mockResolvedValue({
			assigned: false,
			reason: "todo_not_found",
		});

		await expect(
			mocks.captured.assign({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-meeting",
					assigneeUserId: OTHER_MEMBER,
				},
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "To-do not found",
		});
	});

	it("unassigns when neither id is given", async () => {
		const result = await mocks.captured.assign({
			context: baseCtx,
			input: { organizationId: ORG, todoId: "todo-meeting" },
		});

		expect(mocks.setTodoAssignee).toHaveBeenCalledWith(
			expect.objectContaining({
				assigneeUserId: null,
				assigneeContactId: null,
			}),
		);
		expect(result.assigneeKind).toBe("none");
	});

	it("will not let a member reassign another member's project-less manual to-do", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(
			foreignProjectlessManualTodo(),
		);

		await expect(
			mocks.captured.assign({
				context: baseCtx,
				input: {
					organizationId: ORG,
					todoId: "todo-private",
					assigneeUserId: VIEWER,
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.setTodoAssignee).not.toHaveBeenCalled();
	});

	it("puts ids in the ledger and never a person's name or email", async () => {
		// A contact-assigned row is reachable through arm 3, which is the
		// Product Owner of its project — the person who would be doing this
		// reassignment in the first place.
		mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([
			{ projectId: PROJECT, userId: VIEWER, tags: ["PRODUCT_OWNER"] },
		]);
		mocks.loadTodoForMutation.mockResolvedValue(
			meetingTodo({ assigneeContactId: "contact-previous" }),
		);

		await mocks.captured.assign({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoId: "todo-meeting",
				assigneeContactId: CONTACT.id,
			},
		});

		const row = auditCalls()[0];
		expect(row).toMatchObject({
			action: "org.todo.assigned",
			organizationId: ORG,
			resource: { type: "todo_item", id: "todo-meeting", name: null },
			metadata: {
				assigneeKind: "contact",
				assigneeContactId: CONTACT.id,
				previousAssigneeKind: "contact",
			},
		});
		// The audit log is append-only, so a name here would outlive the
		// erasure `org.contact.redacted` exists to record.
		const serialized = JSON.stringify(row);
		expect(serialized).not.toContain(CONTACT.name);
		expect(serialized).not.toContain(CONTACT.email);
	});
});

describe("todos.create", () => {
	beforeEach(() => {
		mocks.createManualTodo.mockImplementation(async (params: any) => ({
			id: "todo-new",
			source: "MANUAL",
			title: params.title,
			projectId: params.projectId ?? null,
			assigneeUserId: null,
			assigneeContactId: null,
			assignedManually: false,
			snoozedUntil: null,
			completedAt: null,
			sourceDate: params.now,
			createdAt: params.now,
			updatedAt: params.now,
		}));
	});

	it("creates a manual to-do with no project at all", async () => {
		const result = await mocks.captured.create({
			context: baseCtx,
			input: { organizationId: ORG, title: "Chase the signed SOW" },
		});

		expect(mocks.createManualTodo).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				// The creator owns the row, which is the arm of the write rule
				// that answers for a to-do with no project.
				userId: VIEWER,
				title: "Chase the signed SOW",
				projectId: null,
			}),
		);
		// No project named, so no project was looked up.
		expect(mocks.dbMock.project.findFirst).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			id: "todo-new",
			source: "MANUAL",
			projectId: null,
		});
	});

	it("verifies a named project with the read's own predicate", async () => {
		await mocks.captured.create({
			context: baseCtx,
			input: {
				organizationId: ORG,
				title: "Chase the signed SOW",
				projectId: PROJECT,
			},
		});

		const where = mocks.dbMock.project.findFirst.mock.calls[0]?.[0]?.where;
		expect(where).toMatchObject({
			id: PROJECT,
			organizationId: ORG,
			deletedAt: null,
		});
	});

	it("refuses a project the caller cannot reach", async () => {
		mocks.dbMock.project.findFirst.mockResolvedValue(null);

		await expect(
			mocks.captured.create({
				context: baseCtx,
				input: {
					organizationId: ORG,
					title: "Chase the signed SOW",
					projectId: "project-elsewhere",
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.createManualTodo).not.toHaveBeenCalled();
	});

	it("records the creation without the title", async () => {
		await mocks.captured.create({
			context: baseCtx,
			input: {
				organizationId: ORG,
				title: "Ask Robin Vasquez for the W-9",
			},
		});

		const row = auditCalls()[0];
		expect(row).toMatchObject({
			action: "org.todo.created",
			organizationId: ORG,
			resource: { type: "todo_item", id: "todo-new", name: null },
		});
		// Free text a person typed routinely names whoever owes the work, and
		// an audit row cannot be edited when that person asks to be erased.
		expect(JSON.stringify(row)).not.toContain("Robin Vasquez");
	});

	it("refuses while the rollout gate is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			mocks.captured.create({
				context: baseCtx,
				input: { organizationId: ORG, title: "Chase it" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.createManualTodo).not.toHaveBeenCalled();
	});
});

describe("todos.bulkResolve", () => {
	it("resolves the reachable projects once, not once per row", async () => {
		// The batch exists to replace fifty round trips with one. A per-row
		// lookup would differ only in the project id while re-evaluating the
		// same predicate over the same caller, organization and clock, so this
		// pins the shape rather than the speed: the moment it regresses to
		// `findFirst` per row, the count below stops being 1.
		const rows = Array.from({ length: 5 }, (_, i) =>
			meetingTodo({ id: `todo-${i}`, projectId: PROJECT, userId: null }),
		);
		mocks.loadTodosForMutation.mockResolvedValue(rows);
		mocks.setTodoCompletion.mockImplementation(async ({ todo }: any) => ({
			todoId: todo.id,
			target: "action_item",
			completedAt: new Date(),
			actionItemId: "action-item-1",
		}));

		await mocks.captured.bulkResolve({
			context: baseCtx,
			input: { organizationId: ORG, todoIds: rows.map((r) => r.id) },
		});

		expect(mocks.dbMock.project.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.dbMock.project.findFirst).not.toHaveBeenCalled();
	});

	it("refuses a row whose project is outside the reachable set", async () => {
		// The rule is unchanged by the batching: a project the caller cannot
		// reach is absent from the scope, and absence is the refusal.
		mocks.dbMock.project.findMany.mockResolvedValue([
			{ id: PROJECT, userId: "user-creator", members: [] },
		]);
		const elsewhere = meetingTodo({
			id: "todo-elsewhere",
			projectId: "project-elsewhere",
			userId: null,
		});
		mocks.loadTodosForMutation.mockResolvedValue([elsewhere]);

		const result = await mocks.captured.bulkResolve({
			context: baseCtx,
			input: { organizationId: ORG, todoIds: ["todo-elsewhere"] },
		});

		expect(result.results).toEqual([
			{ todoId: "todo-elsewhere", outcome: "forbidden" },
		]);
		expect(mocks.setTodoCompletion).not.toHaveBeenCalled();
	});

	it("reports every row and commits the ones it can", async () => {
		const mine = foreignProjectlessManualTodo({
			id: "todo-mine",
			userId: VIEWER,
		});
		const theirs = foreignProjectlessManualTodo({ id: "todo-theirs" });
		const orphan = meetingTodo({ id: "todo-vanished" });

		// "todo-gone" is absent from the load: a re-extraction deleted it
		// between the page rendering and the button being pressed.
		mocks.loadTodosForMutation.mockResolvedValue([mine, theirs, orphan]);
		mocks.setTodoCompletion.mockImplementation(async ({ todo }: any) =>
			todo.id === "todo-vanished"
				? null
				: {
						todoId: todo.id,
						target: "todo",
						completedAt: new Date(),
						actionItemId: null,
					},
		);

		const result = await mocks.captured.bulkResolve({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoIds: [
					"todo-mine",
					"todo-theirs",
					"todo-vanished",
					"todo-gone",
				],
			},
		});

		expect(result.results).toEqual([
			{ todoId: "todo-mine", outcome: "completed" },
			// Authorization is per row: naming four ids does not pool the
			// caller's rights across them.
			{ todoId: "todo-theirs", outcome: "forbidden" },
			{ todoId: "todo-vanished", outcome: "vanished" },
			// The row a re-extraction removed. It must not fail the batch.
			{ todoId: "todo-gone", outcome: "not_found" },
		]);
		expect(result.counts).toEqual({
			requested: 4,
			completed: 1,
			notFound: 1,
			forbidden: 1,
			vanished: 1,
		});
		// The one row it could write, it wrote.
		expect(mocks.setTodoCompletion).toHaveBeenCalledTimes(2);
	});

	it("collapses a duplicated id into one outcome", async () => {
		const mine = foreignProjectlessManualTodo({
			id: "todo-mine",
			userId: VIEWER,
		});
		mocks.loadTodosForMutation.mockResolvedValue([mine]);
		mocks.setTodoCompletion.mockResolvedValue({
			todoId: "todo-mine",
			target: "todo",
			completedAt: new Date(),
			actionItemId: null,
		});

		const result = await mocks.captured.bulkResolve({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoIds: ["todo-mine", "todo-mine", "todo-mine"],
			},
		});

		expect(result.results).toHaveLength(1);
		expect(mocks.setTodoCompletion).toHaveBeenCalledTimes(1);
	});

	it("leaves a receipt naming each row it completed, plus one for the batch", async () => {
		const mine = foreignProjectlessManualTodo({
			id: "todo-mine",
			userId: VIEWER,
		});
		mocks.loadTodosForMutation.mockResolvedValue([mine]);
		mocks.setTodoCompletion.mockResolvedValue({
			todoId: "todo-mine",
			target: "todo",
			completedAt: new Date(),
			actionItemId: null,
		});

		await mocks.captured.bulkResolve({
			context: baseCtx,
			input: {
				organizationId: ORG,
				todoIds: ["todo-mine", "todo-gone"],
			},
		});

		const rows = auditCalls();
		// Without the per-row row, "who completed this to-do" would be
		// answerable only when it was ticked on its own.
		expect(rows[0]).toMatchObject({
			action: "org.todo.completion_changed",
			organizationId: ORG,
			resource: { type: "todo_item", id: "todo-mine" },
			metadata: { completed: true, viaBulkResolve: true },
		});
		expect(rows[1]).toMatchObject({
			action: "org.todo.bulk_resolved",
			organizationId: ORG,
			metadata: { requested: 2, completed: 1, notFound: 1 },
		});
	});
});

describe("every mutation leaves an audit row that names its tenant", () => {
	/**
	 * A sweep rather than six near-identical assertions. The failure it exists
	 * to catch is a new mutation — or a refactor of an existing one — dropping
	 * `organizationId` from its audit row: `buildAuditRow` writes it as `null`,
	 * and the row lands outside every tenant's audit view while nothing else
	 * goes red.
	 */
	const cases: Array<{
		key: string;
		input: Record<string, unknown>;
		action: string;
	}> = [
		{
			key: "complete",
			input: { todoId: "todo-mine", completed: true },
			action: "org.todo.completion_changed",
		},
		{
			key: "snooze",
			input: {
				todoId: "todo-mine",
				snoozedUntil: new Date(Date.now() + 86_400_000),
			},
			action: "org.todo.snoozed",
		},
		{
			key: "unsnooze",
			input: { todoId: "todo-mine" },
			action: "org.todo.unsnoozed",
		},
		{
			key: "assign",
			input: { todoId: "todo-mine", assigneeUserId: OTHER_MEMBER },
			action: "org.todo.assigned",
		},
		{
			key: "create",
			input: { title: "Chase it" },
			action: "org.todo.created",
		},
		{
			key: "bulkResolve",
			input: { todoIds: ["todo-mine"] },
			action: "org.todo.bulk_resolved",
		},
	];

	for (const { key, input, action } of cases) {
		it(`${key} records ${action}`, async () => {
			const mine = foreignProjectlessManualTodo({
				id: "todo-mine",
				userId: VIEWER,
			});
			mocks.loadTodoForMutation.mockResolvedValue(mine);
			mocks.loadTodosForMutation.mockResolvedValue([mine]);
			mocks.setTodoCompletion.mockResolvedValue({
				todoId: "todo-mine",
				target: "todo",
				completedAt: new Date(),
				actionItemId: null,
			});
			mocks.createManualTodo.mockResolvedValue({
				id: "todo-new",
				source: "MANUAL",
				title: "Chase it",
				projectId: null,
				assigneeUserId: null,
				assigneeContactId: null,
				assignedManually: false,
				snoozedUntil: null,
				completedAt: null,
				sourceDate: new Date(),
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			await mocks.captured[key]({
				context: baseCtx,
				input: { organizationId: ORG, ...input },
			});

			const row = auditCalls().find((call) => call.action === action);
			expect(row).toBeDefined();
			expect(row.organizationId).toBe(ORG);
			expect(row.resource).toBeDefined();
			// The affected resource is always named by id, never by a title or
			// a person's name.
			expect(row.resource.name ?? null).toBeNull();
		});
	}
});

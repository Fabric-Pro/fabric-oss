/**
 * The To Do list read procedure (#2340): `todos.list`.
 *
 * Two seams, the split this repository uses for procedures (see
 * `procedures/contacts/__tests__/contacts.test.ts` and
 * `modules/function-tags/procedures/__tests__/project.test.ts`):
 *
 *  1. **Schema level.** `.input()` is a no-op in the stubbed procedure chain
 *     below, so `listTodosInputSchema` is parsed directly. The paging bounds
 *     and the mutually-exclusive assignee filters live there.
 *  2. **Handler level.** `@repo/database` is mocked, so what is asserted is
 *     what the handler ASKS FOR — which organization, which visibility scope,
 *     which thresholds — and the DTO it maps back. The statement those
 *     parameters produce is pinned in
 *     `packages/database/prisma/queries/todos/__tests__/list-todos.test.ts`,
 *     and the visibility rules themselves in `../../lib/__tests__/visibility.test.ts`.
 *
 * The permission GATE cannot run here, because `.use()` is a no-op in the stub.
 * What this file pins is the DECLARATION — `TODO_READ` with
 * `requireOrganization: true` — for the same reason the contact register pins
 * its four: without `requireOrganization`, an explicit `organizationId: null`
 * resolves to nothing and skips the role check entirely, and this procedure has
 * no personal variant for that pass-through to be correct for. What that
 * declaration DOES against the real middleware is pinned in
 * `procedures/contacts/__tests__/contacts-authorization.test.ts`, which drives
 * the same middleware with the same shape.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";

// ---------------------------------------------------------------------------
// Handler level
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	listVisibleTodos: vi.fn(),
	isFeatureEnabled: vi.fn(),
	dbMock: {
		project: { findMany: vi.fn() },
		projectUserFunctionTag: { findMany: vi.fn() },
		user: { findMany: vi.fn() },
		nonMemberContact: { findMany: vi.fn() },
	},
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
		listVisibleTodos: mocks.listVisibleTodos,
		isFeatureEnabled: mocks.isFeatureEnabled,
	};
});

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

setSlot("list");
// Imported AFTER the slot is set: the stubbed chain captures the handler into
// whichever slot is pending, so a static import at the top of the file would
// file it under no name at all.
const { listTodosInputSchema } = await import("../list");

// ---------------------------------------------------------------------------
// Schema level — the real guard behind `.input(...)`
// ---------------------------------------------------------------------------

describe("listTodosInputSchema", () => {
	it("defaults to a bounded page rather than to everything", () => {
		// The over-fetch idiom that keeps paging correct under an access filter
		// is meaningless without a limit, so there is no "no limit" input.
		const parsed = listTodosInputSchema.parse({});
		expect(parsed.limit).toBe(50);
		// The working list, not an archive and not an empty scope.
		expect(parsed.view).toBe("default");
	});

	it("accepts each of the four scopes and nothing else", () => {
		// One enum rather than a flag per rule: as booleans these four would
		// admit combinations the product has never defined an answer for, and
		// the SQL would have to invent one.
		for (const view of ["default", "completed", "snoozed", "ageHidden"]) {
			expect(listTodosInputSchema.safeParse({ view }).success).toBe(true);
		}
		expect(
			listTodosInputSchema.safeParse({ view: "archived" }).success,
		).toBe(false);
		expect(
			listTodosInputSchema.safeParse({ includeCompleted: true }).success,
		).toBe(true);
		// The replaced flag is not silently honoured: it is dropped, and the
		// scope stays the default one rather than quietly widening.
		expect(
			listTodosInputSchema.parse({ includeCompleted: true }),
		).not.toHaveProperty("includeCompleted");
	});

	it("bounds the page size at both ends", () => {
		expect(listTodosInputSchema.safeParse({ limit: 0 }).success).toBe(
			false,
		);
		expect(listTodosInputSchema.safeParse({ limit: 101 }).success).toBe(
			false,
		);
		expect(listTodosInputSchema.safeParse({ limit: 100 }).success).toBe(
			true,
		);
	});

	it("accepts a project filter and an assignee filter together", () => {
		expect(
			listTodosInputSchema.safeParse({
				projectId: "project-1",
				assigneeContactId: "contact-1",
			}).success,
		).toBe(true);
	});

	it("refuses a member filter and a contact filter at once", () => {
		// A to-do carries one or the other, so both can only ever match
		// nothing — and an empty list would read as "nobody owes anything".
		expect(
			listTodosInputSchema.safeParse({
				assigneeUserId: "user-1",
				assigneeContactId: "contact-1",
			}).success,
		).toBe(false);
	});
});

const VIEWER = "user-viewer";
const SESSION_ORG = "org-session";
const INPUT_ORG = "org-named-in-input";

const baseCtx = {
	user: { id: VIEWER, email: "dana@example.com", name: "Dana" },
	session: {
		id: "sess-1",
		activeOrganizationId: SESSION_ORG,
		impersonatedBy: null,
	},
	headers: new Headers(),
};

function dbRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "todo-1",
		source: "MEETING_DIGEST",
		transcriptId: "transcript-1",
		itemKey: "key-1",
		occurrenceIndex: 0,
		itemTextSnapshot: "Send the revised scope",
		title: null,
		projectId: "project-1",
		assigneeUserId: null,
		assigneeContactId: null,
		suggestedUserId: null,
		suggestedContactId: null,
		suggestionCandidates: null,
		assignedManually: false,
		snoozedUntil: null,
		sourceDate: new Date("2026-09-10T09:00:00.000Z"),
		lastKnownCompletedAt: null,
		createdAt: new Date("2026-09-10T09:00:00.000Z"),
		updatedAt: new Date("2026-09-11T09:00:00.000Z"),
		ageClock: new Date("2026-09-10T09:00:00.000Z"),
		effectiveCompletedAt: null,
		isOrphaned: false,
		liveText: "Send the revised scope",
		meetingTranscriptRef: "graph-transcript-1",
		meetingTitle: "Weekly sync",
		meetingDate: new Date("2026-09-10T09:00:00.000Z"),
		...overrides,
	};
}

function queryResult(overrides: Record<string, unknown> = {}) {
	return {
		rows: [],
		hasMore: false,
		nextCursor: null,
		ageHiddenCount: 0,
		// Whether the cursor could be placed at all. Defaulted here so every
		// case in this file answers the shape the query really returns.
		cursorStale: false,
		...overrides,
	};
}

/** The one call the handler makes into the database query layer. */
function queryArgs() {
	return mocks.listVisibleTodos.mock.calls[0]?.[0] as any;
}

beforeEach(() => {
	mocks.listVisibleTodos.mockReset();
	mocks.isFeatureEnabled.mockReset();
	mocks.dbMock.project.findMany.mockReset();
	mocks.dbMock.projectUserFunctionTag.findMany.mockReset();
	mocks.dbMock.user.findMany.mockReset();
	mocks.dbMock.nonMemberContact.findMany.mockReset();

	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.listVisibleTodos.mockResolvedValue(queryResult());
	// `resolveTodoVisibility` asks for the accessible projects (the call that
	// selects `members`); the handler's name hydration asks for the returned
	// rows' projects. One mock, told apart by the shape of the select.
	mocks.dbMock.project.findMany.mockImplementation(async (args: any) =>
		args?.select?.members
			? [{ id: "project-1", userId: "user-creator", members: [] }]
			: [{ id: "project-1", name: "Meridian rollout" }],
	);
	mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([]);
	mocks.dbMock.user.findMany.mockResolvedValue([]);
	mocks.dbMock.nonMemberContact.findMany.mockResolvedValue([]);
});

describe("the gate it declares", () => {
	it("asks for TODO_READ against the organization named in the input", () => {
		expect(mocks.declared.list).toEqual([
			{
				permission: "TODO_READ",
				// Not decoration: without it, `organizationId: null` resolves to
				// nothing and the role check never runs.
				options: { requireOrganization: true },
			},
		]);
	});
});

describe("listTodosProcedure", () => {
	it("refuses a request that names no organization at all", async () => {
		const error = await mocks.captured
			.list({ context: baseCtx, input: { organizationId: null } })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
		expect(mocks.listVisibleTodos).not.toHaveBeenCalled();
	});

	it("reads against the organization NAMED IN THE INPUT, not the session's", async () => {
		await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(queryArgs().organizationId).toBe(INPUT_ORG);
		// The flag is resolved for the same organization, so an organization
		// that has not been rolled out cannot be read through another's session.
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"TODO_LIST",
			INPUT_ORG,
		);
	});

	it("is absent rather than empty while the rollout gate is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			mocks.captured.list({
				context: baseCtx,
				input: { organizationId: INPUT_ORG, limit: 20 },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.listVisibleTodos).not.toHaveBeenCalled();
	});

	it("hands the query the age threshold, the recency floor and the completion window", async () => {
		await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(queryArgs()).toMatchObject({
			ageThresholdDays: 30,
			recencyFloor: 10,
			recentCompletedLimit: 2,
			limit: 20,
		});
	});

	it("passes one clock to the visibility resolution and to the query", async () => {
		await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		// A request that sampled the clock twice could hide a row as snoozed and
		// count it as age-hidden in the same response.
		const membershipClock =
			mocks.dbMock.project.findMany.mock.calls[0]?.[0]?.where?.OR?.[0]
				?.members?.some?.OR?.[1]?.expiresAt?.gt;
		expect(queryArgs().now).toEqual(membershipClock);
	});

	it("composes the visibility predicate rather than letting the query build one", async () => {
		await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		// A parameterised fragment, never interpolated text.
		expect(queryArgs().visibilityCondition.values).toContain(VIEWER);
		expect(queryArgs().visibilityCondition.sql).toContain(
			't."assigneeUserId"',
		);
	});

	it("forwards the project and assignee filters together, plus the cursor and the scope", async () => {
		await mocks.captured.list({
			context: baseCtx,
			input: {
				organizationId: INPUT_ORG,
				limit: 20,
				projectId: "project-1",
				assigneeContactId: "contact-9",
				cursor: "todo-40",
				view: "completed",
			},
		});

		expect(queryArgs()).toMatchObject({
			projectId: "project-1",
			assigneeContactId: "contact-9",
			cursor: "todo-40",
			view: "completed",
		});
	});

	it("asks the SAME visibility question in every scope", async () => {
		// A view narrows which of the rows this caller may already see are
		// kept; it never decides who may see a row. If a scope ever reached the
		// query with a different predicate — or with none — that would be a
		// cross-project leak in a view nobody thinks of as a read.
		const predicates: string[] = [];
		for (const view of [
			"default",
			"completed",
			"snoozed",
			"ageHidden",
		] as const) {
			mocks.listVisibleTodos.mockClear();
			await mocks.captured.list({
				context: baseCtx,
				input: { organizationId: INPUT_ORG, limit: 20, view },
			});

			expect(queryArgs().view).toBe(view);
			expect(queryArgs().organizationId).toBe(INPUT_ORG);
			predicates.push(
				JSON.stringify({
					sql: queryArgs().visibilityCondition.sql,
					values: queryArgs().visibilityCondition.values,
				}),
			);
		}

		expect(new Set(predicates).size).toBe(1);
	});

	it("returns the paging contract and what age hid", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({
				rows: [dbRow()],
				hasMore: true,
				nextCursor: "todo-1",
				ageHiddenCount: 7,
			}),
		);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 1 },
		});

		expect(result.hasMore).toBe(true);
		expect(result.nextCursor).toBe("todo-1");
		// Non-zero is the page's cue to offer a way in — without it, age hiding
		// is indistinguishable from a silent delete.
		expect(result.ageHiddenCount).toBe(7);
		expect(result.ageThresholdDays).toBe(30);
	});

	it("returns the Unassigned bucket's default state so the client needs no second call", async () => {
		mocks.dbMock.project.findMany.mockImplementation(async (args: any) =>
			args?.select?.members
				? [{ id: "project-1", userId: VIEWER, members: [] }]
				: [],
		);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		// The viewer created project-1 and nobody confirmed a tag there.
		expect(result.unassignedExpandedProjectIds).toEqual(["project-1"]);
	});

	it("maps a row to an explicit DTO with ISO dates, never a Prisma row", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({
				rows: [
					dbRow({
						assigneeContactId: "contact-9",
						effectiveCompletedAt: new Date(
							"2026-09-15T08:00:00.000Z",
						),
					}),
				],
			}),
		);
		mocks.dbMock.nonMemberContact.findMany.mockResolvedValue([
			{ id: "contact-9", name: "Robin Vale" },
		]);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(result.items[0]).toEqual({
			id: "todo-1",
			source: "MEETING_DIGEST",
			title: "Send the revised scope",
			projectId: "project-1",
			projectName: "Meridian rollout",
			assigneeUserId: null,
			assigneeUser: null,
			assigneeContactId: "contact-9",
			assigneeContact: { id: "contact-9", name: "Robin Vale" },
			suggestedUserId: null,
			suggestedContactId: null,
			suggestionCandidates: null,
			assignedManually: false,
			snoozedUntil: null,
			sourceDate: "2026-09-10T09:00:00.000Z",
			completedAt: "2026-09-15T08:00:00.000Z",
			isCompleted: true,
			lastKnownCompletedAt: null,
			isOrphaned: false,
			// The meeting reference: the GRAPH transcript id the digest deep
			// link is built from, the durable item key it highlights, the name
			// the digest itself shows, and the date the page groups by.
			meetingTranscriptRef: "graph-transcript-1",
			meetingItemKey: "key-1",
			meetingTitle: "Weekly sync",
			meetingDate: "2026-09-10T09:00:00.000Z",
			createdAt: "2026-09-10T09:00:00.000Z",
			updatedAt: "2026-09-11T09:00:00.000Z",
		});
	});

	it("shows a row pointing at a redacted contact as unassigned", async () => {
		// `contacts.delete` anonymises the row to "Removed contact" and
		// detaches every to-do that named it, so a row still pointing at one
		// here is a row the erasure did not reach. The hydration asks only for
		// LIVE contacts, and the id travels with the name or not at all: the
		// page decides "unassigned" from the id (`assigneeUserId === null &&
		// assigneeContactId === null`) and renders from the object, so keeping
		// the id would leave the row assigned to nobody, out of the Unassigned
		// bucket and out of reach of the suggestion chips.
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({
				rows: [dbRow({ assigneeContactId: "contact-erased" })],
			}),
		);
		// What the filtered query returns for a tombstone: nothing.
		mocks.dbMock.nonMemberContact.findMany.mockResolvedValue([]);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(
			mocks.dbMock.nonMemberContact.findMany.mock.calls[0][0].where,
		).toEqual({
			id: { in: ["contact-erased"] },
			organizationId: INPUT_ORG,
			// The decision, not a copy of the register's filter: rendering
			// the tombstone would give the row an assignee named "Removed
			// contact" and put the erased person back into the page's
			// assignee filter, which is built from these hydrated names.
			redactedAt: null,
		});
		expect(result.items[0].assigneeContactId).toBeNull();
		expect(result.items[0].assigneeContact).toBeNull();
	});

	it("leaves the meeting reference null on a manual row", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({
				rows: [
					dbRow({
						source: "MANUAL",
						transcriptId: null,
						itemKey: null,
						occurrenceIndex: null,
						itemTextSnapshot: null,
						liveText: null,
						title: "Chase the invoice",
						meetingTranscriptRef: null,
						meetingTitle: null,
						meetingDate: null,
					}),
				],
			}),
		);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(result.items[0]).toMatchObject({
			meetingTranscriptRef: null,
			meetingItemKey: null,
			meetingTitle: null,
			meetingDate: null,
		});
	});

	it("never projects the transcript ROW id, which addresses no digest", async () => {
		// `meetingTranscriptRef` is the graph id; the cuid the binding uses
		// reaches nothing outside the database and a page that built a link
		// from it would 404.
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({ rows: [dbRow({ transcriptId: "row-cuid-only" })] }),
		);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(result.items[0]).not.toHaveProperty("transcriptId");
		expect(JSON.stringify(result.items[0])).not.toContain("row-cuid-only");
		expect(result.items[0].meetingTranscriptRef).toBe("graph-transcript-1");
	});

	it("takes completion from the action item, so a meeting row with none is open", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({ rows: [dbRow({ effectiveCompletedAt: null })] }),
		);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(result.items[0].isCompleted).toBe(false);
		expect(result.items[0].completedAt).toBeNull();
	});

	it("shows the live wording, and falls back to the snapshot for an orphan", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({
				rows: [
					dbRow({
						id: "todo-live",
						liveText: "Send the FINAL scope",
					}),
					dbRow({
						id: "todo-orphan",
						liveText: null,
						isOrphaned: true,
						lastKnownCompletedAt: new Date(
							"2026-09-12T08:00:00.000Z",
						),
					}),
					dbRow({
						id: "todo-manual",
						source: "MANUAL",
						transcriptId: null,
						itemKey: null,
						occurrenceIndex: null,
						itemTextSnapshot: null,
						liveText: null,
						title: "Chase the invoice",
					}),
				],
			}),
		);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(
			result.items.map((item: { title: string }) => item.title),
		).toEqual([
			"Send the FINAL scope",
			"Send the revised scope",
			"Chase the invoice",
		]);
		expect(result.items[1].isOrphaned).toBe(true);
		// The display cache, so an orphan can still say it HAD been completed.
		expect(result.items[1].lastKnownCompletedAt).toBe(
			"2026-09-12T08:00:00.000Z",
		);
	});

	it("hydrates names only for the rows it is about to return", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({ rows: [dbRow({ assigneeUserId: "user-dana" })] }),
		);
		mocks.dbMock.user.findMany.mockResolvedValue([
			{ id: "user-dana", name: "Dana", image: null },
		]);

		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(mocks.dbMock.user.findMany).toHaveBeenCalledWith({
			where: { id: { in: ["user-dana"] } },
			select: { id: true, name: true, image: true },
		});
		// The contact lookup is org-scoped as well as id-scoped: a contact id is
		// never enough to reach a row in another tenant's register.
		expect(mocks.dbMock.nonMemberContact.findMany).not.toHaveBeenCalled();
		expect(result.items[0].assigneeUser).toEqual({
			id: "user-dana",
			name: "Dana",
			image: null,
		});
	});

	it("scopes the contact hydration to the organization it read", async () => {
		mocks.listVisibleTodos.mockResolvedValue(
			queryResult({ rows: [dbRow({ assigneeContactId: "contact-9" })] }),
		);

		await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(mocks.dbMock.nonMemberContact.findMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["contact-9"] },
				organizationId: INPUT_ORG,
				// Live rows only — see the redaction case below.
				redactedAt: null,
			},
			select: { id: true, name: true },
		});
	});

	it("returns an empty page without asking for any names", async () => {
		const result = await mocks.captured.list({
			context: baseCtx,
			input: { organizationId: INPUT_ORG, limit: 20 },
		});

		expect(result.items).toEqual([]);
		expect(result.ageHiddenCount).toBe(0);
		expect(mocks.dbMock.user.findMany).not.toHaveBeenCalled();
		expect(mocks.dbMock.nonMemberContact.findMany).not.toHaveBeenCalled();
	});
});

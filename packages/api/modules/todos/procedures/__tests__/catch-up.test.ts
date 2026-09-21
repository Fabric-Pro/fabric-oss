/**
 * `todos.catchUp` — the To Do page's repair path (#2340).
 *
 * WHAT IS ACTUALLY PROVED HERE. The procedure's job is to select the right
 * meetings and start one matcher run each, so the tests are about the
 * SELECTION and the START, and both are exercised for real:
 *
 *  - **Selection.** `@repo/database` is mocked, but `findMany` is not a stub
 *    returning a canned list: it evaluates the handler's own `where` against a
 *    table of fixture transcripts, with the NULL semantics Postgres has rather
 *    than the ones a reader might assume (`todoMatchVersion <> 1` does NOT
 *    match a NULL). That is what makes "already stamped at the current version
 *    is not restarted" and "stamped at an older version IS restarted" mean
 *    something instead of restating the source.
 *
 *  - **Authorization.** The project boundary is asserted by structural
 *    identity against the REAL `accessibleProjectWhere` — the predicate every
 *    other to-do read composes — so a hand-rolled, weaker predicate (an
 *    organization check, say) fails here even though it would still return
 *    rows. The fake `findMany` additionally honours a per-test set of
 *    reachable projects, so the unreachable-project case is observable as a
 *    missing start and not only as a query shape.
 *
 *  - **The start.** `@repo/temporal`'s ROOT is mocked (the client), but
 *    `@repo/temporal/meeting-todo-matcher` is deliberately NOT: the workflow
 *    id is the entire de-duplication between this procedure and the extraction
 *    activity, so a test that stubbed the builder would pass while the two
 *    sites drifted apart and doubled every meeting's to-dos.
 *
 * The permission GATE cannot run — `.use()` is a no-op in the stubbed chain —
 * so what is pinned about it is the DECLARATION, as in `./proposal-links.test.ts`.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	start: vi.fn(),
	getTemporalClient: vi.fn(),
	dbMock: {
		projectMeetingTranscript: { findMany: vi.fn() },
	},
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
	declared: [] as {
		permission: string;
		options?: { requireOrganization?: boolean };
	}[],
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: mocks.dbMock,
		isFeatureEnabled: mocks.isFeatureEnabled,
	};
});

vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Only the ROOT. The workflow-id builder lives in its own import-free module
// and stays real — see the header.
vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: (declaration: {
			permission: string;
			options?: { requireOrganization?: boolean };
		}) => {
			mocks.declared.push(declaration);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured.catchUp = fn as any;
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
	};
});

const { TODO_CATCH_UP_MAX_STARTS, todoCatchUpInputSchema } = await import(
	"../catch-up"
);
const { accessibleProjectWhere } = await import("../../lib/visibility");
const { TODO_BINDING_VERSION } = await import("@repo/database");
const { meetingTodoMatcherWorkflowId } = await import(
	"@repo/temporal/meeting-todo-matcher"
);

const ORG = "org-1";
const OTHER_ORG = "org-2";
const VIEWER = "user-1";
const REACHABLE = "proj-reachable";
const UNREACHABLE = "proj-unreachable";

const baseCtx = {
	user: { id: VIEWER, email: "dev@example.com", name: "Dev" },
	session: { id: "sess-1", activeOrganizationId: ORG },
};

/** A transcript as the fake table holds it, before the `select` narrows it. */
interface TranscriptFixture {
	id: string;
	projectId: string;
	organizationId: string;
	/** What `actionItems: { some: {} }` asks about. */
	actionItemCount: number;
	todosMatchedAt: Date | null;
	todoMatchVersion: number | null;
	meetingDate: Date | null;
}

let table: TranscriptFixture[] = [];
/** Projects this viewer can reach in this test. */
let reachableProjectIds: string[] = [];
/** The `findMany` args the handler last passed, for the shape assertions. */
let lastFindManyArgs: any = null;

/**
 * The version arms, evaluated with Postgres' NULL semantics on purpose.
 *
 * `todoMatchVersion <> 1` is UNKNOWN — therefore false — for a NULL row, which
 * is exactly why the handler spells the `todoMatchVersion: null` arm out
 * instead of leaving it to `not`. Implementing the lenient reading here would
 * hide the removal of that arm.
 */
function matchesVersionArms(row: TranscriptFixture, arms: any[]): boolean {
	return arms.some((arm) => {
		if ("todosMatchedAt" in arm) {
			return arm.todosMatchedAt === null
				? row.todosMatchedAt === null
				: row.todosMatchedAt?.getTime() ===
						(arm.todosMatchedAt as Date).getTime();
		}
		const version = arm.todoMatchVersion;
		if (version === null) {
			return row.todoMatchVersion === null;
		}
		if (version && typeof version === "object" && "not" in version) {
			return (
				row.todoMatchVersion !== null &&
				row.todoMatchVersion !== version.not
			);
		}
		return row.todoMatchVersion === version;
	});
}

/** Newest meeting first, undated last, `id` breaking ties — as ordered. */
function sortAsRequested(rows: TranscriptFixture[]): TranscriptFixture[] {
	return [...rows].sort((a, b) => {
		if (a.meetingDate && b.meetingDate) {
			const diff = b.meetingDate.getTime() - a.meetingDate.getTime();
			if (diff !== 0) {
				return diff;
			}
		} else if (a.meetingDate !== b.meetingDate) {
			return a.meetingDate ? -1 : 1;
		}
		return a.id.localeCompare(b.id);
	});
}

/**
 * Asserts the handler bounded the query with the SHARED project predicate.
 *
 * The clock is the handler's own `new Date()`, so it is read back out of the
 * predicate it built (the membership-expiry arm carries it) and the expected
 * value is then constructed with that same instant. What is compared is the
 * whole structure, so an organization-membership check that happened to return
 * the same rows in these fixtures still fails.
 */
function expectSharedProjectPredicate(projectWhere: any): void {
	const now = projectWhere?.OR?.[0]?.members?.some?.OR?.[1]?.expiresAt?.gt;
	expect(now).toBeInstanceOf(Date);
	expect(projectWhere).toEqual(accessibleProjectWhere(VIEWER, ORG, now));
}

function run(input: Record<string, unknown> = {}) {
	return mocks.captured.catchUp({ context: baseCtx, input });
}

beforeEach(() => {
	vi.clearAllMocks();
	table = [];
	reachableProjectIds = [REACHABLE];
	lastFindManyArgs = null;

	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.start.mockResolvedValue({ workflowId: "started" });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: mocks.start },
	});

	mocks.dbMock.projectMeetingTranscript.findMany.mockImplementation(
		async (args: any) => {
			lastFindManyArgs = args;
			const matched = table.filter(
				(row) =>
					row.organizationId === args.where.organizationId &&
					reachableProjectIds.includes(row.projectId) &&
					(args.where.actionItems?.some
						? row.actionItemCount > 0
						: true) &&
					matchesVersionArms(row, args.where.OR ?? []),
			);
			return sortAsRequested(matched)
				.slice(0, args.take)
				.map((row) => ({ id: row.id, projectId: row.projectId }));
		},
	);
});

/** A meeting with action items that nothing has ever matched. */
function unmatched(
	id: string,
	overrides: Partial<TranscriptFixture> = {},
): TranscriptFixture {
	return {
		id,
		projectId: REACHABLE,
		organizationId: ORG,
		actionItemCount: 3,
		todosMatchedAt: null,
		todoMatchVersion: null,
		meetingDate: new Date("2026-09-01T10:00:00.000Z"),
		...overrides,
	};
}

/** The transcript cuids the handler started a matcher for, in call order. */
function startedTranscriptIds(): string[] {
	return mocks.start.mock.calls.map(
		(call) => (call[1] as any).args[0].transcriptCuid,
	);
}

describe("todos.catchUp — declaration", () => {
	it("is gated on TODO_READ and refuses a request that names no organization", () => {
		expect(mocks.declared).toEqual([
			{
				permission: "TODO_READ",
				options: { requireOrganization: true },
			},
		]);
	});

	it("takes nothing but an optional organization — the cap is not a client's to choose", () => {
		expect(todoCatchUpInputSchema.safeParse({}).success).toBe(true);
		expect(
			todoCatchUpInputSchema.safeParse({ organizationId: ORG }).success,
		).toBe(true);
		expect(
			todoCatchUpInputSchema.safeParse({ organizationId: 42 }).success,
		).toBe(false);
	});
});

describe("todos.catchUp — the gate", () => {
	it("is absent, not empty, when the rollout flag is off for the organization", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		table = [unmatched("t-1")];

		await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("refuses a request that resolves to no organization", async () => {
		await expect(run({ organizationId: null })).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
		expect(
			mocks.dbMock.projectMeetingTranscript.findMany,
		).not.toHaveBeenCalled();
	});
});

describe("todos.catchUp — selection", () => {
	it("starts the matcher for every meeting extracted before the flag was enabled", async () => {
		// Three meetings analyzed while the gate was shut: insights are
		// cached, so extraction will never re-run and never re-start the
		// matcher for them. Nothing but this procedure reaches them.
		table = [
			unmatched("t-1", {
				meetingDate: new Date("2026-08-01T10:00:00.000Z"),
			}),
			unmatched("t-2", {
				meetingDate: new Date("2026-08-02T10:00:00.000Z"),
			}),
			unmatched("t-3", {
				meetingDate: new Date("2026-08-03T10:00:00.000Z"),
			}),
		];

		const result = await run({ organizationId: ORG });

		expect(result).toEqual({
			candidates: 3,
			started: 3,
			failed: 0,
			hasMore: false,
		});
		// Newest first — the meetings a person opening the page is looking for.
		expect(startedTranscriptIds()).toEqual(["t-3", "t-2", "t-1"]);
	});

	it("does not restart a transcript already stamped at the current version", async () => {
		table = [
			{
				...unmatched("t-fresh"),
				todosMatchedAt: new Date("2026-09-02T00:00:00.000Z"),
				todoMatchVersion: TODO_BINDING_VERSION,
			},
		];

		const result = await run({ organizationId: ORG });

		expect(result).toMatchObject({ candidates: 0, started: 0 });
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("restarts a transcript stamped at an older todoMatchVersion", async () => {
		table = [
			{
				...unmatched("t-stale"),
				todosMatchedAt: new Date("2026-09-02T00:00:00.000Z"),
				todoMatchVersion: TODO_BINDING_VERSION - 1,
			},
		];

		const result = await run({ organizationId: ORG });

		expect(result).toMatchObject({ candidates: 1, started: 1 });
		expect(startedTranscriptIds()).toEqual(["t-stale"]);
	});

	it("restarts a transcript matched at no version at all", async () => {
		// The arm that `not` would silently drop: a row with a
		// `todosMatchedAt` but a NULL version is not caught by
		// `todoMatchVersion <> N`, because NULL comparisons are never true.
		table = [
			{
				...unmatched("t-versionless"),
				todosMatchedAt: new Date("2026-09-02T00:00:00.000Z"),
				todoMatchVersion: null,
			},
		];

		const result = await run({ organizationId: ORG });

		expect(startedTranscriptIds()).toEqual(["t-versionless"]);
		expect(result).toMatchObject({ candidates: 1, started: 1 });
	});

	it("skips a transcript with no action items", async () => {
		table = [
			unmatched("t-empty", { actionItemCount: 0 }),
			unmatched("t-has-items"),
		];

		const result = await run({ organizationId: ORG });

		expect(startedTranscriptIds()).toEqual(["t-has-items"]);
		expect(result).toMatchObject({ candidates: 1 });
		// Asked of the database, not of the workflow: an organization whose
		// meetings are all status-only must not queue a run per meeting just to
		// discover there was nothing to do.
		expect(lastFindManyArgs.where.actionItems).toEqual({ some: {} });
	});

	it("selects only what the caller may reach — organization membership is not enough", async () => {
		table = [
			unmatched("t-reachable", { projectId: REACHABLE }),
			unmatched("t-unreachable", { projectId: UNREACHABLE }),
			// Same organization id in the input, a different tenant's row.
			unmatched("t-other-org", { organizationId: OTHER_ORG }),
		];

		const result = await run({ organizationId: ORG });

		expect(startedTranscriptIds()).toEqual(["t-reachable"]);
		expect(result).toMatchObject({ candidates: 1, started: 1 });
		// The boundary itself, not just its effect on these fixtures.
		expect(lastFindManyArgs.where.organizationId).toBe(ORG);
		expectSharedProjectPredicate(lastFindManyArgs.where.project);
	});

	it("finds nothing, and starts nothing, for a viewer who reaches no project", async () => {
		reachableProjectIds = [];
		table = [unmatched("t-1"), unmatched("t-2")];

		const result = await run({ organizationId: ORG });

		expect(result).toEqual({
			candidates: 0,
			started: 0,
			failed: 0,
			hasMore: false,
		});
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
	});
});

describe("todos.catchUp — bounding", () => {
	it("honours the cap and says there is more", async () => {
		// Deliberately more than the cap. Dated so the ordering is total and
		// the first page is predictable.
		table = Array.from({ length: TODO_CATCH_UP_MAX_STARTS + 7 }, (_, i) =>
			unmatched(`t-${String(i).padStart(3, "0")}`, {
				meetingDate: new Date(Date.UTC(2026, 0, i + 1)),
			}),
		);

		const result = await run({ organizationId: ORG });

		expect(result).toEqual({
			candidates: TODO_CATCH_UP_MAX_STARTS,
			started: TODO_CATCH_UP_MAX_STARTS,
			failed: 0,
			hasMore: true,
		});
		expect(mocks.start).toHaveBeenCalledTimes(TODO_CATCH_UP_MAX_STARTS);
		// One over the cap, and only one: `hasMore` must not cost a second
		// count over the same predicate.
		expect(lastFindManyArgs.take).toBe(TODO_CATCH_UP_MAX_STARTS + 1);
	});

	it("reports hasMore false when the candidates exactly fill the cap", async () => {
		table = Array.from({ length: TODO_CATCH_UP_MAX_STARTS }, (_, i) =>
			unmatched(`t-${String(i).padStart(3, "0")}`, {
				meetingDate: new Date(Date.UTC(2026, 0, i + 1)),
			}),
		);

		const result = await run({ organizationId: ORG });

		expect(result).toMatchObject({
			candidates: TODO_CATCH_UP_MAX_STARTS,
			hasMore: false,
		});
	});
});

describe("todos.catchUp — the start", () => {
	it("uses the same deterministic workflow id the extraction path uses", async () => {
		table = [unmatched("t-1")];

		await run({ organizationId: ORG });

		const [workflowType, options] = mocks.start.mock.calls[0] as [
			string,
			any,
		];
		expect(workflowType).toBe("matchMeetingActionItemOwnersWorkflow");
		expect(options.workflowId).toBe(meetingTodoMatcherWorkflowId("t-1"));
		expect(options.taskQueue).toBe("project-documents");
		expect(options.args).toEqual([
			{
				projectId: REACHABLE,
				organizationId: ORG,
				transcriptCuid: "t-1",
			},
		]);
	});

	it("joins a run already in flight rather than failing on it", async () => {
		table = [unmatched("t-1")];

		await run({ organizationId: ORG });

		const options = mocks.start.mock.calls[0][1] as any;
		// USE_EXISTING, not the extraction site's FAIL: a run already going is
		// the outcome this call site wants, and FAIL would make the ordinary
		// race (two members opening the page, or an open racing a daily brief)
		// an exception per meeting.
		expect(options.workflowIdConflictPolicy).toBe("USE_EXISTING");
		// A CLOSED previous run must still be restartable, or a stamp that went
		// stale after a version bump could never be refreshed.
		expect(options.workflowIdReusePolicy).toBe("ALLOW_DUPLICATE");
	});

	it("counts a failed start and still answers the caller", async () => {
		table = [
			unmatched("t-ok", {
				meetingDate: new Date("2026-08-02T10:00:00.000Z"),
			}),
			unmatched("t-bad", {
				meetingDate: new Date("2026-08-01T10:00:00.000Z"),
			}),
		];
		mocks.start.mockImplementation(async (_type: string, options: any) => {
			if (options.workflowId === meetingTodoMatcherWorkflowId("t-bad")) {
				throw new Error("task queue unavailable");
			}
			return { workflowId: options.workflowId };
		});

		const result = await run({ organizationId: ORG });

		expect(result).toEqual({
			candidates: 2,
			started: 1,
			failed: 1,
			hasMore: false,
		});
		// One unstartable meeting must not stop the others.
		expect(startedTranscriptIds().sort()).toEqual(["t-bad", "t-ok"]);
	});

	it("survives Temporal being unreachable and reports every start as failed", async () => {
		table = [unmatched("t-1"), unmatched("t-2")];
		mocks.getTemporalClient.mockRejectedValue(
			new Error("temporal unreachable"),
		);

		const result = await run({ organizationId: ORG });

		expect(result).toEqual({
			candidates: 2,
			started: 0,
			failed: 2,
			hasMore: false,
		});
		// Nothing was stamped, so the next open tries these two again.
		expect(mocks.start).not.toHaveBeenCalled();
	});
});

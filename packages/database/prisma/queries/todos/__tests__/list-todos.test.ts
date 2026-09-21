/**
 * The To Do list's one statement (#2340).
 *
 * What this file can and cannot prove, stated plainly. It drives
 * `listVisibleTodos` with `$queryRaw` mocked, so it pins two things exactly:
 * the STATEMENT that is built (every rule's placement inside it, and every
 * parameter it carries), and the RESULT SHAPING around it (the over-fetch, the
 * cursor, and the hidden count surviving an empty page). It cannot prove which
 * rows Postgres returns; that needs a database.
 *
 * Statement placement is worth pinning precisely because the rules interact and
 * the precedence lives in WHERE each predicate sits:
 *
 *  - The snooze filter is in `scoped`, ahead of every window function. That
 *    placement IS the rule "a snooze hides unconditionally and beats the
 *    visible floor" — a snoozed row cannot occupy a floor slot or be counted as
 *    age-hidden because it never enters the ranked set. Moving it later would
 *    leave the tests on snoozing green while quietly breaking the floor.
 *  - The age clock is `GREATEST(sourceDate, snoozedUntil)`. Without the second
 *    term a to-do snoozed for a month on an already-old meeting returns and is
 *    hidden by age in the same instant, which reads to its owner as a silent
 *    delete.
 *  - The floor is an OR against the age cutoff, not a post-filter top-up.
 *  - The tenant equality, the caller's visibility predicate and the two
 *    narrowing filters sit in `scoped`, which EVERY view is derived from. That
 *    is the structural half of "the access rules are identical in every view";
 *    the behavioural half is in `__tests__/todo-list-query.test.ts`.
 *  - Paging is a KEYSET on the view's own ordering tuple, and the cursor's
 *    position is read out of `scoped` — not out of the view being paged. Both
 *    halves are pinned below because the failure they replaced was silent: a
 *    rank looked up in the view returned NOTHING once the cursor row had left
 *    it, `COALESCE(..., 0)` read that as rank zero, and the statement served
 *    PAGE ONE under a cursor. The behavioural proof is in the same live suite.
 *
 * Run with:
 *   pnpm --filter @repo/database test list-todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	queryRaw: vi.fn(),
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: { $queryRaw: mocks.queryRaw } };
});

const { Prisma } = await import("../../../client");
const { listVisibleTodos } = await import("../list-todos");

const ORG = "org-acme";
const NOW = new Date("2026-09-18T12:00:00.000Z");
/** Thirty days before NOW — what the procedure's threshold resolves to. */
const AGE_CUTOFF = new Date("2026-08-19T12:00:00.000Z");

/** A stand-in for the real predicate, which this module never builds itself. */
const VISIBILITY = Prisma.sql`t."assigneeUserId" = ${"user-viewer"}`;

function baseParams(overrides: Record<string, unknown> = {}) {
	return {
		organizationId: ORG,
		visibilityCondition: VISIBILITY,
		// Stated rather than defaulted, exactly as the parameter type demands:
		// a caller that forgets which scope it meant is a caller that silently
		// gets the working list.
		view: "default" as const,
		limit: 20,
		now: NOW,
		ageThresholdDays: 30,
		recencyFloor: 10,
		recentCompletedLimit: 2,
		...overrides,
	};
}

function row(id: string, overrides: Record<string, unknown> = {}) {
	return {
		ageHiddenCount: 0,
		// The statement no longer ranks: what it carries beside the row is
		// whether the cursor could be placed at all.
		cursorResolved: true,
		id,
		source: "MEETING_DIGEST",
		transcriptId: "transcript-1",
		itemKey: "key-1",
		occurrenceIndex: 0,
		itemTextSnapshot: "Send the revised scope",
		title: null,
		projectId: "project-1",
		assigneeUserId: "user-viewer",
		assigneeContactId: null,
		suggestedUserId: null,
		suggestedContactId: null,
		suggestionCandidates: null,
		assignedManually: false,
		snoozedUntil: null,
		sourceDate: new Date("2026-09-10T09:00:00.000Z"),
		lastKnownCompletedAt: null,
		createdAt: new Date("2026-09-10T09:00:00.000Z"),
		updatedAt: new Date("2026-09-10T09:00:00.000Z"),
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

/** The statement as built, whitespace-flattened so re-indentation is harmless. */
function statement(): string {
	const arg = mocks.queryRaw.mock.calls[0]?.[0] as { sql: string };
	return arg.sql.replace(/\s+/g, " ").trim();
}

function parameters(): unknown[] {
	const arg = mocks.queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
	return arg.values;
}

beforeEach(() => {
	mocks.queryRaw.mockReset();
	mocks.queryRaw.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// The rules, as placements inside one statement
// ---------------------------------------------------------------------------

describe("the statement", () => {
	it("scopes every row to the organization — a raw query passes no tenant extension", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain('WHERE t."organizationId" =');
		// Three times: the action items being ranked, the transcript narrowing
		// that bounds them, and the to-dos themselves. The window function must
		// not rank another tenant's items into a partition.
		expect(parameters().filter((value) => value === ORG)).toHaveLength(3);
	});

	it("bounds the ranked action items to transcripts this organization has to-dos for", async () => {
		await listVisibleTodos(baseParams());

		// Whole transcripts, never individual items: a partial partition would
		// shift the occurrence numbers the binding resolves against.
		expect(statement()).toContain(
			'AND a."transcriptId" IN ( SELECT DISTINCT b."transcriptId" FROM "todo_item" b',
		);
	});

	it("drops snoozed rows before anything is ranked, so a snooze beats the floor", async () => {
		await listVisibleTodos(baseParams());

		const sql = statement();
		const snoozeAt = sql.indexOf('s."snoozedUntil" <=');
		const rankAt = sql.indexOf("ranked_completed AS");

		expect(snoozeAt).toBeGreaterThan(-1);
		expect(rankAt).toBeGreaterThan(-1);
		expect(snoozeAt).toBeLessThan(rankAt);
		// Exclusive: a snooze whose deadline has exactly arrived has elapsed.
		expect(sql).toContain(
			'WHERE s."snoozedUntil" IS NULL OR s."snoozedUntil" <=',
		);
	});

	it("runs the age clock from the later of the source date and an elapsed snooze", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain(
			'GREATEST(t."sourceDate", t."snoozedUntil") AS "ageClock"',
		);
	});

	it("keeps the ten most recent rows regardless of age, as an OR rather than a top-up", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain(
			'WHERE r."ageClock" >= ? OR r."recencyRank" <= ?',
		);
		expect(parameters()).toContainEqual(AGE_CUTOFF);
		expect(parameters()).toContain(10);
	});

	it("counts what age hid as the exact complement of what it kept", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain(
			'WHERE r."ageClock" < ? AND r."recencyRank" > ?',
		);
	});

	it("keeps only the two most recently completed rows by default", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain(
			'WHERE s."effectiveCompletedAt" IS NULL OR rc.rn <= ?',
		);
		expect(parameters()).toContain(2);
	});

	it("takes the completed archive uncapped and without the age cutoff", async () => {
		// The two-row window is the DEFAULT view's rule. Re-applying it, or the
		// age cutoff, to this view would make the history unreachable again —
		// which is the whole reason the view exists.
		await listVisibleTodos(baseParams({ view: "completed" }));

		const sql = statement();
		expect(sql).toContain(
			'FROM scoped s WHERE s."effectiveCompletedAt" IS NOT NULL )',
		);
		// Newest completion first — now as the page's own ORDER BY over the
		// column the view names `sortKey`, which is also the column its cursor
		// is compared against. One ordering, written once.
		expect(sql).toContain('s."effectiveCompletedAt" AS "sortKey"');
		expect(sql).toContain(
			'ORDER BY v."sortKey" DESC NULLS LAST, v.id DESC NULLS LAST',
		);
	});

	it("takes the snoozed view as the exact complement of the awake set, against the same clock", async () => {
		await listVisibleTodos(baseParams({ view: "snoozed" }));

		const sql = statement();
		// Asleep here, awake there — never both and never neither.
		expect(sql).toContain(
			'WHERE s."snoozedUntil" IS NOT NULL AND s."snoozedUntil" > ?',
		);
		expect(sql).toContain(
			'WHERE s."snoozedUntil" IS NULL OR s."snoozedUntil" <= ?',
		);
		// One clock for both halves: two would let a row be asleep and awake in
		// the same request.
		expect(parameters().filter((value) => value === NOW)).toHaveLength(2);
		// A finished item is not offered for waking.
		expect(sql).toContain('AND s."effectiveCompletedAt" IS NULL');
		// Soonest to wake first: the view answers "what comes back next". It is
		// the ONLY ascending view, so its cursor comparison has to be the
		// ascending one too — see the paging block below.
		expect(sql).toContain('s."snoozedUntil" AS "sortKey"');
		expect(sql).toContain(
			'ORDER BY v."sortKey" ASC NULLS LAST, v.id ASC NULLS LAST',
		);
	});

	it("takes the age-hidden view as the negation of both halves of the cutoff, not as everything old", async () => {
		await listVisibleTodos(baseParams({ view: "ageHidden" }));

		const sql = statement();
		// A row inside the recency floor is old and still kept, so the
		// complement has to negate the conjunction, not just the date.
		expect(sql).toContain(
			'FROM recency r WHERE r."ageClock" < ? AND r."recencyRank" > ?',
		);
		expect(sql).not.toContain('r."ageClock" >= ?');
		expect(parameters()).toContainEqual(AGE_CUTOFF);
	});

	it("measures the hidden count over the default view in every view", async () => {
		// Otherwise the same list reports two different numbers depending on
		// which scope the reader is standing in.
		for (const view of [
			"default",
			"completed",
			"snoozed",
			"ageHidden",
		] as const) {
			mocks.queryRaw.mockClear();
			await listVisibleTodos(baseParams({ view }));

			expect(statement()).toContain(
				'SELECT COUNT(*)::int AS "ageHiddenCount" FROM recency r WHERE r."ageClock" < ? AND r."recencyRank" > ?',
			);
		}
	});

	it("applies the caller's visibility predicate exactly once, in every view", async () => {
		// The structural half of "the access rules are identical in every
		// view": one `scoped` every view is derived from, so no view can widen
		// who may see a row and none can carry a second, drifting copy.
		for (const view of [
			"default",
			"completed",
			"snoozed",
			"ageHidden",
		] as const) {
			mocks.queryRaw.mockClear();
			await listVisibleTodos(baseParams({ view }));

			const sql = statement();
			expect(sql.split('t."assigneeUserId" = ?')).toHaveLength(2);
			expect(sql.split('WHERE t."organizationId" = ?')).toHaveLength(2);
			expect(parameters()).toContain("user-viewer");
		}
	});

	it("reads completion off the action item, falling back for an orphan", async () => {
		// Three cases, one expression. A manual row carries its own completion.
		// A BOUND meeting-sourced row carries none — the action item does, which
		// is what stops the digest and this list from disagreeing. An ORPHAN has
		// no live action item to hold it, so the row holds it; COALESCE is safe
		// for the bound case precisely because that invariant leaves the row's
		// own column null there.
		//
		// This is pinned structurally because the behavioural proof lives in
		// packages/database/__tests__/todo-list-query.test.ts, which executes it.
		await listVisibleTodos(baseParams());

		const sql = statement();

		expect(sql).toContain(
			'CASE WHEN t."transcriptId" IS NULL THEN t."completedAt" ELSE COALESCE(ai."completedAt", t."completedAt") END',
		);
	});

	it("names the meeting the way the digest names it, and carries the GRAPH id", async () => {
		await listVisibleTodos(baseParams());

		const sql = statement();
		// `meetingDigest.getMeeting` resolves the subject as
		// `linkedMeeting.subject ?? meetingSubject`; a different precedence here
		// would send a user to a meeting titled something they never saw.
		expect(sql).toContain(
			'COALESCE(lm."subject", tr."meetingSubject") AS "meetingTitle"',
		);
		// The graph id, which addresses the digest — not the row cuid the
		// binding uses, which addresses nothing outside the database.
		expect(sql).toContain('tr."transcriptId" AS "meetingTranscriptRef"');
		expect(sql).toContain('tr."meetingDate" AS "meetingDate"');
		expect(sql).toContain(
			'LEFT JOIN "project_meeting_transcript" tr ON tr."id" = t."transcriptId"',
		);
		expect(sql).toContain(
			'LEFT JOIN "project_linked_meeting" lm ON lm."id" = tr."linkedMeetingId"',
		);
	});

	it("marks a meeting-sourced row whose binding resolves to nothing as orphaned", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain(
			'(t."transcriptId" IS NOT NULL AND ai."itemKey" IS NULL) AS "isOrphaned"',
		);
	});

	it("composes the caller's visibility predicate instead of restating any rule", async () => {
		await listVisibleTodos(baseParams());

		expect(statement()).toContain('t."assigneeUserId" = ?');
		expect(parameters()).toContain("user-viewer");
	});

	it("combines the project and assignee filters", async () => {
		await listVisibleTodos(
			baseParams({
				projectId: "project-7",
				assigneeContactId: "contact-3",
			}),
		);

		const sql = statement();
		expect(sql).toContain('AND t."projectId" = ?');
		expect(sql).toContain('AND t."assigneeContactId" = ?');
		expect(parameters()).toContain("project-7");
		expect(parameters()).toContain("contact-3");
	});

	it("filters by a member when one is named", async () => {
		await listVisibleTodos(baseParams({ assigneeUserId: "user-dana" }));

		expect(statement()).toContain('AND t."assigneeUserId" = ?');
		expect(parameters()).toContain("user-dana");
	});

	it("over-fetches one row so hasMore needs no second query", async () => {
		await listVisibleTodos(baseParams({ limit: 20 }));

		expect(parameters().at(-1)).toBe(21);
	});
});

// ---------------------------------------------------------------------------
// Paging, per view
// ---------------------------------------------------------------------------

/**
 * The ordering each view pages on: the column as `scoped` holds it, and the
 * direction. Written out per view rather than derived, so a view that changes
 * its ORDER BY has to come here and say so.
 */
const PAGING_BY_VIEW = {
	default: { key: 's."ageClock"', direction: "DESC" },
	completed: { key: 's."effectiveCompletedAt"', direction: "DESC" },
	snoozed: { key: 's."snoozedUntil"', direction: "ASC" },
	ageHidden: { key: 's."ageClock"', direction: "DESC" },
} as const;

describe("paging", () => {
	it("asks for the whole view, ordered, when no cursor is given", async () => {
		await listVisibleTodos(baseParams());

		const sql = statement();
		// An explicit TRUE, not a floor of zero: "no cursor" and "a cursor
		// that resolved to nothing" must never collapse into one predicate
		// again, which is precisely what `rn > COALESCE(..., 0)` did.
		expect(sql).toContain("LEFT JOIN visible v ON TRUE");
		expect(sql).not.toContain("cursor_row c)");
	});

	for (const [view, { key, direction }] of Object.entries(PAGING_BY_VIEW)) {
		describe(`the ${view} view`, () => {
			it("resolves the cursor's position in `scoped`, not in the view it is paging", async () => {
				// THE DEFECT, pinned. The old statement read the cursor's rank
				// out of `visible` — the very set this page empties — so a row
				// resolved between two fetches resolved to nothing. `scoped` is
				// every row this caller may see BEFORE any view narrows it, so
				// a completed, snoozed or aged-out row still has a place in it.
				await listVisibleTodos(baseParams({ view, cursor: "todo-42" }));

				const sql = statement();
				expect(sql).toContain(
					`SELECT ${key} AS "sortKey", s.id FROM scoped s WHERE s.id = ?::text AND ${key} IS NOT NULL`,
				);
				expect(sql).not.toContain("FROM visible v WHERE v.id");
				expect(parameters()).toContain("todo-42");
			});

			it("pages by comparing the view's own ordering tuple, with id as the tie-break", async () => {
				await listVisibleTodos(baseParams({ view, cursor: "todo-42" }));

				const sql = statement();
				const operator = direction === "DESC" ? "<" : ">";
				// The tuple, not the date alone: two rows sharing a timestamp
				// would otherwise be served twice or skipped entirely.
				expect(sql).toContain(
					`ON (v."sortKey", v.id) ${operator} ((SELECT c."sortKey" FROM cursor_row c), (SELECT c.id FROM cursor_row c))`,
				);
				// ...and the page is ordered by the same tuple in the same
				// direction. A comparison that disagreed with the ORDER BY
				// would page through a sequence the reader never sees.
				expect(sql).toContain(
					`ORDER BY v."sortKey" ${direction} NULLS LAST, v.id ${direction} NULLS LAST`,
				);
			});

			it("never falls back to the top of the list", async () => {
				await listVisibleTodos(baseParams({ view, cursor: "todo-42" }));

				const sql = statement();
				// No rank to fall back FROM, and nothing that turns "not found"
				// into "start at the beginning".
				expect(sql).not.toContain("COALESCE((SELECT rn FROM");
				expect(sql).not.toContain("v.rn");
			});

			it("treats a cursor whose ordering column has gone null as unplaceable", async () => {
				// A completed row reopened has no completion to order the
				// archive by; an unsnoozed one has no wake date. Paging from a
				// NULL position is paging from nowhere, so the lookup excludes
				// it and the read reports the cursor as stale instead.
				await listVisibleTodos(baseParams({ view, cursor: "todo-42" }));

				expect(statement()).toContain(`AND ${key} IS NOT NULL`);
			});

			it("answers whether the cursor could be placed at all", async () => {
				await listVisibleTodos(baseParams({ view, cursor: "todo-42" }));

				// Carried on the hidden-count row, which exists even when the
				// page is empty — the case a stale cursor produces.
				expect(statement()).toContain(
					'(EXISTS (SELECT 1 FROM cursor_row)) AS "cursorResolved"',
				);
			});
		});
	}
});

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

describe("the result", () => {
	it("returns the page, not the over-fetched extra, and offers a cursor", async () => {
		mocks.queryRaw.mockResolvedValue([
			row("todo-1", { rn: 1 }),
			row("todo-2", { rn: 2 }),
			row("todo-3", { rn: 3 }),
		]);

		const result = await listVisibleTodos(baseParams({ limit: 2 }));

		expect(result.rows.map((r) => r.id)).toEqual(["todo-1", "todo-2"]);
		expect(result.hasMore).toBe(true);
		expect(result.nextCursor).toBe("todo-2");
	});

	it("offers no cursor on the last page", async () => {
		mocks.queryRaw.mockResolvedValue([row("todo-1"), row("todo-2")]);

		const result = await listVisibleTodos(baseParams({ limit: 2 }));

		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeNull();
	});

	it("carries the hidden count out even when age hid the entire page", async () => {
		// The join is driven from the count so that exactly this case still
		// reports it — an empty list plus "14 hidden" is the page's only way to
		// offer a way in.
		mocks.queryRaw.mockResolvedValue([
			{ ageHiddenCount: 14, cursorResolved: false, id: null },
		]);

		const result = await listVisibleTodos(baseParams());

		expect(result.rows).toEqual([]);
		expect(result.ageHiddenCount).toBe(14);
		expect(result.hasMore).toBe(false);
	});

	it("reports a zero hidden count when age hid nothing", async () => {
		mocks.queryRaw.mockResolvedValue([
			row("todo-1", { ageHiddenCount: 0 }),
		]);

		const result = await listVisibleTodos(baseParams());

		expect(result.ageHiddenCount).toBe(0);
	});

	it("strips the paging columns from the rows it returns", async () => {
		mocks.queryRaw.mockResolvedValue([row("todo-1")]);

		const result = await listVisibleTodos(baseParams());

		expect(result.rows[0]).not.toHaveProperty("cursorResolved");
		expect(result.rows[0]).not.toHaveProperty("ageHiddenCount");
		expect(result.rows[0]?.id).toBe("todo-1");
	});

	it("reports a cursor it could not place, instead of answering with the first page", async () => {
		// THE DEFECT, on the result side. The statement answers no rows for a
		// cursor it cannot place; what the caller must be able to tell is that
		// this is not the end of the list. Silence here is what let an
		// appending client render page one twice.
		mocks.queryRaw.mockResolvedValue([
			{ ageHiddenCount: 3, cursorResolved: false, id: null },
		]);

		const result = await listVisibleTodos(
			baseParams({ cursor: "todo-gone" }),
		);

		expect(result.cursorStale).toBe(true);
		expect(result.rows).toEqual([]);
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeNull();
		// The count still travels: the page the client falls back to needs it.
		expect(result.ageHiddenCount).toBe(3);
	});

	it("calls a placed cursor fresh", async () => {
		mocks.queryRaw.mockResolvedValue([row("todo-2"), row("todo-3")]);

		const result = await listVisibleTodos(
			baseParams({ cursor: "todo-1", limit: 2 }),
		);

		expect(result.cursorStale).toBe(false);
		expect(result.rows.map((r) => r.id)).toEqual(["todo-2", "todo-3"]);
	});

	it("never calls a first page stale", async () => {
		// No cursor was sent, so there is nothing that could have gone stale —
		// whatever the lookup says about a row nobody asked for.
		mocks.queryRaw.mockResolvedValue([
			row("todo-1", { cursorResolved: false }),
		]);

		const result = await listVisibleTodos(baseParams());

		expect(result.cursorStale).toBe(false);
	});
});

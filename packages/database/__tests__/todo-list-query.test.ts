/**
 * The To Do list statement, executed against a real PostgreSQL database
 * (Fizzy #2340).
 *
 * `listVisibleTodos` is one raw statement — the completion of a meeting-sourced
 * to-do lives on `ProjectMeetingActionItem` and the binding needs a window
 * function over same-key items, neither of which a Prisma relation can express.
 * That means the unit suite beside it can only pin *where each predicate sits*
 * in the statement; it cannot prove the statement parses, nor that the rules
 * compose the way the SQL says they do. These cases close exactly that gap, so
 * they are worth their setup cost and nothing else here should duplicate them.
 *
 * THE FOUR VIEWS ARE PROVEN HERE AND ONLY HERE. `view` selects between four
 * scopes of the same list, and "the predicate sits in `scoped`" is a statement
 * about text, not about rows: it cannot show that the snoozed view really
 * returns the sleeping rows, that the age-hidden view really returns the
 * complement `ageHiddenCount` counted, or — the one that matters most — that a
 * row the viewer may not see stays invisible in all four. Those are row-level
 * facts and every one of them is asserted below against a real database.
 *
 * Gated on RUN_DB_INTEGRATION exactly like the sibling publishing-*.test.ts
 * suites. Run with: pnpm --filter @repo/database test:todos
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	PLACEHOLDER_SUBJECT,
	resolveMeetingDisplayName,
} from "../prisma/queries/projects/meeting-display-name";
import { listVisibleTodos } from "../prisma/queries/todos/list-todos";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

const ORG_ID = "todo-query-test-org";
const USER_ID = "todo-query-test-user";
/** Someone the visibility predicate below does NOT admit. */
const OTHER_USER_ID = "todo-query-test-other-user";
const PROJECT_ID = "todo-query-test-project";
const LINKED_MEETING_ID = "todo-query-test-linked-meeting";
const TRANSCRIPT_ROW_ID = "todo-query-test-transcript-row";
/** The GRAPH transcript id — what a digest deep link is built from. */
const TRANSCRIPT_GRAPH_ID = "todo-query-test-graph-transcript";

const now = new Date("2026-09-18T12:00:00.000Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(now.getTime() + n * 86_400_000);

/** Everything the viewer owns, which is all these cases need. */
const visibility = Prisma.sql`(t."assigneeUserId" = ${USER_ID} OR t."assigneeUserId" IS NULL)`;

const baseParams = {
	organizationId: ORG_ID,
	visibilityCondition: visibility,
	view: "default" as const,
	now,
	ageThresholdDays: 30,
	recencyFloor: 10,
	recentCompletedLimit: 2,
	limit: 50,
};

/** The four scopes, so a case can sweep all of them and none be forgotten. */
const ALL_VIEWS = ["default", "completed", "snoozed", "ageHidden"] as const;

type TodoSeed = {
	title: string;
	sourceDate: Date;
	snoozedUntil?: Date;
	completedAt?: Date;
	/** Defaults to the viewer; anything else is invisible to this predicate. */
	assigneeUserId?: string;
};

async function seed(todos: TodoSeed[]) {
	await db.todoItem.deleteMany({ where: { organizationId: ORG_ID } });
	await db.todoItem.createMany({
		data: todos.map((t) => ({
			source: "MANUAL" as const,
			title: t.title,
			sourceDate: t.sourceDate,
			snoozedUntil: t.snoozedUntil ?? null,
			completedAt: t.completedAt ?? null,
			organizationId: ORG_ID,
			userId: USER_ID,
			assigneeUserId: t.assigneeUserId ?? USER_ID,
			projectId: PROJECT_ID,
		})),
	});
}

/** When the meeting happened, and the key its item is bound on. */
const MEETING_DATE = daysAgo(2);
const ITEM_KEY = "todo-query-test-item-key";

/**
 * One meeting-sourced to-do, with the linked meeting, the transcript and the
 * live action item behind it.
 *
 * Built here rather than stubbed because the meeting reference is a JOIN: the
 * subject's fallback, the graph id and the binding to the action item are all
 * things only a real row set can show.
 */
async function seedMeetingTodo(
	params: {
		linkedSubject?: string | null;
		// The occurrence's own subject. Overridable because the fallback to the
		// series name is only reachable when this one names nothing (#2340).
		occurrenceSubject?: string | null;
		snoozedUntil?: Date;
	} = {},
) {
	await db.todoItem.deleteMany({ where: { organizationId: ORG_ID } });
	await db.projectMeetingActionItem.deleteMany({
		where: { organizationId: ORG_ID },
	});
	await db.projectMeetingTranscript.deleteMany({
		where: { projectId: PROJECT_ID },
	});
	await db.projectLinkedMeeting.deleteMany({
		where: { projectId: PROJECT_ID },
	});

	await db.projectLinkedMeeting.create({
		data: {
			id: LINKED_MEETING_ID,
			projectId: PROJECT_ID,
			joinUrl: "https://example.com/meetings/weekly-sync",
			subject:
				params.linkedSubject === undefined
					? "Weekly sync"
					: params.linkedSubject,
			organizationId: ORG_ID,
			userId: USER_ID,
		},
	});
	await db.projectMeetingTranscript.create({
		data: {
			id: TRANSCRIPT_ROW_ID,
			projectId: PROJECT_ID,
			linkedMeetingId: LINKED_MEETING_ID,
			meetingId: "todo-query-test-graph-meeting",
			transcriptId: TRANSCRIPT_GRAPH_ID,
			meetingSubject:
				params.occurrenceSubject === undefined
					? "Weekly sync (transcript snapshot)"
					: params.occurrenceSubject,
			meetingDate: MEETING_DATE,
			organizationId: ORG_ID,
			userId: USER_ID,
		},
	});
	await db.projectMeetingActionItem.create({
		data: {
			transcriptId: TRANSCRIPT_ROW_ID,
			orderIndex: 0,
			text: "Send the revised scope",
			itemKey: ITEM_KEY,
			organizationId: ORG_ID,
			userId: USER_ID,
		},
	});
	await db.todoItem.create({
		data: {
			source: "MEETING_DIGEST",
			transcriptId: TRANSCRIPT_ROW_ID,
			itemKey: ITEM_KEY,
			occurrenceIndex: 0,
			itemTextSnapshot: "Send the revised scope",
			sourceDate: MEETING_DATE,
			snoozedUntil: params.snoozedUntil ?? null,
			organizationId: ORG_ID,
			userId: USER_ID,
			assigneeUserId: USER_ID,
			projectId: PROJECT_ID,
		},
	});
}

const titles = (rows: Array<{ title: string | null }>) =>
	rows.map((r) => r.title);

describe.skipIf(!RUN_DB)("listVisibleTodos against PostgreSQL", () => {
	beforeEach(async () => {
		await db.organization.upsert({
			where: { id: ORG_ID },
			update: {},
			create: {
				id: ORG_ID,
				name: "Example Org",
				slug: ORG_ID,
				createdAt: now,
			},
		});
		await db.user.upsert({
			where: { id: USER_ID },
			update: {},
			create: {
				id: USER_ID,
				name: "Example Member",
				email: "member@example.com",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		await db.user.upsert({
			where: { id: OTHER_USER_ID },
			update: {},
			create: {
				id: OTHER_USER_ID,
				name: "Example Colleague",
				email: "colleague@example.com",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		await db.project.upsert({
			where: { id: PROJECT_ID },
			update: {},
			create: {
				id: PROJECT_ID,
				name: "Example Project",
				organizationId: ORG_ID,
				userId: USER_ID,
			},
		});
	});

	afterAll(async () => {
		await db.todoItem.deleteMany({ where: { organizationId: ORG_ID } });
		await db.projectMeetingActionItem.deleteMany({
			where: { organizationId: ORG_ID },
		});
		await db.projectMeetingTranscript.deleteMany({
			where: { projectId: PROJECT_ID },
		});
		await db.projectLinkedMeeting.deleteMany({
			where: { projectId: PROJECT_ID },
		});
		await db.project.deleteMany({ where: { id: PROJECT_ID } });
		await db.organization.deleteMany({ where: { id: ORG_ID } });
		await db.user.deleteMany({
			where: { id: { in: [USER_ID, OTHER_USER_ID] } },
		});
		await db.$disconnect();
	});

	it("parses and returns rows", async () => {
		await seed([{ title: "open", sourceDate: daysAgo(1) }]);

		const page = await listVisibleTodos(baseParams);

		expect(titles(page.rows)).toEqual(["open"]);
	});

	it("hides a snoozed row even though it is among the most recent", async () => {
		// Snooze beats the recency floor: a snooze is a deliberate act, and a
		// floor that overrode it would make the control look broken.
		await seed([
			{ title: "open", sourceDate: daysAgo(1) },
			{
				title: "snoozed",
				sourceDate: daysAgo(1),
				snoozedUntil: daysAhead(7),
			},
		]);

		const page = await listVisibleTodos(baseParams);

		expect(titles(page.rows)).toEqual(["open"]);
	});

	it("keeps an old row visible once its snooze elapses", async () => {
		// The age clock runs from the later of sourceDate and an elapsed snooze.
		// Without that, snoozing an already-old item returns it straight into age
		// hiding, which reads to the user as a silent delete.
		await seed([
			{
				title: "old but just woke",
				sourceDate: daysAgo(90),
				snoozedUntil: daysAgo(1),
			},
			...Array.from({ length: 12 }, (_, i) => ({
				title: `filler ${i}`,
				sourceDate: daysAgo(2 + i),
			})),
		]);

		const page = await listVisibleTodos(baseParams);

		expect(titles(page.rows)).toContain("old but just woke");
	});

	it("keeps the recency floor visible and reports what age hid", async () => {
		await seed(
			Array.from({ length: 15 }, (_, i) => ({
				title: `old ${i}`,
				sourceDate: daysAgo(40 + i),
			})),
		);

		const page = await listVisibleTodos(baseParams);

		expect(page.rows).toHaveLength(10);
		expect(page.ageHiddenCount).toBe(5);
	});

	it("keeps only the most recently completed rows by default", async () => {
		await seed([
			{ title: "open", sourceDate: daysAgo(1) },
			{
				title: "done 1",
				sourceDate: daysAgo(2),
				completedAt: daysAgo(1),
			},
			{
				title: "done 2",
				sourceDate: daysAgo(3),
				completedAt: daysAgo(2),
			},
			{
				title: "done 3",
				sourceDate: daysAgo(4),
				completedAt: daysAgo(3),
			},
		]);

		const page = await listVisibleTodos(baseParams);
		expect(titles(page.rows)).toEqual(["open", "done 1", "done 2"]);

		// Capped, not lost: the third is where the archive keeps it.
		const all = await listVisibleTodos({
			...baseParams,
			view: "completed",
		});
		expect(titles(all.rows)).toContain("done 3");
	});

	it("pages with a cursor", async () => {
		await seed(
			Array.from({ length: 5 }, (_, i) => ({
				title: `row ${i}`,
				sourceDate: daysAgo(1 + i),
			})),
		);

		const first = await listVisibleTodos({ ...baseParams, limit: 2 });
		expect(first.rows).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBeTruthy();

		const second = await listVisibleTodos({
			...baseParams,
			limit: 2,
			cursor: first.nextCursor ?? undefined,
		});
		expect(titles(second.rows)).not.toEqual(titles(first.rows));
	});

	// -----------------------------------------------------------------------
	// The four views, proven by the rows they return
	// -----------------------------------------------------------------------

	describe("the snoozed view", () => {
		it("returns exactly the rows still asleep, carrying the wake date", async () => {
			await seed([
				{ title: "open", sourceDate: daysAgo(1) },
				{
					title: "asleep",
					sourceDate: daysAgo(1),
					snoozedUntil: daysAhead(7),
				},
				{
					title: "just woke",
					sourceDate: daysAgo(1),
					snoozedUntil: daysAgo(1),
				},
				// The boundary is exclusive: a snooze whose deadline has
				// exactly arrived has elapsed, in this view and in the default
				// one alike.
				{
					title: "on the dot",
					sourceDate: daysAgo(1),
					snoozedUntil: now,
				},
			]);

			const asleep = await listVisibleTodos({
				...baseParams,
				view: "snoozed",
			});

			expect(titles(asleep.rows)).toEqual(["asleep"]);
			// The page shows the wake date, so the read has to carry it.
			expect(asleep.rows[0]?.snoozedUntil).toEqual(daysAhead(7));

			// The complement, in the same request's terms: everything this view
			// left out is in the default one, and the sleeping row is not.
			const awake = await listVisibleTodos(baseParams);
			expect(titles(awake.rows).sort()).toEqual([
				"just woke",
				"on the dot",
				"open",
			]);
		});

		it("orders by wake date, soonest first", async () => {
			await seed([
				{
					title: "third",
					sourceDate: daysAgo(1),
					snoozedUntil: daysAhead(30),
				},
				{
					title: "first",
					sourceDate: daysAgo(1),
					snoozedUntil: daysAhead(1),
				},
				{
					title: "second",
					sourceDate: daysAgo(1),
					snoozedUntil: daysAhead(7),
				},
			]);

			const page = await listVisibleTodos({
				...baseParams,
				view: "snoozed",
			});

			// The question this view answers is "what comes back next".
			expect(titles(page.rows)).toEqual(["first", "second", "third"]);
		});

		it("leaves out a row that was completed while it slept", async () => {
			// Completion wins over snooze: waking work that no longer exists is
			// not something to offer.
			await seed([
				{
					title: "done while asleep",
					sourceDate: daysAgo(3),
					snoozedUntil: daysAhead(7),
					completedAt: daysAgo(1),
				},
			]);

			const asleep = await listVisibleTodos({
				...baseParams,
				view: "snoozed",
			});
			expect(asleep.rows).toEqual([]);

			// And it is reachable in the view that does own it.
			const done = await listVisibleTodos({
				...baseParams,
				view: "completed",
			});
			expect(titles(done.rows)).toEqual(["done while asleep"]);
		});
	});

	describe("the age-hidden view", () => {
		it("returns exactly the rows the default view's cutoff removed", async () => {
			await seed(
				Array.from({ length: 15 }, (_, i) => ({
					title: `old ${i}`,
					sourceDate: daysAgo(40 + i),
				})),
			);

			const kept = await listVisibleTodos(baseParams);
			const hidden = await listVisibleTodos({
				...baseParams,
				view: "ageHidden",
			});

			// The count is the promise; this view is the promise kept.
			expect(kept.ageHiddenCount).toBe(5);
			expect(hidden.rows).toHaveLength(kept.ageHiddenCount);
			// The complement of what the floor kept, not "everything old":
			// every one of these 15 rows predates the cutoff, and the ten the
			// floor rescued must not appear here.
			expect(titles(hidden.rows)).toEqual([
				"old 10",
				"old 11",
				"old 12",
				"old 13",
				"old 14",
			]);
			const keptIds = new Set(kept.rows.map((r) => r.id));
			expect(hidden.rows.some((r) => keptIds.has(r.id))).toBe(false);
			expect(keptIds.size + hidden.rows.length).toBe(15);
		});

		it("reports the same hidden count in every view", async () => {
			// Otherwise the same list tells the reader two different numbers
			// depending on which scope they happen to be standing in.
			await seed(
				Array.from({ length: 15 }, (_, i) => ({
					title: `old ${i}`,
					sourceDate: daysAgo(40 + i),
				})),
			);

			for (const view of ALL_VIEWS) {
				const page = await listVisibleTodos({ ...baseParams, view });
				expect(page.ageHiddenCount).toBe(5);
			}
		});
	});

	describe("the completed view", () => {
		it("returns every completed row, newest completion first, past the default cap", async () => {
			await seed([
				{ title: "open", sourceDate: daysAgo(1) },
				{
					title: "done 1",
					sourceDate: daysAgo(2),
					completedAt: daysAgo(1),
				},
				{
					title: "done 2",
					sourceDate: daysAgo(3),
					completedAt: daysAgo(2),
				},
				{
					title: "done 3",
					sourceDate: daysAgo(4),
					completedAt: daysAgo(3),
				},
			]);

			const page = await listVisibleTodos({
				...baseParams,
				view: "completed",
			});

			expect(titles(page.rows)).toEqual(["done 1", "done 2", "done 3"]);
		});

		it("keeps a completed row the age cutoff removed from the default view", async () => {
			// The archive answers "what did we finish", and an answer that
			// stops at thirty days is the unreachability this view exists to
			// end. Twelve recent rows push the old one past the recency floor.
			await seed([
				{
					title: "finished long ago",
					sourceDate: daysAgo(200),
					completedAt: daysAgo(199),
				},
				...Array.from({ length: 12 }, (_, i) => ({
					title: `recent ${i}`,
					sourceDate: daysAgo(1 + i),
				})),
			]);

			const kept = await listVisibleTodos(baseParams);
			expect(titles(kept.rows)).not.toContain("finished long ago");
			expect(kept.ageHiddenCount).toBeGreaterThan(0);

			const done = await listVisibleTodos({
				...baseParams,
				view: "completed",
			});
			expect(titles(done.rows)).toEqual(["finished long ago"]);
		});
	});

	describe("every view", () => {
		/** Enough rows that all four scopes are non-empty at once. */
		const mixed = [
			...Array.from({ length: 13 }, (_, i) => ({
				title: `old ${i}`,
				sourceDate: daysAgo(40 + i),
			})),
			...Array.from({ length: 3 }, (_, i) => ({
				title: `asleep ${i}`,
				sourceDate: daysAgo(1),
				snoozedUntil: daysAhead(1 + i),
			})),
			...Array.from({ length: 3 }, (_, i) => ({
				title: `done ${i}`,
				sourceDate: daysAgo(2 + i),
				completedAt: daysAgo(1 + i),
			})),
		];

		it("pages with the same cursor contract", async () => {
			await seed(mixed);

			for (const view of ALL_VIEWS) {
				const first = await listVisibleTodos({
					...baseParams,
					view,
					limit: 2,
				});
				expect(first.rows).toHaveLength(2);
				expect(first.hasMore).toBe(true);
				expect(first.nextCursor).toBe(first.rows[1]?.id);

				const second = await listVisibleTodos({
					...baseParams,
					view,
					limit: 2,
					cursor: first.nextCursor ?? undefined,
				});
				expect(second.rows.length).toBeGreaterThan(0);
				// A second page that repeated a row would mean the cursor read
				// a rank from an ordering the view does not use.
				const firstIds = new Set(first.rows.map((r) => r.id));
				expect(second.rows.some((r) => firstIds.has(r.id))).toBe(false);
			}
		});

		it("applies the same visibility predicate, so an unreachable row is unreachable in all four", async () => {
			// THE ONE THAT MATTERS. A view narrows which of the rows this
			// viewer may see are kept; it never widens who may see a row. Each
			// of the other user's rows below is planted in the exact scope that
			// would surface it if that view had built its own predicate.
			await seed([
				...Array.from({ length: 12 }, (_, i) => ({
					title: `mine old ${i}`,
					sourceDate: daysAgo(40 + i),
				})),
				{ title: "mine open", sourceDate: daysAgo(1) },
				{
					title: "theirs open",
					sourceDate: daysAgo(1),
					assigneeUserId: OTHER_USER_ID,
				},
				{
					title: "theirs asleep",
					sourceDate: daysAgo(1),
					snoozedUntil: daysAhead(7),
					assigneeUserId: OTHER_USER_ID,
				},
				{
					title: "theirs done",
					sourceDate: daysAgo(3),
					completedAt: daysAgo(2),
					assigneeUserId: OTHER_USER_ID,
				},
				{
					title: "theirs ancient",
					sourceDate: daysAgo(400),
					assigneeUserId: OTHER_USER_ID,
				},
			]);

			for (const view of ALL_VIEWS) {
				const page = await listVisibleTodos({ ...baseParams, view });
				expect(
					titles(page.rows).filter((t) => t?.startsWith("theirs")),
				).toEqual([]);
			}

			// ...and the sweep above is not vacuously green: each view really
			// does return this viewer's own rows in the same shapes.
			const hidden = await listVisibleTodos({
				...baseParams,
				view: "ageHidden",
			});
			expect(hidden.rows.length).toBeGreaterThan(0);
		});
	});

	// -----------------------------------------------------------------------
	// Paging a list that is being emptied underneath the reader
	// -----------------------------------------------------------------------

	/**
	 * A CURSOR WHOSE ROW LEAVES THE VIEW BETWEEN PAGES.
	 *
	 * This is the normal case for the only client that pages. The age-hidden
	 * box exists to bulk-resolve rows OUT of the set it is showing, and it
	 * APPENDS each page to the ones before it, so "the cursor row is gone" is
	 * not an edge case — it is what the feature does.
	 *
	 * The statement used to number the view with `ROW_NUMBER()` and look the
	 * cursor's rank up inside that same view. Once the cursor row had left,
	 * the lookup found nothing, `COALESCE(..., 0)` read that as rank zero, and
	 * the read answered with PAGE ONE — `hasMore` still true, the same
	 * `nextCursor` — which an appending client renders as duplicate rows,
	 * duplicate React keys, a select-all that counts a to-do twice and a "load
	 * more" that never ends. Only a database can show which rows come back,
	 * which is why the proof is here and not in the statement suite.
	 */
	describe("a cursor whose row has left the set", () => {
		/**
		 * Fifteen rows older than the cutoff: ten are rescued by the recency
		 * floor, and the five the floor does not reach are exactly what the
		 * `ageHidden` view hands out.
		 */
		const fifteenOld = () =>
			Array.from({ length: 15 }, (_, i) => ({
				title: `old ${i}`,
				sourceDate: daysAgo(40 + i),
			}));

		/** The first page of the hidden view, two rows at a time. */
		const firstHiddenPage = () =>
			listVisibleTodos({ ...baseParams, view: "ageHidden", limit: 2 });

		const nextHiddenPage = (cursor: string) =>
			listVisibleTodos({
				...baseParams,
				view: "ageHidden",
				limit: 2,
				cursor,
			});

		it("keeps paging from the right place after the cursor row is resolved out of the view", async () => {
			await seed(fifteenOld());

			const first = await firstHiddenPage();
			expect(titles(first.rows)).toEqual(["old 10", "old 11"]);
			const cursor = first.nextCursor;
			expect(cursor).toBe(first.rows[1]?.id);

			// What the box's own button does: complete the rows. Two other
			// completions land more recently, so the cursor row falls outside
			// the `recentCompletedLimit` window and drops out of the set the
			// hidden view is derived from — while remaining a row this viewer
			// may see, which is the position the next page is measured from.
			await db.todoItem.update({
				where: { id: cursor ?? "" },
				data: { completedAt: daysAgo(3) },
			});
			await db.todoItem.updateMany({
				where: { organizationId: ORG_ID, title: "old 0" },
				data: { completedAt: daysAgo(1) },
			});
			await db.todoItem.updateMany({
				where: { organizationId: ORG_ID, title: "old 1" },
				data: { completedAt: daysAgo(2) },
			});

			const second = await nextHiddenPage(cursor ?? "");

			// The page AFTER the cursor row's place in the ordering...
			expect(second.cursorStale).toBe(false);
			expect(titles(second.rows)).toEqual(["old 12", "old 13"]);
			// ...and not one row the reader has already been shown.
			const served = new Set(first.rows.map((r) => r.id));
			expect(second.rows.some((r) => served.has(r.id))).toBe(false);

			// The negative control, and the whole point: the view's own first
			// page is now something ELSE, so answering with it would have been
			// detectable — and it is exactly what the old statement did.
			const restarted = await firstHiddenPage();
			expect(titles(restarted.rows)).toEqual(["old 10", "old 12"]);
			expect(titles(second.rows)).not.toEqual(titles(restarted.rows));
		});

		it("reports a cursor whose row was deleted instead of handing back the first page", async () => {
			await seed(fifteenOld());

			const first = await firstHiddenPage();
			const cursor = first.nextCursor ?? "";
			await db.todoItem.delete({ where: { id: cursor } });

			const second = await nextHiddenPage(cursor);

			// No position left to page from, and the read says so rather than
			// pretending the top of the list is the next page.
			expect(second.cursorStale).toBe(true);
			expect(second.rows).toEqual([]);
			expect(second.hasMore).toBe(false);
			expect(second.nextCursor).toBeNull();
			// The count still travels, so the client that starts again has the
			// number the line it came from is about.
			expect(second.ageHiddenCount).toBe(4);

			// What the client would have appended before: the first page, under
			// a cursor, indistinguishable from a genuine second page.
			const restarted = await firstHiddenPage();
			expect(titles(restarted.rows)).toEqual(["old 10", "old 12"]);
		});

		it("reports a cursor naming a row this viewer may no longer see", async () => {
			// A cursor is not a capability. The position is resolved through
			// the same visibility predicate as the rows, so a to-do reassigned
			// away from this viewer stops being a place they can page from.
			await seed(fifteenOld());

			const first = await firstHiddenPage();
			const cursor = first.nextCursor ?? "";
			await db.todoItem.update({
				where: { id: cursor },
				data: { assigneeUserId: OTHER_USER_ID },
			});

			const second = await nextHiddenPage(cursor);

			expect(second.cursorStale).toBe(true);
			expect(second.rows).toEqual([]);
		});

		it("reports a completed-archive cursor that was reopened", async () => {
			// The archive orders by completion, so a row someone reopened has
			// no position in it at all. Paging from a null position is paging
			// from nowhere; the read says stale rather than starting over.
			await seed([
				{
					title: "done 1",
					sourceDate: daysAgo(4),
					completedAt: daysAgo(1),
				},
				{
					title: "done 2",
					sourceDate: daysAgo(5),
					completedAt: daysAgo(2),
				},
				{
					title: "done 3",
					sourceDate: daysAgo(6),
					completedAt: daysAgo(3),
				},
			]);

			const first = await listVisibleTodos({
				...baseParams,
				view: "completed",
				limit: 2,
			});
			expect(titles(first.rows)).toEqual(["done 1", "done 2"]);
			const cursor = first.nextCursor ?? "";

			await db.todoItem.update({
				where: { id: cursor },
				data: { completedAt: null },
			});

			const second = await listVisibleTodos({
				...baseParams,
				view: "completed",
				limit: 2,
				cursor,
			});

			expect(second.cursorStale).toBe(true);
			expect(second.rows).toEqual([]);
		});

		it("calls nothing stale when no cursor was given", async () => {
			await seed(fifteenOld());

			const first = await firstHiddenPage();

			expect(first.cursorStale).toBe(false);
			expect(first.hasMore).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// The meeting a row came from
	// -----------------------------------------------------------------------

	describe("the meeting reference", () => {
		it("names the meeting the way the digest names it and carries the graph id", async () => {
			await seedMeetingTodo();

			const page = await listVisibleTodos(baseParams);

			expect(page.rows).toHaveLength(1);
			expect(page.rows[0]).toMatchObject({
				// The GRAPH id — what a digest deep link is built from. The
				// row's own `transcriptId` is the cuid the binding uses and
				// addresses nothing outside the database.
				meetingTranscriptRef: TRANSCRIPT_GRAPH_ID,
				transcriptId: TRANSCRIPT_ROW_ID,
				// The occurrence's own subject wins, exactly as
				// `meetingDigest.getMeeting` resolves it. The linked meeting is
				// seeded as "Weekly sync" and loses, which is the whole point:
				// its subject is the series name and goes stale on rename.
				meetingTitle: "Weekly sync (transcript snapshot)",
				meetingDate: MEETING_DATE,
				itemKey: ITEM_KEY,
				// The join to the live action item still resolves beside it.
				isOrphaned: false,
				liveText: "Send the revised scope",
			});
		});

		it("falls back to the series name when the occurrence has none", async () => {
			await seedMeetingTodo({ occurrenceSubject: null });

			const page = await listVisibleTodos(baseParams);

			expect(page.rows[0]?.meetingTitle).toBe("Weekly sync");
		});

		it("treats a stored placeholder as no name and uses the series", async () => {
			// The write path can never store a bare series name — every Graph
			// path defaults a subjectless event to this literal — so a
			// null-keyed rule would let the placeholder beat a real name.
			await seedMeetingTodo({ occurrenceSubject: "Untitled Meeting" });

			const page = await listVisibleTodos(baseParams);

			expect(page.rows[0]?.meetingTitle).toBe("Weekly sync");
		});

		it("leaves the reference null on a manual row", async () => {
			await seed([{ title: "manual", sourceDate: daysAgo(1) }]);

			const page = await listVisibleTodos(baseParams);

			expect(page.rows[0]).toMatchObject({
				meetingTranscriptRef: null,
				meetingTitle: null,
				meetingDate: null,
			});
		});

		it("is carried by every view, not only the default one", async () => {
			// A snoozed or archived row has to say which meeting it came from
			// just as the working list does.
			await seedMeetingTodo({ snoozedUntil: daysAhead(7) });

			const page = await listVisibleTodos({
				...baseParams,
				view: "snoozed",
			});

			expect(page.rows[0]?.meetingTitle).toBe(
				"Weekly sync (transcript snapshot)",
			);
			expect(page.rows[0]?.meetingTranscriptRef).toBe(
				TRANSCRIPT_GRAPH_ID,
			);
		});
	});

	it("keeps an orphan's completion visible after a reload", async () => {
		// The write and the read have to agree about where an orphan's
		// completion lives. `setTodoCompletion` puts it on the row, because an
		// orphan has no live action item to hold it — and a read that only ever
		// looked at the action item would show the row open again on the next
		// page load, which is the silent half of a bug that tests asserting the
		// mutation alone cannot see.
		const linked = await db.projectLinkedMeeting.create({
			data: {
				projectId: PROJECT_ID,
				joinUrl: "https://example.com/meet/1",
			},
		});
		const transcript = await db.projectMeetingTranscript.create({
			data: {
				projectId: PROJECT_ID,
				linkedMeetingId: linked.id,
				meetingId: "meeting-1",
				transcriptId: "transcript-graph-1",
				organizationId: ORG_ID,
				userId: USER_ID,
			},
		});

		await db.todoItem.deleteMany({ where: { organizationId: ORG_ID } });
		await db.todoItem.create({
			data: {
				source: "MEETING_DIGEST",
				transcriptId: transcript.id,
				// A key no live action item carries: the binding is orphaned.
				itemKey: "todo:v1:no-such-item",
				occurrenceIndex: 0,
				itemTextSnapshot: "Send the coverage report",
				sourceDate: daysAgo(2),
				completedAt: daysAgo(1),
				organizationId: ORG_ID,
				userId: USER_ID,
				assigneeUserId: USER_ID,
				projectId: PROJECT_ID,
			},
		});

		const completed = await listVisibleTodos({
			...baseParams,
			view: "completed",
		});

		expect(completed.rows).toHaveLength(1);
		expect(completed.rows[0].isOrphaned).toBe(true);
		expect(completed.rows[0].effectiveCompletedAt).not.toBeNull();

		// The default view keeps the two most recently completed rows, so this one
		// belongs there too — but it must read as completed, not as open work
		// waiting to be done again.
		const open = await listVisibleTodos(baseParams);
		const sameRow = open.rows.find((r) => r.id === completed.rows[0].id);
		expect(sameRow?.effectiveCompletedAt).not.toBeNull();

		await db.todoItem.deleteMany({ where: { organizationId: ORG_ID } });
		await db.projectMeetingTranscript.deleteMany({
			where: { id: transcript.id },
		});
		await db.projectLinkedMeeting.deleteMany({ where: { id: linked.id } });
	});
});

/**
 * The mirror, proved rather than promised.
 *
 * `listVisibleTodos` cannot call `resolveMeetingDisplayName` — it is raw SQL —
 * so the rule exists twice and the two can drift. The string assertion in
 * `prisma/queries/todos/__tests__/list-todos.test.ts` pins the SQL's SHAPE, but
 * a commit that edits the SQL and its expected string together would satisfy it
 * while diverging from the resolver. This is the test that would not be
 * satisfied: it runs the same inputs through both and compares the answers.
 *
 * It earns its place. Review found a real divergence this way — one-argument
 * Postgres BTRIM strips U+0020 only, so a tab-padded subject was blank in
 * TypeScript and a name in SQL, and every test on each side individually passed.
 */
describe.skipIf(!RUN_DB)("the SQL mirror agrees with the resolver", () => {
	const NAMES = [
		"Fabric DSU",
		PLACEHOLDER_SUBJECT,
		"",
		"   ",
		"\tFabric DSU\t",
		"\t\t",
		"\n",
		`\u00A0${PLACEHOLDER_SUBJECT}\u00A0`,
		"\u200B",
		// Whitespace JS trim() strips that one-argument BTRIM does not:
		// ideographic space, line separator, narrow no-break space.
		"\u3000",
		"\u2028",
		`\u202F${PLACEHOLDER_SUBJECT}\u202F`,
		null,
	] as const;

	it("resolves every occurrence/series combination identically", async () => {
		const mismatches: string[] = [];

		for (const occurrence of NAMES) {
			for (const series of NAMES) {
				const inTs = resolveMeetingDisplayName({ occurrence, series });
				const [{ sql: inSql }] = await db.$queryRaw<
					{ sql: string | null }[]
				>`
					SELECT COALESCE(
						NULLIF(NULLIF(BTRIM(${occurrence}::text, E' \t\n\r\f\x0B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), ''), ${PLACEHOLDER_SUBJECT}),
						NULLIF(NULLIF(BTRIM(${series}::text, E' \t\n\r\f\x0B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), ''), ${PLACEHOLDER_SUBJECT}),
						NULLIF(BTRIM(${occurrence}::text, E' \t\n\r\f\x0B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), ''),
						NULLIF(BTRIM(${series}::text, E' \t\n\r\f\x0B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '')
					) AS "sql"
				`;

				if (inTs !== inSql) {
					mismatches.push(
						`occurrence=${JSON.stringify(occurrence)} series=${JSON.stringify(series)}: ts=${JSON.stringify(inTs)} sql=${JSON.stringify(inSql)}`,
					);
				}
			}
		}

		expect(mismatches).toEqual([]);
	});
});

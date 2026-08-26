/**
 * Real-Postgres integration tests for `listFeatureCoverage` (`../test-case-coverage`).
 *
 * The mocked sibling (`test-case-coverage.test.ts`) proves the SHAPE of the
 * queries — which `where` goes to Prisma, in what order, how many times. It
 * cannot prove the two things this file exists for, because both are facts about
 * what Postgres hands back over real rows:
 *
 *   - `UNCOVERED_FIRST` is not an ORDER BY. It reads the result set as two
 *     buckets — `testCaseLinks: { none }` then `{ some }` — and pages ACROSS
 *     them, carrying the leftover offset from one bucket into the next. The
 *     seam between the buckets is arithmetic, and arithmetic on a seam is where
 *     a row gets returned twice or skipped. Every paging assertion below aims at
 *     it: a page that starts inside the uncovered bucket and ends inside the
 *     covered one, and a page that starts past the uncovered bucket entirely.
 *   - a row's bucket can never disagree with its own `caseCount`, because both
 *     are derived from `coveringCaseFilter`. The fixture attacks that with the
 *     exact rows a `_count`-based ranking gets wrong: a story whose only link
 *     points at a SOFT-DELETED case, and a story whose only link points at a
 *     case in another project. `TestCaseWorkItemLink` rows outlive a soft delete
 *     (the cascade is hard-delete only), so both stories really do still carry a
 *     link row — and both must still read `caseCount: 0` / `UNCOVERED`.
 *
 * No mocks — hits the live Aspire Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder
 * (`hasReachableDatabaseUrl`), mirroring the sibling integration suites.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	type FeatureCoverageRow,
	listFeatureCoverage,
} from "../test-case-coverage";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-fcov-org-${RUN_ID}`;
const USER_ID = `test-fcov-user-${RUN_ID}`;

/** Forced timestamps are minute-offsets from here, so both orders are pinned. */
const EPOCH = new Date("2024-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(EPOCH.getTime() + minutes * 60_000);

// ---------------------------------------------------------------------------
// Paging fixture
// ---------------------------------------------------------------------------

interface PagingRow {
	identifier: string;
	/** Gets one live linked case — i.e. lands in the COVERED bucket. */
	covered: boolean;
	/** Forced `createdAt`, in minutes past EPOCH. Ranks the STABLE order. */
	created: number;
	/** Forced `lastEditedAt`, in minutes past EPOCH. Ranks WITHIN a bucket. */
	edited: number;
}

/**
 * Twelve features, seeded adversarially against both orders.
 *
 * `covered` alternates through the identifier sequence so the STABLE order
 * (createdAt asc) interleaves the two buckets — a STABLE page that came out
 * bucketed would be visibly wrong rather than accidentally right.
 *
 * `edited` repeats on purpose: {002,005,008} and {001,009} and {004,010} each
 * share a timestamp, so the `identifier asc` tiebreak is the only thing making
 * the rank total — and a total rank is the whole precondition for paging
 * across buckets safely.
 *
 * The two NEWEST edits in the project (001 and 009, edited 600) are COVERED.
 * Under a plain `lastEditedAt desc` they would lead the list; under the bucket
 * split they must sit at positions 8 and 9, behind every uncovered row.
 */
const PAGING_ROWS: PagingRow[] = [
	{ identifier: "001", covered: true, created: 10, edited: 600 },
	{ identifier: "002", covered: false, created: 20, edited: 500 },
	{ identifier: "003", covered: false, created: 30, edited: 300 },
	{ identifier: "004", covered: true, created: 40, edited: 200 },
	{ identifier: "005", covered: false, created: 30, edited: 500 },
	{ identifier: "006", covered: true, created: 60, edited: 0 },
	{ identifier: "007", covered: false, created: 70, edited: 100 },
	{ identifier: "008", covered: false, created: 80, edited: 500 },
	{ identifier: "009", covered: true, created: 90, edited: 600 },
	{ identifier: "010", covered: true, created: 100, edited: 200 },
	{ identifier: "011", covered: false, created: 110, edited: 400 },
	{ identifier: "012", covered: false, created: 120, edited: 200 },
];

/**
 * `lastEditedAt desc, createdAt desc, identifier asc` over the `none` bucket.
 *
 * `createdAt` is the SECOND key, not `identifier`: the ranking key used to be
 * `updatedAt`, which is never null, so ties were rare and `identifier` was
 * tiebreak enough. `lastEditedAt` is null for every unedited feature and the
 * order puts nulls last, so that whole group ties — ordering it by identifier
 * would sort a string where recency is meant. Hence {008,005,002} rather than
 * {002,005,008}: all three were edited at 500, so the newer row leads.
 */
const UNCOVERED_ORDER = ["008", "005", "002", "011", "003", "012", "007"];
/** Same ranking over the `some` bucket. */
const COVERED_ORDER = ["009", "001", "010", "004", "006"];
const UNCOVERED_FIRST_ORDER = [...UNCOVERED_ORDER, ...COVERED_ORDER];

/**
 * `createdAt asc, identifier asc`. 005 precedes 004 (created earlier despite
 * the higher identifier) and 003 precedes 005 (same createdAt, tiebroken), so
 * this is neither the identifier order nor the seed order.
 */
const STABLE_IDENTIFIER_ORDER = [
	"001",
	"002",
	"003",
	"005",
	"004",
	"006",
	"007",
	"008",
	"009",
	"010",
	"011",
	"012",
];

const UNCOVERED_SIZE = UNCOVERED_ORDER.length; // 7
const COVERED_SIZE = COVERED_ORDER.length; // 5
const PAGING_TOTAL = PAGING_ROWS.length; // 12

const identifiersOf = (rows: FeatureCoverageRow[]) =>
	rows.map((row) => row.identifier);

describe.skipIf(!hasReachableDatabaseUrl())(
	"listFeatureCoverage (real Postgres)",
	() => {
		/** The 12-feature bucket/paging fixture. Read-only. */
		const pagingProjectId = `test-fcov-proj-paging-${RUN_ID}`;
		/** Holds the rows a `_count` ranking would misplace. Read-only. */
		const trapProjectId = `test-fcov-proj-trap-${RUN_ID}`;
		/** Owns the case a trap story links to ACROSS a project boundary. */
		const foreignProjectId = `test-fcov-proj-foreign-${RUN_ID}`;
		/** search / kind / uncoveredOnly / excludeClosed / total. Read-only. */
		const filterProjectId = `test-fcov-proj-filter-${RUN_ID}`;

		/** `createMany` returns no ids, so they are resolved back by identifier. */
		const storyIds = new Map<string, string>();
		const caseIds = new Map<string, string>();

		function storyId(key: string): string {
			const id = storyIds.get(key);
			if (!id) {
				throw new Error(`fixture has no story "${key}"`);
			}
			return id;
		}

		function caseId(key: string): string {
			const id = caseIds.get(key);
			if (!id) {
				throw new Error(`fixture has no test case "${key}"`);
			}
			return id;
		}

		async function loadIds(projectId: string): Promise<void> {
			const stories = await db.userStory.findMany({
				where: { projectId },
				select: { id: true, identifier: true },
			});
			for (const story of stories) {
				storyIds.set(`${projectId}:${story.identifier}`, story.id);
			}
			const cases = await db.testCase.findMany({
				where: { projectId },
				select: { id: true, identifier: true },
			});
			for (const row of cases) {
				caseIds.set(`${projectId}:${row.identifier}`, row.id);
			}
		}

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Feature Coverage User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Feature Coverage Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);

			// Raw SQL, like the sibling scale suite: the fixture only needs
			// id/name/owner, and naming the columns keeps this independent of
			// unrelated churn elsewhere in the Project model.
			for (const [id, name] of [
				[pagingProjectId, "FCov Paging"],
				[trapProjectId, "FCov Trap"],
				[foreignProjectId, "FCov Foreign"],
				[filterProjectId, "FCov Filter"],
			]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "project" (id, name, "userId", "organizationId", "createdAt", "updatedAt")
					VALUES (${id}, ${name}, ${USER_ID}, ${ORG_ID}, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}

			const openStatusFor = async (projectId: string, name: string) =>
				db.projectStoryStatus.create({
					data: {
						projectId,
						name,
						color: "#94a3b8",
						order: 0,
						isDefault: true,
						isFinal: false,
					},
					select: { id: true },
				});

			const pagingStatus = await openStatusFor(
				pagingProjectId,
				"Backlog",
			);
			const trapStatus = await openStatusFor(trapProjectId, "Backlog");
			const filterOpenStatus = await openStatusFor(
				filterProjectId,
				"Backlog",
			);
			// `excludeClosed` hides by THIS flag, not by draftingStage.
			const filterFinalStatus = await db.projectStoryStatus.create({
				data: {
					projectId: filterProjectId,
					name: "Done",
					color: "#22c55e",
					order: 1,
					isFinal: true,
				},
				select: { id: true },
			});

			// --- Paging fixture ------------------------------------------------
			await db.userStory.createMany({
				data: PAGING_ROWS.map((row) => ({
					projectId: pagingProjectId,
					statusId: pagingStatus.id,
					createdById: USER_ID,
					identifier: row.identifier,
					title: `Paging feature ${row.identifier}`,
					kind: "FEATURE" as const,
				})),
			});
			await db.testCase.createMany({
				data: PAGING_ROWS.filter((row) => row.covered).map((row) => ({
					projectId: pagingProjectId,
					identifier: `TC-${row.identifier}`,
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					title: `Covers ${row.identifier}`,
				})),
			});
			await loadIds(pagingProjectId);
			await db.testCaseWorkItemLink.createMany({
				data: PAGING_ROWS.filter((row) => row.covered).map((row) => ({
					testCaseId: caseId(
						`${pagingProjectId}:TC-${row.identifier}`,
					),
					userStoryId: storyId(
						`${pagingProjectId}:${row.identifier}`,
					),
				})),
			});

			// --- Trap fixture --------------------------------------------------
			// 101 / 102 keep a surviving link row that must NOT cover them; 103 is
			// the live control; 104 carries the AC-ref + result-mix tally.
			await db.userStory.createMany({
				data: [
					["101", "Only link is a soft-deleted case"],
					["102", "Only link is a case in another project"],
					["103", "Genuinely covered"],
					["104", "Many links, few distinct AC refs"],
				].map(([identifier, title]) => ({
					projectId: trapProjectId,
					statusId: trapStatus.id,
					createdById: USER_ID,
					identifier,
					title,
					kind: "FEATURE" as const,
				})),
			});
			await db.testCase.createMany({
				data: [
					// PASSED on purpose: if a soft-deleted case ever leaked into the
					// tally it would show up as a non-zero resultCounts.PASSED, not
					// just a wrong total.
					{
						identifier: "TC-SD",
						title: "Soft-deleted coverer",
						currentResult: "PASSED" as const,
						deletedAt: now,
					},
					{
						identifier: "TC-LIVE",
						title: "Live coverer",
						currentResult: "PASSED" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A1",
						title: "AC ref dup A",
						currentResult: "NOT_RUN" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A2",
						title: "AC ref dup B",
						currentResult: "NOT_RUN" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A3",
						title: "AC ref two",
						currentResult: "NOT_RUN" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A4",
						title: "AC ref null",
						currentResult: "PASSED" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A5",
						title: "AC ref blank",
						currentResult: "FAILED" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A6",
						title: "AC ref padded duplicate",
						currentResult: "BLOCKED" as const,
						deletedAt: null,
					},
					{
						identifier: "TC-A7",
						title: "Soft-deleted AC ref",
						currentResult: "PASSED" as const,
						deletedAt: now,
					},
				].map((row) => ({
					...row,
					projectId: trapProjectId,
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
				})),
			});
			await db.testCase.create({
				data: {
					projectId: foreignProjectId,
					identifier: "TC-FOREIGN",
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					title: "Live case in another project",
				},
			});
			await loadIds(trapProjectId);
			await loadIds(foreignProjectId);
			await db.testCaseWorkItemLink.createMany({
				data: [
					{
						testCaseId: caseId(`${trapProjectId}:TC-SD`),
						userStoryId: storyId(`${trapProjectId}:101`),
						// Spelled out even though the column defaults to an empty
						// array. `createMany` builds ONE statement whose column
						// list is the union of every row, so a row that omits a
						// field another row sets is written as an explicit NULL —
						// and this column is NOT NULL, so the default never gets
						// the chance to apply.
						acceptanceCriterionRefs: [],
					},
					// Nothing in the schema stops a link crossing projects — the
					// query is what has to.
					{
						testCaseId: caseId(`${foreignProjectId}:TC-FOREIGN`),
						userStoryId: storyId(`${trapProjectId}:102`),
						acceptanceCriterionRefs: [],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-LIVE`),
						userStoryId: storyId(`${trapProjectId}:103`),
						acceptanceCriterionRefs: [],
					},
					// 104: six live links whose refs collapse to two distinct
					// values, plus a soft-deleted seventh carrying a ref nothing
					// else uses.
					{
						testCaseId: caseId(`${trapProjectId}:TC-A1`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: ["AC 1"],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-A2`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: ["AC 1"],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-A3`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: ["AC 2"],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-A4`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: [],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-A5`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: ["   "],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-A6`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: [" AC 2 "],
					},
					{
						testCaseId: caseId(`${trapProjectId}:TC-A7`),
						userStoryId: storyId(`${trapProjectId}:104`),
						acceptanceCriterionRefs: ["AC 99"],
					},
				],
			});

			// --- Filter fixture ------------------------------------------------
			// "12" and "F-012" coexist so a typed `F-12` can be shown to reach the
			// plain-decimal row via the normalized needle.
			await db.userStory.createMany({
				data: [
					{
						identifier: "1",
						title: "Login flow",
						kind: "FEATURE" as const,
						statusId: filterOpenStatus.id,
					},
					{
						identifier: "2",
						title: "Legacy checkout",
						kind: "FEATURE" as const,
						statusId: filterFinalStatus.id,
					},
					{
						identifier: "3",
						title: "Crash on save",
						kind: "BUG" as const,
						statusId: filterOpenStatus.id,
					},
					{
						identifier: "12",
						title: "Search results ranking",
						kind: "FEATURE" as const,
						statusId: filterOpenStatus.id,
					},
					{
						identifier: "F-012",
						title: "Legacy prefixed feature",
						kind: "FEATURE" as const,
						statusId: filterOpenStatus.id,
					},
				].map((row) => ({
					...row,
					projectId: filterProjectId,
					createdById: USER_ID,
				})),
			});
			await db.testCase.create({
				data: {
					projectId: filterProjectId,
					identifier: "TC-F3",
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					title: "Covers the bug",
				},
			});
			await loadIds(filterProjectId);
			await db.testCaseWorkItemLink.create({
				data: {
					testCaseId: caseId(`${filterProjectId}:TC-F3`),
					userStoryId: storyId(`${filterProjectId}:3`),
				},
			});

			// `createdAt` is `@default(now())`, so the timestamps can only be
			// the values the two orders sort on can only be pinned from raw SQL —
			// and only after every write to the row has landed.
			for (const row of PAGING_ROWS) {
				await db.$executeRaw(Prisma.sql`
					UPDATE "user_story"
					SET "createdAt" = ${at(row.created)}, "lastEditedAt" = ${at(row.edited)}
					WHERE "projectId" = ${pagingProjectId} AND "identifier" = ${row.identifier}
				`);
			}
		}, 60_000);

		afterAll(async () => {
			// Links cascade from test_case AND from user_story; statuses and
			// projects go explicitly, and only after the stories that point at
			// them (UserStory.statusId is a plain FK, no cascade).
			await db.testCase.deleteMany({ where: { createdById: USER_ID } });
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		// -------------------------------------------------------------------
		// 1. UNCOVERED_FIRST — the bucket split
		// -------------------------------------------------------------------

		it("ranks every uncovered feature ahead of every covered one, lastEditedAt desc then identifier asc within each", async () => {
			const page = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: PAGING_TOTAL,
			});

			expect(page.total).toBe(PAGING_TOTAL);
			expect(identifiersOf(page.items)).toEqual(UNCOVERED_FIRST_ORDER);
			expect(page.items.map((i) => i.coverageState)).toEqual([
				...Array(UNCOVERED_SIZE).fill("UNCOVERED"),
				...Array(COVERED_SIZE).fill("COVERED"),
			]);

			// The split dominates recency: 009 and 001 are the two most recently
			// edited rows in the project, and they are still behind all seven
			// uncovered rows. A plain `lastEditedAt desc` would have led with
			// them. 009 precedes 001 because they share an edit time and the
			// newer row wins the tie.
			expect(identifiersOf(page.items).indexOf("009")).toBe(
				UNCOVERED_SIZE,
			);
			expect(identifiersOf(page.items).indexOf("001")).toBe(
				UNCOVERED_SIZE + 1,
			);
		});

		it("never lets a row's bucket disagree with its own caseCount", async () => {
			const page = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: PAGING_TOTAL,
			});

			for (const row of page.items) {
				expect(row.coverageState).toBe(
					row.caseCount === 0 ? "UNCOVERED" : "COVERED",
				);
			}
			// Stated as the rank itself: the counts go 0…0 then ≥1…≥1, never a
			// zero after a non-zero.
			expect(page.items.map((i) => i.caseCount)).toEqual([
				...Array(UNCOVERED_SIZE).fill(0),
				...Array(COVERED_SIZE).fill(1),
			]);
		});

		it("straddles the bucket boundary: the page carries the uncovered tail and the covered head", async () => {
			// The crux. Buckets are 7 and 5; a limit-5 page at offset 5 starts at
			// uncovered row 6 (of 7) and must run 2 rows off the end of that bucket
			// and 3 rows into the next. An off-by-one in "skip into the next
			// bucket" shows up here as a repeated or missing row at position 3.
			expect(UNCOVERED_SIZE).toBe(7);
			expect(COVERED_SIZE).toBe(5);

			const page = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: 5,
				offset: 5,
			});

			// Derived from the two bucket orders rather than restated, so a
			// change to the ranking cannot leave this page expecting the old one.
			expect(identifiersOf(page.items)).toEqual([
				...UNCOVERED_ORDER.slice(5), // uncovered rows 6 and 7 — the tail
				...COVERED_ORDER.slice(0, 3), // covered rows 1..3 — the head
			]);
			expect(page.items.map((i) => i.coverageState)).toEqual([
				"UNCOVERED",
				"UNCOVERED",
				"COVERED",
				"COVERED",
				"COVERED",
			]);
			expect(page.total).toBe(PAGING_TOTAL);
		});

		it("reads only the covered bucket when the offset lands past the uncovered one", async () => {
			// offset === the uncovered bucket's exact size: it is counted, not
			// read, and the covered bucket is entered at skip 0.
			const flush = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: 5,
				offset: UNCOVERED_SIZE,
			});
			expect(identifiersOf(flush.items)).toEqual(COVERED_ORDER);
			expect(
				flush.items.every((i) => i.coverageState === "COVERED"),
			).toBe(true);

			// One past it: the leftover offset has to survive the skipped bucket.
			const inside = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: 3,
				offset: UNCOVERED_SIZE + 1,
			});
			// Derived, not restated: offset skips the whole uncovered bucket plus
			// the covered head, so this is the covered bucket from index 1.
			expect(identifiersOf(inside.items)).toEqual(
				COVERED_ORDER.slice(1, 4),
			);

			// The tail, where the page runs out mid-bucket.
			const tail = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: 5,
				offset: 10,
			});
			// offset 10 is three rows into the covered bucket, so this is its
			// last two — derived so the ranking stays the single source of truth.
			expect(identifiersOf(tail.items)).toEqual(COVERED_ORDER.slice(3));
			expect(tail.total).toBe(PAGING_TOTAL);
		});

		it("returns nothing past the end without miscounting the total", async () => {
			const page = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "UNCOVERED_FIRST",
				limit: 5,
				offset: PAGING_TOTAL,
			});
			expect(page.items).toEqual([]);
			expect(page.total).toBe(PAGING_TOTAL);
		});

		// Every limit that puts a page boundary somewhere interesting: inside the
		// uncovered bucket (1,2,3,5), exactly ON the seam (7), inside the covered
		// bucket (11), exactly the whole set (12), and past it (13). Paging the
		// full set at each and demanding the exact concatenated rank is the single
		// assertion that catches a boundary off-by-one anywhere in the arithmetic:
		// a duplicated row lengthens the list, a dropped one shortens it, and a
		// misplaced one breaks the sequence.
		it.each([1, 2, 3, 5, 7, 11, 12, 13])(
			"pages the whole set at limit %i with no duplicates and no omissions",
			async (limit) => {
				const seen: string[] = [];
				for (let offset = 0; offset < PAGING_TOTAL; offset += limit) {
					const page = await listFeatureCoverage({
						projectId: pagingProjectId,
						order: "UNCOVERED_FIRST",
						limit,
						offset,
					});
					expect(page.total).toBe(PAGING_TOTAL);
					expect(page.items.length).toBeLessThanOrEqual(limit);
					seen.push(...identifiersOf(page.items));
				}
				expect(seen).toHaveLength(PAGING_TOTAL);
				expect(new Set(seen).size).toBe(PAGING_TOTAL);
				expect(seen).toEqual(UNCOVERED_FIRST_ORDER);
			},
		);

		// -------------------------------------------------------------------
		// 2. STABLE — the default, and it must NOT bucket
		// -------------------------------------------------------------------

		it("defaults to STABLE: createdAt asc, identifier asc, buckets interleaved", async () => {
			const page = await listFeatureCoverage({
				projectId: pagingProjectId,
				limit: PAGING_TOTAL,
			});

			expect(page.total).toBe(PAGING_TOTAL);
			expect(identifiersOf(page.items)).toEqual(STABLE_IDENTIFIER_ORDER);
			// A bucketed page could not open with a COVERED row.
			expect(page.items[0].coverageState).toBe("COVERED");
			expect(page.items[0].identifier).toBe("001");
			// And the two states interleave rather than partition.
			expect(page.items.map((i) => i.coverageState)).toEqual([
				"COVERED",
				"UNCOVERED",
				"UNCOVERED",
				"UNCOVERED",
				"COVERED",
				"COVERED",
				"UNCOVERED",
				"UNCOVERED",
				"COVERED",
				"COVERED",
				"UNCOVERED",
				"UNCOVERED",
			]);
		});

		it("passing STABLE explicitly is the same order as omitting it", async () => {
			const explicit = await listFeatureCoverage({
				projectId: pagingProjectId,
				order: "STABLE",
				limit: PAGING_TOTAL,
			});
			expect(identifiersOf(explicit.items)).toEqual(
				STABLE_IDENTIFIER_ORDER,
			);
		});

		it.each([1, 5, 7, 12])(
			"pages the whole set under STABLE at limit %i with no duplicates and no omissions",
			async (limit) => {
				const seen: string[] = [];
				for (let offset = 0; offset < PAGING_TOTAL; offset += limit) {
					const page = await listFeatureCoverage({
						projectId: pagingProjectId,
						order: "STABLE",
						limit,
						offset,
					});
					expect(page.total).toBe(PAGING_TOTAL);
					seen.push(...identifiersOf(page.items));
				}
				expect(seen).toEqual(STABLE_IDENTIFIER_ORDER);
			},
		);

		// -------------------------------------------------------------------
		// 3. The rows a `_count` ranking gets wrong
		// -------------------------------------------------------------------

		it("reports a story whose only link is a SOFT-DELETED case as uncovered", async () => {
			// The reason the implementation cannot use
			// `orderBy: { testCaseLinks: { _count: "asc" } }`: Prisma's relation
			// `_count` takes no filter, and a link row SURVIVES the soft delete of
			// its case (the cascade is hard-delete only). So story 101 really does
			// have a link row — a `_count` ranking would call it covered while its
			// own caseCount said 0.
			const link = await db.testCaseWorkItemLink.findMany({
				where: { userStoryId: storyId(`${trapProjectId}:101`) },
				select: { testCase: { select: { deletedAt: true } } },
			});
			expect(link).toHaveLength(1);
			expect(link[0].testCase.deletedAt).not.toBeNull();

			const page = await listFeatureCoverage({
				projectId: trapProjectId,
			});
			const row = page.items.find((i) => i.identifier === "101");
			expect(row).toBeDefined();
			expect(row?.caseCount).toBe(0);
			expect(row?.coverageState).toBe("UNCOVERED");
			// The soft-deleted case is PASSED — an all-zero mix proves it never
			// reached the tally.
			expect(row?.resultCounts).toEqual({
				NOT_RUN: 0,
				PASSED: 0,
				FAILED: 0,
				BLOCKED: 0,
				SKIPPED: 0,
			});

			// And the bucket agrees with the number: it sorts UNCOVERED-first.
			const ranked = await listFeatureCoverage({
				projectId: trapProjectId,
				order: "UNCOVERED_FIRST",
			});
			expect(ranked.items.map((i) => i.coverageState)).toEqual([
				"UNCOVERED",
				"UNCOVERED",
				"COVERED",
				"COVERED",
			]);
			// Ranked within a bucket by updatedAt, which these rows share — assert
			// membership, not the tiebroken order.
			expect(new Set(identifiersOf(ranked.items).slice(0, 2))).toEqual(
				new Set(["101", "102"]),
			);
			// It is also matched by the uncoveredOnly filter — same predicate.
			const uncovered = await listFeatureCoverage({
				projectId: trapProjectId,
				uncoveredOnly: true,
			});
			expect(identifiersOf(uncovered.items)).toContain("101");
		});

		it("does not count a linked case that lives in another project", async () => {
			// The predicate is project-scoped on BOTH sides of the join, so a link
			// that crossed projects cannot drag a foreign case's result in.
			const link = await db.testCaseWorkItemLink.findMany({
				where: { userStoryId: storyId(`${trapProjectId}:102`) },
				select: { testCase: { select: { projectId: true } } },
			});
			expect(link).toHaveLength(1);
			expect(link[0].testCase.projectId).toBe(foreignProjectId);

			const page = await listFeatureCoverage({
				projectId: trapProjectId,
			});
			const row = page.items.find((i) => i.identifier === "102");
			expect(row?.caseCount).toBe(0);
			expect(row?.coverageState).toBe("UNCOVERED");

			const uncovered = await listFeatureCoverage({
				projectId: trapProjectId,
				uncoveredOnly: true,
			});
			expect(identifiersOf(uncovered.items)).toEqual(
				expect.arrayContaining(["101", "102"]),
			);
			expect(uncovered.total).toBe(2);
		});

		it("counts one live in-project link as covered (the control)", async () => {
			const page = await listFeatureCoverage({
				projectId: trapProjectId,
			});
			const row = page.items.find((i) => i.identifier === "103");
			expect(row?.caseCount).toBe(1);
			expect(row?.coverageState).toBe("COVERED");
			expect(row?.resultCounts).toEqual({
				NOT_RUN: 0,
				PASSED: 1,
				FAILED: 0,
				BLOCKED: 0,
				SKIPPED: 0,
			});
		});

		it("counts DISTINCT non-blank AC refs, and caseCount stays the sum of the result mix", async () => {
			const page = await listFeatureCoverage({
				projectId: trapProjectId,
			});
			const row = page.items.find((i) => i.identifier === "104");
			expect(row).toBeDefined();

			// Seven link rows exist; the soft-deleted one is not one of the six.
			const links = await db.testCaseWorkItemLink.count({
				where: { userStoryId: storyId(`${trapProjectId}:104`) },
			});
			expect(links).toBe(7);
			expect(row?.caseCount).toBe(6);

			// "AC 1" twice, "AC 2" once, " AC 2 " once (trims onto "AC 2"), one
			// null, one whitespace-only, and "AC 99" on the soft-deleted link.
			expect(row?.distinctAcRefs).toBe(2);

			expect(row?.resultCounts).toEqual({
				NOT_RUN: 3,
				PASSED: 1,
				FAILED: 1,
				BLOCKED: 1,
				SKIPPED: 0,
			});
			// caseCount IS the sum — the pass-rate denominator depends on it.
			const mix = row?.resultCounts;
			expect(
				(mix?.NOT_RUN ?? 0) +
					(mix?.PASSED ?? 0) +
					(mix?.FAILED ?? 0) +
					(mix?.BLOCKED ?? 0),
			).toBe(row?.caseCount);
		});

		// -------------------------------------------------------------------
		// 4. Filters
		// -------------------------------------------------------------------

		it("includes closed features by default and drops them under excludeClosed", async () => {
			const all = await listFeatureCoverage({
				projectId: filterProjectId,
			});
			expect(all.total).toBe(5);
			expect(new Set(identifiersOf(all.items))).toEqual(
				new Set(["1", "2", "3", "12", "F-012"]),
			);
			// "2" sits in the isFinal status, and the row says so.
			expect(all.items.find((i) => i.identifier === "2")?.closed).toBe(
				true,
			);
			expect(all.items.find((i) => i.identifier === "1")?.closed).toBe(
				false,
			);

			const open = await listFeatureCoverage({
				projectId: filterProjectId,
				excludeClosed: true,
			});
			expect(open.total).toBe(4);
			expect(identifiersOf(open.items)).not.toContain("2");
			expect(open.items.every((i) => i.closed === false)).toBe(true);
		});

		it("narrows to a single kind", async () => {
			const bugs = await listFeatureCoverage({
				projectId: filterProjectId,
				kind: "BUG",
			});
			expect(bugs.total).toBe(1);
			expect(identifiersOf(bugs.items)).toEqual(["3"]);
			expect(bugs.items[0].kind).toBe("BUG");

			const features = await listFeatureCoverage({
				projectId: filterProjectId,
				kind: "FEATURE",
			});
			expect(features.total).toBe(4);
			expect(features.items.every((i) => i.kind === "FEATURE")).toBe(
				true,
			);

			// The only BUG is covered, so the two filters compose to the empty set.
			const uncoveredBugs = await listFeatureCoverage({
				projectId: filterProjectId,
				kind: "BUG",
				uncoveredOnly: true,
			});
			expect(uncoveredBugs.items).toEqual([]);
			expect(uncoveredBugs.total).toBe(0);
		});

		it("uncoveredOnly keeps exactly the zero-count features, and composes with excludeClosed", async () => {
			const uncovered = await listFeatureCoverage({
				projectId: filterProjectId,
				uncoveredOnly: true,
			});
			expect(uncovered.total).toBe(4);
			expect(new Set(identifiersOf(uncovered.items))).toEqual(
				new Set(["1", "2", "12", "F-012"]),
			);
			expect(uncovered.items.every((i) => i.caseCount === 0)).toBe(true);

			const openUncovered = await listFeatureCoverage({
				projectId: filterProjectId,
				uncoveredOnly: true,
				excludeClosed: true,
			});
			expect(openUncovered.total).toBe(3);
			expect(new Set(identifiersOf(openUncovered.items))).toEqual(
				new Set(["1", "12", "F-012"]),
			);
		});

		it("pages the uncoveredOnly set under UNCOVERED_FIRST without re-reading the covered bucket", async () => {
			// `uncoveredOnly` collapses the rank to ONE bucket — there is nothing
			// to fall through to, so a page past the end must stay empty rather
			// than spilling covered rows the caller filtered out.
			const seen: string[] = [];
			for (let offset = 0; offset < 4; offset += 2) {
				const page = await listFeatureCoverage({
					projectId: filterProjectId,
					order: "UNCOVERED_FIRST",
					uncoveredOnly: true,
					limit: 2,
					offset,
				});
				expect(page.total).toBe(4);
				seen.push(...identifiersOf(page.items));
			}
			// Order inside the single bucket is tiebroken by identifier; what
			// matters is that paging saw all four exactly once.
			expect(seen).toHaveLength(4);
			expect(new Set(seen)).toEqual(new Set(["1", "2", "12", "F-012"]));

			const past = await listFeatureCoverage({
				projectId: filterProjectId,
				order: "UNCOVERED_FIRST",
				uncoveredOnly: true,
				limit: 2,
				offset: 4,
			});
			expect(past.items).toEqual([]);
			expect(identifiersOf(past.items)).not.toContain("3");
		});

		// -------------------------------------------------------------------
		// 5. Search
		// -------------------------------------------------------------------

		it("matches a legacy-prefixed needle against BOTH the legacy and plain-decimal identifier", async () => {
			// A user types `F-12`. The normalized needle (`12`) is what reaches the
			// plain-decimal row; without it, typing the prefix a user has seen for
			// years would silently find nothing.
			const typed = await listFeatureCoverage({
				projectId: filterProjectId,
				search: "F-12",
			});
			expect(new Set(identifiersOf(typed.items))).toEqual(
				new Set(["12", "F-012"]),
			);
			expect(typed.total).toBe(2);

			// And the raw needle still reaches a genuinely legacy identifier.
			const legacy = await listFeatureCoverage({
				projectId: filterProjectId,
				search: "F-012",
			});
			expect(identifiersOf(legacy.items)).toEqual(["F-012"]);
			expect(legacy.total).toBe(1);
		});

		it("matches on title, case-insensitively", async () => {
			for (const search of ["ranking", "RANKING", "Search results"]) {
				const page = await listFeatureCoverage({
					projectId: filterProjectId,
					search,
				});
				expect(identifiersOf(page.items)).toEqual(["12"]);
				expect(page.total).toBe(1);
			}
		});

		it("returns an empty page and a zero total for a needle that matches nothing", async () => {
			const page = await listFeatureCoverage({
				projectId: filterProjectId,
				search: "no-such-feature-anywhere",
			});
			expect(page.items).toEqual([]);
			expect(page.total).toBe(0);
		});

		// -------------------------------------------------------------------
		// 6. total is the RESULT SET's size, not the page's
		// -------------------------------------------------------------------

		it("counts the total under the same predicate it lists under", async () => {
			// A page smaller than the result set must not shrink the total…
			const clipped = await listFeatureCoverage({
				projectId: filterProjectId,
				limit: 1,
			});
			expect(clipped.items).toHaveLength(1);
			expect(clipped.total).toBe(5);

			// …and every filter must move the total exactly as it moves the items.
			const cases: Array<{
				options: Parameters<typeof listFeatureCoverage>[0];
				expected: number;
			}> = [
				{ options: { projectId: filterProjectId }, expected: 5 },
				{
					options: {
						projectId: filterProjectId,
						excludeClosed: true,
					},
					expected: 4,
				},
				{
					options: { projectId: filterProjectId, kind: "BUG" },
					expected: 1,
				},
				{
					options: {
						projectId: filterProjectId,
						uncoveredOnly: true,
					},
					expected: 4,
				},
				{
					options: {
						projectId: filterProjectId,
						uncoveredOnly: true,
						excludeClosed: true,
					},
					expected: 3,
				},
				{
					options: { projectId: filterProjectId, search: "F-12" },
					expected: 2,
				},
			];
			for (const { options, expected } of cases) {
				const unpaged = await listFeatureCoverage(options);
				expect(unpaged.total).toBe(expected);
				expect(unpaged.items).toHaveLength(expected);
				// The total holds when the caller only asks for one row of it, and
				// holds identically under the bucket-paged rank.
				const paged = await listFeatureCoverage({
					...options,
					order: "UNCOVERED_FIRST",
					limit: 1,
				});
				expect(paged.total).toBe(expected);
			}
		});

		it("scopes every row to the project it was asked for", async () => {
			const page = await listFeatureCoverage({
				projectId: pagingProjectId,
				limit: PAGING_TOTAL,
			});
			const ids = new Set(page.items.map((i) => i.storyId));
			const foreign = await db.userStory.count({
				where: {
					id: { in: [...ids] },
					projectId: { not: pagingProjectId },
				},
			});
			expect(foreign).toBe(0);
			expect(ids.size).toBe(PAGING_TOTAL);
		});
	},
);

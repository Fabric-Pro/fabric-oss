/**
 * Unit tests for the batched per-feature coverage query (`../test-case-coverage`).
 *
 * Mocks the Prisma client (`../../../client`) — no real DB, mirroring the
 * `test-cases.test.ts` convention. Asserts the pure decision logic this helper
 * owns:
 *   - the WHERE construction (kind / uncoveredOnly / excludeClosed / merged-away
 *     exclusion, and the identifier-prefix-normalizing search);
 *   - the per-story tally: zero-fill, result bucketing, distinct AC refs,
 *     coverageState;
 *   - the ordering: the default stable page, and the uncovered-first rank the
 *     picker asks for — including that it holds across pagination rather than
 *     reordering the page in hand;
 *   - that it stays BATCHED — a fixed query count no matter how many features
 *     are on the page (the whole point of the helper).
 *
 * Behavior against real rows (RLS, real joins) belongs in an integration test.
 *
 * Run with: pnpm --filter @repo/database test prisma/queries/projects/__tests__/test-case-coverage.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
	const make = () => ({
		findMany: vi.fn(),
		count: vi.fn(),
	});
	return {
		dbMock: {
			userStory: make(),
			testCaseWorkItemLink: make(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import { listFeatureCoverage } from "../test-case-coverage";

type StoryRow = {
	id: string;
	identifier: string;
	title: string;
	kind: "FEATURE" | "BUG";
	draftingStage: string;
	maturationStatus: string | null;
	status: { isFinal: boolean };
};

function story(id: string, overrides: Partial<StoryRow> = {}): StoryRow {
	return {
		id,
		identifier: id.toUpperCase(),
		title: `Title ${id}`,
		kind: "FEATURE",
		draftingStage: "DRAFT",
		maturationStatus: null,
		status: { isFinal: false },
		...overrides,
	};
}

function link(
	userStoryId: string,
	currentResult: string,
	...acceptanceCriterionRefs: string[]
) {
	return {
		userStoryId,
		acceptanceCriterionRefs,
		testCase: { currentResult },
	};
}

/** Wire the three reads the helper makes under the default order. */
function mockReads(
	stories: StoryRow[],
	links: unknown[],
	total = stories.length,
) {
	dbMock.userStory.findMany.mockResolvedValue(stories);
	dbMock.userStory.count.mockResolvedValue(total);
	dbMock.testCaseWorkItemLink.findMany.mockResolvedValue(links);
}

/** Which side of the coverage split a read is asking for. */
function bucketOf(args: {
	where: { testCaseLinks?: { none?: unknown; some?: unknown } };
}): "UNCOVERED" | "COVERED" | "ALL" {
	const links = args.where.testCaseLinks;
	if (links?.none) {
		return "UNCOVERED";
	}
	return links?.some ? "COVERED" : "ALL";
}

/**
 * Wire the per-bucket reads the UNCOVERED_FIRST rank makes.
 *
 * Answers by PREDICATE rather than call order: which buckets get read, and
 * whether a bucket is counted or read, depends on the offset — so a
 * fixed-sequence mock would quietly answer the wrong bucket. `sizes` overrides
 * what a bucket reports its total as, for offsets that page past one.
 */
function mockBucketedReads(
	uncovered: StoryRow[],
	covered: StoryRow[],
	sizes: { uncovered?: number; covered?: number } = {},
) {
	const uncoveredSize = sizes.uncovered ?? uncovered.length;
	const coveredSize = sizes.covered ?? covered.length;
	dbMock.userStory.findMany.mockImplementation((args) =>
		Promise.resolve(bucketOf(args) === "COVERED" ? covered : uncovered),
	);
	dbMock.userStory.count.mockImplementation((args) => {
		const bucket = bucketOf(args);
		if (bucket === "ALL") {
			return Promise.resolve(uncoveredSize + coveredSize);
		}
		return Promise.resolve(
			bucket === "UNCOVERED" ? uncoveredSize : coveredSize,
		);
	});
	dbMock.testCaseWorkItemLink.findMany.mockResolvedValue([]);
}

const pageCall = (i = 0) => dbMock.userStory.findMany.mock.calls[i][0];
const storyWhere = () => pageCall().where;
const linkWhere = () =>
	dbMock.testCaseWorkItemLink.findMany.mock.calls[0][0].where;
const coveringCase = { projectId: "p1", deletedAt: null };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listFeatureCoverage — WHERE construction", () => {
	it("scopes to the project and excludes merged-away duplicates", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1" });

		expect(storyWhere()).toMatchObject({
			projectId: "p1",
			// A merged-away duplicate is a tombstone pointing at the survivor —
			// never a feature to report coverage for.
			mergedIntoStoryId: null,
		});
	});

	it("omits the kind filter entirely when the caller doesn't pass one", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1" });

		// No hardcoded FEATURE default — callers choose.
		expect(storyWhere()).not.toHaveProperty("kind");
	});

	it("narrows to a single kind when asked", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1", kind: "FEATURE" });

		expect(storyWhere()).toMatchObject({ kind: "FEATURE" });
	});

	it("uncoveredOnly matches stories with no LIVE linked case in the project", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1", uncoveredOnly: true });

		// Must use the same "covering case" predicate as the tally read, or a row
		// could be filtered in as uncovered and then tallied with caseCount >= 1.
		expect(storyWhere().testCaseLinks).toEqual({
			none: { testCase: { projectId: "p1", deletedAt: null } },
		});
	});

	it("omits the coverage predicate when uncoveredOnly is not set", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1" });

		expect(storyWhere()).not.toHaveProperty("testCaseLinks");
	});

	it("excludeClosed drops stories sitting in a final status", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1", excludeClosed: true });

		// Closed is the Kanban `ProjectStoryStatus.isFinal` flag — the same
		// notion the pickers hide by — NOT the roadmap's draftingStage.
		expect(storyWhere()).toMatchObject({ status: { isFinal: false } });
	});

	it("omits the status filter by default (a coverage report reports on finished work too)", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1" });

		expect(storyWhere()).not.toHaveProperty("status");
	});
});

describe("listFeatureCoverage — search", () => {
	it("ORs a legacy-prefixed needle against BOTH the raw and normalized identifier", async () => {
		mockReads([], []);

		// The new plain-decimal identifier for what a user still types as "F-12".
		await listFeatureCoverage({ projectId: "p1", search: "F-12" });

		expect(storyWhere().OR).toEqual([
			{ title: { contains: "F-12", mode: "insensitive" } },
			{ identifier: { contains: "F-12", mode: "insensitive" } },
			{ identifier: { contains: "12", mode: "insensitive" } },
		]);
	});

	it("does not duplicate the identifier clause when the needle has no prefix", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1", search: "checkout" });

		expect(storyWhere().OR).toEqual([
			{ title: { contains: "checkout", mode: "insensitive" } },
			{ identifier: { contains: "checkout", mode: "insensitive" } },
		]);
	});

	it("omits the OR entirely with no search", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1" });

		expect(storyWhere()).not.toHaveProperty("OR");
	});
});

describe("listFeatureCoverage — tally", () => {
	it("buckets results, zero-fills empties, and counts distinct AC refs", async () => {
		mockReads(
			[story("s1")],
			[
				link("s1", "PASSED", "AC 1"),
				link("s1", "PASSED", "AC 2"),
				link("s1", "FAILED", "AC 1"), // repeats AC 1 → still 2 distinct
				link("s1", "NOT_RUN"),
			],
		);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			storyId: "s1",
			caseCount: 4,
			// BLOCKED is zero-filled even though no link produced one.
			resultCounts: { NOT_RUN: 1, PASSED: 2, FAILED: 1, BLOCKED: 0 },
			distinctAcRefs: 2,
			coverageState: "COVERED",
		});
	});

	it("treats a blank/whitespace criterion reference as no reference", async () => {
		mockReads(
			[story("s1")],
			[link("s1", "PASSED", "   "), link("s1", "PASSED", "")],
		);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		expect(items[0].distinctAcRefs).toBe(0);
		// The cases still count — only the AC ref is blank.
		expect(items[0].caseCount).toBe(2);
	});

	it("returns an all-zero UNCOVERED row for a feature with no links (not a missing entry)", async () => {
		mockReads([story("s1"), story("s2")], [link("s2", "PASSED")]);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			storyId: "s1",
			caseCount: 0,
			resultCounts: { NOT_RUN: 0, PASSED: 0, FAILED: 0, BLOCKED: 0 },
			distinctAcRefs: 0,
			coverageState: "UNCOVERED",
		});
		expect(items[1]).toMatchObject({
			storyId: "s2",
			coverageState: "COVERED",
		});
	});

	it("flips to COVERED on a single linked case, even an unrun one", async () => {
		mockReads([story("s1")], [link("s1", "NOT_RUN")]);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		// Coverage is "is it tested", not "did it pass" — an unrun case still covers.
		expect(items[0]).toMatchObject({
			caseCount: 1,
			coverageState: "COVERED",
		});
	});

	it("keeps each story's tally to its own links", async () => {
		mockReads(
			[story("s1"), story("s2")],
			[
				link("s1", "PASSED", "AC 1"),
				link("s2", "FAILED", "AC 9"),
				link("s2", "BLOCKED", "AC 9"),
			],
		);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		expect(items[0]).toMatchObject({
			caseCount: 1,
			resultCounts: { NOT_RUN: 0, PASSED: 1, FAILED: 0, BLOCKED: 0 },
			distinctAcRefs: 1,
		});
		expect(items[1]).toMatchObject({
			caseCount: 2,
			resultCounts: { NOT_RUN: 0, PASSED: 0, FAILED: 1, BLOCKED: 1 },
			distinctAcRefs: 1,
		});
	});

	it("caseCount equals the sum of resultCounts (the pass-rate denominator input)", async () => {
		mockReads(
			[story("s1")],
			[
				link("s1", "PASSED"),
				link("s1", "FAILED"),
				link("s1", "BLOCKED"),
				link("s1", "NOT_RUN"),
			],
		);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		const { resultCounts, caseCount } = items[0];
		const summed =
			resultCounts.NOT_RUN +
			resultCounts.PASSED +
			resultCounts.FAILED +
			resultCounts.BLOCKED;
		expect(summed).toBe(caseCount);
		// The canonical rate (passed / executed, per TestResultRollup) is derivable:
		// executed = 4 - 1 NOT_RUN = 3, passed = 1 → 1/3.
		expect(caseCount - resultCounts.NOT_RUN).toBe(3);
	});

	it("reports whether the story sits in a final status", async () => {
		mockReads([story("s1", { status: { isFinal: true } })], []);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		expect(items[0].closed).toBe(true);
	});

	it("passes the story's roadmap stage through (draftingStage, not a Kanban status)", async () => {
		mockReads(
			[
				story("s1", {
					kind: "BUG",
					draftingStage: "PUBLISHED",
					maturationStatus: "DONE",
				}),
			],
			[],
		);

		const { items } = await listFeatureCoverage({ projectId: "p1" });

		expect(items[0]).toMatchObject({
			kind: "BUG",
			draftingStage: "PUBLISHED",
			maturationStatus: "DONE",
		});
	});
});

describe("listFeatureCoverage — uncovered-first rank", () => {
	const uncoveredWhere = { none: { testCase: coveringCase } };
	const coveredWhere = { some: { testCase: coveringCase } };
	// Most recently touched first; identifier only makes the order total.
	const recentFirst = [
		{ lastEditedAt: { sort: "desc", nulls: "last" } },
		{ createdAt: "desc" },
		{ identifier: "asc" },
	];

	it("asks Postgres for the rank — reads the uncovered bucket, then the covered one", async () => {
		mockBucketedReads([story("s1")], [story("s2")]);

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
		});

		expect(pageCall(0).where.testCaseLinks).toEqual(uncoveredWhere);
		expect(pageCall(0).orderBy).toEqual(recentFirst);
		expect(pageCall(1).where.testCaseLinks).toEqual(coveredWhere);
		expect(pageCall(1).orderBy).toEqual(recentFirst);
	});

	it("splits the buckets on the SAME predicate the tally counts with", async () => {
		mockBucketedReads([story("s1")], [story("s2")]);

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
		});

		// This is what keeps a row's bucket and its caseCount from disagreeing:
		// an uncovered-bucket row is matched by the very test the tally then
		// counts with, so it can only tally to zero. Ordering by an unfiltered
		// relation count would rank soft-deleted links as coverage.
		expect(pageCall(0).where.testCaseLinks.none.testCase).toEqual(
			linkWhere().testCase,
		);
	});

	it("returns the buckets concatenated, in the order Postgres gave them", async () => {
		mockBucketedReads([story("u1"), story("u2")], [story("c1")]);
		// A covered-bucket row has a live linked case by definition — that is the
		// same fact the tally reads, so the two agree on every row.
		dbMock.testCaseWorkItemLink.findMany.mockResolvedValue([
			link("c1", "PASSED"),
		]);

		const { items } = await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
		});

		// No re-sort here: the rows arrive ranked, and reordering them in memory
		// could only reorder the window that was already chosen.
		expect(items.map((i) => i.storyId)).toEqual(["u1", "u2", "c1"]);
		expect(items.map((i) => i.coverageState)).toEqual([
			"UNCOVERED",
			"UNCOVERED",
			"COVERED",
		]);
	});

	it("fills the page from the covered bucket with only the room left", async () => {
		mockBucketedReads([story("u1"), story("u2")], [story("c1")]);

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
			limit: 5,
		});

		expect(pageCall(0)).toMatchObject({ take: 5, skip: 0 });
		expect(pageCall(1)).toMatchObject({ take: 3, skip: 0 });
	});

	it("never reads the covered bucket when the uncovered rows already fill the page", async () => {
		mockBucketedReads([story("u1"), story("u2")], [story("c1")]);

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
			limit: 2,
		});

		expect(dbMock.userStory.findMany).toHaveBeenCalledTimes(1);
	});

	it("holds the rank across pagination: an offset past the uncovered bucket skips INTO the covered one", async () => {
		// 4 uncovered rows in total, and the caller wants rows 10-11.
		mockBucketedReads([], [story("c1")], { uncovered: 4, covered: 100 });

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
			limit: 2,
			offset: 10,
		});

		// The uncovered bucket is counted, not read — the page starts past it —
		// and the remaining offset carries into the covered bucket. Ranking a
		// single fetched page could never produce this.
		const covered = dbMock.userStory.findMany.mock.calls[0][0];
		expect(covered.where.testCaseLinks).toEqual(coveredWhere);
		expect(covered).toMatchObject({ take: 2, skip: 6 });
	});

	it("takes the page from the uncovered bucket when the offset lands inside it", async () => {
		mockBucketedReads([story("u3")], [], { uncovered: 4 });

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
			limit: 2,
			offset: 2,
		});

		expect(pageCall(0)).toMatchObject({ take: 2, skip: 2 });
		expect(pageCall(0).where.testCaseLinks).toEqual(uncoveredWhere);
		// The covered bucket picks up where the uncovered one ran out, at its top.
		expect(pageCall(1)).toMatchObject({ take: 1, skip: 0 });
	});

	it("reads ONE bucket when uncoveredOnly already narrowed the set", async () => {
		mockBucketedReads([story("u1")], [story("c1")]);

		const { items } = await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
			uncoveredOnly: true,
		});

		// There is no covered bucket to fall through to — reading one would hand
		// back the very rows the caller filtered out.
		expect(dbMock.userStory.findMany).toHaveBeenCalledTimes(1);
		expect(items.map((i) => i.storyId)).toEqual(["u1"]);
	});

	it("totals across BOTH buckets however the page was ranked", async () => {
		mockBucketedReads([story("u1")], [story("c1")]);

		await listFeatureCoverage({
			projectId: "p1",
			order: "UNCOVERED_FIRST",
		});

		// The total drives pagination, so it must span the whole result set —
		// not whichever bucket answered this page.
		const totalWhere = dbMock.userStory.count.mock.calls.at(-1)?.[0].where;
		expect(totalWhere).not.toHaveProperty("testCaseLinks");
	});
});

describe("listFeatureCoverage — batching", () => {
	it("reads the links for the WHOLE page in ONE query keyed by story id", async () => {
		const stories = Array.from({ length: 25 }, (_, i) => story(`s${i}`));
		mockReads(stories, []);

		await listFeatureCoverage({ projectId: "p1" });

		// The N+1 regression this helper exists to prevent: one link read total,
		// not one per feature.
		expect(dbMock.testCaseWorkItemLink.findMany).toHaveBeenCalledTimes(1);
		expect(dbMock.userStory.findMany).toHaveBeenCalledTimes(1);
		expect(linkWhere()).toEqual({
			userStoryId: { in: stories.map((s) => s.id) },
			testCase: { projectId: "p1", deletedAt: null },
		});
	});

	it("skips the link read entirely when the page is empty", async () => {
		mockReads([], [], 0);

		const { items, total } = await listFeatureCoverage({ projectId: "p1" });

		expect(items).toEqual([]);
		expect(total).toBe(0);
		expect(dbMock.testCaseWorkItemLink.findMany).not.toHaveBeenCalled();
	});

	it("paginates the stories BEFORE the link read, and returns the unpaginated total", async () => {
		mockReads([story("s1")], [], 500);

		const { total } = await listFeatureCoverage({
			projectId: "p1",
			limit: 1,
			offset: 20,
		});

		const call = dbMock.userStory.findMany.mock.calls[0][0];
		expect(call).toMatchObject({ take: 1, skip: 20 });
		// The link `IN` list is bounded by the page, not the project's features.
		expect(linkWhere().userStoryId).toEqual({ in: ["s1"] });
		expect(total).toBe(500);
	});

	it("defaults to a bounded page and a total order (unique identifier tiebreak)", async () => {
		mockReads([], []);

		await listFeatureCoverage({ projectId: "p1" });

		const call = dbMock.userStory.findMany.mock.calls[0][0];
		expect(call.take).toBe(100);
		expect(call.skip).toBe(0);
		// Without the unique tiebreak, paging could repeat or skip rows.
		expect(call.orderBy).toEqual([
			{ createdAt: "asc" },
			{ identifier: "asc" },
		]);
	});

	it("counts under the same predicate it lists under", async () => {
		mockReads([], []);

		await listFeatureCoverage({
			projectId: "p1",
			kind: "FEATURE",
			uncoveredOnly: true,
			search: "F-3",
		});

		expect(dbMock.userStory.count.mock.calls[0][0].where).toEqual(
			storyWhere(),
		);
	});
});

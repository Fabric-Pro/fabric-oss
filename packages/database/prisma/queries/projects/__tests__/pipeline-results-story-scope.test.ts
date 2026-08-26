/**
 * Per-feature run scoping.
 *
 * The feature QA tab used to render every run in the PROJECT, so a feature with
 * no automated coverage at all looked identically busy to one with full
 * coverage. Three properties are worth pinning, because each would be silently
 * wrong rather than loudly broken:
 *
 *   1. the scope really is "runs that touched THIS feature", via the case→story
 *      link — not the project;
 *   2. no coverage yields an EMPTY list, never a widened project-wide one;
 *   3. the filter stays a relation filter on the RUN. The equivalent-looking
 *      "collect run ids from the events, then query runs by id" version cannot
 *      push its dedup into Postgres — `SELECT DISTINCT ON (x) … ORDER BY y` is
 *      invalid SQL, the DISTINCT ON expressions must lead the ORDER BY — so
 *      Prisma dedupes in Node, `take` never becomes a `LIMIT`, and every call
 *      drags the feature's whole event history over the wire. That is invisible
 *      in the returned data, which is exactly why it needs a test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
	dbMock: {
		testResultEvent: { findMany: vi.fn() },
		testPipelineRun: { findMany: vi.fn(), count: vi.fn() },
	},
}));

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	listPipelineRunsPage,
	listProjectPipelineRuns,
	listStoryPipelineRuns,
} from "../pipeline-results";

const INPUT = { projectId: "p1", storyId: "s1" };

/** The relation filter a feature-scoped query must carry. */
const FEATURE_FILTER = {
	some: {
		testCase: {
			projectId: "p1",
			deletedAt: null,
			workItemLinks: { some: { userStoryId: "s1" } },
		},
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.testPipelineRun.findMany.mockResolvedValue([]);
	dbMock.testPipelineRun.count.mockResolvedValue(0);
	// Deliberately WORKING, not absent: if the forbidden event pre-query is ever
	// reintroduced, these tests must fail on the shape assertion below rather
	// than on a TypeError from an unstubbed mock. A red test that only proves
	// the mock is incomplete proves nothing about the guard.
	dbMock.testResultEvent.findMany.mockResolvedValue([
		{ pipelineRunId: "r1" },
	]);
});

describe("listStoryPipelineRuns", () => {
	it("selects runs through the case→feature link, scoped to the project", async () => {
		await listStoryPipelineRuns(INPUT);

		const where = dbMock.testPipelineRun.findMany.mock.calls[0][0].where;
		expect(where.resultEvents).toEqual(FEATURE_FILTER);
		// The tenant guard is restated on the run itself, deliberately: it must
		// not depend on a nested filter keeping its shape.
		expect(where.projectId).toBe("p1");
		// A soft-deleted run stays gone, and a soft-deleted case must not
		// resurrect a run into the feature's list.
		expect(where.deletedAt).toBeNull();
	});

	it("asks the database for the page rather than trimming one in Node", async () => {
		// The regression this pins: a `distinct` + `orderBy`-on-another-column
		// pre-query looks equivalent and quietly stops `take` compiling to a SQL
		// LIMIT, so the whole event history crosses the wire on every poll tick.
		// No second query, and no `distinct` anywhere, is the shape that keeps
		// the limit real.
		await listStoryPipelineRuns({ ...INPUT, limit: 5_000 });

		expect(dbMock.testResultEvent.findMany).not.toHaveBeenCalled();
		const args = dbMock.testPipelineRun.findMany.mock.calls[0][0];
		expect(args.distinct).toBeUndefined();
		expect(args.take).toBe(100);
	});

	it("returns nothing — never the project's runs — when the feature has no coverage", async () => {
		// The load-bearing property. With a relation filter, "no coverage" is
		// simply an empty result; what must never appear is a query that dropped
		// the clause and fell back to the project.
		await expect(listStoryPipelineRuns(INPUT)).resolves.toEqual([]);

		expect(
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where.resultEvents,
		).toEqual(FEATURE_FILTER);
	});

	it("keeps provider and outcome filters when feature-scoped", async () => {
		await listStoryPipelineRuns({
			...INPUT,
			providers: ["github-actions"],
			statuses: ["cancelled"],
		});

		const where = dbMock.testPipelineRun.findMany.mock.calls[0][0].where;
		expect(where.provider).toEqual({ in: ["github-actions"] });
		expect(where.OR).toEqual([
			{
				status: {
					in: ["cancelled", "canceled", "aborted", "stale"],
					mode: "insensitive",
				},
			},
		]);
		expect(where.resultEvents).toEqual(FEATURE_FILTER);
	});
});

describe("listProjectPipelineRuns outcome filters", () => {
	it("maps a failed outcome to counts and provider-specific failure tokens", async () => {
		await listProjectPipelineRuns({
			projectId: "p1",
			statuses: ["failed"],
		});

		const [failed] =
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where.OR;
		expect(failed.AND[0]).toEqual({
			OR: [
				{ status: null },
				{
					status: {
						notIn: ["cancelled", "canceled", "aborted", "stale"],
						mode: "insensitive",
					},
				},
			],
		});
		expect(failed.AND[1].OR).toContainEqual({ failedCount: { gt: 0 } });
		expect(failed.AND[1].OR).toContainEqual({
			status: {
				in: [
					"failed",
					"failure",
					"timed_out",
					"startup_failure",
					"action_required",
					"error",
				],
				mode: "insensitive",
			},
		});
	});

	it("treats successful provider tokens or passing test counts as passed", async () => {
		await listProjectPipelineRuns({
			projectId: "p1",
			statuses: ["passed"],
		});

		const [passed] =
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where.OR;
		expect(passed.AND).toContainEqual({ failedCount: 0 });
		expect(passed.AND).toContainEqual({
			OR: [
				{ passedCount: { gt: 0 } },
				{
					status: {
						in: ["passed", "success", "completed"],
						mode: "insensitive",
					},
				},
			],
		});
	});

	it("combines selected outcomes with OR", async () => {
		await listProjectPipelineRuns({
			projectId: "p1",
			statuses: ["failed", "cancelled"],
		});

		expect(
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where.OR,
		).toHaveLength(2);
	});
});

describe("listPipelineRunsPage", () => {
	const PAGE = { projectId: "p1", limit: 20, offset: 0 };

	it("counts the same set it pages, so 'showing N of M' cannot lie", async () => {
		// The bug this shape prevents: a feature-scoped page paired with a
		// project-wide total, so the dialog reads "showing 3 of 412" for a
		// feature that only ever had 3 runs.
		dbMock.testPipelineRun.findMany.mockResolvedValue([{ id: "r1" }]);
		dbMock.testPipelineRun.count.mockResolvedValue(3);

		const result = await listPipelineRunsPage({ ...PAGE, storyId: "s1" });

		expect(result.total).toBe(3);
		expect(dbMock.testPipelineRun.count.mock.calls[0][0].where).toEqual(
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where,
		);
	});

	it("applies the same provider and outcome filters to the page and count", async () => {
		await listPipelineRunsPage({
			...PAGE,
			providers: ["gitlab-ci"],
			statuses: ["passed"],
		});

		const pageWhere =
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where;
		expect(pageWhere.provider).toEqual({ in: ["gitlab-ci"] });
		expect(pageWhere.OR).toHaveLength(1);
		expect(dbMock.testPipelineRun.count.mock.calls[0][0].where).toEqual(
			pageWhere,
		);
	});

	it("pages the whole project when no feature is named", async () => {
		await listPipelineRunsPage(PAGE);

		expect(dbMock.testPipelineRun.findMany.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
		});
	});

	it("reports zero of zero for a feature with no coverage", async () => {
		await expect(
			listPipelineRunsPage({ ...PAGE, storyId: "s1" }),
		).resolves.toEqual({ runs: [], total: 0 });

		// Page and count must agree even when empty — a count that dropped the
		// clause would report the project's total beside an empty page.
		expect(dbMock.testPipelineRun.count.mock.calls[0][0].where).toEqual(
			dbMock.testPipelineRun.findMany.mock.calls[0][0].where,
		);
	});

	it("clamps a hostile page size and a negative offset", async () => {
		await listPipelineRunsPage({
			projectId: "p1",
			limit: 10_000,
			offset: -5,
		});

		const args = dbMock.testPipelineRun.findMany.mock.calls[0][0];
		expect(args.take).toBe(100);
		expect(args.skip).toBe(0);
	});
});

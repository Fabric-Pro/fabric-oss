/**
 * Resolving the commit range a failure happened in.
 *
 * The correlation built on top of this is only as honest as the baseline it
 * starts from, so the rules worth pinning are the ones that decide when to
 * report NOTHING:
 *
 *  - a run that never mentions the test is not a baseline. The test may not
 *    have existed yet, and treating absent as passing would correlate the
 *    failure against every commit since the suite was created;
 *  - the baseline must come from the SAME test's history, not "the last green
 *    run" — a suite with one flaky test has no green runs at all, and a
 *    suite-level baseline would go silent on exactly the projects that need
 *    this most;
 *  - a provider that sends no commit is an ordinary outcome, not an error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	testFinding: { findFirst: vi.fn() },
	testPipelineRun: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../../../client", () => ({ db: dbMock, Prisma: {} }));

import { getFailureCommitRange } from "../failure-commit-range";

const FINDING = {
	testName: "applies the discount",
	classname: "e2e/checkout.spec.ts",
	lastPipelineRunId: "run-fail",
};
const FAILING_RUN = {
	commitSha: "head000",
	branch: "main",
	startedAt: new Date("2026-07-10T00:00:00Z"),
};
/** A results row shaped like the provider ingesters write it. */
const result = (status: string) => ({
	name: FINDING.testName,
	classname: FINDING.classname,
	status,
});

const load = () => getFailureCommitRange({ projectId: "p1", findingId: "f1" });

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.testFinding.findFirst.mockResolvedValue(FINDING);
	dbMock.testPipelineRun.findFirst.mockResolvedValue(FAILING_RUN);
	dbMock.testPipelineRun.findMany.mockResolvedValue([]);
});

describe("getFailureCommitRange", () => {
	it("resolves the range from the newest earlier run where THIS test passed", async () => {
		dbMock.testPipelineRun.findMany.mockResolvedValue([
			{
				commitSha: "newer0",
				startedAt: new Date("2026-07-09T00:00:00Z"),
				results: [result("FAILED")],
			},
			{
				commitSha: "base000",
				startedAt: new Date("2026-07-08T00:00:00Z"),
				results: [result("PASSED")],
			},
		]);

		expect(await load()).toEqual({
			range: {
				headSha: "head000",
				baseSha: "base000",
				branch: "main",
				baselineRunAt: new Date("2026-07-08T00:00:00Z"),
			},
		});
	});

	it("does not treat a run that never mentions the test as a baseline", async () => {
		// The test may not have existed yet. Calling this a baseline would blame
		// every commit since the suite was created.
		dbMock.testPipelineRun.findMany.mockResolvedValue([
			{
				commitSha: "unrelated",
				startedAt: new Date("2026-07-09T00:00:00Z"),
				results: [{ name: "something else", status: "PASSED" }],
			},
		]);

		expect(await load()).toEqual({
			range: null,
			gap: "NO_PASSING_BASELINE",
		});
	});

	it("does not match a same-named test from a different class", async () => {
		// A rename must read as "never passed" rather than silently correlating
		// against a different test's history.
		dbMock.testPipelineRun.findMany.mockResolvedValue([
			{
				commitSha: "other",
				startedAt: new Date("2026-07-09T00:00:00Z"),
				results: [
					{
						name: FINDING.testName,
						classname: "unit/other.spec.ts",
						status: "PASSED",
					},
				],
			},
		]);

		expect((await load()).range).toBeNull();
	});

	it("looks only at earlier runs on the same branch", async () => {
		await load();

		const where = dbMock.testPipelineRun.findMany.mock.calls[0][0].where;
		expect(where.branch).toBe("main");
		expect(where.startedAt).toEqual({ lt: FAILING_RUN.startedAt });
		expect(where.projectId).toBe("p1");
		// The failing run itself can never be its own baseline.
		expect(where.id).toEqual({ not: "run-fail" });
	});

	it("bounds how far back it reads, so one triage question is not a table scan", async () => {
		await load();

		expect(dbMock.testPipelineRun.findMany.mock.calls[0][0].take).toBe(20);
		expect(
			dbMock.testPipelineRun.findMany.mock.calls[0][0].orderBy,
		).toEqual({ startedAt: "desc" });
	});

	it("reports a provider that sends no commit as its own outcome", async () => {
		// jira-xray deliberately sends none. That is ordinary, and the caller
		// renders a different message for it than for "this test never passed".
		dbMock.testPipelineRun.findFirst.mockResolvedValue({
			...FAILING_RUN,
			commitSha: null,
		});

		expect(await load()).toEqual({ range: null, gap: "NO_COMMIT_ON_RUN" });
	});

	it("reports a finding that was never seen in a run", async () => {
		dbMock.testFinding.findFirst.mockResolvedValue({
			...FINDING,
			lastPipelineRunId: null,
		});

		expect(await load()).toEqual({ range: null, gap: "NO_FAILING_RUN" });
	});

	it("treats a finding from another project as not found", async () => {
		dbMock.testFinding.findFirst.mockResolvedValue(null);

		expect(await load()).toEqual({ range: null, gap: "NO_FAILING_RUN" });
		// projectId is in the WHERE, so the foreign id matched nothing rather
		// than being read across the boundary.
		expect(
			dbMock.testFinding.findFirst.mock.calls[0][0].where,
		).toMatchObject({ id: "f1", projectId: "p1" });
	});

	it("survives a malformed results payload rather than throwing mid-triage", async () => {
		// `results` is provider-ingested JSON. A bad row must cost the baseline,
		// not the whole analysis.
		dbMock.testPipelineRun.findMany.mockResolvedValue([
			{ commitSha: "a", startedAt: new Date(), results: null },
			{ commitSha: "b", startedAt: new Date(), results: "not an array" },
			{ commitSha: "c", startedAt: new Date(), results: [null, 42] },
		]);

		expect((await load()).range).toBeNull();
	});
});

/**
 * Unit tests for the pipeline-result ingestion query. Mocks the
 * Prisma client (no real DB), mirroring test-case-results.test.ts. Asserts the
 * write-path decisions: idempotency on (project, provider, run), one PIPELINE
 * event per matched case + latest-wins denorm, and the no-write short-circuit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
	const make = () => ({
		findUnique: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		upsert: vi.fn(),
		delete: vi.fn(),
		createMany: vi.fn(),
	});
	return {
		dbMock: {
			testPipelineRun: make(),
			testResultEvent: make(),
			testCase: make(),
			testPipelineSyncState: make(),
			$transaction: vi.fn(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	ingestPipelineRun,
	listUnmatchedAutomatedTests,
} from "../pipeline-results";

const baseInput = {
	projectId: "p1",
	organizationId: "org1",
	userId: "u1",
	run: {
		provider: "github-actions",
		externalRunId: "4821",
		pipelineName: "CI",
		branch: "main",
		commitSha: "abc",
		runUrl: "https://gh/run/4821",
		status: "failure",
		startedAt: new Date("2026-07-24T10:00:00Z"),
		finishedAt: new Date("2026-07-24T10:05:00Z"),
		durationMs: 300000,
		totalCount: 2,
		passedCount: 1,
		failedCount: 1,
		skippedCount: 0,
		otherCount: 0,
	},
	matched: [
		{
			testCaseId: "c1",
			result: "PASSED" as const,
			testName: "a",
			matchTier: "tag" as const,
		},
		{
			testCaseId: "c2",
			result: "FAILED" as const,
			testName: "b",
			matchTier: "title" as const,
		},
	],
	unmatchedCount: 1,
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.$transaction.mockImplementation(async (cb: unknown) =>
		(cb as (tx: typeof dbMock) => unknown)(dbMock),
	);
});

describe("ingestPipelineRun", () => {
	it("creates the run, one PIPELINE event per matched case, and denormalizes latest-wins", async () => {
		dbMock.testPipelineRun.findUnique.mockResolvedValue(null); // not ingested
		dbMock.testPipelineRun.create.mockResolvedValue({ id: "run1" });
		dbMock.testResultEvent.createMany.mockResolvedValue({ count: 2 });
		dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });

		const out = await ingestPipelineRun(baseInput);

		expect(out).toEqual({
			pipelineRunId: "run1",
			matched: 2,
			unmatched: 1,
			alreadyIngested: false,
		});
		expect(dbMock.testPipelineRun.create).toHaveBeenCalledTimes(1);
		// ONE batched insert carrying both events — not one round trip per test.
		expect(dbMock.testResultEvent.createMany).toHaveBeenCalledTimes(1);
		expect(
			dbMock.testResultEvent.createMany.mock.calls[0][0].data,
		).toHaveLength(2);
		expect(dbMock.testCase.updateMany).toHaveBeenCalledTimes(2);

		// Events are PIPELINE-sourced, linked to the run, with provenance.
		const firstEvent =
			dbMock.testResultEvent.createMany.mock.calls[0][0].data[0];
		expect(firstEvent).toMatchObject({
			testCaseId: "c1",
			result: "PASSED",
			source: "PIPELINE",
			pipelineRunId: "run1",
			externalRunRef: "4821",
		});

		// Denorm is guarded latest-wins: only when the run is >= the case's last run.
		const denorm = dbMock.testCase.updateMany.mock.calls[0][0];
		expect(denorm.where.OR).toEqual([
			{ lastRunAt: null },
			{ lastRunAt: { lte: baseInput.run.finishedAt } },
		]);
		expect(denorm.data).toMatchObject({
			currentResult: "PASSED",
			lastRunSource: "PIPELINE",
		});
	});

	it("denormalizes the WORST result when one run covers a case with several tests (no green-masks-red)", async () => {
		dbMock.testPipelineRun.findUnique.mockResolvedValue(null);
		dbMock.testPipelineRun.create.mockResolvedValue({ id: "run1" });
		dbMock.testResultEvent.createMany.mockResolvedValue({ count: 2 });
		dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });

		await ingestPipelineRun({
			...baseInput,
			// Same case c1, two tests in ONE run: FAILED then PASSED. The old
			// last-wins denorm would have written PASSED (green masks red); the
			// worst-wins fix must land on FAILED regardless of array order.
			matched: [
				{
					testCaseId: "c1",
					result: "FAILED" as const,
					testName: "b",
					matchTier: "tag" as const,
				},
				{
					testCaseId: "c1",
					result: "PASSED" as const,
					testName: "a",
					matchTier: "tag" as const,
				},
			],
		});

		// Both tests keep their own history event...
		expect(
			dbMock.testResultEvent.createMany.mock.calls[0][0].data,
		).toHaveLength(2);
		// ...but the case is denormalized ONCE, to the WORST (FAILED), not the last.
		expect(dbMock.testCase.updateMany).toHaveBeenCalledTimes(1);
		const denorm = dbMock.testCase.updateMany.mock.calls[0][0];
		expect(denorm.data.currentResult).toBe("FAILED");
		// And the write is project-scoped (belt-and-suspenders tenant guard).
		expect(denorm.where.projectId).toBe("p1");
	});

	it("ranks SKIPPED below PASSED but above NOT_RUN in the worst-wins denorm", async () => {
		// One case covered by two tests in one run: one passed, one was skipped.
		// A skip is not a problem, so it must NOT displace a real pass — the
		// reader wants to know something actually passed. Full history keeps both.
		dbMock.testPipelineRun.findUnique.mockResolvedValue(null);
		dbMock.testPipelineRun.create.mockResolvedValue({ id: "run1" });
		dbMock.testResultEvent.createMany.mockResolvedValue({ count: 2 });
		dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });

		await ingestPipelineRun({
			...baseInput,
			matched: [
				{
					testCaseId: "c1",
					result: "SKIPPED" as const,
					testName: "b",
					matchTier: "tag" as const,
				},
				{
					testCaseId: "c1",
					result: "PASSED" as const,
					testName: "a",
					matchTier: "tag" as const,
				},
			],
		});

		expect(
			dbMock.testCase.updateMany.mock.calls[0][0].data.currentResult,
		).toBe("PASSED");
	});

	it("never lets a skip mask a real problem", async () => {
		// The invariant the whole severity ladder exists for: FAILED and BLOCKED
		// outrank SKIPPED, so a suite that skips around a broken test cannot make
		// the case read as anything other than broken.
		for (const worse of ["FAILED", "BLOCKED"] as const) {
			dbMock.testPipelineRun.findUnique.mockResolvedValue(null);
			dbMock.testPipelineRun.create.mockResolvedValue({ id: "run1" });
			dbMock.testResultEvent.createMany.mockResolvedValue({ count: 2 });
			dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });
			dbMock.testCase.updateMany.mockClear();

			await ingestPipelineRun({
				...baseInput,
				matched: [
					{
						testCaseId: "c1",
						result: worse,
						testName: "b",
						matchTier: "tag" as const,
					},
					{
						testCaseId: "c1",
						result: "SKIPPED" as const,
						testName: "a",
						matchTier: "tag" as const,
					},
				],
			});

			expect(
				dbMock.testCase.updateMany.mock.calls[0][0].data.currentResult,
			).toBe(worse);
		}
	});

	it("is idempotent — re-fetching the SAME run writes nothing", async () => {
		// The stored row matches the incoming run on every field a re-run would
		// change, so this is the same execution seen twice.
		dbMock.testPipelineRun.findUnique.mockResolvedValue({
			id: "run1",
			status: baseInput.run.status,
			finishedAt: baseInput.run.finishedAt,
			totalCount: baseInput.run.totalCount,
			passedCount: baseInput.run.passedCount,
			failedCount: baseInput.run.failedCount,
		});

		const out = await ingestPipelineRun(baseInput);

		expect(out).toEqual({
			pipelineRunId: "run1",
			matched: 0,
			unmatched: 0,
			alreadyIngested: true,
		});
		expect(dbMock.testPipelineRun.create).not.toHaveBeenCalled();
		expect(dbMock.testPipelineRun.delete).not.toHaveBeenCalled();
		expect(dbMock.testResultEvent.createMany).not.toHaveBeenCalled();
		expect(dbMock.testCase.updateMany).not.toHaveBeenCalled();
	});

	it("re-ingests when the provider RE-RAN the same run id", async () => {
		// Regression: GitHub "Re-run all jobs" keeps `workflow_run.id` and GitLab
		// "Retry pipeline" keeps the pipeline id. The old idempotency check keyed
		// on that id alone, so a flaky test that failed, opened a bug, and then
		// passed on a re-run kept its case FAILED and the bug open forever.
		dbMock.testPipelineRun.findUnique.mockResolvedValue({
			id: "run1",
			status: "failure",
			finishedAt: new Date("2026-07-24T10:05:00Z"),
			totalCount: 2,
			passedCount: 1,
			failedCount: 1,
		});
		dbMock.testPipelineRun.create.mockResolvedValue({ id: "run1b" });
		dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });

		const out = await ingestPipelineRun({
			...baseInput,
			run: {
				...baseInput.run,
				// The re-run: everything green, finished later.
				status: "success",
				finishedAt: new Date("2026-07-24T11:30:00Z"),
				passedCount: 2,
				failedCount: 0,
			},
			matched: [
				{
					testCaseId: "c1",
					result: "PASSED" as const,
					testName: "a",
					matchTier: "tag" as const,
				},
			],
		});

		expect(out.alreadyIngested).toBe(false);
		// The provider owns the id, so the stale attempt is replaced in place.
		expect(dbMock.testPipelineRun.delete).toHaveBeenCalledTimes(1);
		expect(dbMock.testPipelineRun.create).toHaveBeenCalledTimes(1);
		// And the case is re-derived from the new attempt, clearing the failure.
		expect(dbMock.testCase.updateMany).toHaveBeenCalledTimes(1);
		expect(
			dbMock.testCase.updateMany.mock.calls[0][0].data.currentResult,
		).toBe("PASSED");
	});
});

describe("listUnmatchedAutomatedTests", () => {
	/** Runs come back newest-first, exactly as the query orders them. */
	const runs = [
		{
			provider: "github-actions",
			startedAt: new Date("2026-07-25T10:00:00Z"),
			createdAt: new Date("2026-07-25T10:00:00Z"),
			results: [
				{
					name: "cart applies discount",
					classname: "cart",
					status: "FAILED",
					matchedCaseId: null,
				},
				{
					name: "cart is empty",
					classname: "cart",
					status: "PASSED",
					matchedCaseId: "tc-1",
				},
				{
					name: "checkout totals",
					classname: "checkout",
					status: "PASSED",
					matchedCaseId: null,
				},
			],
		},
		{
			provider: "github-actions",
			startedAt: new Date("2026-07-24T10:00:00Z"),
			createdAt: new Date("2026-07-24T10:00:00Z"),
			results: [
				{
					name: "cart applies discount",
					classname: "cart",
					status: "PASSED",
					matchedCaseId: null,
				},
			],
		},
	];

	beforeEach(() => {
		dbMock.testPipelineRun.findMany.mockResolvedValue(runs);
		// The read-time re-link needs today's cases; none by default, so nothing
		// is dropped for being tracked already.
		dbMock.testCase.findMany.mockResolvedValue([]);
	});

	it("lists only tests that matched NO case", async () => {
		const res = await listUnmatchedAutomatedTests({ projectId: "p1" });
		// The matched one ("cart is empty") is tracked already and must not be
		// offered for triage.
		expect(res.tests.map((t) => t.name)).toEqual([
			"cart applies discount",
			"checkout totals",
		]);
	});

	it("dedupes across runs and counts occurrences", async () => {
		const res = await listUnmatchedAutomatedTests({ projectId: "p1" });
		const discount = res.tests.find(
			(t) => t.name === "cart applies discount",
		);
		expect(discount?.occurrences).toBe(2);
		// Newest run wins for the status — the older PASSED must not mask that it
		// is failing right now.
		expect(discount?.lastStatus).toBe("FAILED");
	});

	it("orders failing tests first, then by frequency", async () => {
		const res = await listUnmatchedAutomatedTests({ projectId: "p1" });
		expect(res.tests[0].lastStatus).toBe("FAILED");
	});

	it("drops a test that a case now claims, without waiting for the next run", async () => {
		// A run's matchedCaseId is frozen at ingestion and ingested runs are never
		// re-processed, so a case created FROM this list would otherwise keep its
		// row forever. The read re-runs the cascade against today's cases.
		dbMock.testCase.findMany.mockResolvedValue([
			{
				id: "tc-9",
				identifier: "TC-009",
				title: "unrelated",
				automationRef: "cart applies discount",
				automationFilePath: "cart",
			},
		]);
		const res = await listUnmatchedAutomatedTests({ projectId: "p1" });
		expect(res.tests.map((t) => t.name)).toEqual(["checkout totals"]);
		expect(res.totalDistinct).toBe(1);
	});

	it("treats a run with no stored per-test results as contributing nothing", async () => {
		dbMock.testPipelineRun.findMany.mockResolvedValue([
			{
				provider: "gitlab-ci",
				startedAt: null,
				createdAt: null,
				results: null,
			},
		]);
		const res = await listUnmatchedAutomatedTests({ projectId: "p1" });
		expect(res.tests).toEqual([]);
		expect(res.scannedRuns).toBe(1);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	listLinkableCases,
	ingestPipelineRun,
	recordFindingsForRun,
	markDocumentsPendingDeploy,
} = vi.hoisted(() => ({
	listLinkableCases: vi.fn(),
	ingestPipelineRun: vi.fn(),
	recordFindingsForRun: vi.fn(),
	markDocumentsPendingDeploy: vi.fn(),
}));
// EXHAUSTIVE factory: a new `@repo/database` import into the module under test
// must be added here or every test in this file throws on the missing export.
vi.mock("@repo/database", () => ({
	listLinkableCases,
	ingestPipelineRun,
	recordFindingsForRun,
	markDocumentsPendingDeploy,
}));

import { ingestNormalizedRuns } from "../ingest-pipeline-results";
import type { NormalizedRun } from "../normalized-result";

const cases = [
	{
		id: "c1",
		identifier: "TC-014",
		title: "login succeeds",
		automationRef: "login succeeds",
		automationFilePath: null,
	},
];

function run(externalRunId: string): NormalizedRun {
	return {
		provider: "github-actions",
		externalRunId,
		results: [
			{ name: "login succeeds", rawStatus: "passed" }, // → c1 (title)
			{ name: "orphan test", rawStatus: "failed" }, // unmatched
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default so tests that are not about findings need not care.
	recordFindingsForRun.mockResolvedValue({ created: 0, updated: 0 });
	markDocumentsPendingDeploy.mockResolvedValue(0);
	listLinkableCases.mockResolvedValue(cases);
});

describe("ingestNormalizedRuns", () => {
	it("loads cases once, prepares + ingests each run, and aggregates the returns", async () => {
		ingestPipelineRun.mockResolvedValue({
			pipelineRunId: "r",
			matched: 1,
			unmatched: 1,
			alreadyIngested: false,
		});

		const out = await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: "o1",
			userId: "u1",
			runs: [run("1"), run("2")],
		});

		// Candidate cases fetched ONCE for the whole batch, not per run.
		expect(listLinkableCases).toHaveBeenCalledTimes(1);
		expect(ingestPipelineRun).toHaveBeenCalledTimes(2);
		expect(out).toEqual({
			documentsMarkedForDeploy: 0,
			ingestedRuns: 2,
			skippedRuns: 0,
			matched: 2,
			unmatched: 2,
			// Both runs link the same case (c1) — deduped into the RCA input.
			touchedCaseIds: ["c1"],
			findingsCreated: 0,
			findingsUpdated: 0,
		});

		// The prepared payload carries the cascade match + normalized counts.
		const prepared = ingestPipelineRun.mock.calls[0][0];
		expect(prepared.matched).toEqual([
			{
				testCaseId: "c1",
				result: "PASSED",
				testName: "login succeeds",
				matchTier: "title",
			},
		]);
		expect(prepared.run.passedCount).toBe(1);
		expect(prepared.run.failedCount).toBe(1);
		expect(prepared.unmatchedCount).toBe(1);
	});

	it("counts an already-ingested run as skipped (idempotent, no double-tally)", async () => {
		ingestPipelineRun.mockResolvedValue({
			pipelineRunId: "r",
			matched: 0,
			unmatched: 0,
			alreadyIngested: true,
		});

		const out = await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [run("1")],
		});

		expect(out).toEqual({
			documentsMarkedForDeploy: 0,
			ingestedRuns: 0,
			skippedRuns: 1,
			matched: 0,
			unmatched: 0,
			// The run is an idempotent no-op, but its linked case is STILL surfaced
			// for RCA (from the prepared matches) — a retry after a mid-sync failure
			// must not drop a still-failing case just because its run re-ingested.
			touchedCaseIds: ["c1"],
			findingsCreated: 0,
			findingsUpdated: 0,
		});
		// ...and precisely because it is a no-op, no finding is recorded: a
		// re-fetch of the same run must not inflate `occurrences`, which counts
		// how often the FAULT recurred, not how often we happened to sync.
		expect(recordFindingsForRun).not.toHaveBeenCalled();
	});

	it("records one finding per distinct failure in a newly-ingested run", async () => {
		listLinkableCases.mockResolvedValue(cases);
		ingestPipelineRun.mockResolvedValue({
			pipelineRunId: "pr1",
			matched: 1,
			unmatched: 1,
			alreadyIngested: false,
		});
		recordFindingsForRun.mockResolvedValue({ created: 1, updated: 0 });

		const out = await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [run("1")],
		});

		expect(out.findingsCreated).toBe(1);
		const call = recordFindingsForRun.mock.calls[0][0];
		expect(call.pipelineRunId).toBe("pr1");
		// Every failure carries a fingerprint — the identity that makes the same
		// fault one finding across runs instead of a new row every night.
		for (const f of call.failures) {
			expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		}
	});
});

/**
 * Deploy detection.
 *
 * The asymmetry that shapes every case here: missing a deploy delays a document
 * refresh until the next one, while inventing one spends a customer's model
 * budget rewriting documents because a build went red. So everything unclear
 * resolves to "not a deploy".
 */
describe("ingestNormalizedRuns — deploy detection", () => {
	function deployRun(over: Partial<NormalizedRun> = {}): NormalizedRun {
		return { ...run("100"), branch: "main", status: "success", ...over };
	}

	beforeEach(() => {
		ingestPipelineRun.mockResolvedValue({
			pipelineRunId: "r1",
			alreadyIngested: false,
			matched: 1,
			unmatched: 1,
		});
	});

	it("marks documents due when a run succeeds on the watched branch", async () => {
		markDocumentsPendingDeploy.mockResolvedValue(3);

		const res = await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: "o1",
			userId: "u1",
			runs: [deployRun()],
			deployBranch: "main",
		});

		expect(markDocumentsPendingDeploy).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "p1" }),
		);
		expect(res.documentsMarkedForDeploy).toBe(3);
	});

	it("matches a ref-qualified branch against a bare one", async () => {
		// GitHub reports `refs/heads/main`; the stored branch is `main`.
		await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [deployRun({ branch: "refs/heads/main" })],
			deployBranch: "main",
		});

		expect(markDocumentsPendingDeploy).toHaveBeenCalled();
	});

	it("ignores a failed run on the watched branch", async () => {
		await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [deployRun({ status: "failure" })],
			deployBranch: "main",
		});

		expect(markDocumentsPendingDeploy).not.toHaveBeenCalled();
	});

	it("ignores a success on a different branch", async () => {
		await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [deployRun({ branch: "feature/x" })],
			deployBranch: "main",
		});

		expect(markDocumentsPendingDeploy).not.toHaveBeenCalled();
	});

	it("treats an unrecognised status as NOT a deploy", async () => {
		// Fail-safe. A provider token nobody anticipated must not spend money.
		await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [deployRun({ status: "neutral" })],
			deployBranch: "main",
		});

		expect(markDocumentsPendingDeploy).not.toHaveBeenCalled();
	});

	it("does nothing when no deploy branch is configured", async () => {
		await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [deployRun()],
		});

		expect(markDocumentsPendingDeploy).not.toHaveBeenCalled();
	});

	it("does not re-trigger on a run that was already ingested", async () => {
		// A retry re-reads the same run. That is not a new deployment, and
		// treating it as one would refresh the documents on every sync.
		ingestPipelineRun.mockResolvedValue({
			pipelineRunId: "r1",
			alreadyIngested: true,
			matched: 0,
			unmatched: 0,
		});

		await ingestNormalizedRuns({
			projectId: "p1",
			organizationId: null,
			userId: null,
			runs: [deployRun()],
			deployBranch: "main",
		});

		expect(markDocumentsPendingDeploy).not.toHaveBeenCalled();
	});
});

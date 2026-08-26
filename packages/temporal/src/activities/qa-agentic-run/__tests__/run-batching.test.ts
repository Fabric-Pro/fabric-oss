/**
 * Durable batching (spec F3) — what crosses a `continueAsNew` boundary, and what
 * must not.
 *
 * A run used to REFUSE more than fifty cases, pushing the platform's limit onto
 * the user as "pick 50". Slicing removes that, but only if two things hold:
 *
 *  1. each slice's detail is PERSISTED before the workflow continues, because
 *     results cannot cross the boundary — workflow input travels the gRPC
 *     transport and this repo has already been burned by the 4 MiB frame limit;
 *  2. a retried slice cannot double-count, since Temporal replays an activity
 *     whose write committed but whose acknowledgement was lost.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stageAgenticCaseResults = vi.fn(
	async (_i: unknown) => ({ staged: 0 }) as { staged: number },
);
const listStagedAgenticCaseResults = vi.fn(
	async (_i: unknown) => [] as never[],
);

vi.mock("@repo/database", () => ({
	stageAgenticCaseResults: (i: unknown) => stageAgenticCaseResults(i),
	listStagedAgenticCaseResults: (i: unknown) =>
		listStagedAgenticCaseResults(i),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { AGENTIC_RUN_BATCH_SIZE, loadStagedAgenticBatches, stageAgenticBatch } =
	await import("../run-batching");

const TENANT = {
	projectId: "p1",
	organizationId: "o1",
	userId: "u1",
	runId: "r1",
};

function caseResult(
	testCaseId: string,
	result: "PASSED" | "FAILED" | "BLOCKED",
) {
	return {
		testCaseId,
		result,
		failureMessage: result === "PASSED" ? null : "boom",
		durationMs: 12,
		modelCalls: 2,
		steps: [
			{
				order: 1,
				action: "click",
				expected: "it works",
				status: result,
				observation: "saw it",
				evidenceKey: null,
			},
		],
	};
}

beforeEach(() => {
	stageAgenticCaseResults.mockClear().mockResolvedValue({ staged: 1 });
	listStagedAgenticCaseResults.mockClear().mockResolvedValue([]);
});

describe("stageAgenticBatch", () => {
	it("persists the slice's detail, including its steps", async () => {
		await stageAgenticBatch({
			...TENANT,
			results: [caseResult("tc1", "FAILED")],
			caseLabels: { tc1: "TC-001 Sign in works" },
		});

		const staged = stageAgenticCaseResults.mock.calls[0][0] as {
			results: Array<{
				testCaseId: string;
				label: string;
				steps: unknown[];
			}>;
		};
		expect(staged.results[0].testCaseId).toBe("tc1");
		expect(staged.results[0].label).toBe("TC-001 Sign in works");
		// The steps are the whole reason staging exists: they cannot cross the
		// continue-as-new boundary, so if they are not written here they are gone.
		expect(staged.results[0].steps).toHaveLength(1);
	});

	it("carries the tenant columns, so the staged row is scoped like its run", async () => {
		await stageAgenticBatch({
			...TENANT,
			results: [caseResult("tc1", "PASSED")],
		});

		expect(stageAgenticCaseResults.mock.calls[0][0]).toMatchObject({
			projectId: "p1",
			organizationId: "o1",
			userId: "u1",
			runId: "r1",
		});
	});

	it("stages a null label rather than inventing one", async () => {
		// A case with no label must not silently acquire its id as a name — that
		// is the raw-cuid heading bug in a different disguise.
		await stageAgenticBatch({
			...TENANT,
			results: [caseResult("tc1", "PASSED")],
		});

		const staged = stageAgenticCaseResults.mock.calls[0][0] as {
			results: Array<{ label: string | null }>;
		};
		expect(staged.results[0].label).toBeNull();
	});
});

describe("loadStagedAgenticBatches", () => {
	it("reassembles results and labels from every slice", async () => {
		listStagedAgenticCaseResults.mockResolvedValue([
			{
				testCaseId: "tc1",
				result: "PASSED",
				failureMessage: null,
				durationMs: 10,
				modelCalls: 2,
				label: "TC-001 One",
				steps: [{ order: 1 }],
			},
			{
				testCaseId: "tc2",
				result: "FAILED",
				failureMessage: "nope",
				durationMs: 20,
				modelCalls: 4,
				label: "TC-002 Two",
				steps: [],
			},
		] as never);

		const { results, caseLabels } = await loadStagedAgenticBatches({
			projectId: "p1",
			runId: "r1",
		});

		expect(results.map((r) => r.testCaseId)).toEqual(["tc1", "tc2"]);
		expect(results[1].failureMessage).toBe("nope");
		expect(caseLabels).toEqual({ tc1: "TC-001 One", tc2: "TC-002 Two" });
	});

	it("degrades a malformed steps column to none, rather than losing the whole run", async () => {
		// `steps` is JSON on the way back. One bad row must not take down the
		// final ingest, because that would lose every OTHER case in the run too.
		listStagedAgenticCaseResults.mockResolvedValue([
			{
				testCaseId: "tc1",
				result: "FAILED",
				failureMessage: null,
				durationMs: 1,
				modelCalls: 1,
				label: null,
				steps: { not: "an array" },
			},
		] as never);

		const { results } = await loadStagedAgenticBatches({
			projectId: "p1",
			runId: "r1",
		});

		expect(results).toHaveLength(1);
		expect(results[0].steps).toEqual([]);
	});

	it("omits a label rather than mapping it to null", async () => {
		listStagedAgenticCaseResults.mockResolvedValue([
			{
				testCaseId: "tc1",
				result: "PASSED",
				failureMessage: null,
				durationMs: 1,
				modelCalls: 1,
				label: null,
				steps: [],
			},
		] as never);

		const { caseLabels } = await loadStagedAgenticBatches({
			projectId: "p1",
			runId: "r1",
		});

		// `caseLabel()` falls back to the id on a MISSING key; a null value would
		// override that fallback with nothing.
		expect(caseLabels).toEqual({});
	});
});

describe("batch size", () => {
	it("is small enough to bound history and large enough to be worth continuing for", () => {
		expect(AGENTIC_RUN_BATCH_SIZE).toBe(10);
	});

	it("agrees with the workflow's own copy", async () => {
		// The workflow restates the number rather than importing it: workflow code
		// is bundled separately and must not pull in an activity's dependency
		// graph. That is a real constraint, but it means the two can drift — and a
		// workflow slicing by a different size than the activity stages by would
		// leave cases neither run nor reported. The comment beside the workflow
		// constant promises this test exists; it does.
		const { WORKFLOW_BATCH_SIZE } = await import(
			"../../../workflows/qa-agentic-run"
		);
		expect(WORKFLOW_BATCH_SIZE).toBe(AGENTIC_RUN_BATCH_SIZE);
	});
});

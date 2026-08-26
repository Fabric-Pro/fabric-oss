/**
 * Workflow-level tests for `contextSummarizationWorkflow` — the degradation
 * boundary that compresses a project's raw context into a stored summary.
 *
 * Property under test: the workflow NEVER throws out into its fire-and-forget
 * callers. Any failure inside the run routes to `notifySummaryFailureActivity`
 * and the workflow RETURNS `{ status: "FAILED" }`; a failed best-effort embed
 * must NOT undo an already-COMPLETED summary.
 *
 * Harness follows the other light workflow tests in this package
 * (`template-instance-execution.test.ts`, `story-sync-workflow.test.ts`): mock
 * `@temporalio/workflow` so `proxyActivities` returns plain `vi.fn()` stubs and
 * `log` is inert, then invoke the workflow as a regular async function with
 * full control over each activity's return value. Deterministic-replay is
 * covered separately by the replay-validation suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	createPendingSummaryActivity: vi.fn(),
	markSummaryGeneratingActivity: vi.fn(),
	fetchContextForSummaryActivity: vi.fn(),
	generateSummaryActivity: vi.fn(),
	persistSummaryActivity: vi.fn(),
	embedSummaryActivity: vi.fn(),
	notifySummaryFailureActivity: vi.fn(),
	cancelSummaryActivity: vi.fn(),
}));

// A fake Temporal cancellation error the workflow recognizes via isCancellation.
class FakeCancelledFailure extends Error {
	constructor() {
		super("cancelled");
		this.name = "CancelledFailure";
	}
}

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	isCancellation: (e: unknown) => e instanceof FakeCancelledFailure,
	CancellationScope: {
		nonCancellable: (fn: () => Promise<unknown>) => fn(),
	},
}));

import {
	type ContextSummarizationInput,
	contextSummarizationWorkflow,
} from "../context-summarization-workflow";

const INPUT: ContextSummarizationInput = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
	trigger: "MANUAL",
	triggeredByUserId: "user-1",
};

const SNAPSHOT_THROUGH = "2026-07-10T00:00:00.000Z";
const COVERED_THROUGH = "2026-07-09T12:00:00.000Z";
const STATS = {
	eligibleSourceCount: 3,
	processedSourceCount: 3,
	deferredSourceCount: 0,
	batchCount: 1,
	inputChars: 42,
	firstProcessedAt: "2026-07-01T00:00:00.000Z",
	lastProcessedAt: COVERED_THROUGH,
	cursorId: "ctx-9",
	cursorCreatedAt: COVERED_THROUGH,
	markerSeq: 3,
	incompleteCoverage: false,
};
const REFERENCES = [
	{
		marker: "S1",
		sourceType: "TEXT",
		sourceId: "ctx-1",
		sourceTimestamp: "2026-07-01T00:00:00.000Z",
		label: "Kickoff",
	},
];

function primeHappyPath(): void {
	activityStubs.createPendingSummaryActivity.mockResolvedValue({
		summaryId: "sum-1",
		snapshotThrough: SNAPSHOT_THROUGH,
	});
	activityStubs.markSummaryGeneratingActivity.mockResolvedValue(undefined);
	activityStubs.fetchContextForSummaryActivity.mockResolvedValue({
		projectName: "Fabric",
	});
	activityStubs.generateSummaryActivity.mockResolvedValue({
		content: "compressed summary [S1]",
		tokenCount: 123,
		model: "gpt-test",
		references: REFERENCES,
		coveredThrough: COVERED_THROUGH,
		coveredContextCount: 3,
		stats: STATS,
		spentInputTokens: 900,
		spentOutputTokens: 200,
		spentCostMicroUsd: 1500,
	});
	activityStubs.persistSummaryActivity.mockResolvedValue(undefined);
	activityStubs.embedSummaryActivity.mockResolvedValue({ embedded: true });
	activityStubs.notifySummaryFailureActivity.mockResolvedValue(undefined);
}

beforeEach(() => {
	vi.clearAllMocks();
	primeHappyPath();
});

describe("contextSummarizationWorkflow — happy path", () => {
	it("returns COMPLETED and runs the activities in order", async () => {
		const out = await contextSummarizationWorkflow(INPUT);

		expect(out).toEqual({ summaryId: "sum-1", status: "COMPLETED" });

		// PENDING row is created with the project's XOR tenancy + trigger.
		expect(activityStubs.createPendingSummaryActivity).toHaveBeenCalledWith(
			{
				projectId: "proj-1",
				tenancy: { userId: "user-1", organizationId: null },
				trigger: "MANUAL",
				triggeredByUserId: "user-1",
			},
		);

		// The TRUE watermark + references + stats produced by generation are
		// threaded into persist (NOT the run-start snapshot).
		expect(activityStubs.persistSummaryActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				summaryId: "sum-1",
				content: "compressed summary [S1]",
				tokenCount: 123,
				model: "gpt-test",
				coveredContextCount: 3,
				coveredThrough: COVERED_THROUGH,
				references: REFERENCES,
				stats: STATS,
			}),
		);

		// Generation is driven by the snapshot, not handed a raw-context payload.
		expect(activityStubs.generateSummaryActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				summaryId: "sum-1",
				projectId: "proj-1",
				snapshotThrough: SNAPSHOT_THROUGH,
			}),
		);

		// Strict ordering: create → markGenerating → fetch → generate → persist → embed.
		const order = [
			activityStubs.createPendingSummaryActivity,
			activityStubs.markSummaryGeneratingActivity,
			activityStubs.fetchContextForSummaryActivity,
			activityStubs.generateSummaryActivity,
			activityStubs.persistSummaryActivity,
			activityStubs.embedSummaryActivity,
		].map((fn) => fn.mock.invocationCallOrder[0]);
		expect(order).toEqual([...order].sort((a, b) => a - b));

		// A clean run never touches the failure boundary.
		expect(
			activityStubs.notifySummaryFailureActivity,
		).not.toHaveBeenCalled();
	});
});

describe("contextSummarizationWorkflow — degradation boundary", () => {
	it("returns FAILED (does not throw) and notifies when generate throws", async () => {
		activityStubs.generateSummaryActivity.mockRejectedValue(
			new Error("LLM unavailable"),
		);

		const out = await contextSummarizationWorkflow(INPUT);

		expect(out).toEqual({ summaryId: "sum-1", status: "FAILED" });
		expect(activityStubs.notifySummaryFailureActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				summaryId: "sum-1",
				projectId: "proj-1",
				tenancy: { userId: "user-1", organizationId: null },
				error: "LLM unavailable",
			}),
		);
		// The run never reached persist/embed.
		expect(activityStubs.persistSummaryActivity).not.toHaveBeenCalled();
		expect(activityStubs.embedSummaryActivity).not.toHaveBeenCalled();
	});

	it("does not raise a failure incident when there is no pending row yet", async () => {
		// createPending itself throws before a summaryId exists → nothing to flip.
		activityStubs.createPendingSummaryActivity.mockRejectedValue(
			new Error("db down"),
		);

		const out = await contextSummarizationWorkflow(INPUT);

		expect(out).toEqual({ summaryId: null, status: "FAILED" });
		expect(
			activityStubs.notifySummaryFailureActivity,
		).not.toHaveBeenCalled();
	});

	it("stays COMPLETED when the best-effort embed step throws", async () => {
		activityStubs.embedSummaryActivity.mockRejectedValue(
			new Error("qdrant down"),
		);

		const out = await contextSummarizationWorkflow(INPUT);

		expect(out).toEqual({ summaryId: "sum-1", status: "COMPLETED" });
		expect(activityStubs.persistSummaryActivity).toHaveBeenCalledTimes(1);
		expect(
			activityStubs.notifySummaryFailureActivity,
		).not.toHaveBeenCalled();
	});

	it("threads the selected sources + real token spend through the run", async () => {
		await contextSummarizationWorkflow({
			...INPUT,
			sources: {
				context: true,
				decisions: false,
				roadmap: true,
				codeRepo: false,
			},
		});

		expect(activityStubs.createPendingSummaryActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceSelection: {
					context: true,
					decisions: false,
					roadmap: true,
					codeRepo: false,
				},
			}),
		);
		expect(activityStubs.generateSummaryActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceSelection: {
					context: true,
					decisions: false,
					roadmap: true,
					codeRepo: false,
				},
			}),
		);
		// The measured spend from generation is persisted, not the digest size.
		expect(activityStubs.persistSummaryActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				spentInputTokens: 900,
				spentOutputTokens: 200,
				spentCostMicroUsd: 1500,
			}),
		);
	});
});

describe("contextSummarizationWorkflow — cancellation", () => {
	it("returns CANCELLED and marks the row without raising a failure incident", async () => {
		activityStubs.generateSummaryActivity.mockRejectedValue(
			new FakeCancelledFailure(),
		);

		const out = await contextSummarizationWorkflow(INPUT);

		expect(out).toEqual({ summaryId: "sum-1", status: "CANCELLED" });
		expect(activityStubs.cancelSummaryActivity).toHaveBeenCalledWith({
			summaryId: "sum-1",
		});
		// Cancellation is not a failure — no incident, no persist.
		expect(
			activityStubs.notifySummaryFailureActivity,
		).not.toHaveBeenCalled();
		expect(activityStubs.persistSummaryActivity).not.toHaveBeenCalled();
	});
});

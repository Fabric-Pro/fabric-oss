/**
 * The pause activity (Fizzy #2770): records the pause, queues a batch's
 * documents under the resume's id, and starts the resume with a start delay
 * and a deterministic id — a second start of the same resume is success.
 */

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordBulkRunPause: vi.fn(),
	getBulkRunPauseStage: vi.fn(),
	claimBulkRunResume: vi.fn(),
	updateManyDocuments: vi.fn(),
	findManyDocuments: vi.fn(),
	start: vi.fn(),
	notifyBulkRunPlanPaused: vi.fn(),
	notifyBulkRunPlanStopped: vi.fn(),
	/** The workflow the activity runs for: the pausing run. */
	pausingWorkflowId: "security-scan-scan-1",
}));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: { workflowId: mocks.pausingWorkflowId },
			},
		}),
	},
}));

vi.mock("@repo/database", () => ({
	recordBulkRunPause: mocks.recordBulkRunPause,
	getBulkRunPauseStage: mocks.getBulkRunPauseStage,
	claimBulkRunResume: mocks.claimBulkRunResume,
	notifyBulkRunPlanPaused: mocks.notifyBulkRunPlanPaused,
	notifyBulkRunPlanStopped: mocks.notifyBulkRunPlanStopped,
	bulkRunResumeWorkflowId: (base: string, count: number) =>
		`${base}-resume-${count}`,
	db: {
		projectDocument: {
			updateMany: mocks.updateManyDocuments,
			findMany: mocks.findManyDocuments,
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../client", () => ({
	getTemporalClient: async () => ({ workflow: { start: mocks.start } }),
}));

import {
	claimBulkRunResumeActivity,
	pauseBulkRunActivity,
} from "../bulk-run-pause";

const HOUR = 60 * 60_000;

const base = {
	kind: "PROJECT_SCAN" as const,
	runId: "scan-1",
	pauseCount: 0,
	workflowIdBase: "security-scan-scan-1",
	workflowType: "securityAccessibilityScanWorkflow",
	taskQueue: "fabric-worker",
	executionTimeoutMs: 90 * 60_000,
	input: { scanId: "scan-1", jobType: "security-scan" },
	progress: { security: { progress: { doneItemKeys: ["a"] } } },
	waitMs: 3 * HOUR,
	resetKnown: true,
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
	mocks.recordBulkRunPause.mockReset();
	mocks.getBulkRunPauseStage.mockReset();
	mocks.getBulkRunPauseStage.mockResolvedValue("pausing");
	mocks.pausingWorkflowId = base.workflowIdBase;
	mocks.claimBulkRunResume.mockReset();
	mocks.updateManyDocuments.mockReset();
	mocks.updateManyDocuments.mockResolvedValue({ count: 0 });
	mocks.findManyDocuments.mockReset();
	mocks.findManyDocuments.mockResolvedValue([]);
	mocks.start.mockReset();
	mocks.notifyBulkRunPlanPaused.mockReset();
	mocks.notifyBulkRunPlanStopped.mockReset();
	mocks.recordBulkRunPause.mockImplementation(async (args) => ({
		status: "paused",
		pauseCount: args.expectedPauseCount + 1,
		resumesAt: args.resumesAt,
	}));
});

describe("pauseBulkRunActivity", () => {
	it("records the pause and starts the resume at the reset, under a derived id", async () => {
		await expect(pauseBulkRunActivity(base)).resolves.toEqual({
			paused: true,
			resumesAt: "2026-10-12T15:00:00.000Z",
			pauseCount: 1,
		});
		expect(mocks.recordBulkRunPause).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				expectedPauseCount: 0,
				resumesAt: new Date("2026-10-12T15:00:00.000Z"),
				resumeWorkflowId: "security-scan-scan-1-resume-1",
				resumeState: {
					workflowType: "securityAccessibilityScanWorkflow",
					taskQueue: "fabric-worker",
					executionTimeoutMs: 90 * 60_000,
					workflowIdBase: "security-scan-scan-1",
					input: base.input,
					progress: base.progress,
				},
			}),
		);
		expect(mocks.start).toHaveBeenCalledWith(
			"securityAccessibilityScanWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "security-scan-scan-1-resume-1",
				args: [
					{
						scanId: "scan-1",
						jobType: "security-scan",
						resumeOf: {
							runId: "scan-1",
							pauseCount: 1,
							workflowIdBase: "security-scan-scan-1",
						},
					},
				],
				startDelay: 3 * HOUR,
				workflowExecutionTimeout: 90 * 60_000,
			},
		);
	});

	it("sleeps an hour when no plan said when it resets", async () => {
		await pauseBulkRunActivity({
			...base,
			waitMs: 30 * 60_000,
			resetKnown: false,
		});
		expect(mocks.start.mock.calls[0]?.[1]).toMatchObject({
			startDelay: HOUR,
		});
	});

	it("treats a resume that is already scheduled as success", async () => {
		mocks.start.mockRejectedValueOnce(
			new WorkflowExecutionAlreadyStartedError(
				"already started",
				"security-scan-scan-1-resume-1",
				"securityAccessibilityScanWorkflow",
			),
		);
		await expect(pauseBulkRunActivity(base)).resolves.toMatchObject({
			paused: true,
		});
	});

	it("starts nothing past the cap, and says why", async () => {
		mocks.recordBulkRunPause.mockResolvedValueOnce({
			status: "cap",
			pauseCount: 6,
		});
		await expect(pauseBulkRunActivity(base)).resolves.toMatchObject({
			paused: false,
			message: expect.stringContaining("every pause"),
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("queues a batch's remaining documents under the resume's id", async () => {
		mocks.pausingWorkflowId = "batch-document-generation-project-1-1";
		await pauseBulkRunActivity({
			...base,
			kind: "DOCUMENT_BATCH",
			runId: "task-1",
			workflowIdBase: "batch-document-generation-project-1-1",
			queuedDocumentIds: ["doc-2", "doc-3"],
		});
		expect(mocks.getBulkRunPauseStage).toHaveBeenCalledWith({
			kind: "DOCUMENT_BATCH",
			runId: "task-1",
			expectedPauseCount: 0,
		});
		expect(mocks.updateManyDocuments).toHaveBeenCalledWith({
			where: {
				id: { in: ["doc-2", "doc-3"] },
				status: { in: ["DRAFT", "QUEUED", "GENERATING"] },
				OR: [
					{ workflowId: null },
					{ workflowId: "batch-document-generation-project-1-1" },
					{
						workflowId: {
							startsWith:
								"batch-document-generation-project-1-1-child-",
						},
					},
				],
			},
			data: {
				status: "QUEUED",
				workflowId: "batch-document-generation-project-1-1-resume-1",
				generationStartedAt: new Date("2026-10-12T12:00:00.000Z"),
				generationProgress: 0,
			},
		});
	});
});

/**
 * The documents a paused batch or setup hands to its resume (Fizzy #2946):
 * only those the run still holds are queued, and the rest leave the resume's
 * input. The rows live in a small table the two document queries read and
 * write by the conditions the activity sends.
 */
describe("pauseBulkRunActivity documents the run no longer holds", () => {
	type Row = { id: string; status: string; workflowId: string | null };
	type Condition = Record<string, unknown>;
	let rows: Map<string, Row>;

	const matchesValue = (value: unknown, condition: unknown): boolean => {
		if (condition === null || typeof condition !== "object") {
			return value === condition;
		}
		const ops = condition as { in?: unknown[]; startsWith?: string };
		if (ops.in) {
			return ops.in.includes(value);
		}
		if (ops.startsWith !== undefined) {
			return (
				typeof value === "string" && value.startsWith(ops.startsWith)
			);
		}
		throw new Error(`Unsupported condition ${JSON.stringify(condition)}`);
	};
	const matches = (row: Row, where: Condition): boolean =>
		Object.entries(where).every(([key, condition]) =>
			key === "OR"
				? (condition as Condition[]).some((arm) => matches(row, arm))
				: matchesValue(row[key as keyof Row], condition),
		);

	const BATCH_BASE = "batch-document-generation-project-1-1";
	const batch = {
		...base,
		kind: "DOCUMENT_BATCH" as const,
		runId: "task-1",
		workflowIdBase: BATCH_BASE,
		workflowType: "batchDocumentGenerationWorkflow",
		input: {
			projectId: "project-1",
			aiToken: "",
			documents: [
				{ id: "doc-2", type: "PROPOSAL" },
				{ id: "doc-3", type: "PRD" },
			],
		},
		progress: { results: [{ documentId: "doc-1", status: "success" }] },
		queuedDocumentIds: ["doc-2", "doc-3"],
	};

	const savedDocuments = (call = 0) =>
		(
			mocks.recordBulkRunPause.mock.calls[call]?.[0] as {
				resumeState: { input: { documents: Array<{ id: string }> } };
			}
		).resumeState.input.documents.map((doc) => doc.id);
	const startedDocuments = (call = 0) =>
		(
			mocks.start.mock.calls[call]?.[1] as {
				args: Array<{ documents: Array<{ id: string }> }>;
			}
		).args[0]?.documents.map((doc) => doc.id);

	beforeEach(() => {
		rows = new Map();
		mocks.pausingWorkflowId = BATCH_BASE;
		mocks.updateManyDocuments.mockImplementation(
			async ({
				where,
				data,
			}: {
				where: Condition;
				data: Partial<Row>;
			}) => {
				let count = 0;
				for (const row of rows.values()) {
					if (matches(row, where)) {
						Object.assign(row, data);
						count++;
					}
				}
				return { count };
			},
		);
		mocks.findManyDocuments.mockImplementation(
			async ({ where }: { where: Condition }) =>
				[...rows.values()]
					.filter((row) => matches(row, where))
					.map((row) => ({ id: row.id })),
		);
	});

	const seed = (...seeded: Row[]) => {
		for (const row of seeded) {
			rows.set(row.id, { ...row });
		}
	};

	it("queues the documents a first run still holds: the paused one and those it never reached", async () => {
		seed(
			{ id: "doc-2", status: "GENERATING", workflowId: null },
			{ id: "doc-3", status: "DRAFT", workflowId: null },
		);

		await pauseBulkRunActivity(batch);

		for (const id of ["doc-2", "doc-3"]) {
			expect(rows.get(id)).toMatchObject({
				status: "QUEUED",
				workflowId: `${BATCH_BASE}-resume-1`,
			});
		}
		expect(savedDocuments()).toEqual(["doc-2", "doc-3"]);
		expect(startedDocuments()).toEqual(["doc-2", "doc-3"]);
	});

	it("does not reopen a document a save over its stalled run completed, and leaves it out of the resume", async () => {
		seed(
			// A person's editor save over the silent run ended it: complete,
			// its run token cleared, the workflow id left as it was.
			{ id: "doc-2", status: "COMPLETE", workflowId: null },
			{ id: "doc-3", status: "DRAFT", workflowId: null },
		);

		await expect(pauseBulkRunActivity(batch)).resolves.toMatchObject({
			paused: true,
		});

		expect(rows.get("doc-2")).toEqual({
			id: "doc-2",
			status: "COMPLETE",
			workflowId: null,
		});
		expect(rows.get("doc-3")?.status).toBe("QUEUED");
		expect(savedDocuments()).toEqual(["doc-3"]);
		expect(startedDocuments()).toEqual(["doc-3"]);
		// What the batch finished stays as it was.
		expect(
			mocks.recordBulkRunPause.mock.calls[0]?.[0].resumeState.progress,
		).toEqual(batch.progress);
	});

	it("leaves a document a newer generation owns to it, and out of the resume", async () => {
		seed(
			{
				id: "doc-2",
				status: "GENERATING",
				workflowId: "project-document-generation-doc-2-0123abcd",
			},
			{
				id: "doc-3",
				status: "QUEUED",
				workflowId: "project-document-generation-doc-3-4567ef01",
			},
		);

		await pauseBulkRunActivity(batch);

		expect(rows.get("doc-2")).toEqual({
			id: "doc-2",
			status: "GENERATING",
			workflowId: "project-document-generation-doc-2-0123abcd",
		});
		expect(rows.get("doc-3")).toEqual({
			id: "doc-3",
			status: "QUEUED",
			workflowId: "project-document-generation-doc-3-4567ef01",
		});
		expect(savedDocuments()).toEqual([]);
		expect(startedDocuments()).toEqual([]);
	});

	it("queues the documents a resumed run holds under its own ids and its children's", async () => {
		mocks.pausingWorkflowId = `${BATCH_BASE}-resume-1-api`;
		seed(
			// The Proposal child of a Run-now resume recorded its workflow
			// when it claimed its live preview.
			{
				id: "doc-2",
				status: "GENERATING",
				workflowId: `${BATCH_BASE}-resume-1-api-child-doc-2`,
			},
			{
				id: "doc-3",
				status: "QUEUED",
				workflowId: `${BATCH_BASE}-resume-1-api`,
			},
		);

		await pauseBulkRunActivity({ ...batch, pauseCount: 1 });

		for (const id of ["doc-2", "doc-3"]) {
			expect(rows.get(id)).toMatchObject({
				status: "QUEUED",
				workflowId: `${BATCH_BASE}-resume-2`,
			});
		}
		expect(savedDocuments()).toEqual(["doc-2", "doc-3"]);
	});

	it("counts the documents a retried pause's first attempt already queued", async () => {
		seed(
			{ id: "doc-2", status: "GENERATING", workflowId: null },
			{ id: "doc-3", status: "DRAFT", workflowId: null },
		);
		mocks.start.mockRejectedValueOnce(new Error("temporal down"));
		await expect(pauseBulkRunActivity(batch)).rejects.toThrow(
			"temporal down",
		);
		expect(rows.get("doc-2")?.workflowId).toBe(`${BATCH_BASE}-resume-1`);

		// The first attempt recorded the pause; the run waits on it.
		mocks.getBulkRunPauseStage.mockResolvedValue("paused");
		await expect(pauseBulkRunActivity(batch)).resolves.toMatchObject({
			paused: true,
		});

		expect(savedDocuments(1)).toEqual(["doc-2", "doc-3"]);
		expect(startedDocuments(0)).toEqual(["doc-2", "doc-3"]);
		expect(startedDocuments(1)).toEqual(["doc-2", "doc-3"]);
	});

	it("saves and starts a retry without a queued document a newer generation took after the failed schedule", async () => {
		seed(
			{ id: "doc-2", status: "GENERATING", workflowId: null },
			{ id: "doc-3", status: "DRAFT", workflowId: null },
		);
		mocks.start.mockRejectedValueOnce(new Error("temporal down"));
		await expect(pauseBulkRunActivity(batch)).rejects.toThrow(
			"temporal down",
		);
		expect(savedDocuments(0)).toEqual(["doc-2", "doc-3"]);
		// No resume exists to answer for doc-3, so a person's generation of
		// it took the row.
		Object.assign(rows.get("doc-3") ?? {}, {
			workflowId: "project-document-generation-doc-3-4567ef01",
		});

		mocks.getBulkRunPauseStage.mockResolvedValue("paused");
		await pauseBulkRunActivity(batch);

		expect(rows.get("doc-3")).toMatchObject({
			status: "QUEUED",
			workflowId: "project-document-generation-doc-3-4567ef01",
		});
		// The retry's set is what it saves over the first attempt's and
		// what it starts the resume with.
		expect(savedDocuments(1)).toEqual(["doc-2"]);
		expect(startedDocuments(1)).toEqual(["doc-2"]);
	});

	it("leaves a run Run now took back, and its documents, alone on a retry", async () => {
		// The first attempt queued both and recorded the pause, then its
		// schedule failed; Run now moved them to its resume, which started.
		seed(
			{
				id: "doc-2",
				status: "GENERATING",
				workflowId: `${BATCH_BASE}-resume-1-api`,
			},
			{
				id: "doc-3",
				status: "QUEUED",
				workflowId: `${BATCH_BASE}-resume-1-api`,
			},
		);
		mocks.getBulkRunPauseStage.mockResolvedValue("resumed");

		await expect(pauseBulkRunActivity(batch)).resolves.toEqual({
			paused: true,
			resumesAt: "2026-10-12T12:00:00.000Z",
			pauseCount: 1,
		});

		expect(rows.get("doc-2")?.status).toBe("GENERATING");
		expect(rows.get("doc-3")?.workflowId).toBe(
			`${BATCH_BASE}-resume-1-api`,
		);
		expect(mocks.updateManyDocuments).not.toHaveBeenCalled();
		expect(mocks.recordBulkRunPause).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.notifyBulkRunPlanPaused).not.toHaveBeenCalled();
	});

	it("never takes back documents Run now moved while a retry was on its way, and starts nothing", async () => {
		seed(
			{
				id: "doc-2",
				status: "GENERATING",
				workflowId: `${BATCH_BASE}-resume-1-api`,
			},
			{
				id: "doc-3",
				status: "QUEUED",
				workflowId: `${BATCH_BASE}-resume-1-api`,
			},
		);
		// Still waiting when the retry looked; Run now landed right after.
		mocks.getBulkRunPauseStage.mockResolvedValue("paused");
		mocks.recordBulkRunPause.mockResolvedValue({
			status: "resumed",
			pauseCount: 1,
		});

		await expect(pauseBulkRunActivity(batch)).resolves.toMatchObject({
			paused: true,
			pauseCount: 1,
		});

		expect(rows.get("doc-2")).toEqual({
			id: "doc-2",
			status: "GENERATING",
			workflowId: `${BATCH_BASE}-resume-1-api`,
		});
		expect(rows.get("doc-3")).toEqual({
			id: "doc-3",
			status: "QUEUED",
			workflowId: `${BATCH_BASE}-resume-1-api`,
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("leaves the documents of a run cancelled meanwhile alone", async () => {
		seed({ id: "doc-2", status: "GENERATING", workflowId: null });
		mocks.getBulkRunPauseStage.mockResolvedValue("gone");

		await expect(pauseBulkRunActivity(batch)).resolves.toMatchObject({
			paused: false,
		});

		expect(rows.get("doc-2")?.status).toBe("GENERATING");
		expect(mocks.recordBulkRunPause).not.toHaveBeenCalled();
	});

	it("marks a setup's document it no longer holds finished, so its resume skips it", async () => {
		const SETUP_BASE = "existing-setup-project-1-1";
		mocks.pausingWorkflowId = SETUP_BASE;
		seed(
			// The paused Proposal child recorded its workflow on the document.
			{
				id: "doc-2",
				status: "GENERATING",
				workflowId: `${SETUP_BASE}-doc-doc-2`,
			},
			// Created GENERATING, never reached.
			{ id: "doc-3", status: "GENERATING", workflowId: null },
			// A person's own generation took it meanwhile.
			{
				id: "doc-4",
				status: "QUEUED",
				workflowId: "project-document-generation-doc-4-89ab0123",
			},
		);
		const progress = {
			analysisDone: true,
			backlogDone: true,
			documents: [
				{ id: "doc-1", type: "PRD" },
				{ id: "doc-2", type: "PROPOSAL" },
				{ id: "doc-3", type: "ARCHITECTURE" },
				{ id: "doc-4", type: "TECHNICAL_SPEC" },
			],
			documentIds: ["doc-1"],
			finishedDocumentIds: ["doc-1"],
		};

		await pauseBulkRunActivity({
			...base,
			kind: "PROJECT_SETUP",
			runId: "setup-task-1",
			workflowIdBase: SETUP_BASE,
			workflowType: "existingProjectSetupWorkflow",
			input: { projectId: "project-1", aiToken: "" },
			progress,
			queuedDocumentIds: ["doc-2", "doc-3", "doc-4"],
		});

		for (const id of ["doc-2", "doc-3"]) {
			expect(rows.get(id)).toMatchObject({
				status: "QUEUED",
				workflowId: `${SETUP_BASE}-resume-1`,
			});
		}
		expect(rows.get("doc-4")?.workflowId).toBe(
			"project-document-generation-doc-4-89ab0123",
		);
		expect(
			mocks.recordBulkRunPause.mock.calls[0]?.[0].resumeState,
		).toMatchObject({
			input: { projectId: "project-1", aiToken: "" },
			progress: {
				...progress,
				documentIds: ["doc-1"],
				finishedDocumentIds: ["doc-1", "doc-4"],
			},
		});
	});
});

describe("claimBulkRunResumeActivity", () => {
	it("hands back the saved progress when the claim wins", async () => {
		mocks.claimBulkRunResume.mockResolvedValueOnce({
			progress: base.progress,
		});
		await expect(
			claimBulkRunResumeActivity({
				kind: "PROJECT_SCAN",
				resumeOf: {
					runId: "scan-1",
					pauseCount: 1,
					workflowIdBase: "security-scan-scan-1",
				},
				viaApiOverride: true,
			}),
		).resolves.toEqual({ claimed: true, progress: base.progress });
		expect(mocks.claimBulkRunResume).toHaveBeenCalledWith({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			pauseCount: 1,
			viaApiOverride: true,
		});
	});

	it("says so when it lost", async () => {
		mocks.claimBulkRunResume.mockResolvedValueOnce(null);
		await expect(
			claimBulkRunResumeActivity({
				kind: "SCAN_REVIEW",
				resumeOf: {
					runId: "review-1",
					pauseCount: 1,
					workflowIdBase: "scan-review-1",
				},
				viaApiOverride: false,
			}),
		).resolves.toEqual({ claimed: false });
	});
});

describe("pauseBulkRunActivity notices (Fizzy #3050)", () => {
	it("announces a run's first pause, after its resume is scheduled", async () => {
		await pauseBulkRunActivity(base);

		expect(mocks.notifyBulkRunPlanPaused).toHaveBeenCalledTimes(1);
		expect(mocks.notifyBulkRunPlanPaused).toHaveBeenCalledWith({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			resumesAt: new Date("2026-10-12T15:00:00.000Z"),
			now: new Date("2026-10-12T12:00:00.000Z"),
		});
		expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.notifyBulkRunPlanPaused.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("stays quiet on every later pause of the same run", async () => {
		for (const pauseCount of [1, 2, 5]) {
			await pauseBulkRunActivity({ ...base, pauseCount });
		}
		expect(mocks.notifyBulkRunPlanPaused).not.toHaveBeenCalled();
	});

	it("announces nothing when the resume could not be scheduled, so the retry is the one that tells", async () => {
		mocks.start.mockRejectedValueOnce(new Error("temporal down"));
		await expect(pauseBulkRunActivity(base)).rejects.toThrow(
			"temporal down",
		);
		expect(mocks.notifyBulkRunPlanPaused).not.toHaveBeenCalled();

		await pauseBulkRunActivity(base);
		expect(mocks.notifyBulkRunPlanPaused).toHaveBeenCalledTimes(1);
	});

	it("announces the stop when the run reached its pause cap", async () => {
		mocks.recordBulkRunPause.mockResolvedValue({
			status: "cap",
			pauseCount: 6,
		});
		await pauseBulkRunActivity({ ...base, pauseCount: 6 });

		expect(mocks.notifyBulkRunPlanStopped).toHaveBeenCalledWith({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			reason: "PLAN_SPENT",
		});
		expect(mocks.notifyBulkRunPlanPaused).not.toHaveBeenCalled();
	});

	it("announces nothing for a run that was cancelled meanwhile", async () => {
		mocks.recordBulkRunPause.mockResolvedValue({ status: "gone" });
		await pauseBulkRunActivity(base);
		expect(mocks.notifyBulkRunPlanPaused).not.toHaveBeenCalled();
		expect(mocks.notifyBulkRunPlanStopped).not.toHaveBeenCalled();
	});
});

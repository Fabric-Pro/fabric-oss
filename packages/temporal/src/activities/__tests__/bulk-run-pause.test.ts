/**
 * The pause activity (Fizzy #2770): records the pause, queues a batch's
 * documents under the resume's id, and starts the resume with a start delay
 * and a deterministic id — a second start of the same resume is success.
 */

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordBulkRunPause: vi.fn(),
	claimBulkRunResume: vi.fn(),
	updateManyDocuments: vi.fn(),
	start: vi.fn(),
	notifyBulkRunPlanPaused: vi.fn(),
	notifyBulkRunPlanStopped: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	recordBulkRunPause: mocks.recordBulkRunPause,
	claimBulkRunResume: mocks.claimBulkRunResume,
	notifyBulkRunPlanPaused: mocks.notifyBulkRunPlanPaused,
	notifyBulkRunPlanStopped: mocks.notifyBulkRunPlanStopped,
	bulkRunResumeWorkflowId: (base: string, count: number) =>
		`${base}-resume-${count}`,
	db: { projectDocument: { updateMany: mocks.updateManyDocuments } },
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
	mocks.claimBulkRunResume.mockReset();
	mocks.updateManyDocuments.mockReset();
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
		await pauseBulkRunActivity({
			...base,
			kind: "DOCUMENT_BATCH",
			runId: "task-1",
			workflowIdBase: "batch-document-generation-project-1-1",
			queuedDocumentIds: ["doc-2", "doc-3"],
		});
		expect(mocks.updateManyDocuments).toHaveBeenCalledWith({
			where: { id: { in: ["doc-2", "doc-3"] } },
			data: {
				status: "QUEUED",
				workflowId: "batch-document-generation-project-1-1-resume-1",
				generationStartedAt: new Date("2026-10-12T12:00:00.000Z"),
				generationProgress: 0,
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

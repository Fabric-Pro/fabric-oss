/**
 * A newer setup of a project replaces one paused for a ChatGPT plan reset
 * (Fizzy #2770), by the same path as Cancel: the run ends FAILED, the
 * project's analysis and the documents queued for its resume are closed, and
 * the scheduled resume is stopped — it can never write over the newer setup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getPausedProjectSetup: vi.fn(),
	cancelPausedBulkRun: vi.fn(),
	closePausedProjectSetup: vi.fn(),
	terminate: vi.fn(),
	getHandle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	bulkRunResumeWorkflowId: (base: string, count: number) =>
		`${base}-resume-${count}`,
	getPausedProjectSetup: mocks.getPausedProjectSetup,
	cancelPausedBulkRun: mocks.cancelPausedBulkRun,
	closePausedProjectSetup: mocks.closePausedProjectSetup,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: mocks.getHandle },
	}),
}));

import { cancelPausedSetupsOfProject } from "../paused-setup";

const scope = { projectId: "project-1", organizationId: "org-1", userId: "u" };
const resumeState = {
	workflowType: "existingProjectSetupWorkflow",
	taskQueue: "project-documents",
	workflowIdBase: "existing-setup-project-1-1",
	input: { projectId: "project-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getHandle.mockImplementation(() => ({ terminate: mocks.terminate }));
});

describe("cancelPausedSetupsOfProject", () => {
	it("cancels the paused setup, closes its project's analysis and queued documents, and stops its resume", async () => {
		mocks.getPausedProjectSetup
			.mockResolvedValueOnce({ id: "task-1" })
			.mockResolvedValueOnce(null);
		mocks.cancelPausedBulkRun.mockResolvedValue({
			pauseCount: 2,
			resumeState,
		});

		await expect(cancelPausedSetupsOfProject(scope)).resolves.toBe(1);

		expect(mocks.getPausedProjectSetup).toHaveBeenCalledWith(scope);
		expect(mocks.cancelPausedBulkRun).toHaveBeenCalledWith({
			kind: "PROJECT_SETUP",
			runId: "task-1",
			message: expect.stringContaining("A newer setup"),
		});
		expect(mocks.closePausedProjectSetup).toHaveBeenCalledWith({
			resumeState,
			pauseCount: 2,
			message: expect.stringContaining("A newer setup"),
		});
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"existing-setup-project-1-1-resume-2",
		);
		expect(mocks.terminate).toHaveBeenCalled();
	});

	it("does nothing when no setup of the project is paused", async () => {
		mocks.getPausedProjectSetup.mockResolvedValue(null);

		await expect(cancelPausedSetupsOfProject(scope)).resolves.toBe(0);
		expect(mocks.cancelPausedBulkRun).not.toHaveBeenCalled();
		expect(mocks.terminate).not.toHaveBeenCalled();
	});

	it("closes nothing for a setup whose resume claimed it first", async () => {
		mocks.getPausedProjectSetup
			.mockResolvedValueOnce({ id: "task-1" })
			.mockResolvedValueOnce(null);
		mocks.cancelPausedBulkRun.mockResolvedValue(null);

		await expect(cancelPausedSetupsOfProject(scope)).resolves.toBe(0);
		expect(mocks.closePausedProjectSetup).not.toHaveBeenCalled();
		expect(mocks.terminate).not.toHaveBeenCalled();
	});
});

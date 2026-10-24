/**
 * The scheduled recurring-error sweep: one child per opted-in project, under a
 * project-scoped workflow id, so a tick that overlaps a still-running scan
 * collapses onto it instead of scanning the project twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	listProjectsDueForRecurringErrorScanActivity: vi.fn(),
	scanRecurringErrorsForProject: vi.fn(),
}));

const startChildMock = vi.hoisted(() => vi.fn());

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => activityStubs,
	startChild: (...args: unknown[]) => startChildMock(...args),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

// The real class, so the workflow's `instanceof` behaves as in production.
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	recurringErrorScanProjectWorkflow,
	recurringErrorScanWorkflowId,
	recurringErrorSweepWorkflow,
} from "../recurring-error-scan";

function project(id: string, organizationId: string | null = "org_example") {
	return {
		projectId: id,
		organizationId,
		userId: "user_owner",
		threshold: 5,
		windowHours: 24,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	startChildMock.mockResolvedValue({ workflowId: "child" });
});

describe("recurringErrorSweepWorkflow", () => {
	it("starts one scan per opted-in project with its own settings", async () => {
		activityStubs.listProjectsDueForRecurringErrorScanActivity.mockResolvedValue(
			[project("p1"), project("p2", null)],
		);

		const result = await recurringErrorSweepWorkflow({});

		expect(result).toEqual({
			considered: 2,
			started: 2,
			alreadyRunning: 0,
		});
		const [, options] = startChildMock.mock.calls[1];
		expect(options).toMatchObject({
			workflowId: "recurring-error-scan-p2",
			parentClosePolicy: "ABANDON",
			args: [
				{
					projectId: "p2",
					organizationId: null,
					userId: "user_owner",
					threshold: 5,
					windowHours: 24,
				},
			],
		});
	});

	it("counts an overlapping scan as already running, not as a failure", async () => {
		activityStubs.listProjectsDueForRecurringErrorScanActivity.mockResolvedValue(
			[project("p1"), project("p2")],
		);
		startChildMock.mockRejectedValueOnce(
			new WorkflowExecutionAlreadyStartedError(
				"already started",
				recurringErrorScanWorkflowId("p1"),
				"recurringErrorScanProjectWorkflow",
			),
		);

		const result = await recurringErrorSweepWorkflow();

		expect(result).toEqual({
			considered: 2,
			started: 1,
			alreadyRunning: 1,
		});
	});

	it("surfaces any other start failure", async () => {
		activityStubs.listProjectsDueForRecurringErrorScanActivity.mockResolvedValue(
			[project("p1")],
		);
		startChildMock.mockRejectedValueOnce(
			new Error("namespace unavailable"),
		);

		await expect(recurringErrorSweepWorkflow()).rejects.toThrow(
			"namespace unavailable",
		);
	});

	it("runs an empty sweep when nobody opted in", async () => {
		activityStubs.listProjectsDueForRecurringErrorScanActivity.mockResolvedValue(
			[],
		);

		expect(await recurringErrorSweepWorkflow()).toEqual({
			considered: 0,
			started: 0,
			alreadyRunning: 0,
		});
		expect(startChildMock).not.toHaveBeenCalled();
	});
});

describe("recurringErrorScanProjectWorkflow", () => {
	it("delegates to the scan activity", async () => {
		const input = project("p1");
		activityStubs.scanRecurringErrorsForProject.mockResolvedValue({
			status: "completed",
		});

		expect(await recurringErrorScanProjectWorkflow(input)).toEqual({
			status: "completed",
		});
		expect(
			activityStubs.scanRecurringErrorsForProject,
		).toHaveBeenCalledWith(input);
	});
});

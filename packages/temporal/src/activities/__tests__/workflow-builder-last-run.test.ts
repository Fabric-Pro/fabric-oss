/**
 * `Workflow.lastRunAt` is stamped when a run moves to RUNNING, and only then.
 *
 * The stamp goes out before the activity's own RUNNING status write, which
 * overwrites the row unconditionally: the stamp's guard is that the execution
 * is still live (PENDING or RUNNING), so a run already cancelled, failed or
 * completed is not counted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentContextMock, recordRunStartedMock, updateExecutionMock } =
	vi.hoisted(() => ({
		currentContextMock: vi.fn(),
		recordRunStartedMock: vi.fn(),
		updateExecutionMock: vi.fn(),
	}));

vi.mock("@temporalio/activity", () => ({
	Context: { current: currentContextMock },
	heartbeat: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	recordWorkflowRunStarted: recordRunStartedMock,
	updateWorkflowExecution: updateExecutionMock,
	// Everything else the activity module pulls in at import time.
	createExecutionLog: vi.fn(),
	updateExecutionLog: vi.fn(),
	getWorkflowById: vi.fn(),
	isProjectReadOnly: vi.fn(),
}));

import { updateWorkflowExecutionStatus } from "../workflow-builder-execution";

const STARTED_AT = new Date("2026-10-17T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	currentContextMock.mockImplementation(() => {
		throw new Error("No activity context");
	});
	recordRunStartedMock.mockResolvedValue(1);
	updateExecutionMock.mockResolvedValue({ id: "exec-1" });
});

describe("updateWorkflowExecutionStatus → Workflow.lastRunAt", () => {
	it("records the actual Temporal workflow ID for a scheduled child once it is running", async () => {
		currentContextMock.mockReturnValue({
			info: {
				workflowExecution: {
					workflowId: "workflow-execution-example",
					runId: "example-run",
				},
			},
		});
		await updateWorkflowExecutionStatus({
			executionId: "exec-1",
			status: "RUNNING",
			startedAt: STARTED_AT,
		});
		expect(updateExecutionMock).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({
				temporalRunId: "workflow-execution-example",
			}),
		);
	});
	it("does not invent a Temporal ID outside an activity context", async () => {
		await updateWorkflowExecutionStatus({
			executionId: "exec-1",
			status: "RUNNING",
			startedAt: STARTED_AT,
		});
		expect(updateExecutionMock.mock.calls[0][1]).not.toHaveProperty(
			"temporalRunId",
		);
	});
	it("stamps the run start before writing RUNNING", async () => {
		await updateWorkflowExecutionStatus({
			executionId: "exec-1",
			status: "RUNNING",
			startedAt: STARTED_AT,
		});

		expect(recordRunStartedMock).toHaveBeenCalledWith({
			executionId: "exec-1",
			startedAt: STARTED_AT,
		});
		expect(recordRunStartedMock.mock.invocationCallOrder[0]).toBeLessThan(
			updateExecutionMock.mock.invocationCallOrder[0],
		);
	});

	it.each(["COMPLETED", "FAILED", "CANCELLED"])(
		"does not stamp on %s",
		async (status) => {
			await updateWorkflowExecutionStatus({
				executionId: "exec-1",
				status,
				completedAt: STARTED_AT,
			});

			expect(recordRunStartedMock).not.toHaveBeenCalled();
			expect(updateExecutionMock).toHaveBeenCalledTimes(1);
		},
	);

	it("does not stamp a RUNNING write that carries no start time", async () => {
		await updateWorkflowExecutionStatus({
			executionId: "exec-1",
			status: "RUNNING",
		});

		expect(recordRunStartedMock).not.toHaveBeenCalled();
	});
});

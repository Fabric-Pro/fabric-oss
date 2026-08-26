import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockFindByWorkflowId,
	mockCreateExecution,
	mockUpdateExecution,
	mockClaimAndAdvance,
	mockComputeNext,
	mockGetClient,
	mockStart,
	mockGetScheduleMode,
} = vi.hoisted(() => ({
	mockFindByWorkflowId: vi.fn(),
	mockCreateExecution: vi.fn(),
	mockUpdateExecution: vi.fn(),
	mockClaimAndAdvance: vi.fn(),
	mockComputeNext: vi.fn(),
	mockGetClient: vi.fn(),
	mockStart: vi.fn(),
	mockGetScheduleMode: vi.fn(),
}));

// heartbeat() throws outside a real activity context — no-op it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

// Real instanceof-able error class so the activity's `err instanceof ...` branch works.
vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	findExecutionByWorkflowId: (...a: unknown[]) => mockFindByWorkflowId(...a),
	createTemplateInstanceExecution: (...a: unknown[]) =>
		mockCreateExecution(...a),
	updateTemplateInstanceExecution: (...a: unknown[]) =>
		mockUpdateExecution(...a),
	claimAndAdvanceScheduledInstance: (...a: unknown[]) =>
		mockClaimAndAdvance(...a),
	computeNextRunAt: (...a: unknown[]) => mockComputeNext(...a),
	getInstanceScheduleMode: (...a: unknown[]) => mockGetScheduleMode(...a),
}));

// From src/activities/scheduled-report/__tests__/ → ../../../client resolves to the
// same src/client the activity imports as ../../client.
vi.mock("../../../client", () => ({ getTemporalClient: mockGetClient }));

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { dispatchScheduledReportActivity } from "../dispatch-scheduled-report";

const row = {
	id: "i1",
	schedule: { frequency: "daily" } as never,
	nextRunAt: "2026-06-24T09:00:00.000Z",
	userId: "u1",
	organizationId: null,
};
const NEXT = new Date("2026-06-25T09:00:00.000Z");
const wfId = `scheduled-report-i1-${new Date(row.nextRunAt).getTime()}`;

beforeEach(() => {
	vi.clearAllMocks();
	mockFindByWorkflowId.mockResolvedValue(null);
	mockCreateExecution.mockResolvedValue({ id: "e1" });
	mockUpdateExecution.mockResolvedValue({});
	mockClaimAndAdvance.mockResolvedValue(true);
	mockComputeNext.mockReturnValue(NEXT);
	mockStart.mockResolvedValue({ firstExecutionRunId: "r1" });
	mockGetClient.mockResolvedValue({ workflow: { start: mockStart } });
	mockGetScheduleMode.mockResolvedValue("INHERITED");
});

describe("dispatchScheduledReportActivity", () => {
	it("uses a deterministic workflowId keyed on instanceId+dueAt, REJECT_DUPLICATE/FAIL, and the row's own tenant", async () => {
		await dispatchScheduledReportActivity(row);
		expect(mockCreateExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: "i1",
				userId: "u1",
				organizationId: undefined,
				workflowId: wfId,
			}),
		);
		expect(mockStart).toHaveBeenCalledWith(
			"templateInstanceExecutionWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: wfId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					expect.objectContaining({
						executionId: "e1",
						instanceId: "i1",
						userId: "u1",
						organizationId: undefined,
					}),
				],
			}),
		);
	});

	it("advances nextRunAt LAST via CAS using the observed dueAt", async () => {
		await dispatchScheduledReportActivity(row);
		expect(mockClaimAndAdvance).toHaveBeenCalledWith(
			"i1",
			new Date(row.nextRunAt),
			NEXT,
		);
		// start happened before the advance
		expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(
			mockClaimAndAdvance.mock.invocationCallOrder[0],
		);
	});

	it("labels schedule-dispatched runs as scheduled-report for usage attribution (Fizzy #1894)", async () => {
		await dispatchScheduledReportActivity(row);

		expect(mockStart).toHaveBeenCalledWith(
			"templateInstanceExecutionWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({ jobType: "scheduled-report" }),
				],
			}),
		);
	});

	it("reuses an existing execution row on retry (create-or-get by workflowId)", async () => {
		mockFindByWorkflowId.mockResolvedValue({
			id: "e1",
			instanceId: "i1",
			status: "PENDING",
		});
		await dispatchScheduledReportActivity(row);
		expect(mockCreateExecution).not.toHaveBeenCalled();
		expect(mockStart).toHaveBeenCalled();
	});

	it("treats WorkflowExecutionAlreadyStartedError as success and still advances", async () => {
		mockStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already started",
				"wf",
				"rt",
			),
		);
		await expect(
			dispatchScheduledReportActivity(row),
		).resolves.toBeUndefined();
		expect(mockClaimAndAdvance).toHaveBeenCalled();
	});

	it("rethrows a transient start error (retryable) WITHOUT advancing nextRunAt", async () => {
		mockStart.mockRejectedValue(new Error("temporal down"));
		await expect(dispatchScheduledReportActivity(row)).rejects.toThrow(
			"temporal down",
		);
		expect(mockClaimAndAdvance).not.toHaveBeenCalled();
		expect(mockUpdateExecution).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILED" }),
		);
	});

	it("no-ops (no execution row, no workflow.start) when the instance was switched OFF after find-due", async () => {
		mockGetScheduleMode.mockResolvedValue("OFF");
		await expect(
			dispatchScheduledReportActivity(row),
		).resolves.toBeUndefined();
		expect(mockCreateExecution).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
		expect(mockClaimAndAdvance).not.toHaveBeenCalled();
	});
});

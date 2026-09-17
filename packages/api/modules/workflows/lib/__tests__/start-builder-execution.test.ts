/**
 * The shared builder-run start.
 *
 * Five trigger surfaces go through this. What they must agree on — and what
 * two of them used to get wrong — is pinned here once: the registered
 * workflow type, the id scheme the cancel paths derive from the row, the
 * queue the dedicated worker listens on, and a run ceiling.
 *
 * And what a failed start CALL means. Every caller used to treat any throw
 * as "never started" and fail the row; a start that Temporal accepted before
 * the client timed out was then retried under a NEW row, so both ran. The
 * outcome protocol here is the coding-run and Weave one: an already-started
 * error confirms the run, any other error is settled by describing the
 * deterministic id, and only a typed not-found releases the row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { startMock, cancelMock, describeMock, getHandleMock } = vi.hoisted(
	() => ({
		startMock: vi.fn(),
		cancelMock: vi.fn(),
		describeMock: vi.fn(),
		getHandleMock: vi.fn(),
	}),
);

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: startMock, getHandle: getHandleMock },
	}),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: Record<string, unknown>) => ({
		...o,
		memo: { correlationId: "corr-1" },
	}),
}));

import {
	attemptWorkflowBuilderStart,
	builderWorkflowIdFor,
	cancelWorkflowBuilderExecution,
	WORKFLOW_BUILDER_WORKFLOW_TYPE,
} from "../start-builder-execution";

/** Temporal's typed errors are matched by name, so a named Error stands in. */
function temporalError(name: string, message = name): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

beforeEach(() => {
	vi.clearAllMocks();
	startMock.mockResolvedValue({
		workflowId: "workflow-execution-exec-1",
		firstExecutionRunId: "run-1",
	});
	getHandleMock.mockReturnValue({
		cancel: cancelMock,
		describe: describeMock,
	});
	cancelMock.mockResolvedValue(undefined);
	describeMock.mockResolvedValue({ runId: "run-1" });
});

const input = {
	executionId: "exec-1",
	workflowId: "wf-1",
	userId: "user-1",
	organizationId: "org-1",
	triggerData: { hello: "world" },
};

describe("builderWorkflowIdFor", () => {
	it("derives the Temporal id from the execution row alone", () => {
		expect(builderWorkflowIdFor("exec-1")).toBe(
			"workflow-execution-exec-1",
		);
	});
});

describe("attemptWorkflowBuilderStart", () => {
	it("starts the registered workflow type — not a name Temporal has never heard of", async () => {
		await attemptWorkflowBuilderStart(input);

		const [type] = startMock.mock.calls[0];
		expect(type).toBe("workflowBuilderExecutionWorkflow");
		expect(type).toBe(WORKFLOW_BUILDER_WORKFLOW_TYPE);
	});

	it("uses the shared id scheme, the builder queue and a run ceiling", async () => {
		await attemptWorkflowBuilderStart(input);

		const [, options] = startMock.mock.calls[0];
		expect(options.workflowId).toBe(builderWorkflowIdFor("exec-1"));
		expect(options.taskQueue).toBe("workflow-builder");
		expect(options.workflowExecutionTimeout).toBe("6 hours");
	});

	it("passes the input through as the single workflow argument", async () => {
		await attemptWorkflowBuilderStart(input);

		const [, options] = startMock.mock.calls[0];
		expect(options.args).toEqual([input]);
	});

	it("carries the request correlation memo", async () => {
		await attemptWorkflowBuilderStart(input);

		const [, options] = startMock.mock.calls[0];
		expect(options.memo).toEqual({ correlationId: "corr-1" });
	});

	it("confirms a returned start with the handle's workflow id, which is what the row stores", async () => {
		const outcome = await attemptWorkflowBuilderStart(input);

		expect(outcome).toEqual({
			status: "confirmed",
			workflowId: "workflow-execution-exec-1",
			runId: "run-1",
			via: "start",
		});
		expect(describeMock).not.toHaveBeenCalled();
	});

	it("treats an already-started rejection as confirmation — the id is the row's, so it is this run", async () => {
		startMock.mockRejectedValue(
			temporalError("WorkflowExecutionAlreadyStartedError"),
		);

		const outcome = await attemptWorkflowBuilderStart(input);

		expect(outcome).toEqual({
			status: "confirmed",
			workflowId: "workflow-execution-exec-1",
			via: "already-started",
		});
		expect(describeMock).not.toHaveBeenCalled();
	});

	it("confirms an accepted-but-lost start by describing the deterministic id", async () => {
		// The client timed out AFTER the server accepted the start. Failing
		// the row here is the duplicate-run bug: the retry would run too.
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockResolvedValue({ runId: "run-accepted" });

		const outcome = await attemptWorkflowBuilderStart(input);

		expect(getHandleMock).toHaveBeenCalledWith("workflow-execution-exec-1");
		expect(outcome).toEqual({
			status: "confirmed",
			workflowId: "workflow-execution-exec-1",
			runId: "run-accepted",
			via: "describe",
		});
	});

	it("reports not-started only when Temporal says no execution exists under the id", async () => {
		const failure = new Error("connection refused");
		startMock.mockRejectedValue(failure);
		describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));

		const outcome = await attemptWorkflowBuilderStart(input);

		expect(outcome).toEqual({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: failure,
		});
	});

	it("reports unknown — never not-started — when the describe cannot settle it either", async () => {
		const failure = new Error("DEADLINE_EXCEEDED");
		startMock.mockRejectedValue(failure);
		describeMock.mockRejectedValue(new Error("UNAVAILABLE"));

		const outcome = await attemptWorkflowBuilderStart(input);

		expect(outcome).toEqual({
			status: "unknown",
			workflowId: "workflow-execution-exec-1",
			error: failure,
		});
	});
});

describe("cancelWorkflowBuilderExecution", () => {
	it("addresses the run by the same id the start used", async () => {
		await cancelWorkflowBuilderExecution("exec-1");

		expect(getHandleMock).toHaveBeenCalledWith("workflow-execution-exec-1");
		expect(cancelMock).toHaveBeenCalledTimes(1);
	});
});

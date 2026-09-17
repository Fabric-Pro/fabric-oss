/**
 * Starting a manual run.
 *
 * Three things here are easy to get wrong and expensive when wrong:
 *
 * - Refusing an invalid graph has to happen *before* the execution row exists,
 *   or the run history fills with rows that never ran.
 * - The editor can post unsaved nodes/edges. Those are what must be validated
 *   and executed — validating the stored graph and running the posted one (or
 *   the reverse) is a silent correctness hole.
 * - When Temporal will not take the run, the row must reach a terminal state.
 *   Nothing sweeps PENDING executions, so a row left as created reads as
 *   "queued" in the UI forever rather than "never started".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	accessMock,
	getWorkflowMock,
	reserveMock,
	executionUpdateMock,
	markRunningMock,
	temporalAvailableMock,
	startMock,
	describeMock,
} = vi.hoisted(() => ({
	accessMock: vi.fn(),
	getWorkflowMock: vi.fn(),
	reserveMock: vi.fn(),
	executionUpdateMock: vi.fn(),
	markRunningMock: vi.fn(),
	temporalAvailableMock: vi.fn(),
	startMock: vi.fn(),
	describeMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowExecution: { update: executionUpdateMock } },
	getWorkflowById: getWorkflowMock,
	hasWorkflowAccess: accessMock,
	markExecutionRunningIfPending: markRunningMock,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: startMock,
			getHandle: () => ({ describe: describeMock }),
		},
	}),
	isTemporalAvailable: temporalAvailableMock,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

// The row is created inside the capacity reservation; the mock returns the
// row the way the real helper does.
vi.mock("../../../lib/execution-concurrency", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createExecutionWithinConcurrencyCap: reserveMock,
	};
});

/** Temporal's typed errors are matched by name, so a named Error stands in. */
function temporalError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ id: "member-1" }),
}));

vi.mock("../../../../../orpc/procedures", () => ({
	Permissions: { WORKSPACE_UPDATE: "workspace:update" },
	requirePermission: () => (next: unknown) => next,
	resolveOrganizationId: (input: string | null | undefined) =>
		input ?? undefined,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					handler: (fn: unknown) => fn,
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { startWorkflowExecutionProcedure } from "../start-execution";

// biome-ignore lint/suspicious/noExplicitAny: the builder is stubbed to a bare handler above
const start = startWorkflowExecutionProcedure as any;

const USER = "user-1";

/** A saved graph with one real node — valid on its own. */
const SAVED_NODES = [{ id: "saved", type: "http-request", data: {} }];

const ctx = { user: { id: USER }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	accessMock.mockResolvedValue(true);
	getWorkflowMock.mockResolvedValue({
		id: "wf-1",
		version: 3,
		projectId: "proj-1",
		nodes: SAVED_NODES,
		edges: [],
	});
	reserveMock.mockResolvedValue({
		allowed: true,
		execution: {
			id: "exec-1",
			startedAt: new Date("2026-08-08T00:00:00Z"),
			status: "PENDING",
		},
		inFlight: 1,
		limit: 25,
	});
	executionUpdateMock.mockResolvedValue({});
	markRunningMock.mockResolvedValue(true);
	temporalAvailableMock.mockResolvedValue(true);
	startMock.mockResolvedValue({ workflowId: "temporal-run-1" });
	// Default: a start that threw really did not happen.
	describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));
});

function failedWrites() {
	return executionUpdateMock.mock.calls.filter(
		([args]) =>
			(args as { data?: { status?: string } }).data?.status === "FAILED",
	);
}

describe("validation happens before anything is written", () => {
	it("refuses an empty graph without creating an execution row", async () => {
		getWorkflowMock.mockResolvedValue({
			id: "wf-1",
			version: 3,
			nodes: [],
			edges: [],
		});

		await expect(
			start({ input: { id: "wf-1" }, context: ctx }),
		).rejects.toThrow(/validation failed/i);

		expect(reserveMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("validates the posted graph, not the stored one", async () => {
		// Saved graph is fine; what the editor posted is not. Validating the
		// stored graph here would let a broken canvas run.
		await expect(
			start({
				input: { id: "wf-1", nodes: [], edges: [] },
				context: ctx,
			}),
		).rejects.toThrow(/validation failed/i);

		expect(reserveMock).not.toHaveBeenCalled();
	});

	it("refuses at the concurrency cap and starts nothing", async () => {
		reserveMock.mockResolvedValue({
			allowed: false,
			inFlight: 25,
			limit: 25,
		});

		await expect(
			start({ input: { id: "wf-1" }, context: ctx }),
		).rejects.toThrow(/already has 25/);

		expect(startMock).not.toHaveBeenCalled();
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("reserves the row with its content, so the cap and the insert are one decision", async () => {
		await start({
			input: { id: "wf-1", triggerData: { a: 1 } },
			context: ctx,
		});

		expect(reserveMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER,
				data: expect.objectContaining({
					workflowId: "wf-1",
					version: 3,
					triggerType: "MANUAL",
					triggerInput: expect.objectContaining({
						triggerData: { a: 1 },
					}),
				}),
			}),
		);
	});
});

describe("unsaved canvas changes", () => {
	it("executes the posted nodes and edges when the editor sends them", async () => {
		const posted = [{ id: "posted", type: "http-request", data: {} }];

		await start({
			input: { id: "wf-1", nodes: posted, edges: [] },
			context: ctx,
		});

		const [, options] = startMock.mock.calls[0];
		expect(options.args[0].nodes).toEqual(posted);
	});

	it("leaves nodes undefined when nothing was posted, so the run loads the stored graph", async () => {
		await start({ input: { id: "wf-1" }, context: ctx });

		const [, options] = startMock.mock.calls[0];
		expect(options.args[0].nodes).toBeUndefined();
	});
});

describe("when the engine will not take the run", () => {
	it("records FAILED rather than leaving the row PENDING when Temporal is unavailable", async () => {
		temporalAvailableMock.mockResolvedValue(false);

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("failed");
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "exec-1" },
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("records FAILED when the start call throws AND Temporal confirms no run exists under the row's id", async () => {
		startMock.mockRejectedValue(new Error("connection refused"));
		describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("failed");
		expect(result.message).toMatch(/connection refused/);
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("reports an accepted-but-lost start as started — the run exists, so a retry would duplicate it", async () => {
		// The client timed out after the server accepted the start. Failing
		// the row here was the bug: the editor's retry created a new row, a
		// new id, and a second run with the same side effects.
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockResolvedValue({ runId: "run-accepted" });

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("started");
		expect(result.temporalWorkflowId).toBe("workflow-execution-exec-1");
		expect(failedWrites()).toHaveLength(0);
		expect(markRunningMock).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
	});

	it("treats an already-started rejection as the run it is", async () => {
		startMock.mockRejectedValue(
			temporalError("WorkflowExecutionAlreadyStartedError"),
		);

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("started");
		expect(describeMock).not.toHaveBeenCalled();
		expect(failedWrites()).toHaveLength(0);
	});

	it("resolves an unconfirmed outcome naming the execution, and leaves the row active, when neither the start nor the describe can settle it", async () => {
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockRejectedValue(new Error("UNAVAILABLE"));

		// Resolved, not thrown: an error reads as "retry", and a retry
		// creates a second row and a second run.
		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("unconfirmed");
		expect(result.outcome).toBe("unconfirmed");
		expect(result.execution.id).toBe("exec-1");
		expect(result.message).toMatch(/exec-1/);

		// Neither FAILED (invites a duplicate retry) nor RUNNING (claims a
		// confirmation nobody has): the row is left exactly as created, and
		// no second row was reserved.
		expect(executionUpdateMock).not.toHaveBeenCalled();
		expect(markRunningMock).not.toHaveBeenCalled();
		expect(reserveMock).toHaveBeenCalledTimes(1);
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("reports the failure to the caller instead of a success-shaped result", async () => {
		// Both UI call sites treat a resolved mutation as "started" unless the
		// status says otherwise, so this field is load-bearing.
		temporalAvailableMock.mockResolvedValue(false);

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.temporalWorkflowId).toBeNull();
		expect(result.message).toMatch(/not started/i);
	});
});

describe("the happy path still works", () => {
	it("starts the run on the workflow-builder queue with a ceiling and marks it RUNNING", async () => {
		const result = await start({ input: { id: "wf-1" }, context: ctx });

		const [type, options] = startMock.mock.calls[0];
		expect(type).toBe("workflowBuilderExecutionWorkflow");
		expect(options.taskQueue).toBe("workflow-builder");
		expect(options.workflowExecutionTimeout).toBe("6 hours");
		expect(result.status).toBe("started");
		expect(result.outcome).toBe("started");
		// The RUNNING write is conditional on PENDING, so a run that already
		// finished is never moved back.
		expect(markRunningMock).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "temporal-run-1",
		});
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});
	it("still reports a started run when marking the row RUNNING fails, and never marks it FAILED", async () => {
		markRunningMock.mockRejectedValueOnce(new Error("connection reset"));

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(startMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("started");
		expect(failedWrites()).toHaveLength(0);
	});
});

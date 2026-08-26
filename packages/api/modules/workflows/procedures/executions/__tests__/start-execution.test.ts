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
	createExecutionMock,
	executionUpdateMock,
	concurrencyMock,
	temporalAvailableMock,
	startMock,
} = vi.hoisted(() => ({
	accessMock: vi.fn(),
	getWorkflowMock: vi.fn(),
	createExecutionMock: vi.fn(),
	executionUpdateMock: vi.fn(),
	concurrencyMock: vi.fn(),
	temporalAvailableMock: vi.fn(),
	startMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowExecution: { update: executionUpdateMock } },
	createWorkflowExecution: createExecutionMock,
	getWorkflowById: getWorkflowMock,
	hasWorkflowAccess: accessMock,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: startMock } }),
	isTemporalAvailable: temporalAvailableMock,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

vi.mock("../../../lib/execution-concurrency", () => ({
	checkExecutionConcurrency: concurrencyMock,
}));

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
	concurrencyMock.mockResolvedValue({
		allowed: true,
		inFlight: 0,
		limit: 25,
	});
	createExecutionMock.mockResolvedValue({
		id: "exec-1",
		startedAt: new Date("2026-08-08T00:00:00Z"),
		status: "PENDING",
	});
	executionUpdateMock.mockResolvedValue({});
	temporalAvailableMock.mockResolvedValue(true);
	startMock.mockResolvedValue({ workflowId: "temporal-run-1" });
});

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

		expect(createExecutionMock).not.toHaveBeenCalled();
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

		expect(createExecutionMock).not.toHaveBeenCalled();
	});

	it("refuses at the concurrency cap before creating a row", async () => {
		concurrencyMock.mockResolvedValue({
			allowed: false,
			inFlight: 25,
			limit: 25,
		});

		await expect(
			start({ input: { id: "wf-1" }, context: ctx }),
		).rejects.toThrow(/already has 25/);

		expect(createExecutionMock).not.toHaveBeenCalled();
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

	it("records FAILED when the start call itself throws", async () => {
		startMock.mockRejectedValue(new Error("connection refused"));

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("failed");
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
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
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "RUNNING" }),
			}),
		);
	});
});

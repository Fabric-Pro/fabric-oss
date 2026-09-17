/**
 * v1 workflow executions — Phase 8b integration tests
 *
 * Covers:
 *   POST /workflows/:id/trigger
 *   GET  /workflows/:id/executions
 *   POST /workflows/:id/executions/:execId/cancel
 *
 * Verifies tenant scoping, status filter validation, the 409 path for
 * already-terminal executions, and that the cancel route always
 * updates the DB row (Temporal call is best-effort and may be a noop
 * when isTemporalAvailable returns false).
 *
 * The trigger tests exist because this route used to start a workflow type
 * that is not registered (`workflowExecutionWorkflow`) under an id no other
 * path used (`workflow-exec-<id>`), and swallowed the failure. Every
 * API-started run sat at PENDING forever, and the cancel route addressed a
 * run that did not exist. Both now go through the shared helper.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetWorkflowById = vi.fn();
const mockGetWorkflowExecutionById = vi.fn();
const mockListWorkflowExecutions = vi.fn();
const mockUpdateWorkflowExecution = vi.fn();
const mockMarkExecutionRunningIfPending = vi.fn();
const mockListWorkflows = vi.fn();
const mockIsTemporalAvailable = vi.fn();
const mockTemporalCancel = vi.fn();
const mockTemporalStart = vi.fn();
const mockTemporalDescribe = vi.fn();
const mockGetTemporalClient = vi.fn();

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	getWorkflowById: (...args: unknown[]) => mockGetWorkflowById(...args),
	getWorkflowExecutionById: (...args: unknown[]) =>
		mockGetWorkflowExecutionById(...args),
	listWorkflowExecutions: (...args: unknown[]) =>
		mockListWorkflowExecutions(...args),
	updateWorkflowExecution: (...args: unknown[]) =>
		mockUpdateWorkflowExecution(...args),
	markExecutionRunningIfPending: (...args: unknown[]) =>
		mockMarkExecutionRunningIfPending(...args),
	listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

/**
 * The row is created inside the capacity reservation. The mock returns the
 * row the way the real helper does: `{ allowed: true, execution }` below the
 * cap, `{ allowed: false }` at it.
 */
const mockCreateExecutionWithinConcurrencyCap = vi.fn();

vi.mock("../../workflows/lib/execution-concurrency", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createExecutionWithinConcurrencyCap: (...args: unknown[]) =>
			mockCreateExecutionWithinConcurrencyCap(...(args as [never])),
	};
});

vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: (...args: unknown[]) =>
		mockIsTemporalAvailable(...args),
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerWorkflowRoutes } from "../workflows";

function makeApp() {
	const app = new Hono<{
		Variables: {
			externalApiContext: {
				keyType: "personal" | "organization";
				keyId: string;
				keyPrefix: string;
				userId: string;
				organizationId: string | undefined;
				scopes: string[];
			};
		};
	}>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: "user-1",
			organizationId: undefined,
			scopes: ["workflows:read", "workflows:run"],
		});
		await next();
	});
	registerWorkflowRoutes(app as never);
	return app;
}

function execRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		organizationId: null,
		status: "RUNNING" as const,
		triggerType: "MANUAL" as const,
		startedAt: new Date("2026-05-11T00:00:00.000Z"),
		completedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetWorkflowById.mockResolvedValue({
		id: "wf-1",
		name: "wf",
		version: 1,
		status: "ACTIVE",
		projectId: null,
	});
	mockIsTemporalAvailable.mockResolvedValue(false);
});

/** Temporal's typed errors are matched by name, so a named Error stands in. */
function temporalError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

function failedWrites() {
	return mockUpdateWorkflowExecution.mock.calls.filter(
		([, data]) => (data as { status?: string }).status === "FAILED",
	);
}

describe("POST /workflows/:id/trigger", () => {
	beforeEach(() => {
		mockCreateExecutionWithinConcurrencyCap.mockResolvedValue({
			allowed: true,
			execution: execRow({ status: "PENDING" }),
			inFlight: 1,
			limit: 10,
		});
		mockUpdateWorkflowExecution.mockImplementation(
			async (_id: string, data: Record<string, unknown>) => execRow(data),
		);
		mockMarkExecutionRunningIfPending.mockResolvedValue(true);
		mockGetTemporalClient.mockResolvedValue({
			workflow: {
				start: mockTemporalStart,
				getHandle: () => ({ describe: mockTemporalDescribe }),
			},
		});
		mockTemporalStart.mockResolvedValue({
			workflowId: "workflow-execution-exec-1",
			firstExecutionRunId: "run-1",
		});
		// Default: a start that threw really did not happen.
		mockTemporalDescribe.mockRejectedValue(
			temporalError("WorkflowNotFoundError"),
		);
	});

	it("starts the registered builder workflow under the shared id scheme", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
			body: JSON.stringify({ triggerInput: { ticket: "T-1" } }),
		});

		expect(res.status).toBe(202);
		const [type, options] = mockTemporalStart.mock.calls[0];
		expect(type).toBe("workflowBuilderExecutionWorkflow");
		expect(options.workflowId).toBe("workflow-execution-exec-1");
		expect(options.taskQueue).toBe("workflow-builder");
		expect(options.workflowExecutionTimeout).toBeDefined();
	});

	it("hands the trigger input to the workflow under the key it actually reads", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);

		await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
			body: JSON.stringify({ triggerInput: { ticket: "T-1" } }),
		});

		const [, options] = mockTemporalStart.mock.calls[0];
		expect(options.args[0]).toEqual(
			expect.objectContaining({
				executionId: "exec-1",
				workflowId: "wf-1",
				userId: "user-1",
				triggerData: { ticket: "T-1" },
			}),
		);
		expect(options.args[0]).not.toHaveProperty("triggerInput");
	});

	it("marks the row RUNNING with the Temporal id once the start succeeds", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(mockMarkExecutionRunningIfPending).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
		const body = (await res.json()) as { data: { status: string } };
		expect(body.data.status).toBe("RUNNING");
	});

	it("does not move a run that already finished back to RUNNING, and reports where it is", async () => {
		// A short run can write its terminal status before the starter's
		// RUNNING write lands; the conditional write leaves it alone.
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockMarkExecutionRunningIfPending.mockResolvedValue(false);
		mockGetWorkflowExecutionById.mockResolvedValue(
			execRow({ status: "COMPLETED" }),
		);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(202);
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
		const body = (await res.json()) as { data: { status: string } };
		expect(body.data.status).toBe("COMPLETED");
	});

	it("fails the row and says so when the engine is unavailable, rather than leaving it PENDING", async () => {
		mockIsTemporalAvailable.mockResolvedValue(false);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(502);
		expect(mockTemporalStart).not.toHaveBeenCalled();
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "FAILED" }),
		);
		const body = (await res.json()) as {
			error: { code: string; executionId: string };
		};
		expect(body.error.code).toBe("EXECUTION_NOT_STARTED");
		expect(body.error.executionId).toBe("exec-1");
	});

	it("still reports a started run when marking the row RUNNING fails, and never marks it FAILED", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockMarkExecutionRunningIfPending.mockRejectedValueOnce(
			new Error("connection reset"),
		);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(202);
		expect(mockTemporalStart).toHaveBeenCalledTimes(1);
		const failedWrites = mockUpdateWorkflowExecution.mock.calls.filter(
			([, data]) => (data as { status?: string }).status === "FAILED",
		);
		expect(failedWrites).toHaveLength(0);
		const body = (await res.json()) as {
			data: { executionId: string; status: string };
		};
		expect(body.data.executionId).toBe("exec-1");
		expect(body.data.status).toBe("RUNNING");
	});

	it("fails the row when the start call throws AND Temporal confirms no run exists under the row's id", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockTemporalStart.mockRejectedValue(new Error("connection refused"));
		mockTemporalDescribe.mockRejectedValue(
			temporalError("WorkflowNotFoundError"),
		);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(502);
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({
				status: "FAILED",
				error: "connection refused",
			}),
		);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("EXECUTION_NOT_STARTED");
	});

	it("reports an accepted-but-lost start as started — the run exists, so a retry would duplicate it", async () => {
		// The client timed out after the server accepted the start. Failing
		// the row here was the bug: the caller retried, a new row got a new
		// id, and both runs executed their side effects.
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockTemporalStart.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		mockTemporalDescribe.mockResolvedValue({ runId: "run-accepted" });

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(202);
		expect(failedWrites()).toHaveLength(0);
		expect(mockMarkExecutionRunningIfPending).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
		const body = (await res.json()) as {
			data: { executionId: string; status: string };
		};
		expect(body.data).toEqual(
			expect.objectContaining({
				executionId: "exec-1",
				status: "RUNNING",
			}),
		);
	});

	it("treats an already-started rejection as the run it is", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockTemporalStart.mockRejectedValue(
			temporalError("WorkflowExecutionAlreadyStartedError"),
		);

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(202);
		expect(mockTemporalDescribe).not.toHaveBeenCalled();
		expect(failedWrites()).toHaveLength(0);
	});

	it("answers 202 unconfirmed with the execution id, not a retryable 5xx, when neither the start nor the describe can settle it", async () => {
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockTemporalStart.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		mockTemporalDescribe.mockRejectedValue(new Error("UNAVAILABLE"));

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		// Clients retry 5xx, and a retry creates a second row and run.
		expect(res.status).toBe(202);
		// Neither FAILED (invites a duplicate retry) nor RUNNING (claims a
		// confirmation nobody has): the row is left exactly as created, and
		// no second row was reserved.
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
		expect(mockMarkExecutionRunningIfPending).not.toHaveBeenCalled();
		expect(mockCreateExecutionWithinConcurrencyCap).toHaveBeenCalledTimes(
			1,
		);
		expect(mockTemporalStart).toHaveBeenCalledTimes(1);
		const body = (await res.json()) as {
			data: { executionId: string; status: string; message: string };
		};
		expect(body.data.status).toBe("unconfirmed");
		expect(body.data.executionId).toBe("exec-1");
		expect(body.data.message).toMatch(/exec-1/);
	});
});

describe("POST /workflows/:id/trigger — concurrency cap", () => {
	it("refuses with 429 and starts nothing when the reservation reports the tenant at its in-flight limit", async () => {
		mockCreateExecutionWithinConcurrencyCap.mockResolvedValueOnce({
			allowed: false,
			inFlight: 10,
			limit: 10,
		});

		const res = await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
		});

		expect(res.status).toBe(429);
		expect(mockTemporalStart).not.toHaveBeenCalled();
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("EXECUTION_LIMIT_REACHED");
	});

	it("reserves the row for the caller's own tenant, with the row's content — one decision, not count-then-insert", async () => {
		await makeApp().request("/workflows/wf-1/trigger", {
			method: "POST",
			body: JSON.stringify({ triggerInput: { ticket: "T-1" } }),
		});
		expect(mockCreateExecutionWithinConcurrencyCap).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-test",
				data: expect.objectContaining({
					workflowId: "wf-1",
					version: 1,
					triggerType: "MANUAL",
					triggerInput: { ticket: "T-1" },
				}),
			}),
		);
	});
});

describe("GET /workflows/:id/executions", () => {
	it("returns 404 when workflow not found for tenant", async () => {
		mockGetWorkflowById.mockResolvedValue(null);
		const res = await makeApp().request("/workflows/wf-x/executions");
		expect(res.status).toBe(404);
		expect(mockListWorkflowExecutions).not.toHaveBeenCalled();
	});

	it("lists with status + pagination forwarded", async () => {
		mockListWorkflowExecutions.mockResolvedValue({
			executions: [execRow(), execRow({ id: "exec-2" })],
			total: 2,
			hasMore: false,
		});
		const res = await makeApp().request(
			"/workflows/wf-1/executions?status=RUNNING&limit=50&offset=10",
		);
		expect(res.status).toBe(200);
		expect(mockListWorkflowExecutions).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-1",
				userId: "user-1",
				status: "RUNNING",
				limit: 50,
				offset: 10,
			}),
		);
		const body = (await res.json()) as {
			data: unknown[];
			meta: { total: number };
		};
		expect(body.data).toHaveLength(2);
		expect(body.meta.total).toBe(2);
	});

	it("400 on invalid status filter", async () => {
		const res = await makeApp().request(
			"/workflows/wf-1/executions?status=NOTASTATUS",
		);
		expect(res.status).toBe(400);
		expect(mockListWorkflowExecutions).not.toHaveBeenCalled();
	});
});

describe("POST /workflows/:id/executions/:execId/cancel", () => {
	it("404 when workflow not found", async () => {
		mockGetWorkflowById.mockResolvedValue(null);
		const res = await makeApp().request(
			"/workflows/wf-x/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("404 when execution belongs to a different workflow", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(
			execRow({ workflowId: "wf-other" }),
		);
		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("409 when execution is already in terminal state", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(
			execRow({ status: "COMPLETED" }),
		);
		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("EXECUTION_TERMINAL");
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("happy path (Temporal unavailable): updates DB row to CANCELLED", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(execRow());
		mockIsTemporalAvailable.mockResolvedValue(false);
		mockUpdateWorkflowExecution.mockResolvedValue(
			execRow({ status: "CANCELLED", completedAt: new Date() }),
		);
		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { status: string };
		};
		expect(body.data.status).toBe("CANCELLED");
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
	});

	it("happy path (Temporal available): signals cancel on the workflow handle, then updates DB", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(execRow());
		mockIsTemporalAvailable.mockResolvedValue(true);
		const getHandle = vi.fn(() => ({ cancel: mockTemporalCancel }));
		mockGetTemporalClient.mockResolvedValue({
			workflow: { getHandle },
		});
		mockTemporalCancel.mockResolvedValue(undefined);
		mockUpdateWorkflowExecution.mockResolvedValue(
			execRow({ status: "CANCELLED" }),
		);

		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		// The same id the trigger route started the run under. The cancel
		// used to guess `workflow-exec-<id>` and cancelled nothing.
		expect(getHandle).toHaveBeenCalledWith("workflow-execution-exec-1");
		expect(mockTemporalCancel).toHaveBeenCalledTimes(1);
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});

	it("Temporal cancel failure does NOT prevent DB row update", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(execRow());
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockGetTemporalClient.mockResolvedValue({
			workflow: {
				getHandle: () => ({
					cancel: () => Promise.reject(new Error("handle gone")),
				}),
			},
		});
		mockUpdateWorkflowExecution.mockResolvedValue(
			execRow({ status: "CANCELLED" }),
		);

		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		// DB row still got CANCELLED even though Temporal threw
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});
});

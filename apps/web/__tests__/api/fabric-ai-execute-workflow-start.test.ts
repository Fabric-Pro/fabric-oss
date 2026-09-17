/**
 * The chat-confirmed workflow start (`/api/agents/fabric-ai/execute-workflow`)
 * must behave like every other starter: refuse over the tenant's in-flight
 * cap before a row exists, and never report a run that did not reach the
 * engine as "queued" — nothing picks a PENDING row up later. It also asks the
 * same live permission question the in-app start does (WORKSPACE_UPDATE), and
 * answers an unconfirmed start with 202 rather than a retryable 5xx.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	checkRateLimit: vi.fn(),
	createExecutionWithinConcurrencyCap: vi.fn(),
	attemptWorkflowBuilderStart: vi.fn(),
	getWorkflowById: vi.fn(),
	updateWorkflowExecution: vi.fn(),
	markExecutionRunningIfPending: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
	hasOrganizationTie: vi.fn(),
	isTemporalAvailable: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: mocks.getSession,
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
	RATE_LIMIT_PRESETS: { workflow: { limit: 30, windowMs: 60_000 } },
}));
// The row is created inside the capacity reservation; the mock returns the
// row the way the real helper does.
vi.mock("@repo/api/modules/workflows/lib/execution-concurrency", () => ({
	createExecutionWithinConcurrencyCap:
		mocks.createExecutionWithinConcurrencyCap,
	concurrencyRefusalMessage: (r: { inFlight: number; limit: number }) =>
		`This workspace already has ${r.inFlight} workflow executions running (limit ${r.limit}).`,
}));
vi.mock("@repo/api/modules/workflows/lib/start-builder-execution", () => ({
	attemptWorkflowBuilderStart: mocks.attemptWorkflowBuilderStart,
	startFailureMessage: (error: unknown) =>
		error instanceof Error ? error.message : "Failed to start workflow",
	unconfirmedStartMessage: (executionId: string) =>
		`The workflow engine did not confirm whether execution ${executionId} started.`,
}));
vi.mock("@repo/database", () => ({
	getWorkflowById: mocks.getWorkflowById,
	updateWorkflowExecution: mocks.updateWorkflowExecution,
	markExecutionRunningIfPending: mocks.markExecutionRunningIfPending,
	canRunOrganizationWorkflows: mocks.canRunOrganizationWorkflows,
	// The organization resolver checks the caller's tie before the permission
	// question; this suite is about starting, so the caller is always tied.
	hasOrganizationTie: mocks.hasOrganizationTie,
}));
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: mocks.isTemporalAvailable,
}));

import { POST } from "@/app/api/agents/fabric-ai/execute-workflow/route";

function request(body: unknown) {
	return new NextRequest(
		"http://localhost/api/agents/fabric-ai/execute-workflow",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

describe("POST /api/agents/fabric-ai/execute-workflow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-1" },
		});
		mocks.checkRateLimit.mockResolvedValue({ allowed: true });
		mocks.createExecutionWithinConcurrencyCap.mockResolvedValue({
			allowed: true,
			execution: { id: "exec-1" },
			inFlight: 1,
			limit: 10,
		});
		mocks.getWorkflowById.mockResolvedValue({
			id: "wf-1",
			name: "Nightly digest",
			version: 3,
			status: "ACTIVE",
			triggerType: "MANUAL",
			projectId: null,
		});
		mocks.updateWorkflowExecution.mockResolvedValue({ id: "exec-1" });
		mocks.markExecutionRunningIfPending.mockResolvedValue(true);
		mocks.canRunOrganizationWorkflows.mockResolvedValue(true);
		mocks.hasOrganizationTie.mockResolvedValue(true);
		mocks.isTemporalAvailable.mockResolvedValue(true);
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "confirmed",
			workflowId: "workflow-execution-exec-1",
			runId: "run-1",
			via: "start",
		});
	});

	it("refuses with 403 and reserves nothing when the caller no longer holds the live permission to run workflows", async () => {
		// A creator demoted since the workflow was built can still see it,
		// but must not run it.
		mocks.canRunOrganizationWorkflows.mockResolvedValue(false);
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(403);
		expect(mocks.canRunOrganizationWorkflows).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		expect(mocks.getWorkflowById).not.toHaveBeenCalled();
		expect(
			mocks.createExecutionWithinConcurrencyCap,
		).not.toHaveBeenCalled();
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
	});

	it("refuses with 403 when the session has no organization — there is no personal arm", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: null },
		});
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(403);
		expect(mocks.canRunOrganizationWorkflows).not.toHaveBeenCalled();
		expect(
			mocks.createExecutionWithinConcurrencyCap,
		).not.toHaveBeenCalled();
	});

	it("refuses with 429 and starts nothing when the tenant is at its cap", async () => {
		mocks.createExecutionWithinConcurrencyCap.mockResolvedValue({
			allowed: false,
			inFlight: 10,
			limit: 10,
		});
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(429);
		expect(mocks.createExecutionWithinConcurrencyCap).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				data: expect.objectContaining({
					workflowId: "wf-1",
					version: 3,
					triggerType: "MANUAL",
				}),
			}),
		);
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
		expect(mocks.updateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("fails the row and reports 503 when the engine is unavailable, instead of a queued success", async () => {
		mocks.isTemporalAvailable.mockResolvedValue(false);
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(503);
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
		expect(mocks.updateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "FAILED" }),
		);
		const body = (await res.json()) as {
			code: string;
			executionId: string;
		};
		expect(body.code).toBe("EXECUTION_NOT_STARTED");
		expect(body.executionId).toBe("exec-1");
	});

	it("fails the row and reports 502 when Temporal confirms the start never happened", async () => {
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("task queue closed"),
		});
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(502);
		expect(mocks.updateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({
				status: "FAILED",
				error: expect.stringContaining("task queue closed"),
			}),
		);
	});

	it("reports an accepted-but-lost start as started — a retry would run it twice", async () => {
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "confirmed",
			workflowId: "workflow-execution-exec-1",
			runId: "run-accepted",
			via: "describe",
		});
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(200);
		const failedCalls = mocks.updateWorkflowExecution.mock.calls.filter(
			([, data]) => (data as { status?: string }).status === "FAILED",
		);
		expect(failedCalls).toHaveLength(0);
	});

	it("answers 202 unconfirmed with the execution id, not a retryable 5xx, and leaves the row active when the start cannot be settled", async () => {
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "unknown",
			workflowId: "workflow-execution-exec-1",
			error: new Error("DEADLINE_EXCEEDED"),
		});
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(202);
		// Neither FAILED (invites a duplicate retry) nor RUNNING (claims a
		// confirmation nobody has): the row is left exactly as created, and
		// no second row was reserved.
		expect(mocks.updateWorkflowExecution).not.toHaveBeenCalled();
		expect(mocks.markExecutionRunningIfPending).not.toHaveBeenCalled();
		expect(mocks.createExecutionWithinConcurrencyCap).toHaveBeenCalledTimes(
			1,
		);
		const body = (await res.json()) as {
			status: string;
			executionId: string;
			message: string;
		};
		expect(body.status).toBe("unconfirmed");
		expect(body.executionId).toBe("exec-1");
		expect(body.message).toContain("exec-1");
	});

	it("marks the row RUNNING with the workflow id every other starter and the cancel path use", async () => {
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(200);
		// Conditional on PENDING: a run that already finished stays finished.
		expect(mocks.markExecutionRunningIfPending).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
		expect(mocks.updateWorkflowExecution).not.toHaveBeenCalled();
		const body = (await res.json()) as {
			success: boolean;
			temporalWorkflowId: string;
			message: string;
		};
		expect(body.success).toBe(true);
		expect(body.temporalWorkflowId).toBe("workflow-execution-exec-1");
		expect(body.message).not.toContain("queued");
	});
	it("still reports a started run when marking the row RUNNING fails, and never marks it FAILED", async () => {
		mocks.markExecutionRunningIfPending.mockRejectedValueOnce(
			new Error("connection reset"),
		);
		const res = await POST(request({ workflowId: "wf-1" }));
		expect(res.status).toBe(200);
		expect(mocks.attemptWorkflowBuilderStart).toHaveBeenCalledTimes(1);
		const failedCalls = mocks.updateWorkflowExecution.mock.calls.filter(
			([, data]) => (data as { status?: string }).status === "FAILED",
		);
		expect(failedCalls).toHaveLength(0);
		const body = (await res.json()) as { temporalWorkflowId: string };
		expect(body.temporalWorkflowId).toBe("workflow-execution-exec-1");
	});
});

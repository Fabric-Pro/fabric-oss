/**
 * `fabric_execute_workflow` and `fabric_get_workflow_execution`.
 *
 * The execute tool used to start a workflow type that is not registered
 * (`workflowBuilderExecution`), under an id it invented on the spot, with no
 * execution row behind it. The run never began, and the "executionId" it
 * handed back was a string the status tool could not find — an agent polling
 * it saw "not found" forever. These pin the repaired contract: the row is
 * created through the same query every other trigger uses, the start goes
 * through the shared helper, and the id returned is the row's.
 *
 * `@repo/database`, `@repo/temporal` and the `@repo/api` workflow helpers are
 * mocked — the handlers import them dynamically, so the mock intercepts the
 * `await import(...)` inside the handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/execute-workflow-tool
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getWorkflowById: vi.fn(),
	getWorkflowExecutionById: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
	executionUpdate: vi.fn(),
	markExecutionRunningIfPending: vi.fn(),
	attemptWorkflowBuilderStart: vi.fn(),
	createExecutionWithinConcurrencyCap: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowExecution: { update: mocks.executionUpdate } },
	getWorkflowById: mocks.getWorkflowById,
	getWorkflowExecutionById: mocks.getWorkflowExecutionById,
	canRunOrganizationWorkflows: mocks.canRunOrganizationWorkflows,
	markExecutionRunningIfPending: mocks.markExecutionRunningIfPending,
}));

vi.mock("@repo/api/modules/workflows/lib/start-builder-execution", () => ({
	attemptWorkflowBuilderStart: mocks.attemptWorkflowBuilderStart,
	startFailureMessage: (error: unknown) =>
		error instanceof Error ? error.message : "Failed to start workflow",
	unconfirmedStartMessage: (executionId: string) =>
		`The workflow engine did not confirm whether execution ${executionId} started.`,
}));

vi.mock("@repo/api/modules/workflows/lib/execution-concurrency", () => ({
	createExecutionWithinConcurrencyCap:
		mocks.createExecutionWithinConcurrencyCap,
	concurrencyRefusalMessage: (r: { inFlight: number; limit: number }) =>
		`This workspace already has ${r.inFlight} workflow executions running (limit ${r.limit}).`,
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

const WORKFLOW = {
	id: "wf-1",
	name: "Nightly digest",
	version: 4,
	projectId: "proj-1",
	status: "ACTIVE",
	publishedAt: new Date("2026-02-01T00:00:00Z"),
};

function failedWrites() {
	return mocks.executionUpdate.mock.calls.filter(
		([args]) =>
			(args as { data?: { status?: string } }).data?.status === "FAILED",
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getWorkflowById.mockResolvedValue(WORKFLOW);
	mocks.canRunOrganizationWorkflows.mockResolvedValue(true);
	mocks.createExecutionWithinConcurrencyCap.mockResolvedValue({
		allowed: true,
		execution: {
			id: "exec-1",
			status: "PENDING",
			startedAt: new Date("2026-08-08T00:00:00Z"),
		},
		inFlight: 1,
		limit: 25,
	});
	mocks.attemptWorkflowBuilderStart.mockResolvedValue({
		status: "confirmed",
		workflowId: "workflow-execution-exec-1",
		runId: "run-1",
		via: "start",
	});
	mocks.executionUpdate.mockResolvedValue({});
	mocks.markExecutionRunningIfPending.mockResolvedValue(true);
});

describe("fabric_execute_workflow", () => {
	it("creates an execution row through the shared query, tenant-scoped to the session", async () => {
		await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1", inputs: { day: "monday" } },
			session,
		);

		// The row is created inside the capacity reservation, so the tenant
		// cap and the insert are one decision rather than count-then-insert.
		expect(mocks.createExecutionWithinConcurrencyCap).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				data: expect.objectContaining({
					workflowId: "wf-1",
					version: 4,
					triggerType: "MANUAL",
				}),
			}),
		);
	});

	it("starts the run through the shared helper with the row's id", async () => {
		await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1", inputs: { day: "monday" } },
			session,
		);

		expect(mocks.attemptWorkflowBuilderStart).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				workflowId: "wf-1",
				userId: "user-1",
				organizationId: "org-1",
				projectId: "proj-1",
				triggerData: { day: "monday" },
			}),
		);
	});

	it("returns the execution row's id — the one the status tool can find", async () => {
		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBeFalsy();
		const body = payload(result);
		expect(body.executionId).toBe("exec-1");
		expect(body.status).toBe("RUNNING");
		expect(body.executionId).not.toMatch(/^mcp-wf-/);
	});

	it("marks the row RUNNING with the Temporal id", async () => {
		await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		// Conditional on PENDING: a run that already finished stays finished.
		expect(mocks.markExecutionRunningIfPending).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
		expect(mocks.executionUpdate).not.toHaveBeenCalled();
	});

	it("fails the row rather than leaving it PENDING when Temporal confirms the start never happened", async () => {
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "not-started",
			workflowId: "workflow-execution-exec-1",
			error: new Error("connection refused"),
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/connection refused/);
		expect(mocks.executionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "exec-1" },
				data: expect.objectContaining({
					status: "FAILED",
					error: "connection refused",
				}),
			}),
		);
	});

	it("reports an accepted-but-lost start as started — a second call would run it twice", async () => {
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "confirmed",
			workflowId: "workflow-execution-exec-1",
			runId: "run-accepted",
			via: "describe",
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBeFalsy();
		expect(payload(result).executionId).toBe("exec-1");
		expect(failedWrites()).toHaveLength(0);
	});

	it("returns a non-error unconfirmed result naming the execution to poll, and leaves the row active, when the start cannot be confirmed either way", async () => {
		mocks.attemptWorkflowBuilderStart.mockResolvedValue({
			status: "unknown",
			workflowId: "workflow-execution-exec-1",
			error: new Error("DEADLINE_EXCEEDED"),
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		// Not an error: agents retry errors, and a retry is a second run.
		expect(result.isError).toBeFalsy();
		// Neither FAILED (invites a duplicate call) nor RUNNING (claims a
		// confirmation nobody has): the row is left exactly as created, and
		// no second row was reserved.
		expect(mocks.executionUpdate).not.toHaveBeenCalled();
		expect(mocks.markExecutionRunningIfPending).not.toHaveBeenCalled();
		expect(mocks.createExecutionWithinConcurrencyCap).toHaveBeenCalledTimes(
			1,
		);
		const body = payload(result);
		expect(body.status).toBe("unconfirmed");
		expect(body.executionId).toBe("exec-1");
		expect(body.message).toMatch(/exec-1/);
		expect(body.message).toMatch(/fabric_get_workflow_execution/);
		expect(body.message).toMatch(/do not call this tool again/i);
	});

	it("still reports a started run when marking the row RUNNING fails, and never marks it FAILED", async () => {
		mocks.markExecutionRunningIfPending.mockRejectedValueOnce(
			new Error("connection reset"),
		);

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).not.toBe(true);
		expect(mocks.attemptWorkflowBuilderStart).toHaveBeenCalledTimes(1);
		expect(failedWrites()).toHaveLength(0);
		expect(payload(result).executionId).toBe("exec-1");
	});

	it("refuses at the tenant concurrency cap and starts nothing", async () => {
		mocks.createExecutionWithinConcurrencyCap.mockResolvedValue({
			allowed: false,
			inFlight: 25,
			limit: 25,
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/already has 25/);
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
		expect(mocks.executionUpdate).not.toHaveBeenCalled();
	});

	it("refuses an unpublished workflow without touching the row or the engine", async () => {
		mocks.getWorkflowById.mockResolvedValue({
			...WORKFLOW,
			publishedAt: null,
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(
			mocks.createExecutionWithinConcurrencyCap,
		).not.toHaveBeenCalled();
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
	});

	it.each(["PAUSED", "ARCHIVED", "DRAFT", "PUBLISHED"])(
		"refuses a %s workflow even though it was once published — the tool promises ACTIVE",
		async (status) => {
			// Pausing or archiving leaves `publishedAt` in place, so a check on
			// the timestamp alone ran paused and archived workflows.
			mocks.getWorkflowById.mockResolvedValue({ ...WORKFLOW, status });

			const result = await executePlatformTool(
				"fabric_execute_workflow",
				{ workflowId: "wf-1" },
				session,
			);

			expect(result.isError).toBe(true);
			expect(payload(result).error).toMatch(new RegExp(status));
			expect(
				mocks.createExecutionWithinConcurrencyCap,
			).not.toHaveBeenCalled();
			expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
		},
	);

	it("refuses when the session's user no longer holds the live permission the in-app start requires", async () => {
		// Stored scopes say what the credential was granted, not what its
		// owner may do now — `["*"]` here is the widest there is.
		mocks.canRunOrganizationWorkflows.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/no longer hold/);
		expect(mocks.canRunOrganizationWorkflows).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		expect(
			mocks.createExecutionWithinConcurrencyCap,
		).not.toHaveBeenCalled();
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
	});

	it("refuses a session with no organization instead of skipping the permission check — there is no personal arm", async () => {
		// Even a caller who would pass the role check anywhere is refused:
		// without an organization there is no role to check (ADR-018).
		mocks.canRunOrganizationWorkflows.mockResolvedValue(true);

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			{ ...session, organizationId: null },
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/requires an organization/);
		expect(
			mocks.createExecutionWithinConcurrencyCap,
		).not.toHaveBeenCalled();
		expect(mocks.attemptWorkflowBuilderStart).not.toHaveBeenCalled();
	});

	it("refuses a workflow the session cannot see", async () => {
		mocks.getWorkflowById.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-other" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(
			mocks.createExecutionWithinConcurrencyCap,
		).not.toHaveBeenCalled();
	});
});

describe("fabric_get_workflow_execution", () => {
	it("finds the row the execute tool returned", async () => {
		mocks.getWorkflowExecutionById.mockResolvedValue({
			id: "exec-1",
			workflowId: "wf-1",
			status: "COMPLETED",
			startedAt: new Date("2026-08-08T00:00:00Z"),
			completedAt: new Date("2026-08-08T00:01:00Z"),
			output: { ok: true },
			error: null,
			duration: 60_000,
		});

		const result = await executePlatformTool(
			"fabric_get_workflow_execution",
			{ executionId: "exec-1" },
			session,
		);

		expect(mocks.getWorkflowExecutionById).toHaveBeenCalledWith(
			"exec-1",
			"user-1",
			"org-1",
		);
		expect(payload(result)).toEqual(
			expect.objectContaining({ id: "exec-1", status: "COMPLETED" }),
		);
	});
});

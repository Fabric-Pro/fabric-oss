/**
 * Tests for cancelExecutionProcedure.
 *
 * Pinned contract:
 *  - Only RUNNING/PAUSED/CHECKPOINT executions can be cancelled; otherwise
 *    BAD_REQUEST and nothing is written.
 *  - Cancelling signals the workflow, flips the execution to CANCELLED, and
 *    restores the parent plan RUNNING -> APPROVED immediately (guarded).
 *  - A failed cancel signal is swallowed but the execution + plan are still
 *    reconciled (the workflow may already be gone).
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockFindFirst,
	mockExecutionUpdate,
	mockPlanUpdateMany,
	mockGetTemporalClient,
	mockSignal,
} = vi.hoisted(() => ({
	mockFindFirst: vi.fn(),
	mockExecutionUpdate: vi.fn(),
	mockPlanUpdateMany: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockSignal: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weaveExecution: {
			findFirst: mockFindFirst,
			update: mockExecutionUpdate,
		},
		weavePlan: {
			updateMany: mockPlanUpdateMany,
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("@repo/temporal/workflows", () => ({
	orchestratorCancelSignal: "orchestratorCancelSignal",
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		protectedProcedure: chainable,
		requirePermission: () => () => undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		resolveOrganizationId: (
			orgId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => orgId ?? session?.activeOrganizationId ?? undefined,
	};
});

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

async function loadHandler() {
	const mod = await import("../cancel-execution");
	return (mod.cancelExecutionProcedure as any)._handler as (args: {
		input: { executionId: string; organizationId?: string | null };
		context: typeof context;
	}) => Promise<{ success: boolean; message: string }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockFindFirst.mockResolvedValue({
		id: "exec-1",
		planId: "plan-1",
		status: "RUNNING",
		workflowId: "wf-1",
		runId: "run-1",
		userId: "user-1",
		organizationId: null,
	});
	mockExecutionUpdate.mockResolvedValue({});
	mockPlanUpdateMany.mockResolvedValue({ count: 1 });
	mockGetTemporalClient.mockResolvedValue({
		workflow: { getHandle: () => ({ signal: mockSignal }) },
	});
	mockSignal.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("cancelExecutionProcedure", () => {
	it("cancels the execution and restores the parent plan to APPROVED", async () => {
		const handler = await loadHandler();
		const res = await handler({
			input: { executionId: "exec-1" },
			context,
		});

		expect(res).toEqual({ success: true, message: "Execution cancelled" });
		expect(mockSignal).toHaveBeenCalledWith("orchestratorCancelSignal");
		expect(mockExecutionUpdate).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: { status: "CANCELLED", completedAt: expect.any(Date) },
		});
		expect(mockPlanUpdateMany).toHaveBeenCalledWith({
			where: { id: "plan-1", status: "RUNNING" },
			data: { status: "APPROVED" },
		});
	});

	it("still reconciles the execution + plan when the cancel signal fails (workflow already gone)", async () => {
		mockSignal.mockRejectedValue(new Error("workflow not found"));
		const handler = await loadHandler();

		const res = await handler({
			input: { executionId: "exec-1" },
			context,
		});

		expect(res.success).toBe(true);
		expect(mockExecutionUpdate).toHaveBeenCalled();
		expect(mockPlanUpdateMany).toHaveBeenCalledWith({
			where: { id: "plan-1", status: "RUNNING" },
			data: { status: "APPROVED" },
		});
	});

	it("rejects cancelling a terminal execution with BAD_REQUEST and writes nothing", async () => {
		mockFindFirst.mockResolvedValue({
			id: "exec-1",
			planId: "plan-1",
			status: "COMPLETED",
			workflowId: "wf-1",
			runId: "run-1",
			userId: "user-1",
			organizationId: null,
		});
		const handler = await loadHandler();

		const error = await handler({
			input: { executionId: "exec-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(mockExecutionUpdate).not.toHaveBeenCalled();
		expect(mockPlanUpdateMany).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the execution is not found / not owned", async () => {
		mockFindFirst.mockResolvedValue(null);
		const handler = await loadHandler();

		const error = await handler({
			input: { executionId: "exec-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockPlanUpdateMany).not.toHaveBeenCalled();
	});
});

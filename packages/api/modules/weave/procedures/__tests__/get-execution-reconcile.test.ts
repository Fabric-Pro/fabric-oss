/**
 * Tests for the get-execution reconcile-on-read.
 *
 * Pinned contract:
 *   - Rows that look live (RUNNING/PAUSED/CHECKPOINT) and are past a 30 s
 *     startup grace get reconciled against Temporal `describe()`:
 *     FAILED/TERMINATED/TIMED_OUT ⇒ FAILED (+ plan RUNNING→APPROVED),
 *     CANCELLED ⇒ CANCELLED (+ plan APPROVED), COMPLETED ⇒ COMPLETED (no
 *     plan change), RUNNING/CONTINUED_AS_NEW ⇒ untouched,
 *     WorkflowNotFoundError ⇒ FAILED ("no longer exists").
 *   - The reconcile handle is resolved WITHOUT a runId pin (continueAsNew
 *     chains must resolve to the latest run).
 *   - Persistence is a guarded updateMany over the non-terminal status set;
 *     when the guard loses the race (count 0) the plan write is skipped.
 *   - Any Temporal failure falls back to returning the row as-is — the
 *     read never breaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockExecutionFindFirst,
	mockExecutionUpdateMany,
	mockPlanUpdateMany,
	mockCodingRunFindFirst,
	mockGetTemporalClient,
	mockGetHandle,
	mockDescribe,
	mockQuery,
} = vi.hoisted(() => ({
	mockExecutionFindFirst: vi.fn(),
	mockExecutionUpdateMany: vi.fn(),
	mockPlanUpdateMany: vi.fn(),
	mockCodingRunFindFirst: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockGetHandle: vi.fn(),
	mockDescribe: vi.fn(),
	mockQuery: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weaveExecution: {
			findFirst: mockExecutionFindFirst,
			updateMany: mockExecutionUpdateMany,
		},
		weavePlan: { updateMany: mockPlanUpdateMany },
		codingRun: { findFirst: mockCodingRunFindFirst },
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("@repo/temporal/workflows", () => ({
	orchestratorProgressQuery: "orchestratorProgressQuery",
	orchestratorPendingApprovalQuery: "orchestratorPendingApprovalQuery",
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
		assertProjectPermission: async () => undefined,
		requirePermission: () => () => undefined,
		requireProjectPermission: () => () => undefined,
		Permissions: new Proxy({}, { get: (_target, prop) => String(prop) }),
		resolveOrganizationIdForCaller: async (
			inputOrganizationId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			// Mirrors the resolution half only. The membership half it adds is
			// covered directly in the orpc procedure tests; these suites are
			// about weave's own behaviour, and a caller who is not a member
			// never reaches them.
			if (inputOrganizationId) {
				return inputOrganizationId;
			}
			if (inputOrganizationId === null) {
				return undefined;
			}
			return session.activeOrganizationId ?? undefined;
		},
		resolveOrganizationId: (
			inputOrganizationId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (inputOrganizationId) {
				return inputOrganizationId;
			}
			if (inputOrganizationId === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
	};
});

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const NON_TERMINAL = ["PENDING", "RUNNING", "PAUSED", "CHECKPOINT"];

function makeRunningRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "exec-1",
		status: "RUNNING",
		workflowId: "wf-1",
		runId: "run-1",
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		startedAt: new Date(Date.now() - 120_000),
		completedAt: null,
		error: null,
		plan: { userStoryId: null, storyTaskId: null },
		...overrides,
	};
}

async function loadHandler() {
	const mod = await import("../get-execution");
	return (mod.getExecutionProcedure as any)._handler as (args: {
		input: { executionId: string; organizationId?: string | null };
		context: typeof context;
	}) => Promise<Record<string, unknown>>;
}

async function callHandler() {
	const handler = await loadHandler();
	return handler({
		input: { executionId: "exec-1", organizationId: "org-1" },
		context,
	});
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockCodingRunFindFirst.mockResolvedValue(null);
	mockExecutionUpdateMany.mockResolvedValue({ count: 1 });
	mockPlanUpdateMany.mockResolvedValue({ count: 1 });
	mockQuery.mockResolvedValue(null);
	mockGetHandle.mockReturnValue({
		describe: mockDescribe,
		query: mockQuery,
	});
	mockGetTemporalClient.mockResolvedValue({
		workflow: { getHandle: mockGetHandle },
	});
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
});

describe("getExecutionProcedure — reconcile terminal outcomes", () => {
	it("describe FAILED ⇒ persists FAILED, restores the plan, returns the reconciled row", async () => {
		const runningRow = makeRunningRow();
		const failedRow = makeRunningRow({
			status: "FAILED",
			error: "Execution workflow failed",
			completedAt: new Date(),
		});
		mockExecutionFindFirst
			.mockResolvedValueOnce(runningRow)
			.mockResolvedValueOnce(failedRow);
		mockDescribe.mockResolvedValue({ status: { name: "FAILED" } });

		const result = await callHandler();

		// Handle resolved WITHOUT a runId pin.
		expect(mockGetHandle).toHaveBeenCalledTimes(1);
		expect(mockGetHandle.mock.calls[0]).toEqual(["wf-1"]);

		expect(mockExecutionUpdateMany).toHaveBeenCalledExactlyOnceWith({
			where: { id: "exec-1", status: { in: NON_TERMINAL } },
			data: {
				status: "FAILED",
				error: "Execution workflow failed",
				completedAt: expect.any(Date),
			},
		});
		expect(mockPlanUpdateMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				status: "RUNNING",
				executions: { some: { id: "exec-1" } },
			},
			data: { status: "APPROVED" },
		});

		// Response reflects the re-read terminal row; the live progress
		// query was skipped for the terminal state.
		expect(result.status).toBe("FAILED");
		expect(result.error).toBe("Execution workflow failed");
		expect(mockQuery).not.toHaveBeenCalled();
		expect(mockExecutionFindFirst).toHaveBeenCalledTimes(2);
	});

	it.each([
		["TERMINATED", "Execution workflow terminated"],
		["TIMED_OUT", "Execution workflow timed out"],
	])("describe %s ⇒ persists FAILED with %j", async (statusName, error) => {
		mockExecutionFindFirst
			.mockResolvedValueOnce(makeRunningRow())
			.mockResolvedValueOnce(makeRunningRow({ status: "FAILED", error }));
		mockDescribe.mockResolvedValue({ status: { name: statusName } });

		await callHandler();

		expect(mockExecutionUpdateMany).toHaveBeenCalledExactlyOnceWith({
			where: { id: "exec-1", status: { in: NON_TERMINAL } },
			data: {
				status: "FAILED",
				error,
				completedAt: expect.any(Date),
			},
		});
		expect(mockPlanUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("describe CANCELLED ⇒ persists CANCELLED (no error) and restores the plan", async () => {
		mockExecutionFindFirst
			.mockResolvedValueOnce(makeRunningRow())
			.mockResolvedValueOnce(makeRunningRow({ status: "CANCELLED" }));
		mockDescribe.mockResolvedValue({ status: { name: "CANCELLED" } });

		const result = await callHandler();

		expect(mockExecutionUpdateMany).toHaveBeenCalledExactlyOnceWith({
			where: { id: "exec-1", status: { in: NON_TERMINAL } },
			data: {
				status: "CANCELLED",
				completedAt: expect.any(Date),
			},
		});
		expect(mockPlanUpdateMany).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("CANCELLED");
	});

	it("describe COMPLETED ⇒ persists COMPLETED without touching the plan", async () => {
		mockExecutionFindFirst
			.mockResolvedValueOnce(makeRunningRow())
			.mockResolvedValueOnce(makeRunningRow({ status: "COMPLETED" }));
		mockDescribe.mockResolvedValue({ status: { name: "COMPLETED" } });

		const result = await callHandler();

		expect(mockExecutionUpdateMany).toHaveBeenCalledExactlyOnceWith({
			where: { id: "exec-1", status: { in: NON_TERMINAL } },
			data: {
				status: "COMPLETED",
				completedAt: expect.any(Date),
			},
		});
		expect(mockPlanUpdateMany).not.toHaveBeenCalled();
		expect(result.status).toBe("COMPLETED");
	});

	it("WorkflowNotFoundError ⇒ persists FAILED with the no-longer-exists copy", async () => {
		mockExecutionFindFirst
			.mockResolvedValueOnce(makeRunningRow())
			.mockResolvedValueOnce(
				makeRunningRow({
					status: "FAILED",
					error: "Execution workflow no longer exists",
				}),
			);
		mockDescribe.mockRejectedValue(
			Object.assign(new Error("workflow execution not found"), {
				name: "WorkflowNotFoundError",
			}),
		);

		const result = await callHandler();

		expect(mockExecutionUpdateMany).toHaveBeenCalledExactlyOnceWith({
			where: { id: "exec-1", status: { in: NON_TERMINAL } },
			data: {
				status: "FAILED",
				error: "Execution workflow no longer exists",
				completedAt: expect.any(Date),
			},
		});
		expect(mockPlanUpdateMany).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("FAILED");
	});
});

describe("getExecutionProcedure — live workflows untouched", () => {
	it.each([["RUNNING"], ["CONTINUED_AS_NEW"]])(
		"describe %s ⇒ no persistence, proceeds to the progress query",
		async (statusName) => {
			mockExecutionFindFirst.mockResolvedValue(makeRunningRow());
			mockDescribe.mockResolvedValue({ status: { name: statusName } });
			mockQuery.mockResolvedValue({ currentStep: 2 });

			const result = await callHandler();

			expect(mockExecutionUpdateMany).not.toHaveBeenCalled();
			expect(mockPlanUpdateMany).not.toHaveBeenCalled();
			// Reconcile handle (no runId) + progress handle (runId pinned).
			expect(mockGetHandle).toHaveBeenCalledTimes(2);
			expect(mockGetHandle.mock.calls[0]).toEqual(["wf-1"]);
			expect(mockGetHandle.mock.calls[1]).toEqual(["wf-1", "run-1"]);
			expect(mockQuery).toHaveBeenCalledWith("orchestratorProgressQuery");
			expect(result.status).toBe("RUNNING");
			expect(result.workflowStatus).toEqual({ currentStep: 2 });
			// No re-read for an untouched row.
			expect(mockExecutionFindFirst).toHaveBeenCalledTimes(1);
		},
	);
});

describe("getExecutionProcedure — reconcile never breaks the read", () => {
	it("returns the row as-is when the Temporal client is unavailable", async () => {
		mockExecutionFindFirst.mockResolvedValue(makeRunningRow());
		mockGetTemporalClient.mockRejectedValue(
			new Error("temporal unavailable"),
		);

		const result = await callHandler();

		expect(mockExecutionUpdateMany).not.toHaveBeenCalled();
		expect(mockPlanUpdateMany).not.toHaveBeenCalled();
		expect(result.status).toBe("RUNNING");
		expect(result.workflowStatus).toBeNull();
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it("returns the row as-is when describe fails with a non-NotFound error", async () => {
		mockExecutionFindFirst.mockResolvedValue(makeRunningRow());
		mockDescribe.mockRejectedValue(new Error("deadline exceeded"));
		mockQuery.mockResolvedValue({ currentStep: 1 });

		const result = await callHandler();

		expect(mockExecutionUpdateMany).not.toHaveBeenCalled();
		expect(result.status).toBe("RUNNING");
		// The existing live progress query still ran.
		expect(result.workflowStatus).toEqual({ currentStep: 1 });
	});
});

describe("getExecutionProcedure — grace window and guard", () => {
	it("skips reconcile for rows younger than 30 s", async () => {
		mockExecutionFindFirst.mockResolvedValue(
			makeRunningRow({ startedAt: new Date(Date.now() - 10_000) }),
		);
		mockQuery.mockResolvedValue({ currentStep: 1 });

		await callHandler();

		expect(mockDescribe).not.toHaveBeenCalled();
		expect(mockExecutionUpdateMany).not.toHaveBeenCalled();
		// Only the progress handle (runId pinned) was resolved.
		expect(mockGetHandle).toHaveBeenCalledTimes(1);
		expect(mockGetHandle.mock.calls[0]).toEqual(["wf-1", "run-1"]);
	});

	it("skips reconcile when startedAt is not set", async () => {
		mockExecutionFindFirst.mockResolvedValue(
			makeRunningRow({ startedAt: null }),
		);

		await callHandler();

		expect(mockDescribe).not.toHaveBeenCalled();
		expect(mockExecutionUpdateMany).not.toHaveBeenCalled();
	});

	it("skips the plan write when the guarded update lost the race (count 0)", async () => {
		// Another writer (workflow finally / watchdog / cancel) flipped the
		// row terminal between our read and the guarded update.
		const completedRow = makeRunningRow({ status: "COMPLETED" });
		mockExecutionFindFirst
			.mockResolvedValueOnce(makeRunningRow())
			.mockResolvedValueOnce(completedRow);
		mockDescribe.mockResolvedValue({ status: { name: "FAILED" } });
		mockExecutionUpdateMany.mockResolvedValue({ count: 0 });

		const result = await callHandler();

		expect(mockPlanUpdateMany).not.toHaveBeenCalled();
		// Response reflects the actual current row from the re-read.
		expect(result.status).toBe("COMPLETED");
	});
});

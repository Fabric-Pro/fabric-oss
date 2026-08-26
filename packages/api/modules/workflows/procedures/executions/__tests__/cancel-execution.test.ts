/**
 * Cancelling a run must be tenant-scoped, idempotent, and must never leave an
 * execution stuck in RUNNING.
 *
 * The last one is the reason for the fallback path: if Temporal is unreachable
 * — or the execution never got a Temporal run because Temporal was down when
 * it started — the row is still marked CANCELLED directly. Otherwise a user
 * would be looking at a run they cannot stop and that will never finish.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getExecutionMock,
	updateExecutionMock,
	cancelMock,
	getHandleMock,
	isTemporalAvailableMock,
} = vi.hoisted(() => {
	const cancelMock = vi.fn();
	return {
		getExecutionMock: vi.fn(),
		updateExecutionMock: vi.fn(),
		cancelMock,
		getHandleMock: vi.fn(() => ({ cancel: cancelMock })),
		isTemporalAvailableMock: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	getWorkflowExecutionById: getExecutionMock,
	updateWorkflowExecution: updateExecutionMock,
}));

vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: isTemporalAvailableMock,
	getTemporalClient: async () => ({
		workflow: { getHandle: getHandleMock },
	}),
}));

vi.mock("../../../../../orpc/procedures", () => ({
	Permissions: { WORKSPACE_UPDATE: "workspace:update" },
	requirePermission: () => (next: unknown) => next,
	resolveOrganizationId: (input: string | null | undefined) => input ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({
						handler: (fn: unknown) => fn,
					}),
				}),
			}),
		}),
	},
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ id: "member-1" }),
}));

import { cancelWorkflowExecutionProcedure } from "../cancel-execution";

type Handler = (args: {
	input: { executionId: string; organizationId?: string | null };
	context: { user: { id: string }; session: unknown };
}) => Promise<{ cancelled: boolean; status: string; message?: string }>;

const handler = cancelWorkflowExecutionProcedure as unknown as Handler;

function call(executionId = "exec-1") {
	return handler({
		input: { executionId, organizationId: null },
		context: { user: { id: "user-1" }, session: {} },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	isTemporalAvailableMock.mockResolvedValue(true);
	cancelMock.mockResolvedValue(undefined);
	updateExecutionMock.mockResolvedValue(undefined);
});

describe("cancelWorkflowExecution", () => {
	it("requests cancellation in Temporal for a running execution", async () => {
		getExecutionMock.mockResolvedValue({
			id: "exec-1",
			status: "RUNNING",
			temporalRunId: "workflow-execution-exec-1",
		});

		const result = await call();

		expect(getHandleMock).toHaveBeenCalledWith("workflow-execution-exec-1");
		expect(cancelMock).toHaveBeenCalledOnce();
		expect(result.cancelled).toBe(true);
		// The workflow writes its own terminal state on the way out.
		expect(updateExecutionMock).not.toHaveBeenCalled();
	});

	it("is a no-op for an execution that already finished", async () => {
		getExecutionMock.mockResolvedValue({
			id: "exec-1",
			status: "COMPLETED",
			temporalRunId: "workflow-execution-exec-1",
		});

		const result = await call();

		expect(result.cancelled).toBe(false);
		expect(result.status).toBe("COMPLETED");
		expect(cancelMock).not.toHaveBeenCalled();
		expect(updateExecutionMock).not.toHaveBeenCalled();
	});

	it("refuses an execution the caller cannot see", async () => {
		// Tenant-scoped lookup returns nothing for another tenant's execution.
		getExecutionMock.mockResolvedValue(null);

		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(cancelMock).not.toHaveBeenCalled();
	});

	it("marks the row cancelled when Temporal is unavailable", async () => {
		isTemporalAvailableMock.mockResolvedValue(false);
		getExecutionMock.mockResolvedValue({
			id: "exec-1",
			status: "RUNNING",
			temporalRunId: "workflow-execution-exec-1",
		});

		const result = await call();

		expect(result.cancelled).toBe(true);
		expect(updateExecutionMock).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});

	it("marks the row cancelled when the Temporal handle rejects", async () => {
		cancelMock.mockRejectedValue(new Error("workflow not found"));
		getExecutionMock.mockResolvedValue({
			id: "exec-1",
			status: "RUNNING",
			temporalRunId: "workflow-execution-exec-1",
		});

		const result = await call();

		expect(result.cancelled).toBe(true);
		expect(updateExecutionMock).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});

	it("cancels an execution that never got a Temporal run", async () => {
		getExecutionMock.mockResolvedValue({
			id: "exec-1",
			status: "PENDING",
			temporalRunId: null,
		});

		const result = await call();

		expect(result.cancelled).toBe(true);
		expect(getHandleMock).not.toHaveBeenCalled();
		expect(updateExecutionMock).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});
});

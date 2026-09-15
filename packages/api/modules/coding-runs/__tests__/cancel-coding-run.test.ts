/**
 * cancelCodingRun — the cancel signal must reach a live workflow before the
 * row is released.
 *
 * The workflow id is deterministic (`coding-run-${id}`), so a null
 * `workflowId` column only means post-start bookkeeping failed. Marking
 * the row CANCELLED without signalling the derived id would drop it out of
 * coding_run_one_active_per_story while the workflow keeps running.
 *
 * Run with: pnpm --filter @repo/api test modules/coding-runs/__tests__/cancel-coding-run.test.ts
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockGetCodingRun,
	mockGetProjectMemberRole,
	mockUpdateCodingRunStatus,
	mockHasPermission,
	mockGetTemporalClient,
	workflowGetHandle,
	workflowSignal,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mockGetCodingRun = vi.fn();
	const mockGetProjectMemberRole = vi.fn();
	const mockUpdateCodingRunStatus = vi.fn();
	const mockHasPermission = vi.fn();
	const mockGetTemporalClient = vi.fn();
	const workflowSignal = vi.fn();
	const workflowGetHandle = vi.fn(() => ({ signal: workflowSignal }));
	return {
		handlers,
		mockGetCodingRun,
		mockGetProjectMemberRole,
		mockUpdateCodingRunStatus,
		mockHasPermission,
		mockGetTemporalClient,
		workflowGetHandle,
		workflowSignal,
	};
});

vi.mock("@repo/database", () => ({
	getCodingRun: mockGetCodingRun,
	getProjectMemberRole: mockGetProjectMemberRole,
	updateCodingRunStatus: mockUpdateCodingRunStatus,
}));

vi.mock("@repo/permissions", () => ({
	hasPermission: mockHasPermission,
	Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	resolveProjectPermissions: vi.fn(() => new Set<string>()),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.cancel = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

import "../procedures/cancel-coding-run";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const baseRun = {
	id: "run-1",
	projectId: "proj-1",
	status: "RUNNING",
	workflowId: null as string | null,
};

async function callCancel(input = { id: "run-1", organizationId: null }) {
	return await handlers.cancel({ input, context });
}

async function expectORPCError(
	promise: Promise<unknown>,
	code: string,
): Promise<ORPCError<string, unknown>> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	expect((error as ORPCError<string, unknown>).code).toBe(code);
	return error as ORPCError<string, unknown>;
}

function workflowNotFoundError() {
	const error = new Error("Workflow execution not found");
	error.name = "WorkflowNotFoundError";
	return error;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCodingRun.mockResolvedValue({ ...baseRun });
	mockGetProjectMemberRole.mockResolvedValue("EDITOR");
	mockHasPermission.mockReturnValue(true);
	mockUpdateCodingRunStatus.mockResolvedValue({});
	mockGetTemporalClient.mockResolvedValue({
		workflow: { getHandle: workflowGetHandle },
	});
	workflowSignal.mockResolvedValue(undefined);
});

describe("cancelCodingRun — null workflowId (post-start bookkeeping failed)", () => {
	it("signals the derived deterministic workflow id instead of skipping the signal", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, workflowId: null });

		const result = await callCancel();

		expect(workflowGetHandle).toHaveBeenCalledTimes(1);
		expect(workflowGetHandle).toHaveBeenCalledWith("coding-run-run-1");
		expect(workflowSignal).toHaveBeenCalledWith("cancelCodingRun");
		expect(mockUpdateCodingRunStatus).toHaveBeenCalledWith(
			"run-1",
			"CANCELLED",
		);
		expect(result).toEqual({ status: "cancelled" });
	});

	it("marks the run CANCELLED only after the signal succeeds", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, workflowId: null });

		await callCancel();

		const signalOrder = workflowSignal.mock.invocationCallOrder[0];
		const updateOrder =
			mockUpdateCodingRunStatus.mock.invocationCallOrder[0];
		expect(signalOrder).toBeLessThan(updateOrder);
	});

	it("treats WorkflowNotFoundError on the derived id as an absent workflow and marks CANCELLED", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, workflowId: null });
		workflowSignal.mockRejectedValue(workflowNotFoundError());

		const result = await callCancel();

		expect(workflowGetHandle).toHaveBeenCalledWith("coding-run-run-1");
		expect(mockUpdateCodingRunStatus).toHaveBeenCalledWith(
			"run-1",
			"CANCELLED",
		);
		expect(result).toEqual({ status: "cancelled" });
	});

	it("does not release the row when the signal fails for any other reason", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, workflowId: null });
		workflowSignal.mockRejectedValue(new Error("temporal unavailable"));

		const error = await expectORPCError(
			callCancel(),
			"INTERNAL_SERVER_ERROR",
		);

		expect(error.message).toContain("temporal unavailable");
		expect(mockUpdateCodingRunStatus).not.toHaveBeenCalled();
	});

	it("does not treat a lookalike not-found message as an absent workflow", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, workflowId: null });
		workflowSignal.mockRejectedValue(
			new Error("workflow not found in cache"),
		);

		await expectORPCError(callCancel(), "INTERNAL_SERVER_ERROR");
		expect(mockUpdateCodingRunStatus).not.toHaveBeenCalled();
	});

	it("does not release the row when the Temporal client cannot be built", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, workflowId: null });
		mockGetTemporalClient.mockRejectedValue(
			new Error("temporal unreachable"),
		);

		await expectORPCError(callCancel(), "INTERNAL_SERVER_ERROR");
		expect(mockUpdateCodingRunStatus).not.toHaveBeenCalled();
	});
});

describe("cancelCodingRun — persisted workflowId", () => {
	it("uses the stored workflow id as-is", async () => {
		mockGetCodingRun.mockResolvedValue({
			...baseRun,
			workflowId: "coding-run-run-1",
		});

		await callCancel();

		expect(workflowGetHandle).toHaveBeenCalledWith("coding-run-run-1");
		expect(workflowSignal).toHaveBeenCalledWith("cancelCodingRun");
		expect(mockUpdateCodingRunStatus).toHaveBeenCalledWith(
			"run-1",
			"CANCELLED",
		);
	});
});

describe("cancelCodingRun — guards", () => {
	it("rejects cancellation of a run that is not active without touching Temporal", async () => {
		mockGetCodingRun.mockResolvedValue({ ...baseRun, status: "COMPLETED" });

		await expectORPCError(callCancel(), "BAD_REQUEST");
		expect(workflowGetHandle).not.toHaveBeenCalled();
		expect(mockUpdateCodingRunStatus).not.toHaveBeenCalled();
	});

	it("rejects a caller without project-level STORY_UPDATE before signalling", async () => {
		mockHasPermission.mockReturnValue(false);

		await expectORPCError(callCancel(), "FORBIDDEN");
		expect(workflowGetHandle).not.toHaveBeenCalled();
		expect(mockUpdateCodingRunStatus).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND for a run outside the caller's tenant scope", async () => {
		mockGetCodingRun.mockResolvedValue(null);

		await expectORPCError(callCancel(), "NOT_FOUND");
		expect(workflowGetHandle).not.toHaveBeenCalled();
	});
});

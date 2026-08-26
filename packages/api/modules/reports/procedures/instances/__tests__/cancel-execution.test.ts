/**
 * Handler tests for `reports.instances.cancelExecution`. Exercise the orchestration
 * — tenant-isolation gate, owner-or-org-admin authz (a non-member resolves to
 * NOT_FOUND, not FORBIDDEN, so existence isn't leaked), the guarded compare-and-set
 * flip, partial-output (artifact) cleanup, and best-effort Temporal terminate — with
 * `@repo/database`, `@repo/temporal`, `@repo/logs`, and the orpc procedure chain
 * mocked (no Prisma, no worker). The orpc procedures mock path is the SUT's import
 * path plus one extra `../` because this file sits one directory deeper in `__tests__/`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockGetExecution,
	mockCancelActive,
	mockDeleteArtifacts,
	mockGetOrgMembership,
	mockGetTemporalClient,
	mockTerminate,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	mockGetExecution: vi.fn(),
	mockCancelActive: vi.fn(),
	mockDeleteArtifacts: vi.fn(),
	mockGetOrgMembership: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockTerminate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getTemplateInstanceExecution: (...a: unknown[]) => mockGetExecution(...a),
	cancelActiveTemplateInstanceExecution: (...a: unknown[]) =>
		mockCancelActive(...a),
	deleteTemplateInstanceArtifactsForExecution: (...a: unknown[]) =>
		mockDeleteArtifacts(...a),
	getOrganizationMembership: (...a: unknown[]) => mockGetOrgMembership(...a),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => mockGetTemporalClient(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../../../../../orpc/procedures", () => {
	function makeChainable() {
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			use: () => c,
			route: () => c,
			input: () => c,
			handler: (fn: (...args: unknown[]) => unknown) => {
				handlers.cancelExecution = fn;
				return { _handler: fn };
			},
		});
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: { REPORT_EXECUTE: "REPORT_EXECUTE" },
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? null,
	};
});

import "../cancel-execution";

const ctx = {
	user: { id: "u1", email: "u@x.com" },
	session: { id: "s1", activeOrganizationId: null },
};

const call = (input: Record<string, unknown>) =>
	handlers.cancelExecution({ input, context: ctx }) as Promise<{
		cancelled: boolean;
	}>;

beforeEach(() => {
	vi.clearAllMocks();
	mockGetTemporalClient.mockResolvedValue({
		workflow: { getHandle: () => ({ terminate: mockTerminate }) },
	});
	mockTerminate.mockResolvedValue(undefined);
	mockGetOrgMembership.mockResolvedValue({ role: "admin" });
	mockDeleteArtifacts.mockResolvedValue(0);
	mockCancelActive.mockResolvedValue(true);
});

describe("cancelExecutionProcedure", () => {
	it("owner cancels a RUNNING execution → flips CANCELLED, clears artifacts, terminates (AE2)", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e1",
			userId: "u1",
			organizationId: null,
			status: "RUNNING",
			workflowId: "wf1",
		});

		await expect(call({ executionId: "e1" })).resolves.toEqual({
			cancelled: true,
		});
		// Owner path never consults org membership.
		expect(mockGetOrgMembership).not.toHaveBeenCalled();
		expect(mockCancelActive).toHaveBeenCalledWith("e1", {
			cancelledBy: "u1",
		});
		expect(mockDeleteArtifacts).toHaveBeenCalledWith("e1");
		expect(mockTerminate).toHaveBeenCalledTimes(1);
	});

	it("org admin (not owner) cancels an org-context RUNNING execution → allowed (R11)", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e2",
			userId: "owner2",
			organizationId: "org1",
			status: "RUNNING",
			workflowId: "wf2",
		});
		mockGetOrgMembership.mockResolvedValue({ role: "owner" });

		await expect(
			call({ executionId: "e2", organizationId: "org1" }),
		).resolves.toEqual({ cancelled: true });
		// Membership is checked against the execution's STORED org.
		expect(mockGetOrgMembership).toHaveBeenCalledWith("org1", "u1");
		expect(mockCancelActive).toHaveBeenCalledWith("e2", {
			cancelledBy: "u1",
		});
	});

	it("org member without admin/owner role → FORBIDDEN, no flip, no terminate (AE5)", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e3",
			userId: "owner3",
			organizationId: "org1",
			status: "RUNNING",
			workflowId: "wf3",
		});
		mockGetOrgMembership.mockResolvedValue({ role: "member" });

		await expect(
			call({ executionId: "e3", organizationId: "org1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockCancelActive).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
	});

	it("non-member of the org → NOT_FOUND (no existence oracle), no flip", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e3b",
			userId: "owner3",
			organizationId: "org1",
			status: "RUNNING",
			workflowId: "wf3b",
		});
		mockGetOrgMembership.mockResolvedValue(null);

		await expect(
			call({ executionId: "e3b", organizationId: "org1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockCancelActive).not.toHaveBeenCalled();
	});

	it("personal execution owned by someone else → NOT_FOUND (no cross-owner leak)", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e4",
			userId: "other",
			organizationId: null,
			status: "RUNNING",
			workflowId: "wf4",
		});

		await expect(call({ executionId: "e4" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockCancelActive).not.toHaveBeenCalled();
	});

	it("cross-tenant executionId (org mismatch) → NOT_FOUND, no flip, no terminate (IDOR)", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e5",
			userId: "x",
			organizationId: "orgOther",
			status: "RUNNING",
			workflowId: "wf5",
		});

		await expect(
			call({ executionId: "e5", organizationId: "org1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockCancelActive).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
	});

	it("lost race / already terminal → CAS false → {cancelled:false}, no cleanup, no terminate (AE3/AE4)", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e6",
			userId: "u1",
			organizationId: null,
			status: "RUNNING",
			workflowId: "wf6",
		});
		mockCancelActive.mockResolvedValue(false);

		await expect(call({ executionId: "e6" })).resolves.toEqual({
			cancelled: false,
		});
		expect(mockDeleteArtifacts).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
	});

	it("terminate() throws → swallowed, still {cancelled:true}", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e7",
			userId: "u1",
			organizationId: null,
			status: "RUNNING",
			workflowId: "wf7",
		});
		mockTerminate.mockRejectedValue(new Error("handle gone"));

		await expect(call({ executionId: "e7" })).resolves.toEqual({
			cancelled: true,
		});
	});

	it("missing workflowId → skips terminate, still {cancelled:true}", async () => {
		mockGetExecution.mockResolvedValue({
			id: "e8",
			userId: "u1",
			organizationId: null,
			status: "PENDING",
			workflowId: null,
		});

		await expect(call({ executionId: "e8" })).resolves.toEqual({
			cancelled: true,
		});
		// Artifacts are still cleared even when there's no workflow to terminate.
		expect(mockDeleteArtifacts).toHaveBeenCalledWith("e8");
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
	});

	it("execution not found → NOT_FOUND", async () => {
		mockGetExecution.mockResolvedValue(null);

		await expect(call({ executionId: "missing" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockCancelActive).not.toHaveBeenCalled();
	});
});

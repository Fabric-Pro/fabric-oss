/**
 * Tests for the deletePlanProcedure.
 *
 * Pinned contract:
 *   - Tenant-XOR lookup: a miss throws NOT_FOUND with no delete.
 *   - Project-access denial throws FORBIDDEN with no delete.
 *   - A plan with an active execution (PENDING/RUNNING/PAUSED/CHECKPOINT)
 *     throws BAD_REQUEST and is NOT deleted.
 *   - Otherwise the plan is deleted by id (executions cascade via schema).
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockAssertProjectPermission,
	mockPlanFindFirst,
	mockPlanDelete,
	mockExecutionFindFirst,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockAssertProjectPermission: vi.fn(),
	mockPlanFindFirst: vi.fn(),
	mockPlanDelete: vi.fn(),
	mockExecutionFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weavePlan: {
			findFirst: mockPlanFindFirst,
			delete: mockPlanDelete,
		},
		weaveExecution: {
			findFirst: mockExecutionFindFirst,
		},
	},
	hasProjectAccess: mockHasProjectAccess,
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
		assertProjectPermission: mockAssertProjectPermission,
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

const plan = { id: "plan-1", projectId: "proj-1", name: "Test plan" };

async function loadHandler() {
	const mod = await import("../delete-plan");
	return (mod.deletePlanProcedure as any)._handler as (args: {
		input: { planId: string; organizationId?: string | null };
		context: typeof context;
	}) => Promise<{ success: boolean; planId: string }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockHasProjectAccess.mockResolvedValue(true);
	mockAssertProjectPermission.mockResolvedValue(undefined);
	mockPlanFindFirst.mockResolvedValue(plan);
	mockExecutionFindFirst.mockResolvedValue(null);
	mockPlanDelete.mockResolvedValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("deletePlanProcedure", () => {
	it("throws NOT_FOUND when the tenant-XOR lookup misses (no delete)", async () => {
		mockPlanFindFirst.mockResolvedValue(null);
		const handler = await loadHandler();

		const error = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockPlanDelete).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when project access is denied (no delete)", async () => {
		mockAssertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission",
			}),
		);
		const handler = await loadHandler();

		const error = await handler({
			input: { planId: "plan-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
		expect(mockPlanDelete).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when an execution is still active (no delete)", async () => {
		mockExecutionFindFirst.mockResolvedValue({ id: "exec-1" });
		const handler = await loadHandler();

		const error = await handler({
			input: { planId: "plan-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(mockPlanDelete).not.toHaveBeenCalled();
		// the guard query scopes to the non-terminal statuses
		const where = mockExecutionFindFirst.mock.calls[0][0].where;
		expect(where.planId).toBe("plan-1");
		expect(where.status.in).toEqual(
			expect.arrayContaining([
				"PENDING",
				"RUNNING",
				"PAUSED",
				"CHECKPOINT",
			]),
		);
	});

	it("deletes the plan by id when no execution is active", async () => {
		const handler = await loadHandler();

		const result = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		});

		expect(result).toEqual({ success: true, planId: "plan-1" });
		expect(mockPlanDelete).toHaveBeenCalledWith({
			where: { id: "plan-1" },
		});
	});

	it("scopes the lookup to personal context when organizationId is null", async () => {
		const handler = await loadHandler();

		await handler({
			input: { planId: "plan-1", organizationId: null },
			context,
		});

		const where = mockPlanFindFirst.mock.calls[0][0].where;
		expect(where.userId).toBe("user-1");
		expect(where.organizationId).toBeNull();
	});
});

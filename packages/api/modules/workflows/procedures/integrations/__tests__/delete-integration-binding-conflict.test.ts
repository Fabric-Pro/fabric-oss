/**
 * Check-then-delete race on integration deletion vs project Databricks
 * knowledge bindings (`onDelete: Restrict`).
 *
 * Both delete procedures pre-check for dependent bindings and return a named
 * CONFLICT — but a binding created BETWEEN the check and the delete is only
 * blocked by the RESTRICT FK (Prisma P2003). That error must be caught and
 * re-reported as the same named CONFLICT (re-querying the dependents for the
 * message), never escape as a raw constraint error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	deleteIntegrationMock,
	deleteByTypeMock,
	getByIdMock,
	listBoundMock,
	findManyMock,
	MockPrismaKnownError,
} = vi.hoisted(() => {
	class MockPrismaKnownError extends Error {
		code: string;
		constructor(code: string) {
			super(`prisma error ${code}`);
			this.code = code;
		}
	}
	return {
		deleteIntegrationMock: vi.fn(),
		deleteByTypeMock: vi.fn(),
		getByIdMock: vi.fn(),
		listBoundMock: vi.fn(),
		findManyMock: vi.fn(),
		MockPrismaKnownError,
	};
});

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	return {
		deleteWorkflowIntegration: deleteIntegrationMock,
		deleteWorkflowIntegrationByType: deleteByTypeMock,
		getWorkflowIntegrationById: getByIdMock,
		listProjectsBoundToIntegration: listBoundMock,
		db: { workflowIntegration: { findMany: findManyMock } },
		Prisma: { PrismaClientKnownRequestError: MockPrismaKnownError },
		WorkflowIntegrationProviderSchema: z.string(),
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requirePermission: () => () => ({}),
		resolveOrganizationId: (input: unknown) => input ?? undefined,
		Permissions: { WORKSPACE_DELETE: "workspace:delete" } as const,
	};
});

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ id: "m-1" }),
}));

vi.mock("@orpc/client", () => ({
	ORPCError: class extends Error {
		readonly code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

const ctx = {
	user: { id: "user-1", email: "u@example.com", name: "U" },
	session: { id: "session-1" },
};

type CapturedHandler = (args: {
	input: Record<string, unknown>;
	context: typeof ctx;
}) => Promise<unknown>;

function handlerOf(procedure: unknown): CapturedHandler {
	return (procedure as { _handler: CapturedHandler })._handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	getByIdMock.mockResolvedValue({ id: "int-1" });
});

describe("deleteIntegrationProcedure — P2003 race", () => {
	it("reports a binding created after the pre-check as the named CONFLICT with the dependent project", async () => {
		// Pre-check sees nothing; the RESTRICT FK then fires on delete; the
		// re-query names the project that appeared in between.
		listBoundMock
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ projectId: "proj_a", projectName: "Proj A" },
			]);
		deleteIntegrationMock.mockRejectedValue(
			new MockPrismaKnownError("P2003"),
		);
		const mod = await import("../delete-integration");
		const handler = handlerOf(mod.deleteIntegrationProcedure);

		await expect(
			handler({ input: { integrationId: "int-1" }, context: ctx }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Proj A"),
		});
	});

	it("falls back to a generic dependent-projects message when the re-query races empty", async () => {
		listBoundMock.mockResolvedValue([]);
		deleteIntegrationMock.mockRejectedValue(
			new MockPrismaKnownError("P2003"),
		);
		const mod = await import("../delete-integration");
		const handler = handlerOf(mod.deleteIntegrationProcedure);

		await expect(
			handler({ input: { integrationId: "int-1" }, context: ctx }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("one or more projects"),
		});
	});

	it("re-throws non-P2003 delete errors untouched", async () => {
		listBoundMock.mockResolvedValue([]);
		deleteIntegrationMock.mockRejectedValue(
			new MockPrismaKnownError("P2002"),
		);
		const mod = await import("../delete-integration");
		const handler = handlerOf(mod.deleteIntegrationProcedure);

		await expect(
			handler({ input: { integrationId: "int-1" }, context: ctx }),
		).rejects.toThrow(/P2002/);
	});
});

describe("disconnectByTypeProcedure — P2003 race", () => {
	it("reports a binding created after the pre-check as the named CONFLICT with the dependent project", async () => {
		// Pre-check: no integrations rows yet → no bindings. Post-catch
		// re-query: the row and its dependent project are visible.
		findManyMock
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "int-1" }]);
		listBoundMock.mockResolvedValue([
			{ projectId: "proj_b", projectName: "Proj B" },
		]);
		deleteByTypeMock.mockRejectedValue(new MockPrismaKnownError("P2003"));
		const mod = await import("../disconnect-by-type");
		const handler = handlerOf(mod.disconnectByTypeProcedure);

		await expect(
			handler({
				input: { type: "DATABRICKS_VECTOR_SEARCH" },
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Proj B"),
		});
	});

	it("re-throws non-P2003 delete errors untouched", async () => {
		findManyMock.mockResolvedValue([]);
		deleteByTypeMock.mockRejectedValue(new Error("connection reset"));
		const mod = await import("../disconnect-by-type");
		const handler = handlerOf(mod.disconnectByTypeProcedure);

		await expect(
			handler({
				input: { type: "DATABRICKS_VECTOR_SEARCH" },
				context: ctx,
			}),
		).rejects.toThrow(/connection reset/);
	});
});

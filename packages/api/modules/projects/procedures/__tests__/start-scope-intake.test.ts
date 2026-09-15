/**
 * projects.backlog.startScopeIntake (plan §Slice 1)
 *
 * Run with: pnpm --filter @repo/api test -- modules/projects/procedures/__tests__/start-scope-intake.test.ts
 */

import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockGetContextById, mockWorkflowStart } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockGetContextById: vi.fn(),
	mockWorkflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getContextById: mockGetContextById,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockQuery = vi.fn();
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: mockWorkflowStart,
			getHandle: () => ({ query: mockQuery, result: vi.fn() }),
		},
	}),
	intakeProgressQuery: "intakeProgress",
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			// First registered handler is start, second is progress.
			handlers[handlers.start ? "progress" : "start"] = fn;
			return { _handler: fn };
		},
	};
	return {
		resolveOrganizationIdForCaller: vi.fn(
			async (organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

import "../backlog/start-scope-intake";
import "../backlog/intake-progress";

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

function call(input: Record<string, unknown>) {
	return handlers.start({ input, context: ctx }) as Promise<{
		success: true;
		workflowId: string;
		alreadyRunning: boolean;
	}>;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("startScopeIntake", () => {
	it("rejects a context that belongs to another project or tenant as NOT_FOUND", async () => {
		// getContextById(contextId, projectId, tenant) applies the XOR tenant
		// filter and returns null for a foreign row.
		mockGetContextById.mockResolvedValue(null);
		await expect(
			call({
				projectId: "proj-A",
				contextId: "ctx-of-proj-B",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<
			ORPCError<string, unknown>
		>);
		expect(mockGetContextById).toHaveBeenCalledWith(
			"ctx-of-proj-B",
			"proj-A",
			{
				userId: "user-1",
				organizationId: "org-1",
			},
		);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("rejects a row whose projectId does not match even if the lookup returns it", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-B",
			extractionStatus: "COMPLETED",
			organizationId: "org-1",
		});
		await expect(
			call({
				projectId: "proj-A",
				contextId: "ctx-1",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses a context whose extraction failed", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-A",
			extractionStatus: "FAILED",
			organizationId: "org-1",
		});
		await expect(
			call({
				projectId: "proj-A",
				contextId: "ctx-1",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("starts the workflow on project-documents with the deterministic id", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-A",
			extractionStatus: "COMPLETED",
			organizationId: "org-1",
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "scope-intake-ctx-1",
		});
		const result = await call({
			projectId: "proj-A",
			contextId: "ctx-1",
			organizationId: "org-1",
		});
		expect(result).toMatchObject({
			success: true,
			workflowId: "scope-intake-ctx-1",
			alreadyRunning: false,
		});
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"scopeIntakeWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				workflowId: "scope-intake-ctx-1",
				args: [
					expect.objectContaining({
						projectId: "proj-A",
						contextId: "ctx-1",
						userId: "user-1",
						organizationId: "org-1",
					}),
				],
			}),
		);
	});

	it("treats WorkflowExecutionAlreadyStartedError as success (idempotent)", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-A",
			extractionStatus: "EXTRACTING",
			organizationId: "org-1",
		});
		const err = new Error("Workflow execution already started");
		err.name = "WorkflowExecutionAlreadyStartedError";
		mockWorkflowStart.mockRejectedValue(err);
		const result = await call({
			projectId: "proj-A",
			contextId: "ctx-1",
			organizationId: "org-1",
		});
		expect(result).toMatchObject({
			success: true,
			workflowId: "scope-intake-ctx-1",
			alreadyRunning: true,
		});
	});

	it("surfaces other start failures as INTERNAL_SERVER_ERROR", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-A",
			extractionStatus: "COMPLETED",
			organizationId: "org-1",
		});
		mockWorkflowStart.mockRejectedValue(new Error("temporal down"));
		await expect(
			call({
				projectId: "proj-A",
				contextId: "ctx-1",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
	});
});

describe("intakeProgress", () => {
	it("refuses to address a workflow for a context outside the project or tenant", async () => {
		mockGetContextById.mockResolvedValue(null);
		await expect(
			handlers.progress({
				input: {
					projectId: "proj-A",
					contextId: "ctx-of-proj-B",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockQuery).not.toHaveBeenCalled();
	});

	it("returns progress for a context that belongs to the project", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-A",
			extractionStatus: "COMPLETED",
		});
		mockQuery.mockResolvedValue({
			status: "extracting",
			message: "Extracting scope items",
		});
		const result = (await handlers.progress({
			input: {
				projectId: "proj-A",
				contextId: "ctx-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as { status: string; contextId: string };
		expect(result.status).toBe("extracting");
		expect(result.contextId).toBe("ctx-1");
	});
});

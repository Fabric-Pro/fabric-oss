/**
 * Unit tests for `summarizeContextProcedure` — the manual context-summarization
 * trigger.
 *
 * Two gates guard the handler:
 *   1. Admin-only middleware — `requireProjectPermission(PROJECT_SETTINGS_EDIT)`.
 *      In this oRPC-mock harness the permission middleware is a no-op
 *      passthrough (its enforcement is covered by
 *      `packages/api/__tests__/require-project-permission.test.ts`), so here we
 *      assert *structurally* that the procedure is wired to that admin
 *      permission — the create-test-case harness pattern.
 *   2. Feature flag — `assertContextSummarizationEnabled()` throws NOT_FOUND
 *      when `FABRIC_FEATURE_CONTEXT_SUMMARIZATION` is unset (default). This runs
 *      inside the handler body, so it is exercised end-to-end below, plus a
 *      direct unit test of the assert.
 *
 * Harness mirrors the sibling `contexts/__tests__/delete-context.test.ts` and
 * `test-cases/__tests__/create-test-case.test.ts` oRPC mocks exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetInProgress, mockHasProjectAccess, mockStartWorkflow } =
	vi.hoisted(() => ({
		mockGetInProgress: vi.fn(),
		mockHasProjectAccess: vi.fn(),
		mockStartWorkflow: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	getInProgressContextSummary: mockGetInProgress,
	hasProjectAccess: mockHasProjectAccess,
}));

// Lazy-imported inside the handler (`await import("@repo/temporal")`).
vi.mock("@repo/temporal", () => ({
	startContextSummarizationWorkflow: mockStartWorkflow,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (
			orgId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (orgId) {
				return orgId;
			}
			if (orgId === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { assertContextSummarizationEnabled } from "../../../lib/context-summarization-feature";
import { summarizeContextProcedure } from "../summarize-context";

type Handler = (args: {
	input: {
		projectId: string;
		organizationId?: string | null;
		sources?: {
			context: boolean;
			decisions: boolean;
			roadmap: boolean;
			codeRepo: boolean;
		};
	};
	context: {
		user: { id: string; name?: string; email?: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

const handler = (summarizeContextProcedure as unknown as { handler: Handler })
	.handler;

const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: { activeOrganizationId: undefined },
};

const FLAG = "FABRIC_FEATURE_CONTEXT_SUMMARIZATION";

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetInProgress.mockResolvedValue(null);
	mockStartWorkflow.mockResolvedValue({
		workflowId: "context-summarization-p1",
		started: true,
	});
	delete process.env[FLAG];
});

afterEach(() => {
	delete process.env[FLAG];
});

describe("summarizeContextProcedure — admin gate", () => {
	it("is gated on PROJECT_SETTINGS_EDIT (admin-only)", () => {
		expect(
			(summarizeContextProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("PROJECT_SETTINGS_EDIT");
	});
});

describe("summarizeContextProcedure — feature flag", () => {
	it("throws NOT_FOUND and never touches the project when the flag is unset", async () => {
		await expect(
			handler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// The gate runs before any access check or dispatch.
		expect(mockHasProjectAccess).not.toHaveBeenCalled();
		expect(mockStartWorkflow).not.toHaveBeenCalled();
	});
});

describe("summarizeContextProcedure — access + dispatch (flag on)", () => {
	beforeEach(() => {
		process.env[FLAG] = "true";
	});

	it("rejects FORBIDDEN when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handler({
				input: { projectId: "p1", organizationId: null },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockStartWorkflow).not.toHaveBeenCalled();
	});

	it("dispatches a MANUAL run and returns PENDING when nothing is in flight", async () => {
		const res = await handler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(res).toEqual({
			started: true,
			status: "PENDING",
			workflowId: "context-summarization-p1",
		});
		// Default selection = all on, EXCEPT code-repo (its flag is off in tests).
		expect(mockStartWorkflow).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "u1",
			organizationId: null,
			trigger: "MANUAL",
			triggeredByUserId: "u1",
			sources: {
				context: true,
				decisions: true,
				roadmap: true,
				codeRepo: false,
			},
		});
	});

	it("passes a chosen subset through and never enables code-repo without its flag", async () => {
		await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				sources: {
					context: false,
					decisions: true,
					roadmap: false,
					// Requested on, but the FEATURE_CODE_INDEXING flag is off → forced off.
					codeRepo: true,
				},
			},
			context: ctx,
		});

		expect(mockStartWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				sources: {
					context: false,
					decisions: true,
					roadmap: false,
					codeRepo: false,
				},
			}),
		);
	});

	it("rejects BAD_REQUEST when no source is selected", async () => {
		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					sources: {
						context: false,
						decisions: false,
						roadmap: false,
						codeRepo: false,
					},
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mockStartWorkflow).not.toHaveBeenCalled();
	});

	it("early-outs (started: false) when a run is already in progress", async () => {
		mockGetInProgress.mockResolvedValue({ status: "GENERATING" });

		const res = await handler({
			input: { projectId: "p1", organizationId: null },
			context: ctx,
		});

		expect(res).toEqual({
			started: false,
			status: "GENERATING",
			workflowId: "context-summarization-p1",
		});
		expect(mockStartWorkflow).not.toHaveBeenCalled();
	});
});

describe("assertContextSummarizationEnabled", () => {
	afterEach(() => {
		delete process.env[FLAG];
	});

	it("throws NOT_FOUND when the flag is unset", () => {
		delete process.env[FLAG];
		expect(() => assertContextSummarizationEnabled()).toThrow(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
	});

	it("does not throw when the flag is enabled", () => {
		process.env[FLAG] = "true";
		expect(() => assertContextSummarizationEnabled()).not.toThrow();
	});
});

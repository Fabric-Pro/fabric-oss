/**
 * Tests for the start-execution provider preflight.
 *
 * Pinned contract:
 *   - All prerequisite checks run after the APPROVED-status guard and BEFORE
 *     `db.weaveExecution.create` — on failure no execution row and no
 *     workflow exist.
 *   - Both providers require a project repository URL.
 *   - BACKGROUND_AGENTS (also the default when the provider is omitted)
 *     additionally requires a GitHub owner/repo-parseable URL (HTTPS or SSH,
 *     mirroring the worker-side sandbox parser).
 *   - KANBAN_LOCAL requires AGENT_SERVICE_SECRET in every environment.
 *   - With prerequisites satisfied the existing behavior is unchanged:
 *     row created (PENDING) → workflow started → row+plan flipped RUNNING.
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockAssertProjectPermission,
	mockPlanFindFirst,
	mockPlanUpdate,
	mockProjectFindUnique,
	mockExecutionCreate,
	mockExecutionUpdate,
	mockGetTemporalClient,
	mockWorkflowStart,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockAssertProjectPermission: vi.fn(),
	mockPlanFindFirst: vi.fn(),
	mockPlanUpdate: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockExecutionCreate: vi.fn(),
	mockExecutionUpdate: vi.fn(),
	mockGetTemporalClient: vi.fn(),
	mockWorkflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weavePlan: {
			findFirst: mockPlanFindFirst,
			update: mockPlanUpdate,
		},
		project: { findUnique: mockProjectFindUnique },
		weaveExecution: {
			create: mockExecutionCreate,
			update: mockExecutionUpdate,
		},
	},
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
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

const approvedPlan = {
	id: "plan-1",
	projectId: "proj-1",
	name: "Approved plan",
	status: "APPROVED",
};

type StartExecutionInput = {
	planId: string;
	organizationId?: string | null;
	executionProvider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
};

async function loadHandler() {
	const mod = await import("../start-execution");
	return (mod.startExecutionProcedure as any)._handler as (args: {
		input: StartExecutionInput;
		context: typeof context;
	}) => Promise<{
		success: boolean;
		executionId: string;
		workflowId: string;
		status: string;
	}>;
}

const ENV_KEYS = ["AGENT_SERVICE_SECRET", "WEAVE_MAX_RUN_MINUTES"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	mockHasProjectAccess.mockResolvedValue(true);
	mockAssertProjectPermission.mockResolvedValue(undefined);
	mockPlanFindFirst.mockResolvedValue(approvedPlan);
	mockPlanUpdate.mockResolvedValue({});
	mockProjectFindUnique.mockResolvedValue({
		repositoryUrl: "https://github.com/acme/widgets",
	});
	mockExecutionCreate.mockResolvedValue({ id: "exec-1" });
	mockExecutionUpdate.mockResolvedValue({});
	mockWorkflowStart.mockResolvedValue({ firstExecutionRunId: "run-1" });
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
});

async function callExpectingError(input: StartExecutionInput) {
	const handler = await loadHandler();
	const error = await handler({ input, context }).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ORPCError);
	return error as Error & { code: string };
}

describe("startExecutionProcedure — preflight failures (no row, no workflow)", () => {
	it("keeps the APPROVED-status guard ahead of the preflight", async () => {
		mockPlanFindFirst.mockResolvedValue({
			...approvedPlan,
			status: "PENDING_APPROVAL",
		});

		const error = await callExpectingError({
			planId: "plan-1",
			organizationId: "org-1",
		});

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe("Plan must be approved before execution");
		expect(mockProjectFindUnique).not.toHaveBeenCalled();
		expect(mockExecutionCreate).not.toHaveBeenCalled();
	});

	it("missing project repository URL ⇒ BAD_REQUEST and no execution row", async () => {
		mockProjectFindUnique.mockResolvedValue({ repositoryUrl: null });

		const error = await callExpectingError({
			planId: "plan-1",
			organizationId: "org-1",
		});

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(
			"This project has no repository URL configured. Add one in project settings before delegating work.",
		);
		expect(mockExecutionCreate).not.toHaveBeenCalled();
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
	});

	it("whitespace-only repository URL counts as missing", async () => {
		mockProjectFindUnique.mockResolvedValue({ repositoryUrl: "   " });

		const error = await callExpectingError({
			planId: "plan-1",
			organizationId: "org-1",
		});

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(
			"This project has no repository URL configured. Add one in project settings before delegating work.",
		);
		expect(mockExecutionCreate).not.toHaveBeenCalled();
	});

	it("BACKGROUND_AGENTS + non-GitHub URL ⇒ BAD_REQUEST naming the expected format", async () => {
		mockProjectFindUnique.mockResolvedValue({
			repositoryUrl: "https://gitlab.com/acme/widgets",
		});

		const error = await callExpectingError({
			planId: "plan-1",
			organizationId: "org-1",
			executionProvider: "BACKGROUND_AGENTS",
		});

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(
			"Background Agents need a GitHub repository URL (https://github.com/owner/repo). Update the project repository URL.",
		);
		expect(mockExecutionCreate).not.toHaveBeenCalled();
	});

	it("defaults to BACKGROUND_AGENTS when the provider is omitted", async () => {
		mockProjectFindUnique.mockResolvedValue({
			repositoryUrl: "https://gitlab.com/acme/widgets",
		});

		const error = await callExpectingError({
			planId: "plan-1",
			organizationId: "org-1",
		});

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(
			"Background Agents need a GitHub repository URL (https://github.com/owner/repo). Update the project repository URL.",
		);
		expect(mockExecutionCreate).not.toHaveBeenCalled();
	});

	it("KANBAN_LOCAL without AGENT_SERVICE_SECRET ⇒ SERVICE_UNAVAILABLE", async () => {
		const error = await callExpectingError({
			planId: "plan-1",
			organizationId: "org-1",
			executionProvider: "KANBAN_LOCAL",
		});

		expect(error.code).toBe("SERVICE_UNAVAILABLE");
		expect(error.message).toBe(
			"Local delegation is not configured for this environment — set AGENT_SERVICE_SECRET.",
		);
		expect(mockExecutionCreate).not.toHaveBeenCalled();
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
	});
});

describe("startExecutionProcedure — prerequisites satisfied (existing behavior pinned)", () => {
	it("creates the row and starts the workflow for BACKGROUND_AGENTS + GitHub URL", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				planId: "plan-1",
				organizationId: "org-1",
				executionProvider: "BACKGROUND_AGENTS",
			},
			context,
		});

		expect(mockExecutionCreate).toHaveBeenCalledExactlyOnceWith({
			data: {
				planId: "plan-1",
				projectId: "proj-1",
				workflowId: expect.stringMatching(/^weave-exec-plan-1-\d+$/),
				runId: "pending",
				status: "PENDING",
				userId: "user-1",
				organizationId: "org-1",
			},
		});

		expect(mockWorkflowStart).toHaveBeenCalledExactlyOnceWith(
			"orchestratorExecutionWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-orchestrator",
				workflowExecutionTimeout: "120m",
				args: [
					expect.objectContaining({
						executionMode: "weave",
						weavePlanId: "plan-1",
						weaveExecutionId: "exec-1",
						weaveImplementationProvider: "BACKGROUND_AGENTS",
					}),
				],
			}),
		);

		expect(mockExecutionUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "exec-1" },
			data: {
				runId: "run-1",
				status: "RUNNING",
				startedAt: expect.any(Date),
			},
		});
		expect(mockPlanUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "plan-1" },
			data: { status: "RUNNING" },
		});

		expect(result).toMatchObject({
			success: true,
			executionId: "exec-1",
			status: "RUNNING",
		});
	});

	it("accepts the SSH GitHub form for BACKGROUND_AGENTS", async () => {
		mockProjectFindUnique.mockResolvedValue({
			repositoryUrl: "git@github.com:acme/widgets.git",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		});

		expect(result.success).toBe(true);
		expect(mockExecutionCreate).toHaveBeenCalledTimes(1);
	});

	it("KANBAN_LOCAL with the secret set does not require a GitHub-parseable URL", async () => {
		process.env.AGENT_SERVICE_SECRET = "secret-value";
		mockProjectFindUnique.mockResolvedValue({
			repositoryUrl: "https://gitlab.com/acme/widgets",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: {
				planId: "plan-1",
				organizationId: "org-1",
				executionProvider: "KANBAN_LOCAL",
			},
			context,
		});

		expect(result.success).toBe(true);
		expect(mockExecutionCreate).toHaveBeenCalledTimes(1);
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
	});
});

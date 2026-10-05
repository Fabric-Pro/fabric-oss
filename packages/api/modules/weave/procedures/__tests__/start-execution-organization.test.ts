/**
 * Starting a weave execution runs in the authorized project's organization
 * (Fizzy #2904).
 *
 * The procedure names a plan, so it loads the plan (by id and creator) BEFORE
 * it can authorize the plan's project. Before the fix it
 * then stamped that earlier organization on the execution and handed it to the
 * orchestrator workflow — so a plan stamped with an organization other than its
 * project's (which the pre-binding create-plan allowed) ran on that
 * organization's AI provider. Now the plan's stored organization must match the
 * project `assertProjectPermission` authorized, and everything after uses the
 * authorized one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_PROJECT = "org-example-project";
const ORG_OTHER = "org-example-other";

const mocks = vi.hoisted(() => ({
	assertProjectPermission: vi.fn(),
	planFindFirst: vi.fn(),
	planUpdate: vi.fn(),
	projectFindUnique: vi.fn(),
	executionCreate: vi.fn(),
	executionUpdate: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	StoryVersionConflictError: class extends Error {},
	db: {
		weavePlan: { findFirst: mocks.planFindFirst, update: mocks.planUpdate },
		project: { findUnique: mocks.projectFindUnique },
		weaveExecution: {
			create: mocks.executionCreate,
			update: mocks.executionUpdate,
		},
	},
	hasProjectAccess: vi.fn(async () => true),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
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
		assertProjectPermission: mocks.assertProjectPermission,
		Permissions: new Proxy({}, { get: (_target, prop) => String(prop) }),
	};
});

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

async function startExecution(organizationId: string | null) {
	const mod = await import("../start-execution");
	const handler = (
		mod.startExecutionProcedure as unknown as {
			_handler: (args: unknown) => Promise<unknown>;
		}
	)._handler;
	return handler({ input: { planId: "plan-1", organizationId }, context });
}

function plan(organizationId: string | null) {
	return {
		id: "plan-1",
		projectId: "proj-1",
		name: "Approved plan",
		status: "APPROVED",
		organizationId,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "proj-1",
		organizationId: ORG_PROJECT,
	});
	mocks.projectFindUnique.mockResolvedValue({
		repositoryUrl: "https://github.com/example/widgets",
	});
	mocks.executionCreate.mockResolvedValue({ id: "exec-1" });
	mocks.executionUpdate.mockResolvedValue({});
	mocks.planUpdate.mockResolvedValue({});
	mocks.workflowStart.mockResolvedValue({ firstExecutionRunId: "run-1" });
});

describe("startExecution — organization", () => {
	it("refuses a plan stamped with another organization than its project's, before any row or workflow", async () => {
		mocks.planFindFirst.mockResolvedValue(plan(ORG_OTHER));

		await expect(startExecution(null)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.executionCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses another organization named in the input, before any row or workflow", async () => {
		mocks.planFindFirst.mockResolvedValue(plan(ORG_PROJECT));

		await expect(startExecution(ORG_OTHER)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.executionCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("stamps the execution and starts the workflow in the project's organization", async () => {
		// A plan created by a project guest before the binding carries no
		// organization; it is accepted and runs in the project's.
		mocks.planFindFirst.mockResolvedValue(plan(null));

		await startExecution(null);

		expect(mocks.executionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ organizationId: ORG_PROJECT }),
			}),
		);
		const startOptions = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{ organizationId?: string }>;
		};
		expect(startOptions.args[0]?.organizationId).toBe(ORG_PROJECT);
	});

	it("refuses a project with no organization before any row is written", async () => {
		mocks.assertProjectPermission.mockResolvedValue({
			projectId: "proj-1",
			organizationId: null,
		});
		mocks.planFindFirst.mockResolvedValue(plan(null));

		await expect(startExecution(null)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.executionCreate).not.toHaveBeenCalled();
	});
});

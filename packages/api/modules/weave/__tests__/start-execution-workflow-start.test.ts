/**
 * weave.startExecution — workflow start vs post-start bookkeeping.
 *
 * A Temporal start that was accepted must never be undone by a later
 * bookkeeping failure: marking the row FAILED would release the
 * weave_execution_one_active_per_story index while the execution is live.
 *
 * Run with: pnpm --filter @repo/api test -- modules/weave/__tests__/start-execution-workflow-start.test.ts
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockDb,
	mockHasProjectAccess,
	mockComputeStoryReadiness,
	mockLogger,
	mockGetTemporalClient,
	workflowStart,
	workflowGetHandle,
	workflowDescribe,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mockDb = {
		weavePlan: { findFirst: vi.fn(), update: vi.fn() },
		weaveExecution: { create: vi.fn(), update: vi.fn() },
		// Provider preflight reads the project repository URL.
		project: {
			findUnique: vi.fn(async () => ({
				repositoryUrl: "https://github.com/acme/repo",
			})),
		},
	};
	const mockHasProjectAccess = vi.fn();
	const mockComputeStoryReadiness = vi.fn();
	const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const workflowStart = vi.fn();
	const workflowDescribe = vi.fn();
	const workflowGetHandle = vi.fn(() => ({ describe: workflowDescribe }));
	const mockGetTemporalClient = vi.fn();
	return {
		handlers,
		mockDb,
		mockHasProjectAccess,
		mockComputeStoryReadiness,
		mockLogger,
		mockGetTemporalClient,
		workflowStart,
		workflowGetHandle,
		workflowDescribe,
	};
});

vi.mock("@repo/database", () => {
	class StageTransitionBlockedError extends Error {}
	class GovernedActorRequiredError extends Error {}
	class StageTransitionConflictError extends Error {}
	class StageApprovalError extends Error {}
	return {
		db: mockDb,
		hasProjectAccess: mockHasProjectAccess,
		computeStoryReadiness: mockComputeStoryReadiness,
		StageTransitionBlockedError,
		GovernedActorRequiredError,
		StageTransitionConflictError,
		StageApprovalError,
	};
});

vi.mock("@repo/logs", () => ({
	logger: mockLogger,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

// Deterministic row id so the derived workflow id can be asserted.
vi.mock("@paralleldrive/cuid2", () => ({
	createId: () => "exec-1",
}));

vi.mock("../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.start = fn;
			return { _handler: fn };
		},
	};
	return {
		resolveOrganizationIdForCaller: async (
			organizationId: string | null | undefined,
		) => organizationId ?? null,
		assertProjectPermission: async () => undefined,
		protectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

import "../procedures/start-execution";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const baseInput = {
	planId: "plan-1",
	organizationId: null,
};

const planRow = {
	id: "plan-1",
	name: "Ship export",
	projectId: "proj-1",
	userStoryId: "story-1",
	status: "APPROVED",
	userId: "user-1",
	organizationId: null,
};

const readySnapshot = {
	ready: true,
	missing: [],
	advisory: [],
	effectiveTrack: "SPECIFY",
	deliveryTrack: "SPECIFY",
	draftingStage: "PUBLISHED",
	reviewRequired: false,
};

async function callStart(input = baseInput) {
	return await handlers.start({ input, context });
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

/** Every `weaveExecution.update` call that would release the active row. */
function failedStatusUpdates() {
	return mockDb.weaveExecution.update.mock.calls.filter(
		([args]) =>
			(args as { data?: { status?: string } }).data?.status === "FAILED",
	);
}

/** Temporal's typed rejection for a workflow id with no execution. */
function workflowNotFoundError() {
	const error = new Error("Workflow execution not found");
	error.name = "WorkflowNotFoundError";
	return error;
}

function alreadyStartedError() {
	const error = new Error("Workflow execution already started");
	error.name = "WorkflowExecutionAlreadyStartedError";
	return error;
}

/** Every `weaveExecution.update` call that wrote a run id. */
function runIdUpdates() {
	return mockDb.weaveExecution.update.mock.calls
		.map(([args]) => (args as { data?: { runId?: string } }).data?.runId)
		.filter((runId) => runId !== undefined);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.weavePlan.findFirst.mockResolvedValue(planRow);
	mockDb.weavePlan.update.mockResolvedValue({});
	mockDb.weaveExecution.create.mockImplementation(
		async ({ data }: { data: { id: string } }) => ({ id: data.id }),
	);
	mockDb.weaveExecution.update.mockResolvedValue({});
	mockHasProjectAccess.mockResolvedValue(true);
	mockComputeStoryReadiness.mockResolvedValue(readySnapshot);
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: workflowStart, getHandle: workflowGetHandle },
	});
	workflowStart.mockResolvedValue({ firstExecutionRunId: "temporal-run" });
	// Default verdict after a failed start: Temporal has no execution.
	workflowDescribe.mockRejectedValue(workflowNotFoundError());
});

describe("startExecution — deterministic workflow id", () => {
	it("keys the workflow id on the execution row id and writes it at create time", async () => {
		const result = (await callStart()) as {
			executionId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			success: true,
			executionId: "exec-1",
			workflowId: "weave-exec-exec-1",
			status: "RUNNING",
		});
		expect(mockDb.weaveExecution.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				id: "exec-1",
				workflowId: "weave-exec-exec-1",
				planId: "plan-1",
				userStoryId: "story-1",
				// Required column; the placeholder is replaced by the real
				// run id in phase B and treated as unknown by every reader.
				runId: "pending",
				status: "PENDING",
			}),
		});
		expect(workflowStart).toHaveBeenCalledWith(
			"orchestratorExecutionWorkflow",
			expect.objectContaining({
				workflowId: "weave-exec-exec-1",
				args: [expect.objectContaining({ weaveExecutionId: "exec-1" })],
			}),
		);
		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({
				runId: "temporal-run",
				status: "RUNNING",
			}),
		});
		expect(mockDb.weavePlan.update).toHaveBeenCalledWith({
			where: { id: "plan-1" },
			data: { status: "RUNNING" },
		});
		expect(failedStatusUpdates()).toHaveLength(0);
	});
});

describe("startExecution — workflow start vs post-start bookkeeping", () => {
	it("marks the row FAILED and rethrows when Temporal rejects the start and reports no execution", async () => {
		workflowStart.mockRejectedValue(new Error("temporal down"));
		workflowDescribe.mockRejectedValue(workflowNotFoundError());

		await expectORPCError(callStart(), "INTERNAL_SERVER_ERROR");

		// The verdict comes from describing the deterministic id.
		expect(workflowGetHandle).toHaveBeenCalledWith("weave-exec-exec-1");
		expect(workflowDescribe).toHaveBeenCalledTimes(1);
		expect(failedStatusUpdates()).toHaveLength(1);
		expect(failedStatusUpdates()[0][0]).toEqual({
			where: { id: "exec-1" },
			data: expect.objectContaining({ status: "FAILED" }),
		});
		// Nothing is running, so neither the execution nor the plan is
		// promoted to RUNNING.
		expect(mockDb.weaveExecution.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "RUNNING" }),
			}),
		);
		expect(mockDb.weavePlan.update).not.toHaveBeenCalled();
	});

	it("keeps the row active and still returns the ids when bookkeeping fails after a confirmed start", async () => {
		// First update is the post-start RUNNING/runId persist.
		mockDb.weaveExecution.update.mockRejectedValueOnce(
			new Error("db connection reset"),
		);

		const result = (await callStart()) as {
			executionId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			success: true,
			executionId: "exec-1",
			workflowId: "weave-exec-exec-1",
			status: "RUNNING",
		});
		expect(workflowStart).toHaveBeenCalledTimes(1);
		// The active row must not be released: a FAILED status would drop it
		// out of weave_execution_one_active_per_story while the workflow runs.
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				workflowId: "weave-exec-exec-1",
			}),
			expect.stringMatching(/bookkeeping failed/i),
		);
	});

	it("keeps the row active when only the plan status update fails", async () => {
		mockDb.weavePlan.update.mockRejectedValue(new Error("db down"));

		const result = (await callStart()) as { status: string };

		expect(result.status).toBe("RUNNING");
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(mockLogger.warn).toHaveBeenCalled();
	});

	it("treats WorkflowExecutionAlreadyStartedError as a confirmed start and persists the real run id from describe", async () => {
		workflowStart.mockRejectedValue(alreadyStartedError());
		workflowDescribe.mockResolvedValue({
			workflowId: "weave-exec-exec-1",
			runId: "temporal-run-existing",
		});

		const result = (await callStart()) as {
			executionId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			success: true,
			executionId: "exec-1",
			workflowId: "weave-exec-exec-1",
			status: "RUNNING",
		});
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(workflowGetHandle).toHaveBeenCalledWith("weave-exec-exec-1");
		// Bookkeeping runs for the execution that is already live, and the
		// placeholder is replaced by the run id Temporal reports.
		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({
				runId: "temporal-run-existing",
				status: "RUNNING",
			}),
		});
		expect(runIdUpdates()).not.toContain("pending");
		expect(mockDb.weavePlan.update).toHaveBeenCalledWith({
			where: { id: "plan-1" },
			data: { status: "RUNNING" },
		});
	});

	it("keeps the placeholder (never a made-up run id) when describe fails after an already-started rejection", async () => {
		workflowStart.mockRejectedValue(alreadyStartedError());
		workflowDescribe.mockRejectedValue(new Error("connection refused"));

		const result = (await callStart()) as { status: string };

		// The typed rejection already confirmed the start, so the row is
		// promoted; only the run id stays unknown.
		expect(result.status).toBe("RUNNING");
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(runIdUpdates()).toHaveLength(0);
		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({ status: "RUNNING" }),
		});
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ workflowId: "weave-exec-exec-1" }),
			expect.stringMatching(/could not resolve run id/i),
		);
	});

	it("still releases the row when the failure is a generic error whose message merely mentions 'already started'", async () => {
		// Only Temporal's typed rejection counts as a confirmed start; a
		// lookalike message from elsewhere goes through the describe check
		// like any other generic error.
		workflowStart.mockRejectedValue(
			new Error("connection already started to close"),
		);
		workflowDescribe.mockRejectedValue(workflowNotFoundError());

		await expectORPCError(callStart(), "INTERNAL_SERVER_ERROR");
		expect(workflowDescribe).toHaveBeenCalledTimes(1);
		expect(failedStatusUpdates()).toHaveLength(1);
	});
});

describe("startExecution — ambiguous start errors (describe the deterministic id)", () => {
	it("treats a generic start error as a confirmed start when the workflow can be described, persisting its run id", async () => {
		// e.g. a client-side timeout after the server accepted the start.
		workflowStart.mockRejectedValue(new Error("deadline exceeded"));
		workflowDescribe.mockResolvedValue({
			workflowId: "weave-exec-exec-1",
			runId: "temporal-run-existing",
		});

		const result = (await callStart()) as {
			executionId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			success: true,
			executionId: "exec-1",
			workflowId: "weave-exec-exec-1",
			status: "RUNNING",
		});
		expect(workflowGetHandle).toHaveBeenCalledWith("weave-exec-exec-1");
		// The row stays in the one-active-per-story index...
		expect(failedStatusUpdates()).toHaveLength(0);
		// ...and phase B bookkeeping runs with the real run id.
		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({
				runId: "temporal-run-existing",
				status: "RUNNING",
			}),
		});
		expect(mockDb.weavePlan.update).toHaveBeenCalledWith({
			where: { id: "plan-1" },
			data: { status: "RUNNING" },
		});
	});

	it("marks the row FAILED and rethrows when describe reports WorkflowNotFoundError", async () => {
		workflowStart.mockRejectedValue(new Error("deadline exceeded"));
		workflowDescribe.mockRejectedValue(workflowNotFoundError());

		await expectORPCError(callStart(), "INTERNAL_SERVER_ERROR");

		expect(failedStatusUpdates()).toHaveLength(1);
		expect(failedStatusUpdates()[0][0]).toEqual({
			where: { id: "exec-1" },
			data: expect.objectContaining({ status: "FAILED" }),
		});
		expect(mockDb.weaveExecution.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "RUNNING" }),
			}),
		);
		expect(mockDb.weavePlan.update).not.toHaveBeenCalled();
	});

	it("leaves the row untouched and reports an unknown outcome when describe fails for any other reason", async () => {
		workflowStart.mockRejectedValue(new Error("deadline exceeded"));
		workflowDescribe.mockRejectedValue(new Error("connection refused"));

		const error = await expectORPCError(
			callStart(),
			"INTERNAL_SERVER_ERROR",
		);

		expect(error.message).toMatch(/could not confirm/i);
		expect(error.message).toMatch(/remains active/i);
		// No status write of any kind: releasing the row while a workflow
		// may be live would permit a duplicate execution.
		expect(mockDb.weaveExecution.update).not.toHaveBeenCalled();
		expect(mockDb.weavePlan.update).not.toHaveBeenCalled();
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				workflowId: "weave-exec-exec-1",
			}),
			expect.stringMatching(/outcome unknown/i),
		);
	});

	it("does not treat a lookalike not-found message as a verdict", async () => {
		workflowStart.mockRejectedValue(new Error("deadline exceeded"));
		workflowDescribe.mockRejectedValue(
			new Error("workflow not found in cache"),
		);

		await expectORPCError(callStart(), "INTERNAL_SERVER_ERROR");
		expect(mockDb.weaveExecution.update).not.toHaveBeenCalled();
	});

	it("releases the row when the Temporal client itself cannot be built (no start was ever sent)", async () => {
		mockGetTemporalClient.mockRejectedValue(
			new Error("temporal unreachable"),
		);

		await expectORPCError(callStart(), "INTERNAL_SERVER_ERROR");

		expect(workflowStart).not.toHaveBeenCalled();
		expect(workflowDescribe).not.toHaveBeenCalled();
		expect(failedStatusUpdates()).toHaveLength(1);
	});
});

describe("startExecution — active-execution uniqueness (plan §F2)", () => {
	it("maps a P2002 on weave_execution_one_active_per_story to CONFLICT without starting a workflow", async () => {
		mockDb.weaveExecution.create.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
				meta: { target: "weave_execution_one_active_per_story" },
			}),
		);

		const error = await expectORPCError(callStart(), "CONFLICT");
		expect(error.data).toEqual(
			expect.objectContaining({
				code: "ACTIVE_EXECUTION_EXISTS",
				storyId: "story-1",
			}),
		);
		expect(workflowStart).not.toHaveBeenCalled();
	});
});

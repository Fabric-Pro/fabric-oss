/**
 * startCodingRun — run-start readiness gate and active-run uniqueness
 * (plan §F1 run-start checks, §F2, Slice 5). Fail-closed first.
 *
 * Run with: pnpm --filter @repo/api test modules/coding-runs
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockDb,
	mockComputeStoryReadiness,
	mockLogger,
	mockLogWorkflowEvent,
	mockGetTemporalClient,
	workflowStart,
	workflowGetHandle,
	workflowDescribe,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mockDb = {
		userStory: { findFirst: vi.fn() },
		organization: { findUnique: vi.fn() },
		codingRun: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
		},
	};
	const mockComputeStoryReadiness = vi.fn();
	const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const mockLogWorkflowEvent = vi.fn();
	const workflowStart = vi.fn();
	const workflowDescribe = vi.fn();
	const workflowGetHandle = vi.fn(() => ({ describe: workflowDescribe }));
	const mockGetTemporalClient = vi.fn();
	return {
		handlers,
		mockDb,
		mockComputeStoryReadiness,
		mockLogger,
		mockLogWorkflowEvent,
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
		computeStoryReadiness: mockComputeStoryReadiness,
		StageTransitionBlockedError,
		GovernedActorRequiredError,
		StageTransitionConflictError,
		StageApprovalError,
	};
});

vi.mock("@repo/logs", () => ({
	logger: mockLogger,
	logWorkflowEvent: mockLogWorkflowEvent,
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
			handlers.start = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

import "../procedures/start-coding-run";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const baseInput = {
	projectId: "proj-1",
	storyId: "story-1",
	organizationId: null,
	kind: "IMPLEMENT" as const,
};

const storyRow = {
	id: "story-1",
	identifier: "F-001",
	title: "Export report",
	tasks: [],
	project: {
		name: "Project",
		organizationId: null,
		repositoryUrl: "https://github.com/acme/repo",
		repositoryOwner: "acme",
		repositoryName: "repo",
		defaultBranch: "main",
	},
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

/** Temporal's typed rejection for a workflow id with no execution. */
function workflowNotFoundError() {
	const error = new Error("Workflow execution not found");
	error.name = "WorkflowNotFoundError";
	return error;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.userStory.findFirst.mockResolvedValue(storyRow);
	mockDb.organization.findUnique.mockResolvedValue(null);
	mockDb.codingRun.findFirst.mockResolvedValue(null);
	mockDb.codingRun.create.mockResolvedValue({ id: "run-1" });
	mockDb.codingRun.update.mockResolvedValue({});
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: workflowStart, getHandle: workflowGetHandle },
	});
	workflowStart.mockResolvedValue({ firstExecutionRunId: "temporal-run" });
	// Default verdict after a failed start: Temporal has no execution.
	workflowDescribe.mockRejectedValue(workflowNotFoundError());
	mockLogWorkflowEvent.mockResolvedValue(undefined);
	mockComputeStoryReadiness.mockResolvedValue(readySnapshot);
});

/** Every `codingRun.update` call that would release the active row. */
function failedStatusUpdates() {
	return mockDb.codingRun.update.mock.calls.filter(
		([args]) =>
			(args as { data?: { status?: string } }).data?.status === "FAILED",
	);
}

describe("startCodingRun — readiness gate (fail closed)", () => {
	it("throws PRECONDITION_FAILED with the gap list when enforced gaps remain", async () => {
		mockComputeStoryReadiness.mockResolvedValue({
			...readySnapshot,
			ready: false,
			missing: ["ACCEPTANCE_CRITERIA_MISSING"],
		});

		const error = await expectORPCError(callStart(), "PRECONDITION_FAILED");
		expect(error.data).toEqual(
			expect.objectContaining({
				code: "STORY_NOT_READY",
				missing: ["ACCEPTANCE_CRITERIA_MISSING"],
				draftingStage: "PUBLISHED",
			}),
		);
		expect(mockDb.codingRun.create).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("throws PRECONDITION_FAILED when the story is not PUBLISHED even if no gaps", async () => {
		mockComputeStoryReadiness.mockResolvedValue({
			...readySnapshot,
			draftingStage: "DRAFT",
		});
		const error = await expectORPCError(callStart(), "PRECONDITION_FAILED");
		expect(error.data).toEqual(
			expect.objectContaining({ draftingStage: "DRAFT", missing: [] }),
		);
		expect(mockDb.codingRun.create).not.toHaveBeenCalled();
	});

	it("blocks DEFER items (DEFERRED gap) regardless of stage", async () => {
		mockComputeStoryReadiness.mockResolvedValue({
			...readySnapshot,
			ready: false,
			effectiveTrack: "DEFER",
			deliveryTrack: "DEFER",
			missing: ["DEFERRED"],
		});
		const error = await expectORPCError(callStart(), "PRECONDITION_FAILED");
		expect(error.data).toEqual(
			expect.objectContaining({ missing: ["DEFERRED"] }),
		);
	});

	it("checks readiness scoped to the story's project", async () => {
		await callStart();
		expect(mockComputeStoryReadiness).toHaveBeenCalledWith({
			storyId: "story-1",
			projectId: "proj-1",
		});
	});

	it("maps a missing story from the readiness check to NOT_FOUND", async () => {
		mockComputeStoryReadiness.mockRejectedValue(
			new Error("Story not found"),
		);
		await expectORPCError(callStart(), "NOT_FOUND");
		expect(mockDb.codingRun.create).not.toHaveBeenCalled();
	});
});

describe("startCodingRun — active-run uniqueness (plan §F2)", () => {
	it("maps a P2002 on coding_run_one_active_per_story to CONFLICT", async () => {
		const p2002 = Object.assign(new Error("Unique constraint failed"), {
			code: "P2002",
			meta: { target: "coding_run_one_active_per_story" },
		});
		mockDb.codingRun.create.mockRejectedValue(p2002);

		const error = await expectORPCError(callStart(), "CONFLICT");
		expect(error.message).toMatch(/already active/i);
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("maps a P2002 without a reported target to CONFLICT (fail closed)", async () => {
		mockDb.codingRun.create.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);
		await expectORPCError(callStart(), "CONFLICT");
	});

	it("rethrows non-unique database errors unchanged", async () => {
		mockDb.codingRun.create.mockRejectedValue(
			new Error("connection reset"),
		);
		await expect(callStart()).rejects.toThrow("connection reset");
	});

	it("keeps the pre-insert active-run check as a fast path", async () => {
		mockDb.codingRun.findFirst.mockResolvedValue({ id: "run-active" });
		await expectORPCError(callStart(), "CONFLICT");
		expect(mockDb.codingRun.create).not.toHaveBeenCalled();
	});
});

describe("startCodingRun — happy path", () => {
	it("creates the run and starts the workflow when PUBLISHED and ready", async () => {
		const result = (await callStart()) as {
			codingRunId: string;
			workflowId: string;
			status: string;
		};
		expect(result.codingRunId).toBe("run-1");
		expect(result.workflowId).toBe("coding-run-run-1");
		expect(result.status).toBe("started");
		expect(mockDb.codingRun.create).toHaveBeenCalledTimes(1);
		expect(workflowStart).toHaveBeenCalledTimes(1);
		expect(workflowStart).toHaveBeenCalledWith(
			"codingRunWorkflow",
			expect.objectContaining({ workflowId: "coding-run-run-1" }),
		);
		expect(mockDb.codingRun.update).toHaveBeenCalledWith({
			where: { id: "run-1" },
			data: {
				workflowId: "coding-run-run-1",
				startedAt: expect.any(Date),
			},
		});
		expect(failedStatusUpdates()).toHaveLength(0);
	});
});

describe("startCodingRun — workflow start vs post-start bookkeeping", () => {
	it("marks the row FAILED and rethrows when Temporal rejects the start and reports no execution", async () => {
		workflowStart.mockRejectedValue(new Error("temporal down"));
		workflowDescribe.mockRejectedValue(workflowNotFoundError());

		const error = await expectORPCError(
			callStart(),
			"INTERNAL_SERVER_ERROR",
		);
		expect(error.message).toContain("temporal down");
		// The verdict comes from describing the deterministic id.
		expect(workflowGetHandle).toHaveBeenCalledWith("coding-run-run-1");
		expect(workflowDescribe).toHaveBeenCalledTimes(1);
		expect(failedStatusUpdates()).toHaveLength(1);
		expect(failedStatusUpdates()[0][0]).toEqual({
			where: { id: "run-1" },
			data: { status: "FAILED" },
		});
		// Nothing is running, so no workflow id is persisted and no audit
		// event is emitted.
		expect(mockDb.codingRun.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					workflowId: expect.anything(),
				}),
			}),
		);
		expect(mockLogWorkflowEvent).not.toHaveBeenCalled();
	});

	it("keeps the row active and still returns the ids when persisting the workflow id fails after a confirmed start", async () => {
		// First update is the post-start workflowId persist.
		mockDb.codingRun.update.mockRejectedValueOnce(
			new Error("db connection reset"),
		);

		const result = (await callStart()) as {
			codingRunId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			codingRunId: "run-1",
			workflowId: "coding-run-run-1",
			status: "started",
		});
		expect(workflowStart).toHaveBeenCalledTimes(1);
		// The active row must not be released: a FAILED status would drop it
		// out of coding_run_one_active_per_story while the workflow runs.
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				codingRunId: "run-1",
				workflowId: "coding-run-run-1",
			}),
			expect.stringMatching(/bookkeeping failed/i),
		);
	});

	it("does not fail the request or release the row when the audit log write fails", async () => {
		mockLogWorkflowEvent.mockRejectedValue(new Error("audit sink down"));

		const result = (await callStart()) as { status: string };

		expect(result.status).toBe("started");
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(mockLogger.warn).toHaveBeenCalled();
	});

	it("treats WorkflowExecutionAlreadyStartedError as a confirmed start", async () => {
		const alreadyStarted = new Error("Workflow execution already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		workflowStart.mockRejectedValue(alreadyStarted);

		const result = (await callStart()) as {
			codingRunId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			codingRunId: "run-1",
			workflowId: "coding-run-run-1",
			status: "started",
		});
		expect(failedStatusUpdates()).toHaveLength(0);
		// Bookkeeping still runs for the execution that is already live.
		expect(mockDb.codingRun.update).toHaveBeenCalledWith({
			where: { id: "run-1" },
			data: {
				workflowId: "coding-run-run-1",
				startedAt: expect.any(Date),
			},
		});
		expect(mockLogWorkflowEvent).toHaveBeenCalledTimes(1);
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

	it("does not consult Temporal for a not-found verdict when the start error is the typed already-started rejection", async () => {
		const alreadyStarted = new Error("Workflow execution already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		workflowStart.mockRejectedValue(alreadyStarted);

		await callStart();

		expect(workflowDescribe).not.toHaveBeenCalled();
		expect(failedStatusUpdates()).toHaveLength(0);
	});
});

describe("startCodingRun — ambiguous start errors (describe the deterministic id)", () => {
	it("treats a generic start error as a confirmed start when the workflow can be described", async () => {
		// e.g. a client-side timeout after the server accepted the start.
		workflowStart.mockRejectedValue(new Error("deadline exceeded"));
		workflowDescribe.mockResolvedValue({
			workflowId: "coding-run-run-1",
			runId: "temporal-run-existing",
		});

		const result = (await callStart()) as {
			codingRunId: string;
			workflowId: string;
			status: string;
		};

		expect(result).toEqual({
			codingRunId: "run-1",
			workflowId: "coding-run-run-1",
			status: "started",
		});
		expect(workflowGetHandle).toHaveBeenCalledWith("coding-run-run-1");
		// The row stays in the one-active-per-story index...
		expect(failedStatusUpdates()).toHaveLength(0);
		// ...and phase B bookkeeping runs for the live execution.
		expect(mockDb.codingRun.update).toHaveBeenCalledWith({
			where: { id: "run-1" },
			data: {
				workflowId: "coding-run-run-1",
				startedAt: expect.any(Date),
			},
		});
		expect(mockLogWorkflowEvent).toHaveBeenCalledTimes(1);
	});

	it("marks the row FAILED and rethrows when describe reports WorkflowNotFoundError", async () => {
		workflowStart.mockRejectedValue(new Error("deadline exceeded"));
		workflowDescribe.mockRejectedValue(workflowNotFoundError());

		const error = await expectORPCError(
			callStart(),
			"INTERNAL_SERVER_ERROR",
		);

		expect(error.message).toContain("deadline exceeded");
		expect(failedStatusUpdates()).toHaveLength(1);
		expect(mockDb.codingRun.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					workflowId: expect.anything(),
				}),
			}),
		);
		expect(mockLogWorkflowEvent).not.toHaveBeenCalled();
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
		expect(mockDb.codingRun.update).not.toHaveBeenCalled();
		expect(failedStatusUpdates()).toHaveLength(0);
		expect(mockLogWorkflowEvent).not.toHaveBeenCalled();
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				codingRunId: "run-1",
				workflowId: "coding-run-run-1",
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
		expect(mockDb.codingRun.update).not.toHaveBeenCalled();
	});

	it("releases the row when the Temporal client itself cannot be built (no start was ever sent)", async () => {
		mockGetTemporalClient.mockRejectedValue(
			new Error("temporal unreachable"),
		);

		const error = await expectORPCError(
			callStart(),
			"INTERNAL_SERVER_ERROR",
		);

		expect(error.message).toContain("temporal unreachable");
		expect(workflowStart).not.toHaveBeenCalled();
		expect(workflowDescribe).not.toHaveBeenCalled();
		expect(failedStatusUpdates()).toHaveLength(1);
	});
});

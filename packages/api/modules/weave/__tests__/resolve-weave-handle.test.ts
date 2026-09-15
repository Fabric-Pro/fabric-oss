/**
 * Weave Temporal handle resolution — the `"pending"` placeholder written
 * at row creation is never a Temporal run id and must never reach
 * `getHandle`. Covers the helper directly and the cancel / signal
 * procedures that address a live workflow through it.
 *
 * Run with: pnpm --filter @repo/api test modules/weave/__tests__/resolve-weave-handle.test.ts
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isKnownRunId,
	PENDING_RUN_ID,
	resolveWeaveHandle,
} from "../lib/temporal-handle";

const { handlers, mockDb, mockGetTemporalClient, workflowGetHandle, signal } =
	vi.hoisted(() => {
		const handlers: Record<string, (...args: unknown[]) => unknown> = {};
		const mockDb = {
			weaveExecution: { findFirst: vi.fn(), update: vi.fn() },
			weavePlan: { updateMany: vi.fn(async () => ({ count: 1 })) },
			project: {
				findUnique: vi.fn(async () => ({
					repositoryUrl: "https://github.com/acme/repo",
				})),
			},
		};
		const signal = vi.fn();
		const workflowGetHandle = vi.fn(() => ({ signal }));
		const mockGetTemporalClient = vi.fn();
		return {
			handlers,
			mockDb,
			mockGetTemporalClient,
			workflowGetHandle,
			signal,
		};
	});

vi.mock("@repo/database", () => ({ db: mockDb }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("@repo/temporal/workflows", () => ({
	orchestratorCancelSignal: "orchestratorCancel",
	orchestratorApprovalSignal: "orchestratorApproval",
	orchestratorAutoApproveAllSignal: "orchestratorAutoApproveAll",
	orchestratorRevokeAutoApproveSignal: "orchestratorRevokeAutoApprove",
	orchestratorRetryFromStepSignal: "orchestratorRetryFromStep",
}));

vi.mock("../../../orpc/procedures", () => {
	// Several procedures live in one module; key each handler by its route
	// path so the test can address them individually.
	let currentPath = "";
	const chainable: any = {
		use: () => chainable,
		route: (config: { path: string }) => {
			currentPath = config.path;
			return chainable;
		},
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[currentPath] = fn;
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

import "../procedures/cancel-execution";
import "../procedures/signal-approval";

const CANCEL = "/weave/executions/:executionId/cancel";
const SIGNAL = "/weave/executions/:executionId/signal";
const AUTO_APPROVE = "/weave/executions/:executionId/auto-approve";
const REVOKE = "/weave/executions/:executionId/revoke-auto-approve";
const RETRY = "/weave/executions/:executionId/retry-from-step";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const WORKFLOW_ID = "weave-exec-exec-1";

function executionRow(overrides: Partial<{ runId: string; status: string }>) {
	return {
		id: "exec-1",
		workflowId: WORKFLOW_ID,
		runId: "temporal-run-1",
		status: "CHECKPOINT",
		userId: "user-1",
		organizationId: null,
		...overrides,
	};
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

/** Arguments of every `getHandle` call, for asserting the exact arity. */
function getHandleCalls(): unknown[][] {
	return workflowGetHandle.mock.calls as unknown[][];
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.weaveExecution.update.mockResolvedValue({});
	mockGetTemporalClient.mockResolvedValue({
		workflow: { getHandle: workflowGetHandle },
	});
	signal.mockResolvedValue(undefined);
});

describe("resolveWeaveHandle (unit)", () => {
	const client = { workflow: { getHandle: workflowGetHandle } } as any;

	it("addresses the workflow id alone when the run id is the placeholder", () => {
		resolveWeaveHandle(client, {
			workflowId: WORKFLOW_ID,
			runId: PENDING_RUN_ID,
		});
		expect(getHandleCalls()).toEqual([[WORKFLOW_ID]]);
	});

	it.each([null, undefined, ""])(
		"addresses the workflow id alone when the run id is %s",
		(runId) => {
			resolveWeaveHandle(client, { workflowId: WORKFLOW_ID, runId });
			expect(getHandleCalls()).toEqual([[WORKFLOW_ID]]);
		},
	);

	it("pins the handle to the stored run id when one is known", () => {
		resolveWeaveHandle(client, {
			workflowId: WORKFLOW_ID,
			runId: "temporal-run-1",
		});
		expect(getHandleCalls()).toEqual([[WORKFLOW_ID, "temporal-run-1"]]);
	});

	it("isKnownRunId rejects the placeholder and empty values", () => {
		expect(isKnownRunId(PENDING_RUN_ID)).toBe(false);
		expect(isKnownRunId("")).toBe(false);
		expect(isKnownRunId(null)).toBe(false);
		expect(isKnownRunId(undefined)).toBe(false);
		expect(isKnownRunId("temporal-run-1")).toBe(true);
	});
});

describe("weave.cancelExecution — handle resolution", () => {
	it("never passes the placeholder run id to Temporal", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: PENDING_RUN_ID, status: "RUNNING" }),
		);

		const result = await handlers[CANCEL]({
			input: { executionId: "exec-1", organizationId: null },
			context,
		});

		expect(getHandleCalls()).toEqual([[WORKFLOW_ID]]);
		expect(signal).toHaveBeenCalledWith("orchestratorCancel");
		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({ status: "CANCELLED" }),
		});
		expect(result).toEqual(expect.objectContaining({ success: true }));
	});

	it("leaves the execution active when the cancel signal cannot be delivered", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: "temporal-run-1", status: "RUNNING" }),
		);
		signal.mockRejectedValueOnce(new Error("temporal unavailable"));

		await expectORPCError(
			handlers[CANCEL]({
				input: { executionId: "exec-1", organizationId: null },
				context,
			}) as Promise<unknown>,
			"INTERNAL_SERVER_ERROR",
		);
		expect(mockDb.weaveExecution.update).not.toHaveBeenCalled();
	});

	it("marks CANCELLED when the workflow definitely does not exist", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: "temporal-run-1", status: "RUNNING" }),
		);
		const notFound = new Error("no such workflow");
		notFound.name = "WorkflowNotFoundError";
		signal.mockRejectedValueOnce(notFound);

		await handlers[CANCEL]({
			input: { executionId: "exec-1", organizationId: null },
			context,
		});

		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({ status: "CANCELLED" }),
		});
	});

	it("pins the handle to a known run id", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: "temporal-run-1", status: "RUNNING" }),
		);

		await handlers[CANCEL]({
			input: { executionId: "exec-1", organizationId: null },
			context,
		});

		expect(getHandleCalls()).toEqual([[WORKFLOW_ID, "temporal-run-1"]]);
	});

	it("cancels a PENDING row left by an ambiguous start, still signalling the workflow id", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: PENDING_RUN_ID, status: "PENDING" }),
		);

		await handlers[CANCEL]({
			input: { executionId: "exec-1", organizationId: null },
			context,
		});

		expect(getHandleCalls()).toEqual([[WORKFLOW_ID]]);
		expect(signal).toHaveBeenCalledWith("orchestratorCancel");
		expect(mockDb.weaveExecution.update).toHaveBeenCalledWith({
			where: { id: "exec-1" },
			data: expect.objectContaining({ status: "CANCELLED" }),
		});
	});

	it("still rejects cancellation of a terminal row", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: "temporal-run-1", status: "COMPLETED" }),
		);

		await expectORPCError(
			handlers[CANCEL]({
				input: { executionId: "exec-1", organizationId: null },
				context,
			}) as Promise<unknown>,
			"BAD_REQUEST",
		);
		expect(workflowGetHandle).not.toHaveBeenCalled();
		expect(mockDb.weaveExecution.update).not.toHaveBeenCalled();
	});
});

describe("weave signal procedures — handle resolution", () => {
	const cases: Array<{
		name: string;
		path: string;
		status: string;
		input: Record<string, unknown>;
		signalName: string;
	}> = [
		{
			name: "signalApproval",
			path: SIGNAL,
			status: "CHECKPOINT",
			input: {
				executionId: "exec-1",
				organizationId: null,
				approved: true,
			},
			signalName: "orchestratorApproval",
		},
		{
			name: "autoApproveAll",
			path: AUTO_APPROVE,
			status: "RUNNING",
			input: { executionId: "exec-1", organizationId: null },
			signalName: "orchestratorAutoApproveAll",
		},
		{
			name: "revokeAutoApprove",
			path: REVOKE,
			status: "RUNNING",
			input: { executionId: "exec-1", organizationId: null },
			signalName: "orchestratorRevokeAutoApprove",
		},
		{
			name: "retryFromStep",
			path: RETRY,
			status: "FAILED",
			input: {
				executionId: "exec-1",
				organizationId: null,
				stepId: "s1",
			},
			signalName: "orchestratorRetryFromStep",
		},
	];

	it.each(cases)(
		"$name never passes the placeholder run id to Temporal",
		async ({ path, status, input, signalName }) => {
			mockDb.weaveExecution.findFirst.mockResolvedValue(
				executionRow({ runId: PENDING_RUN_ID, status }),
			);

			await handlers[path]({ input, context });

			expect(getHandleCalls()).toEqual([[WORKFLOW_ID]]);
			expect(signal.mock.calls[0][0]).toBe(signalName);
		},
	);

	it.each(cases)(
		"$name pins the handle to a known run id",
		async ({ path, status, input }) => {
			mockDb.weaveExecution.findFirst.mockResolvedValue(
				executionRow({ runId: "temporal-run-1", status }),
			);

			await handlers[path]({ input, context });

			expect(getHandleCalls()).toEqual([[WORKFLOW_ID, "temporal-run-1"]]);
		},
	);

	it("signalApproval ignores a caller-supplied runId and uses the stored row", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: PENDING_RUN_ID, status: "CHECKPOINT" }),
		);

		await handlers[SIGNAL]({
			input: {
				executionId: "exec-1",
				organizationId: null,
				approved: true,
				workflowId: "attacker-wf",
				runId: "attacker-run",
			},
			context,
		});

		expect(getHandleCalls()).toEqual([[WORKFLOW_ID]]);
	});

	it("signalApproval surfaces a signal failure instead of reporting success", async () => {
		mockDb.weaveExecution.findFirst.mockResolvedValue(
			executionRow({ runId: PENDING_RUN_ID, status: "CHECKPOINT" }),
		);
		signal.mockRejectedValue(new Error("temporal unavailable"));

		const error = await expectORPCError(
			handlers[SIGNAL]({
				input: {
					executionId: "exec-1",
					organizationId: null,
					approved: true,
				},
				context,
			}) as Promise<unknown>,
			"INTERNAL_SERVER_ERROR",
		);
		expect(error.message).toContain("temporal unavailable");
	});
});

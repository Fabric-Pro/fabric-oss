/**
 * The shared settle step for a PM sync start that throws.
 *
 * `workflow.start` can throw after Temporal accepted the request (a client
 * timeout, a lost response, an interceptor failing after the response, a
 * retried call refused after an earlier attempt applied), so no error that
 * escapes it may mark the item FAILED outright: only a client that could not
 * be acquired does. Everything else is reconciled by describing the workflow
 * id, under an RPC deadline.
 */

import { ServiceError, WorkflowNotFoundError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	userStoryUpdateMany: vi.fn(),
	testCaseUpdateMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: { updateMany: h.userStoryUpdateMany },
		testCase: { updateMany: h.testCaseUpdateMany },
	},
	PmSyncStatus: { PENDING: "PENDING", FAILED: "FAILED" },
}));

const {
	compensatePmSyncStart,
	describePmSyncWorkflow,
	newPmSyncPendingStamp,
	settleFailedPmSyncStart,
} = await import("../src/lib/pm-sync-start");

function grpcError(code: number) {
	return Object.assign(new Error(`${code} status`), {
		code,
		details: "status details",
		metadata: {},
	});
}

function startServiceError(code: number) {
	return new ServiceError("Failed to start Workflow", {
		cause: grpcError(code),
	});
}

function clientDescribing(describe: () => Promise<unknown>) {
	return {
		workflow: { getHandle: () => ({ describe }) },
	} as never;
}

beforeEach(() => {
	h.userStoryUpdateMany.mockReset().mockResolvedValue({ count: 1 });
	h.testCaseUpdateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("describePmSyncWorkflow", () => {
	it("runs the describe under an RPC deadline when the client supports one", async () => {
		const withDeadline = vi.fn(
			async (_deadline: number, fn: () => Promise<unknown>) => fn(),
		);
		const before = Date.now();
		const state = await describePmSyncWorkflow(
			{
				workflow: {
					getHandle: () => ({
						describe: async () => ({ status: { name: "RUNNING" } }),
					}),
				},
				withDeadline,
			} as never,
			"wf",
		);
		expect(state).toBe("running");
		const deadline = withDeadline.mock.calls[0]?.[0] as number;
		expect(deadline - before).toBeGreaterThanOrEqual(10_000);
		expect(deadline - before).toBeLessThan(11_000);
	});

	it("reads a describe that hits its deadline as unknown", async () => {
		expect(
			await describePmSyncWorkflow(
				{
					workflow: { getHandle: () => ({ describe: vi.fn() }) },
					withDeadline: async () => {
						throw startServiceError(4);
					},
				} as never,
				"wf",
			),
		).toBe("unknown");
	});

	it("maps RUNNING, closed, typed not-found and any other failure", async () => {
		expect(
			await describePmSyncWorkflow(
				clientDescribing(async () => ({ status: { name: "RUNNING" } })),
				"wf",
			),
		).toBe("running");
		expect(
			await describePmSyncWorkflow(
				clientDescribing(async () => ({
					status: { name: "COMPLETED" },
				})),
				"wf",
			),
		).toBe("closed");
		expect(
			await describePmSyncWorkflow(
				clientDescribing(async () => {
					throw new WorkflowNotFoundError("nf", "wf", undefined);
				}),
				"wf",
			),
		).toBe("not-found");
		expect(
			await describePmSyncWorkflow(
				clientDescribing(async () => {
					throw startServiceError(14);
				}),
				"wf",
			),
		).toBe("unknown");
	});
});

describe("settleFailedPmSyncStart", () => {
	it("compensates without describing when there is no client", async () => {
		const compensate = vi.fn(async () => undefined);
		expect(
			await settleFailedPmSyncStart({
				client: null,
				workflowId: "wf",
				compensate,
			}),
		).toBe("failed");
		expect(compensate).toHaveBeenCalledTimes(1);
	});

	it.each([
		["running", { status: { name: "RUNNING" } }, "running", 0],
		["closed", { status: { name: "FAILED" } }, "failed", 1],
	])(
		"on an uncertain start with a %s workflow settles %s",
		async (_state, description, settlement, compensations) => {
			const compensate = vi.fn(async () => undefined);
			expect(
				await settleFailedPmSyncStart({
					client: clientDescribing(async () => description),
					workflowId: "wf",
					compensate,
				}),
			).toBe(settlement);
			expect(compensate).toHaveBeenCalledTimes(compensations);
		},
	);

	it("never compensates without a describe once there is a client, whatever the start threw", async () => {
		const compensate = vi.fn(async () => undefined);
		const describe = vi.fn(async () => ({ status: { name: "RUNNING" } }));
		expect(
			await settleFailedPmSyncStart({
				client: clientDescribing(describe),
				workflowId: "wf",
				compensate,
			}),
		).toBe("running");
		expect(describe).toHaveBeenCalledTimes(1);
		expect(compensate).not.toHaveBeenCalled();
	});

	it("leaves the row alone when the describe cannot answer", async () => {
		const compensate = vi.fn(async () => undefined);
		expect(
			await settleFailedPmSyncStart({
				client: clientDescribing(async () => {
					throw new Error("still down");
				}),
				workflowId: "wf",
				compensate,
			}),
		).toBe("uncertain");
		expect(compensate).not.toHaveBeenCalled();
	});
});

describe("compensatePmSyncStart and newPmSyncPendingStamp", () => {
	it("writes FAILED only for the attempt's PENDING row, per table", async () => {
		await compensatePmSyncStart({
			table: "userStory",
			itemId: "story-1",
			attemptId: "attempt-1",
			message: "boom",
		});
		await compensatePmSyncStart({
			table: "testCase",
			itemId: "case-1",
			attemptId: "attempt-2",
			message: "boom",
		});
		expect(h.userStoryUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "story-1",
				lastPmSyncAttemptId: "attempt-1",
				lastPmSyncStatus: "PENDING",
			},
			data: expect.objectContaining({ lastPmSyncStatus: "FAILED" }),
		});
		expect(h.testCaseUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "case-1",
				lastPmSyncAttemptId: "attempt-2",
				lastPmSyncStatus: "PENDING",
			},
			data: expect.objectContaining({ lastPmSyncStatus: "FAILED" }),
		});
	});

	it("reports a zero-row compensation as 0, not an error", async () => {
		h.userStoryUpdateMany.mockResolvedValue({ count: 0 });
		await expect(
			compensatePmSyncStart({
				table: "userStory",
				itemId: "story-1",
				attemptId: "attempt-1",
				message: "boom",
			}),
		).resolves.toBe(0);
	});

	it("gives every stamp a new attempt id, and keeps a passed pending-since", () => {
		const a = newPmSyncPendingStamp();
		const b = newPmSyncPendingStamp();
		expect(a.attemptId).not.toBe(b.attemptId);
		expect(a.data.pmSyncPendingSince).toEqual(a.data.lastPmSyncAttemptAt);
		const since = new Date("2026-01-01T00:00:00.000Z");
		expect(newPmSyncPendingStamp(since).data.pmSyncPendingSince).toBe(
			since,
		);
	});
});

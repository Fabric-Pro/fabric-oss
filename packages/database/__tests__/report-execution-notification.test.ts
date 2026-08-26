import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared tx mocks (hoisted so the vi.mock factory can close over them).
const { findUnique, txUpdateMany, txCreate, transaction } = vi.hoisted(() => {
	const txUpdateMany = vi.fn();
	const txCreate = vi.fn();
	const findUnique = vi.fn();
	const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
		cb({
			templateInstanceExecution: { updateMany: txUpdateMany },
			notification: { create: txCreate },
		}),
	);
	return { findUnique, txUpdateMany, txCreate, transaction };
});

vi.mock("../prisma/client", () => ({
	db: {
		templateInstanceExecution: { findUnique },
		$transaction: transaction,
	},
}));

import { emitReportExecutionNotification } from "../prisma/queries/report-execution-notification";

function execution(overrides: Record<string, unknown> = {}) {
	return {
		userId: "user-1",
		organizationId: null,
		instanceId: "inst-1",
		notificationEmittedAt: null,
		instance: { name: "Weekly Sales" },
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	findUnique.mockResolvedValue(execution());
	txUpdateMany.mockResolvedValue({ count: 1 });
	txCreate.mockResolvedValue({ id: "notif-1" });
});

describe("emitReportExecutionNotification — COMPLETED", () => {
	it("creates a REPORT_COMPLETED row with an explicit ?tab=overview link", async () => {
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "COMPLETED",
		});

		expect(txUpdateMany).toHaveBeenCalledTimes(1);
		// Claim predicate ties the notification to the PERSISTED status (Codex).
		expect(txUpdateMany.mock.calls[0][0]).toMatchObject({
			where: {
				id: "exec-1",
				status: "COMPLETED",
				notificationEmittedAt: null,
			},
		});
		expect(txCreate).toHaveBeenCalledTimes(1);
		expect(txCreate.mock.calls[0][0].data).toMatchObject({
			userId: "user-1",
			organizationId: null,
			type: "REPORT_COMPLETED",
			category: "SYSTEM",
			title: 'Report "Weekly Sales" is ready',
			snippet: "Your report finished generating",
			link: "report-templates/instances/inst-1?tab=overview",
		});
		expect(txCreate.mock.calls[0][0].data.payload).toMatchObject({
			executionId: "exec-1",
			instanceId: "inst-1",
			instanceName: "Weekly Sales",
			status: "COMPLETED",
		});
	});
});

describe("emitReportExecutionNotification — FAILED", () => {
	it("creates a REPORT_FAILED row with a generic snippet + ?tab=history link", async () => {
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "FAILED",
		});
		expect(txUpdateMany.mock.calls[0][0].where).toMatchObject({
			id: "exec-1",
			status: "FAILED",
			notificationEmittedAt: null,
		});
		expect(txCreate.mock.calls[0][0].data).toMatchObject({
			type: "REPORT_FAILED",
			title: 'Report "Weekly Sales" failed',
			snippet: "Open Execution History to see what went wrong",
			link: "report-templates/instances/inst-1?tab=history",
		});
		expect(txCreate.mock.calls[0][0].data.payload.status).toBe("FAILED");
	});

	it("never leaks raw execution error into the bell snippet or payload", async () => {
		// The raw error lives only in execution.error (humanized in Execution
		// History). The notification must carry neither the raw text nor an error
		// field — the notification list API returns the payload to the client.
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "FAILED",
		});
		const data = txCreate.mock.calls[0][0].data;
		expect(data.snippet).toBe(
			"Open Execution History to see what went wrong",
		);
		expect(data.payload).not.toHaveProperty("error");
		expect(Object.keys(data.payload)).toEqual([
			"executionId",
			"instanceId",
			"instanceName",
			"status",
		]);
	});
});

describe("emitReportExecutionNotification — tenant scope", () => {
	it("carries the execution's organizationId onto the notification", async () => {
		findUnique.mockResolvedValue(execution({ organizationId: "org-1" }));
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "COMPLETED",
		});
		expect(txCreate.mock.calls[0][0].data.organizationId).toBe("org-1");
	});
});

describe("emitReportExecutionNotification — skip paths (no throw, no create)", () => {
	it("skips non-terminal status", async () => {
		await emitReportExecutionNotification({
			executionId: "exec-1",
			// @ts-expect-error — defensive guard test: non-terminal status
			status: "RUNNING",
		});
		expect(transaction).not.toHaveBeenCalled();
		expect(txCreate).not.toHaveBeenCalled();
	});

	it("skips when the execution row is missing", async () => {
		findUnique.mockResolvedValue(null);
		await expect(
			emitReportExecutionNotification({
				executionId: "exec-1",
				status: "COMPLETED",
			}),
		).resolves.toBeUndefined();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("skips when userId is missing (no recipient)", async () => {
		findUnique.mockResolvedValue(execution({ userId: null }));
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "COMPLETED",
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fast-path skips when notificationEmittedAt already set", async () => {
		findUnique.mockResolvedValue(
			execution({ notificationEmittedAt: new Date() }),
		);
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "COMPLETED",
		});
		expect(transaction).not.toHaveBeenCalled();
	});
});

describe("emitReportExecutionNotification — idempotency + durability", () => {
	it("does not create when the claim loses the race / status mismatch (count 0)", async () => {
		txUpdateMany.mockResolvedValue({ count: 0 });
		await emitReportExecutionNotification({
			executionId: "exec-1",
			status: "COMPLETED",
		});
		expect(txUpdateMany).toHaveBeenCalledTimes(1);
		expect(txCreate).not.toHaveBeenCalled();
	});

	it("rethrows when create fails inside the tx (so the caller can retry)", async () => {
		txCreate.mockRejectedValue(new Error("db connection lost"));
		await expect(
			emitReportExecutionNotification({
				executionId: "exec-1",
				status: "COMPLETED",
			}),
		).rejects.toThrow("db connection lost");
	});
});

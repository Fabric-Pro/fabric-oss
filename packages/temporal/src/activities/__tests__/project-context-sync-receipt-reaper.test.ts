/**
 * The stranded-receipt pass for the Living Memory repository sync (Fizzy
 * #2784), the twin of `project-instruction-sync-receipt-reaper.test.ts`.
 *
 * A receipt outlives its execution when `record` never runs: a terminated
 * workflow, or a `begin` attempt whose insert committed after `record` had
 * swept. Only the next "Sync now" reconciled it, without an audit row. The
 * reaper closes such a receipt, with one audit row, once Temporal says its
 * exact workflow run has ended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimStranded: vi.fn(),
	transaction: vi.fn(),
	lockSync: vi.fn(),
	lockRun: vi.fn(),
	releaseKey: vi.fn(),
	complete: vi.fn(),
	getIntegration: vi.fn(),
	recordAuditTx: vi.fn(),
	describe: vi.fn(),
	getHandle: vi.fn(),
	getTemporalClient: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	TX: { tx: true },
}));

vi.mock("@repo/database", () => ({
	claimStrandedContextSyncRunReceipts: (...a: unknown[]) =>
		mocks.claimStranded(...a),
	db: {
		$transaction: (
			fn: (tx: unknown) => Promise<unknown>,
			options: unknown,
		) => mocks.transaction(fn, options),
	},
	getContextRepositorySyncForUpdate: (...a: unknown[]) =>
		mocks.lockSync(...a),
	getContextRepositorySyncRunForUpdate: (...a: unknown[]) =>
		mocks.lockRun(...a),
	releaseContextRepositorySyncRunKey: (...a: unknown[]) =>
		mocks.releaseKey(...a),
	completeContextRepositorySyncRun: (...a: unknown[]) => mocks.complete(...a),
	getContextSyncIntegration: (...a: unknown[]) => mocks.getIntegration(...a),
	recordAuditTx: (...a: unknown[]) => mocks.recordAuditTx(...a),
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClient(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: vi.fn(),
		log: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

/** The error name the SDK raises for an execution Temporal does not have. */
class WorkflowNotFoundError extends Error {
	override name = "WorkflowNotFoundError";
}

import { contextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { reapStrandedContextSyncReceipts } from "../project-context-sync-receipt-reaper";
import {
	MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	STRANDED_SYNC_RECEIPT_AGE_MS,
	STRANDED_SYNC_RECEIPT_RECHECK_MS,
} from "../project-instruction-sync-receipt-reaper";

const NOW = new Date("2026-09-30T12:40:00.000Z");

function receipt(
	id: string,
	overrides: Partial<{
		syncId: string;
		projectId: string;
		organizationId: string;
		generation: number;
	}> = {},
) {
	return {
		id,
		syncId: overrides.syncId ?? id.split(":")[0],
		projectId: overrides.projectId ?? "proj_1",
		organizationId: overrides.organizationId ?? "org_1",
		userId: "user_1",
		generation: overrides.generation ?? 3,
		trigger: "MANUAL",
	};
}

/** What the run lock returns for an unfinished receipt. */
function lockedRun(id: string, overrides: Record<string, unknown> = {}) {
	return {
		status: "ok",
		run: {
			id,
			syncId: id.split(":")[0],
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			generation: 3,
			context: { repositoryIntegrationId: "int_1" },
			trigger: "MANUAL",
			startedAt: new Date("2026-09-30T11:00:00.000Z"),
			commitSha: null,
			plan: null,
			outcomes: {},
			removedCount: 0,
			pruneConflicts: { keys: [], overflow: 0 },
			...overrides,
		},
	};
}

function currentSync(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		generation: 3,
		activeRunKey: null,
		now: new Date("2026-09-30T12:40:05.000Z"),
		...overrides,
	};
}

function describesAs(status: string) {
	mocks.describe.mockResolvedValue({ status: { name: status } });
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const m of Object.values(mocks)) {
		if (typeof m === "function") {
			m.mockReset();
		}
	}
	mocks.claimStranded.mockResolvedValue([]);
	mocks.transaction.mockImplementation((fn) => fn(mocks.TX));
	mocks.lockSync.mockResolvedValue(currentSync("sync_1"));
	mocks.lockRun.mockImplementation(async (_tx, id: string) => lockedRun(id));
	mocks.complete.mockResolvedValue({ completed: true, run: null });
	mocks.getIntegration.mockResolvedValue({
		status: "ACTIVE",
		repositoryOwner: "example-org",
		repositoryName: "memory",
	});
	mocks.getHandle.mockImplementation(() => ({ describe: mocks.describe }));
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: mocks.getHandle },
	});
	describesAs("COMPLETED");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("reapStrandedContextSyncReceipts", () => {
	it("claims unfinished receipts past the age bound and outside the recheck interval, capped per run, and does nothing else when there are none", async () => {
		expect(await reapStrandedContextSyncReceipts()).toEqual({
			candidates: 0,
			completed: 0,
			alreadyFinished: 0,
			stillRunning: 0,
			unknown: 0,
			errorCount: 0,
			hitCap: false,
		});

		expect(mocks.claimStranded).toHaveBeenCalledWith({
			startedBefore: new Date(
				NOW.getTime() - STRANDED_SYNC_RECEIPT_AGE_MS,
			),
			checkedBefore: new Date(
				NOW.getTime() - STRANDED_SYNC_RECEIPT_RECHECK_MS,
			),
			checkedAt: NOW,
			limit: MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
		});
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("describes the EXACT execution the receipt names: the starter's workflow id and the run id in its key", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		await reapStrandedContextSyncReceipts();

		expect(mocks.getHandle).toHaveBeenCalledWith(
			contextRepositorySyncWorkflowId("proj_1"),
			"run_a",
		);
		expect(contextRepositorySyncWorkflowId("proj_1")).toBe(
			"context-repository-sync-proj_1",
		);
	});

	it.each([
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"TERMINATED",
		"TIMED_OUT",
		"CONTINUED_AS_NEW",
	])(
		"completes the receipt of a %s run of the current configuration as FAILED / INTERRUPTED, under the record activity's locks, with one audit row",
		async (status) => {
			describesAs(status);
			mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

			const result = await reapStrandedContextSyncReceipts();

			expect(result).toMatchObject({ candidates: 1, completed: 1 });
			expect(mocks.transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{ timeout: 30_000 },
			);
			expect(mocks.lockSync).toHaveBeenCalledWith(mocks.TX, "sync_1", {
				projectId: "proj_1",
				organizationId: "org_1",
			});
			expect(mocks.lockSync.mock.invocationCallOrder[0]).toBeLessThan(
				mocks.lockRun.mock.invocationCallOrder[0] ?? 0,
			);
			expect(mocks.complete).toHaveBeenCalledWith(
				mocks.TX,
				"sync_1:run_a",
				expect.objectContaining({
					status: "FAILED",
					error: "INTERRUPTED",
				}),
			);
			expect(mocks.recordAuditTx).toHaveBeenCalledTimes(1);
			expect(mocks.recordAuditTx).toHaveBeenCalledWith(
				mocks.TX,
				expect.objectContaining({
					action: "project.context.repository_sync_completed",
					outcome: "failure",
					actor: { type: "user", userId: "user_1" },
					organizationId: "org_1",
					projectId: "proj_1",
					resource: {
						type: "project_context_repository_sync",
						id: "sync_1",
						name: "example-org/memory",
					},
					metadata: expect.objectContaining({
						runId: "sync_1:run_a",
						trigger: "MANUAL",
						status: "FAILED",
						error: "INTERRUPTED",
					}),
				}),
			);
		},
	);

	it("dates the completion on the clock the configuration lock read, and releases the run key the receipt still holds", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		mocks.lockSync.mockResolvedValue(
			currentSync("sync_1", { activeRunKey: "sync_1:run_a" }),
		);

		await reapStrandedContextSyncReceipts();

		expect(mocks.complete).toHaveBeenCalledWith(
			mocks.TX,
			"sync_1:run_a",
			expect.objectContaining({
				now: new Date("2026-09-30T12:40:05.000Z"),
			}),
		);
		expect(mocks.releaseKey).toHaveBeenCalledWith(
			mocks.TX,
			"sync_1",
			"sync_1:run_a",
		);
	});

	it("leaves another run's key alone", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		mocks.lockSync.mockResolvedValue(
			currentSync("sync_1", { activeRunKey: "sync_1:run_b" }),
		);

		await reapStrandedContextSyncReceipts();

		expect(mocks.releaseKey).not.toHaveBeenCalled();
	});

	it("completes a receipt whose configuration is gone as CONFIGURATION_CHANGED", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		mocks.lockSync.mockResolvedValue(null);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ completed: 1 });
		expect(mocks.complete).toHaveBeenCalledWith(
			mocks.TX,
			"sync_1:run_a",
			expect.objectContaining({
				status: "FAILED",
				error: "CONFIGURATION_CHANGED",
			}),
		);
		expect(mocks.releaseKey).not.toHaveBeenCalled();
		expect(mocks.recordAuditTx).toHaveBeenCalledTimes(1);
	});

	it("decides CONFIGURATION_CHANGED under the lock, from the generation it reads there, not from what the claim read", async () => {
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_a", { generation: 3 }),
		]);
		mocks.lockSync.mockResolvedValue(
			currentSync("sync_1", { generation: 4 }),
		);

		await reapStrandedContextSyncReceipts();

		expect(mocks.complete).toHaveBeenCalledWith(
			mocks.TX,
			"sync_1:run_a",
			expect.objectContaining({ error: "CONFIGURATION_CHANGED" }),
		);
	});

	it("writes neither a completion nor an audit row when something finished the receipt first", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		mocks.lockRun.mockResolvedValue({ status: "superseded", run: null });

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ completed: 0, alreadyFinished: 1 });
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("audits nothing when the completion matched nothing, as on a retry after another caller completed it", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		mocks.complete.mockResolvedValue({ completed: false, run: null });

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ completed: 0, alreadyFinished: 1 });
		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
		expect(mocks.releaseKey).not.toHaveBeenCalled();
	});

	it("refuses to complete a run that is not the receipt's tenant's", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		mocks.lockRun.mockResolvedValue(
			lockedRun("sync_1:run_a", { organizationId: "org_other" }),
		);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ completed: 0, alreadyFinished: 1 });
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("completes a receipt Temporal has no execution for", async () => {
		mocks.describe.mockRejectedValue(new WorkflowNotFoundError("gone"));
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		expect(await reapStrandedContextSyncReceipts()).toMatchObject({
			completed: 1,
		});
	});

	it("leaves a receipt whose run is still open to its own record", async () => {
		describesAs("RUNNING");
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ stillRunning: 1, completed: 0 });
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("never reads an unanswered describe as closed", async () => {
		mocks.describe.mockRejectedValue(new Error("deadline exceeded"));
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ unknown: 1, completed: 0 });
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("never describes a key of another shape", async () => {
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:poll_a:3", { syncId: "sync_1" }),
		]);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({ unknown: 1, completed: 0 });
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});

	it("leaves every candidate for the next tick when the Temporal client will not construct", async () => {
		mocks.getTemporalClient.mockRejectedValue(new Error("no connection"));
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_a"),
			receipt("sync_2:run_b", { syncId: "sync_2", projectId: "proj_2" }),
		]);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({
			candidates: 2,
			unknown: 2,
			completed: 0,
		});
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("keeps going when one tenant's completion fails, and counts the failure", async () => {
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_a"),
			receipt("sync_2:run_b", { syncId: "sync_2", projectId: "proj_2" }),
		]);
		mocks.transaction
			.mockRejectedValueOnce(new Error("serialization failure"))
			.mockImplementation((fn) => fn(mocks.TX));
		mocks.lockSync.mockResolvedValue(currentSync("sync_2"));
		mocks.lockRun.mockImplementation(async (_tx, id: string) =>
			lockedRun(id, { projectId: "proj_2" }),
		);

		const result = await reapStrandedContextSyncReceipts();

		expect(result).toMatchObject({
			candidates: 2,
			errorCount: 1,
			completed: 1,
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "context.reaper.sync_receipts.complete_failed",
				projectId: "proj_1",
			}),
			expect.any(String),
		);
	});

	it("reports a full batch as possibly leaving more", async () => {
		mocks.claimStranded.mockResolvedValue(
			Array.from({ length: MAX_STRANDED_SYNC_RECEIPTS_PER_RUN }, (_, i) =>
				receipt(`sync_${i}:run_${i}`, { projectId: `proj_${i}` }),
			),
		);
		describesAs("RUNNING");

		expect(await reapStrandedContextSyncReceipts()).toMatchObject({
			hitCap: true,
		});
	});
});

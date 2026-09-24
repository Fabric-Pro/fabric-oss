/**
 * The stranded sync-receipt pass of the Coding Instructions reaper
 * (Fizzy #2672).
 *
 * A receipt outlives its configuration now that it carries no foreign key,
 * and `record` is the only thing that completes one. A receipt `record`
 * never reaches stays open, and unaudited, for good. The late insert of a
 * timed-out `begin` attempt that commits after `record` already ran is one
 * way, and a terminated workflow is another. The reaper closes such a receipt
 * once Temporal says its workflow run has ended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimStranded: vi.fn(),
	getSyncForRun: vi.fn(),
	complete: vi.fn(),
	describe: vi.fn(),
	getHandle: vi.fn(),
	getTemporalClient: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	claimStrandedInstructionSyncRunReceipts: (...a: unknown[]) =>
		mocks.claimStranded(...a),
	getInstructionRepositorySyncForRun: (...a: unknown[]) =>
		mocks.getSyncForRun(...a),
	completeInstructionRepositorySyncRun: (...a: unknown[]) =>
		mocks.complete(...a),
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClient(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		log: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

/** The error name the SDK raises for an execution Temporal does not have. */
class WorkflowNotFoundError extends Error {
	override name = "WorkflowNotFoundError";
}

// Imported AFTER the mocks so the activity captures them.
import { instructionRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import {
	MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	reapStrandedInstructionSyncReceipts,
	STRANDED_SYNC_RECEIPT_AGE_MS,
	STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS,
	STRANDED_SYNC_RECEIPT_RECHECK_MS,
} from "../project-instruction-sync-receipt-reaper";

const NOW = new Date("2026-09-24T12:40:00.000Z");

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

function currentSync(id: string, organizationId = "org_1") {
	return { id, projectId: "proj_1", organizationId };
}

function describesAs(status: string) {
	mocks.describe.mockResolvedValue({ status: { name: status } });
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.claimStranded.mockResolvedValue([]);
	mocks.getSyncForRun.mockResolvedValue(currentSync("sync_1"));
	mocks.complete.mockResolvedValue({
		completed: true,
		configurationCurrent: false,
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

describe("reapStrandedInstructionSyncReceipts", () => {
	it("claims unfinished receipts older than the age bound and not checked within the recheck interval, capped per run, and does nothing else when there are none", async () => {
		expect(await reapStrandedInstructionSyncReceipts()).toEqual({
			candidates: 0,
			completed: 0,
			alreadyFinished: 0,
			stillRunning: 0,
			unknown: 0,
			errorCount: 0,
			hitCap: false,
		});
		expect(mocks.claimStranded).toHaveBeenCalledTimes(1);
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
		// Comfortably past begin's one-minute start-to-close, and bounded.
		expect(STRANDED_SYNC_RECEIPT_AGE_MS).toBeGreaterThanOrEqual(
			15 * 60 * 1000,
		);
		// Below the hourly schedule's interval, so a receipt left open by one
		// tick is due again at the next one even when that tick's pass starts
		// a few minutes earlier in its hour than the last one did.
		expect(STRANDED_SYNC_RECEIPT_RECHECK_MS).toBeGreaterThan(0);
		expect(STRANDED_SYNC_RECEIPT_RECHECK_MS).toBeLessThanOrEqual(
			50 * 60 * 1000,
		);
		expect(MAX_STRANDED_SYNC_RECEIPTS_PER_RUN).toBe(100);
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("describes the EXACT execution the receipt names: the starter's workflow id and the run id in its key", async () => {
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);
		await reapStrandedInstructionSyncReceipts();
		expect(mocks.getHandle).toHaveBeenCalledWith(
			instructionRepositorySyncWorkflowId("proj_1"),
			"run_a",
		);
		expect(instructionRepositorySyncWorkflowId("proj_1")).toBe(
			"project-instruction-repository-sync-proj_1",
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
		"completes the receipt of a %s run of the current configuration as FAILED / CHILD_ABORTED, with no scheduling effect",
		async (status) => {
			describesAs(status);
			mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

			const result = await reapStrandedInstructionSyncReceipts();

			expect(result).toMatchObject({ candidates: 1, completed: 1 });
			expect(mocks.getSyncForRun).toHaveBeenCalledWith("proj_1");
			expect(mocks.complete).toHaveBeenCalledTimes(1);
			expect(mocks.complete).toHaveBeenCalledWith({
				runKey: "sync_1:run_a",
				syncId: "sync_1",
				generation: 3,
				projectId: "proj_1",
				organizationId: "org_1",
				userId: "user_1",
				trigger: "MANUAL",
				status: "FAILED",
				error: "CHILD_ABORTED",
				note: null,
				commitSha: null,
				snapshotId: null,
				scheduling: { kind: "none" },
				// The read above is unlocked: a disable, re-configure or
				// replacement can commit before the completion's lock, which
				// then records the receipt as CONFIGURATION_CHANGED instead.
				classifyStaleAsConfigurationChanged: true,
			});
		},
	);

	it.each([
		["switched off (no configuration row)", null],
		["switched off and set up again (a new row)", currentSync("sync_2")],
		[
			"a row that names another organization",
			currentSync("sync_1", "org_other"),
		],
	])(
		"completes the receipt as CONFIGURATION_CHANGED when its configuration was %s",
		async (_label, row) => {
			mocks.getSyncForRun.mockResolvedValue(row);
			mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

			await reapStrandedInstructionSyncReceipts();

			expect(mocks.complete).toHaveBeenCalledWith(
				expect.objectContaining({
					runKey: "sync_1:run_a",
					syncId: "sync_1",
					status: "FAILED",
					error: "CONFIGURATION_CHANGED",
					scheduling: { kind: "none" },
					classifyStaleAsConfigurationChanged: true,
				}),
			);
		},
	);

	it("completes the receipt when Temporal has no such execution (never started, or past retention)", async () => {
		mocks.describe.mockRejectedValue(new WorkflowNotFoundError("nope"));
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			completed: 1,
		});
		expect(mocks.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				runKey: "sync_1:run_a",
				error: "CHILD_ABORTED",
			}),
		);
	});

	it("leaves the receipt of a run that is still RUNNING alone: its own record will complete it", async () => {
		describesAs("RUNNING");
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			candidates: 1,
			completed: 0,
			stillRunning: 1,
		});
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("leaves a receipt alone when its describe never answers, and moves on to the next once the describe bound passes", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(NOW);
		mocks.getHandle.mockImplementation(
			(_workflowId: string, runId: string) => ({
				describe:
					runId === "run_hung"
						? () => new Promise(() => undefined)
						: mocks.describe,
			}),
		);
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_hung"),
			receipt("sync_1:run_b"),
		]);

		let settled = false;
		const pass = reapStrandedInstructionSyncReceipts().then((result) => {
			settled = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(
			STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS - 1,
		);
		// Still waiting on the hung describe: nothing completed, nothing skipped.
		expect(settled).toBe(false);
		expect(mocks.complete).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(await pass).toMatchObject({
			candidates: 2,
			completed: 1,
			unknown: 1,
			errorCount: 0,
		});
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		expect(mocks.complete).toHaveBeenCalledWith(
			expect.objectContaining({ runKey: "sync_1:run_b" }),
		);
		expect(STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS).toBe(5_000);
	});

	it("leaves a receipt alone when the describe fails: unknown is never read as closed", async () => {
		mocks.describe.mockRejectedValue(new Error("deadline exceeded"));
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			completed: 0,
			unknown: 1,
		});
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("proves nothing without a Temporal client: every candidate is left for the next run", async () => {
		mocks.getTemporalClient.mockRejectedValue(new Error("unreachable"));
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_a"),
			receipt("sync_1:run_b"),
		]);

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			candidates: 2,
			completed: 0,
			unknown: 2,
		});
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("never describes or completes a key that is not a sync workflow's `<syncId>:<run id>` (a poll receipt's shape)", async () => {
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:poll_run_1:3", { syncId: "sync_1" }),
		]);

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			completed: 0,
			unknown: 1,
		});
		expect(mocks.getHandle).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("is idempotent: a receipt a concurrent record or an earlier attempt already completed is counted, not re-audited", async () => {
		mocks.complete.mockResolvedValue({
			completed: false,
			configurationCurrent: false,
		});
		mocks.claimStranded.mockResolvedValue([receipt("sync_1:run_a")]);

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			completed: 0,
			alreadyFinished: 1,
			errorCount: 0,
		});
	});

	it("carries on past one receipt's failed completion: each belongs to a different tenant", async () => {
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_a"),
			receipt("sync_9:run_b", {
				projectId: "proj_9",
				organizationId: "org_9",
			}),
		]);
		mocks.getSyncForRun.mockImplementation(async (projectId: string) =>
			projectId === "proj_9"
				? { id: "sync_9", projectId, organizationId: "org_9" }
				: currentSync("sync_1"),
		);
		mocks.complete
			.mockRejectedValueOnce(new Error("connection reset"))
			.mockResolvedValueOnce({
				completed: true,
				configurationCurrent: true,
			});

		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			candidates: 2,
			completed: 1,
			errorCount: 1,
		});
		expect(mocks.complete).toHaveBeenLastCalledWith(
			expect.objectContaining({
				runKey: "sync_9:run_b",
				projectId: "proj_9",
				organizationId: "org_9",
				error: "CHILD_ABORTED",
			}),
		);
	});

	it("reads each project's configuration once per run", async () => {
		mocks.claimStranded.mockResolvedValue([
			receipt("sync_1:run_a"),
			receipt("sync_old:run_b", { syncId: "sync_old" }),
		]);

		await reapStrandedInstructionSyncReceipts();

		expect(mocks.getSyncForRun).toHaveBeenCalledTimes(1);
		expect(mocks.complete).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				runKey: "sync_1:run_a",
				error: "CHILD_ABORTED",
			}),
		);
		expect(mocks.complete).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				runKey: "sync_old:run_b",
				error: "CONFIGURATION_CHANGED",
			}),
		);
	});

	it("says when the batch was full, so the remainder is known to be next run's work", async () => {
		mocks.claimStranded.mockResolvedValue(
			Array.from({ length: MAX_STRANDED_SYNC_RECEIPTS_PER_RUN }, (_, i) =>
				receipt(`sync_1:run_${i}`),
			),
		);
		expect(await reapStrandedInstructionSyncReceipts()).toMatchObject({
			candidates: MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
			hitCap: true,
		});
	});
});

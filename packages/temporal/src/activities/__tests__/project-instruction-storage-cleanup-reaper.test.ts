import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listDue: vi.fn(),
	clear: vi.fn(),
	defer: vi.fn(),
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listDueInstructionStorageCleanupReceipts: (...args: unknown[]) =>
		mocks.listDue(...args),
	clearInstructionStorageCleanupReceipt: (...args: unknown[]) =>
		mocks.clear(...args),
	deferInstructionStorageCleanupReceipt: (...args: unknown[]) =>
		mocks.defer(...args),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		listObjects: (...args: unknown[]) => mocks.listObjects(...args),
		deleteObjects: (...args: unknown[]) => mocks.deleteObjects(...args),
	}),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
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

import {
	INSTRUCTION_STORAGE_CLEANUP_RETRY_MS,
	MAX_INSTRUCTION_STORAGE_CLEANUP_OBJECTS_PER_RUN,
	MAX_INSTRUCTION_STORAGE_CLEANUP_RECEIPTS_PER_RUN,
	reapInstructionStorageCleanupReceipts,
} from "../project-instruction-storage-cleanup-reaper";

const NOW = new Date("2026-10-05T12:00:00.000Z");

function receipt(id: string, projectId = "project_1") {
	return {
		id,
		snapshotId: `snapshot_${id}`,
		projectId,
		organizationId: "org_1",
		attempts: 0,
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.listDue.mockResolvedValue([]);
	mocks.listObjects.mockResolvedValue({ objects: [] });
	mocks.deleteObjects.mockImplementation(async (keys: string[]) => ({
		deleted: keys.length,
		errors: [],
	}));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("reapInstructionStorageCleanupReceipts", () => {
	it("does not touch storage when no grace-expired receipts are due", async () => {
		expect(await reapInstructionStorageCleanupReceipts()).toEqual({
			candidates: 0,
			completed: 0,
			deferred: 0,
			objectsDeleted: 0,
			errorCount: 0,
			hitCap: false,
		});
		expect(mocks.listDue).toHaveBeenCalledWith({
			now: NOW,
			limit: MAX_INSTRUCTION_STORAGE_CLEANUP_RECEIPTS_PER_RUN,
		});
		expect(mocks.listObjects).not.toHaveBeenCalled();
	});

	it("clears a receipt only after all of its canonical owned prefixes are empty", async () => {
		mocks.listDue.mockResolvedValue([receipt("one")]);

		expect(await reapInstructionStorageCleanupReceipts()).toMatchObject({
			candidates: 1,
			completed: 1,
			deferred: 0,
		});
		expect(
			mocks.listObjects.mock.calls.map(
				([input]) => (input as { prefix: string }).prefix,
			),
		).toEqual([
			"projects/project_1/instructions/staging/snapshot_one/",
			"projects/project_1/instructions/snapshots/snapshot_one/",
			"projects/project_1/instructions/exports/snapshot_one-",
		]);
		expect(mocks.clear).toHaveBeenCalledWith("one");
		expect(mocks.defer).not.toHaveBeenCalled();
	});

	it("retains and backs off a receipt when a prefix reaches its page bound", async () => {
		mocks.listDue.mockResolvedValue([receipt("wide")]);
		mocks.listObjects.mockResolvedValue({
			objects: [
				{
					key: "projects/project_1/instructions/staging/snapshot_wide/file",
					size: 1,
				},
			],
			nextContinuationToken: "more",
		});

		expect(await reapInstructionStorageCleanupReceipts()).toMatchObject({
			completed: 0,
			deferred: 1,
			objectsDeleted: 20,
		});
		expect(mocks.clear).not.toHaveBeenCalled();
		expect(mocks.defer).toHaveBeenCalledWith({
			id: "wide",
			nextAttemptAt: new Date(
				NOW.getTime() + INSTRUCTION_STORAGE_CLEANUP_RETRY_MS,
			),
			error: "truncated",
		});
	});

	it("records one storage failure and continues with later receipts", async () => {
		mocks.listDue.mockResolvedValue([
			receipt("bad"),
			receipt("good", "p2"),
		]);
		mocks.listObjects
			.mockRejectedValueOnce(
				Object.assign(new Error("denied"), { code: "EACCES" }),
			)
			.mockResolvedValue({ objects: [] });

		expect(await reapInstructionStorageCleanupReceipts()).toMatchObject({
			candidates: 2,
			completed: 1,
			deferred: 1,
			errorCount: 1,
		});
		expect(mocks.defer).toHaveBeenCalledWith({
			id: "bad",
			nextAttemptAt: new Date(
				NOW.getTime() + INSTRUCTION_STORAGE_CLEANUP_RETRY_MS,
			),
			error: "Error",
		});
		expect(mocks.clear).toHaveBeenCalledWith("good");
		const event = mocks.loggerWarn.mock.calls.at(0)?.[0];
		expect(event).toEqual({
			event: "instructions.reaper.storage_cleanup_failed",
			projectId: "project_1",
			organizationId: "org_1",
			errorName: "Error",
			code: "EACCES",
		});
	});

	it("charges attempted partial deletes against the global object budget", async () => {
		mocks.listDue.mockResolvedValue([receipt("partial"), receipt("later")]);
		mocks.listObjects.mockResolvedValue({
			objects: Array.from(
				{ length: MAX_INSTRUCTION_STORAGE_CLEANUP_OBJECTS_PER_RUN },
				(_, index) => ({
					key: `projects/project_1/instructions/staging/snapshot_partial/${index}`,
					size: 1,
				}),
			),
		});
		mocks.deleteObjects.mockResolvedValue({
			deleted: MAX_INSTRUCTION_STORAGE_CLEANUP_OBJECTS_PER_RUN - 1,
			errors: [{ key: "unavailable", message: "AccessDenied" }],
		});

		expect(await reapInstructionStorageCleanupReceipts()).toMatchObject({
			candidates: 2,
			completed: 0,
			deferred: 1,
			errorCount: 1,
			hitCap: true,
		});
		// The failed prefix did not finish, so its partial provider result is
		// not reported as a completed cleanup count.
		expect(mocks.clear).not.toHaveBeenCalled();
		expect(mocks.listObjects).toHaveBeenCalledTimes(1);
	});
});

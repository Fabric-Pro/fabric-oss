import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteFile: vi.fn(),
	getFileMetadata: vi.fn(),
	findUnique: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	listObjects: (...a: unknown[]) => mocks.listObjects(...a),
	deleteFile: (...a: unknown[]) => mocks.deleteFile(...a),
	getFileMetadata: (...a: unknown[]) => mocks.getFileMetadata(...a),
}));

vi.mock("@repo/database", () => ({
	db: {
		storyAttachment: {
			findUnique: (...a: unknown[]) => mocks.findUnique(...a),
		},
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
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

// Import AFTER the mocks so the activity captures them.
import { sweepAttachmentTempOrphansActivity } from "../attachment-temp-orphan-sweep";

const PREFIX = "story-attachments-tmp/";
const OLD = new Date(Date.now() - 1000 * 60 * 60 * 48); // 48h ago — past 24h+1h
const RECENT = new Date(Date.now() - 1000 * 60 * 5); // 5 min ago

function obj(key: string, lastModified: Date, size = 10) {
	return { key, lastModified, size };
}

const originalAgeEnv = process.env.FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS;

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	delete process.env.FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS;
	mocks.findUnique.mockResolvedValue(null); // default: no row
});

afterEach(() => {
	if (originalAgeEnv === undefined) {
		delete process.env.FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS;
	} else {
		process.env.FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS =
			originalAgeEnv;
	}
});

describe("sweepAttachmentTempOrphansActivity", () => {
	it("deletes aged no-row orphans and keeps recent objects", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [
				obj(`${PREFIX}p/s/old.png`, OLD),
				obj(`${PREFIX}p/s/new.png`, RECENT),
			],
			nextContinuationToken: undefined,
		});
		const res = await sweepAttachmentTempOrphansActivity();
		expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
		expect(mocks.deleteFile).toHaveBeenCalledWith(`${PREFIX}p/s/old.png`, {
			bucket: "project-contexts",
		});
		expect(res.deleted).toBe(1);
		expect(res.scanned).toBe(2);
	});

	it("paginates across pages via nextContinuationToken", async () => {
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: [obj(`${PREFIX}a.png`, OLD)],
				nextContinuationToken: "tok",
			})
			.mockResolvedValueOnce({
				objects: [obj(`${PREFIX}b.png`, OLD)],
				nextContinuationToken: undefined,
			});
		const res = await sweepAttachmentTempOrphansActivity();
		expect(mocks.listObjects).toHaveBeenCalledTimes(2);
		expect(mocks.listObjects.mock.calls[1][0]).toMatchObject({
			continuationToken: "tok",
		});
		expect(res.deleted).toBe(2);
	});

	it("interlock: row + final object present -> deletes the redundant temp", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}p/s/x.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.findUnique.mockResolvedValue({ id: "att_1" });
		mocks.getFileMetadata.mockResolvedValue({
			size: 10,
			contentType: "image/png",
			uploadedAt: OLD,
			pathname: "x",
			url: "u",
		});
		const res = await sweepAttachmentTempOrphansActivity();
		expect(mocks.getFileMetadata).toHaveBeenCalledWith(
			"story-attachments/p/s/x.png",
			{ bucket: "project-contexts" },
		);
		expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
		expect(res.deleted).toBe(1);
		expect(res.skippedOrphanRows).toBe(0);
	});

	it("interlock: row + final object MISSING -> skips + warns (recovery bytes)", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}p/s/x.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.findUnique.mockResolvedValue({ id: "att_1" });
		mocks.getFileMetadata.mockResolvedValue(null);
		const res = await sweepAttachmentTempOrphansActivity();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
		expect(res.skippedOrphanRows).toBe(1);
		expect(res.deleted).toBe(0);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "attachments.temp_sweep.skipped_orphan_row",
			}),
			expect.any(String),
		);
	});

	it("interlock: transient HEAD failure -> skips the object this run", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}p/s/x.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.findUnique.mockResolvedValue({ id: "att_1" });
		mocks.getFileMetadata.mockRejectedValue(new Error("503"));
		const res = await sweepAttachmentTempOrphansActivity();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
		expect(res.deleted).toBe(0);
	});

	it("continues on a deleteFile failure and counts the error", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}a.png`, OLD), obj(`${PREFIX}b.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.deleteFile
			.mockRejectedValueOnce(new Error("denied"))
			.mockResolvedValueOnce(undefined);
		const res = await sweepAttachmentTempOrphansActivity();
		expect(res.deleted).toBe(1);
		expect(res.errorCount).toBe(1);
	});

	it("stops at the page safety cap (MAX_PAGES)", async () => {
		mocks.listObjects.mockResolvedValue({
			objects: [obj(`${PREFIX}x.png`, RECENT)],
			nextContinuationToken: "tok",
		});
		const res = await sweepAttachmentTempOrphansActivity();
		expect(res.hitSafetyCap).toBe(true);
		expect(mocks.listObjects).toHaveBeenCalledTimes(50);
	});

	it("defaults MAX_AGE_HOURS to 24 when unset (regression guard for the inversion)", async () => {
		const t25h = new Date(Date.now() - 1000 * 60 * 60 * 25 - 1000 * 60 * 5);
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}x.png`, t25h)],
			nextContinuationToken: undefined,
		});
		const res = await sweepAttachmentTempOrphansActivity();
		expect(res.maxAgeHours).toBe(24);
		expect(res.deleted).toBe(1);
	});

	it("returns a clean summary for an empty prefix", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [],
			nextContinuationToken: undefined,
		});
		const res = await sweepAttachmentTempOrphansActivity();
		expect(res).toMatchObject({
			scanned: 0,
			deleted: 0,
			skippedOrphanRows: 0,
			hitSafetyCap: false,
		});
		expect(mocks.deleteFile).not.toHaveBeenCalled();
	});
});

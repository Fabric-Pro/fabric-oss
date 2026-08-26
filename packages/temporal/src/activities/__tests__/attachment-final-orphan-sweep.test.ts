import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	findMany: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	listObjects: (...a: unknown[]) => mocks.listObjects(...a),
	deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
}));

vi.mock("@repo/database", () => ({
	db: {
		storyAttachment: {
			findMany: (...a: unknown[]) => mocks.findMany(...a),
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
import { sweepAttachmentFinalOrphansActivity } from "../attachment-final-orphan-sweep";

const PREFIX = "story-attachments/";
const OLD = new Date(Date.now() - 1000 * 60 * 60 * 48); // 48h ago — past 24h+1h
const RECENT = new Date(Date.now() - 1000 * 60 * 5); // 5 min ago

function obj(key: string, lastModified: Date, size = 10) {
	return { key, lastModified, size };
}

function manyObjs(n: number, lastModified: Date, startIdx = 0) {
	return Array.from({ length: n }, (_, i) =>
		obj(
			`${PREFIX}p/s/k${String(startIdx + i).padStart(6, "0")}.png`,
			lastModified,
		),
	);
}

const originalAgeEnv = process.env.FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS;

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	delete process.env.FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS;
	// Defaults: no rows (every aged key is an orphan); deletes succeed.
	mocks.findMany.mockResolvedValue([]);
	mocks.deleteObjects.mockImplementation((keys: string[]) =>
		Promise.resolve({ deleted: keys.length, errors: [] }),
	);
});

afterEach(() => {
	if (originalAgeEnv === undefined) {
		delete process.env.FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS;
	} else {
		process.env.FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS =
			originalAgeEnv;
	}
});

describe("sweepAttachmentFinalOrphansActivity", () => {
	it("deletes an aged no-row orphan and keeps a recent object", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [
				obj(`${PREFIX}p/s/old.png`, OLD),
				obj(`${PREFIX}p/s/new.png`, RECENT),
			],
			nextContinuationToken: undefined,
		});
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(mocks.deleteObjects).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			[`${PREFIX}p/s/old.png`],
			{
				bucket: "project-contexts",
			},
		);
		expect(res.deleted).toBe(1);
		expect(res.scanned).toBe(2);
	});

	it("keeps an aged object whose row exists (live attachment)", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}p/s/live.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.findMany.mockResolvedValue([
			{ storageKey: `${PREFIX}p/s/live.png` },
		]);
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(res.deleted).toBe(0);
		expect(res.keptLive).toBe(1);
	});

	it("batched correctness: a mixed page deletes only the orphan", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [
				obj(`${PREFIX}p/s/orphan.png`, OLD),
				obj(`${PREFIX}p/s/live.png`, OLD),
				obj(`${PREFIX}p/s/recent.png`, RECENT),
			],
			nextContinuationToken: undefined,
		});
		mocks.findMany.mockResolvedValue([
			{ storageKey: `${PREFIX}p/s/live.png` },
		]);
		const res = await sweepAttachmentFinalOrphansActivity();
		// findMany asked only about the two AGED keys, not the recent one.
		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				storageKey: {
					in: [`${PREFIX}p/s/orphan.png`, `${PREFIX}p/s/live.png`],
				},
			},
			select: { storageKey: true },
		});
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			[`${PREFIX}p/s/orphan.png`],
			{
				bucket: "project-contexts",
			},
		);
		expect(res.deleted).toBe(1);
		expect(res.keptLive).toBe(1);
	});

	it("reaches a later-page orphan despite two full pages of failing deletes", async () => {
		// Two REALISTIC 1000-key pages whose deletes ALL fail (must NOT consume the
		// success budget), then a third page with a deletable orphan. Mirrors the
		// production boundary: listObjects uses maxKeys 1000, so a page never holds
		// more than 1000 keys.
		const page1 = manyObjs(1000, OLD, 0);
		const page2 = manyObjs(1000, OLD, 1000);
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: page1,
				nextContinuationToken: "t1",
			})
			.mockResolvedValueOnce({
				objects: page2,
				nextContinuationToken: "t2",
			})
			.mockResolvedValueOnce({
				objects: [obj(`${PREFIX}p/s/later.png`, OLD)],
				nextContinuationToken: undefined,
			});
		mocks.deleteObjects.mockImplementation((keys: string[]) =>
			keys.includes(`${PREFIX}p/s/later.png`)
				? Promise.resolve({ deleted: 1, errors: [] })
				: Promise.resolve({
						deleted: 0,
						errors: keys.map((k) => ({
							key: k,
							message: "denied",
						})),
					}),
		);
		const res = await sweepAttachmentFinalOrphansActivity();
		// Despite 2000 failing keys across two full pages, the third-page orphan IS
		// deleted this run (failures consume neither budget nor traversal).
		expect(mocks.listObjects).toHaveBeenCalledTimes(3);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			[`${PREFIX}p/s/later.png`],
			{
				bucket: "project-contexts",
			},
		);
		// Every deleteObjects call gets at most one page's worth of keys.
		for (const call of mocks.deleteObjects.mock.calls) {
			expect((call[0] as string[]).length).toBeLessThanOrEqual(1000);
		}
		expect(res.deleted).toBe(1);
		expect(res.errorCount).toBe(2000);
		expect(res.hitDeletionCap).toBe(false);
	});

	it("aborts the run when findMany throws (no delete)", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}p/s/x.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.findMany.mockRejectedValue(new Error("db down"));
		await expect(sweepAttachmentFinalOrphansActivity()).rejects.toThrow(
			"db down",
		);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
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
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(mocks.listObjects).toHaveBeenCalledTimes(2);
		expect(mocks.listObjects.mock.calls[1][0]).toMatchObject({
			continuationToken: "tok",
		});
		expect(res.deleted).toBe(2);
	});

	it("stops at the successful-delete budget (MAX_DELETIONS) across pages, before fetching the next", async () => {
		// Two full 1000-key pages of successful deletes reach the 2000 budget; a
		// third page (token "t2") must NOT be fetched.
		const page1 = manyObjs(1000, OLD, 0);
		const page2 = manyObjs(1000, OLD, 1000);
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: page1,
				nextContinuationToken: "t1",
			})
			.mockResolvedValueOnce({
				objects: page2,
				nextContinuationToken: "t2",
			});
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(res.deleted).toBe(2000);
		expect(res.hitDeletionCap).toBe(true);
		// Budget exhausted after page 2 → page 3 (token "t2") never fetched.
		expect(mocks.listObjects).toHaveBeenCalledTimes(2);
		for (const call of mocks.deleteObjects.mock.calls) {
			expect((call[0] as string[]).length).toBeLessThanOrEqual(1000);
		}
	});

	it("aborts the run when listObjects throws", async () => {
		mocks.listObjects.mockRejectedValue(new Error("list boom"));
		await expect(sweepAttachmentFinalOrphansActivity()).rejects.toThrow(
			"list boom",
		);
	});

	it("counts deleteObjects per-key errors and continues", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}a.png`, OLD), obj(`${PREFIX}b.png`, OLD)],
			nextContinuationToken: undefined,
		});
		mocks.deleteObjects.mockResolvedValue({
			deleted: 1,
			errors: [{ key: `${PREFIX}b.png`, message: "denied" }],
		});
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(res.deleted).toBe(1);
		expect(res.errorCount).toBe(1);
	});

	it("defaults MAX_AGE_HOURS to 24 when unset (regression guard for the inversion)", async () => {
		const t25h = new Date(Date.now() - 1000 * 60 * 60 * 25 - 1000 * 60 * 5);
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj(`${PREFIX}x.png`, t25h)],
			nextContinuationToken: undefined,
		});
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(res.maxAgeHours).toBe(24);
		expect(res.deleted).toBe(1);
	});

	it("returns a clean summary for an empty prefix", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [],
			nextContinuationToken: undefined,
		});
		const res = await sweepAttachmentFinalOrphansActivity();
		expect(res).toMatchObject({
			scanned: 0,
			deleted: 0,
			keptLive: 0,
			hitDeletionCap: false,
		});
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	findProject: vi.fn(),
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
		project: { findUnique: (...a: unknown[]) => mocks.findProject(...a) },
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

import { deleteProjectAttachmentsFromStorageActivity } from "../project-deletion";

function obj(key: string) {
	return { key, lastModified: new Date("2026-06-01T00:00:00Z"), size: 1 };
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
	mocks.findProject.mockResolvedValue(null); // default: project was hard-deleted
});

describe("deleteProjectAttachmentsFromStorageActivity", () => {
	it("skips entirely (no list, no delete) when the project row still exists (restored)", async () => {
		mocks.findProject.mockResolvedValue({ id: "p" });
		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(res).toEqual({ deleted: 0, pages: 0 });
	});

	it("lists the project prefix and batch-deletes the keys", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [
				obj("story-attachments/p/s/a.png"),
				obj("story-attachments/p/s/b.png"),
			],
			nextContinuationToken: undefined,
		});
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 2, errors: [] });

		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});

		expect(mocks.listObjects).toHaveBeenCalledWith({
			bucket: "project-contexts",
			prefix: "story-attachments/p/",
			continuationToken: undefined,
			maxKeys: 1000,
		});
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s/a.png", "story-attachments/p/s/b.png"],
			{ bucket: "project-contexts" },
		);
		expect(res).toEqual({ deleted: 2, pages: 1 });
	});

	it("paginates across pages via nextContinuationToken until exhausted", async () => {
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: [obj("story-attachments/p/a")],
				nextContinuationToken: "t",
			})
			.mockResolvedValueOnce({
				objects: [obj("story-attachments/p/b")],
				nextContinuationToken: undefined,
			});
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });

		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});

		expect(mocks.listObjects).toHaveBeenCalledTimes(2);
		expect(mocks.listObjects.mock.calls[1][0]).toMatchObject({
			continuationToken: "t",
		});
		expect(res).toEqual({ deleted: 2, pages: 2 });
	});

	it("is a no-op (no delete) on an empty prefix", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [],
			nextContinuationToken: undefined,
		});
		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(res).toEqual({ deleted: 0, pages: 1 });
	});

	it("propagates a listObjects failure (so Temporal retries)", async () => {
		mocks.listObjects.mockRejectedValueOnce(new Error("bucket down"));
		await expect(
			deleteProjectAttachmentsFromStorageActivity({ projectId: "p" }),
		).rejects.toThrow("bucket down");
	});

	it("throws after the pass when deleteObjects reported residual errors (so Temporal retries)", async () => {
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj("story-attachments/p/a")],
			nextContinuationToken: undefined,
		});
		mocks.deleteObjects.mockResolvedValueOnce({
			deleted: 0,
			errors: [{ key: "story-attachments/p/a", message: "denied" }],
		});
		await expect(
			deleteProjectAttachmentsFromStorageActivity({ projectId: "p" }),
		).rejects.toThrow(/1 object/);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	findProject: vi.fn(),
	listFramesOfDeletedProject: vi.fn(),
	detachFramesFromProject: vi.fn(),
	deleteFrameOfDeletedProject: vi.fn(),
	deleteFramePageFiles: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	listObjects: (...a: unknown[]) => mocks.listObjects(...a),
	deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
	deleteFramePageFiles: (...a: unknown[]) => mocks.deleteFramePageFiles(...a),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: (...a: unknown[]) => mocks.findProject(...a) },
	},
	listFramesOfDeletedProject: (...a: unknown[]) =>
		mocks.listFramesOfDeletedProject(...a),
	detachFramesFromProject: (...a: unknown[]) =>
		mocks.detachFramesFromProject(...a),
	deleteFrameOfDeletedProject: (...a: unknown[]) =>
		mocks.deleteFrameOfDeletedProject(...a),
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "project-contexts",
				workspaceDocuments: "workspace-documents",
			},
		},
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
	mocks.listFramesOfDeletedProject.mockResolvedValue({
		workspaceFrameIds: [],
		artifactFrames: [],
	});
	mocks.detachFramesFromProject.mockResolvedValue(0);
	mocks.deleteFrameOfDeletedProject.mockResolvedValue(1);
	mocks.deleteFramePageFiles.mockResolvedValue({ deleted: 0 });
	// Default: an empty prefix. The activity sweeps three prefixes
	// (attachments, Glossy recipient logos, then Proposal exports), so a test
	// that stubs only the first pages still sees the later listings come back
	// empty.
	mocks.listObjects.mockResolvedValue({
		objects: [],
		nextContinuationToken: undefined,
	});
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

	it("leaves a restored project's pages alone", async () => {
		mocks.findProject.mockResolvedValue({ id: "p" });

		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });

		expect(mocks.listFramesOfDeletedProject).not.toHaveBeenCalled();
		expect(mocks.detachFramesFromProject).not.toHaveBeenCalled();
		expect(mocks.deleteFramePageFiles).not.toHaveBeenCalled();
		expect(mocks.deleteFrameOfDeletedProject).not.toHaveBeenCalled();
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
		// One page per prefix: the attachments, then the empty brand and
		// export prefixes.
		expect(res).toEqual({ deleted: 2, pages: 3 });
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

		// Two attachment pages, then one (empty) brand page and one (empty)
		// export page.
		expect(mocks.listObjects).toHaveBeenCalledTimes(4);
		expect(mocks.listObjects.mock.calls[1][0]).toMatchObject({
			continuationToken: "t",
		});
		expect(res).toEqual({ deleted: 2, pages: 4 });
	});

	it("is a no-op (no delete) on empty prefixes", async () => {
		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(res).toEqual({ deleted: 0, pages: 3 });
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

// Glossy recipient logos (Fizzy #2589, KTD23): pending and promoted objects
// under `project-brand/{projectId}/` that a best-effort cleanup left behind
// are unreferenced, and project deletion is what removes them.
describe("deleteProjectAttachmentsFromStorageActivity — recipient brand prefix", () => {
	it("also lists and deletes everything under project-brand/{projectId}/", async () => {
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: [obj("story-attachments/p/s/a.png")],
				nextContinuationToken: undefined,
			})
			.mockResolvedValueOnce({
				objects: [
					obj("project-brand/p/recipient-brand/current/c1.png"),
					obj("project-brand/p/recipient-brand/pending/t1.png"),
				],
				nextContinuationToken: undefined,
			});
		mocks.deleteObjects
			.mockResolvedValueOnce({ deleted: 1, errors: [] })
			.mockResolvedValueOnce({ deleted: 2, errors: [] });

		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});

		expect(mocks.listObjects.mock.calls.map((c) => c[0].prefix)).toEqual([
			"story-attachments/p/",
			"project-brand/p/",
			"proposal-exports/p/",
		]);
		expect(mocks.deleteObjects).toHaveBeenLastCalledWith(
			[
				"project-brand/p/recipient-brand/current/c1.png",
				"project-brand/p/recipient-brand/pending/t1.png",
			],
			{ bucket: "project-contexts" },
		);
		expect(res).toEqual({ deleted: 3, pages: 3 });
	});

	it("paginates the brand prefix like the attachment prefix", async () => {
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: [],
				nextContinuationToken: undefined,
			})
			.mockResolvedValueOnce({
				objects: [obj("project-brand/p/recipient-brand/pending/a.png")],
				nextContinuationToken: "b1",
			})
			.mockResolvedValueOnce({
				objects: [obj("project-brand/p/recipient-brand/pending/b.png")],
				nextContinuationToken: undefined,
			});
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });

		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});

		expect(mocks.listObjects.mock.calls[2][0]).toMatchObject({
			prefix: "project-brand/p/",
			continuationToken: "b1",
		});
		expect(res).toEqual({ deleted: 2, pages: 4 });
	});

	it("keeps a restored project's brand objects", async () => {
		mocks.findProject.mockResolvedValue({ id: "p" });

		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });

		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("throws (so Temporal retries) when a brand object could not be deleted", async () => {
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: [],
				nextContinuationToken: undefined,
			})
			.mockResolvedValueOnce({
				objects: [
					obj("project-brand/p/recipient-brand/current/c1.png"),
				],
				nextContinuationToken: undefined,
			});
		mocks.deleteObjects.mockResolvedValueOnce({
			deleted: 0,
			errors: [
				{
					key: "project-brand/p/recipient-brand/current/c1.png",
					message: "denied",
				},
			],
		});

		await expect(
			deleteProjectAttachmentsFromStorageActivity({ projectId: "p" }),
		).rejects.toThrow(/1 object/);
	});
});

// Exported Proposal files (Fizzy #2946) live under
// `proposal-exports/{projectId}/` in the same bucket; deleting the project
// deletes them with it, whatever their age.
describe("deleteProjectAttachmentsFromStorageActivity — Proposal export prefix", () => {
	it("also lists and deletes everything under proposal-exports/{projectId}/", async () => {
		mocks.listObjects
			.mockResolvedValueOnce({
				objects: [],
				nextContinuationToken: undefined,
			})
			.mockResolvedValueOnce({
				objects: [],
				nextContinuationToken: undefined,
			})
			.mockResolvedValueOnce({
				objects: [
					obj("proposal-exports/p/proposal-export-0123.pdf"),
					obj("proposal-exports/p/proposal-export-4567.docx"),
				],
				nextContinuationToken: undefined,
			});
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 2, errors: [] });

		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});

		expect(mocks.listObjects.mock.calls[2][0]).toMatchObject({
			bucket: "project-contexts",
			prefix: "proposal-exports/p/",
		});
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			[
				"proposal-exports/p/proposal-export-0123.pdf",
				"proposal-exports/p/proposal-export-4567.docx",
			],
			{ bucket: "project-contexts" },
		);
		expect(res).toEqual({ deleted: 2, pages: 3 });
	});
});

// Pages have no foreign key to the project, so deleting the project leaves
// them, their records and their stored files. A Workspace page belongs to the
// organization and is unlinked; every other page of the project is deleted,
// its files first so a failure leaves the row for the retry.
describe("deleteProjectAttachmentsFromStorageActivity — pages", () => {
	const artifact = (id: string, organizationId: string | null = "org-1") => ({
		id,
		userId: "owner-1",
		organizationId,
	});

	it("deletes an artifact page's stored files, then its row", async () => {
		const order: string[] = [];
		mocks.listFramesOfDeletedProject.mockResolvedValue({
			workspaceFrameIds: [],
			artifactFrames: [artifact("f1")],
		});
		mocks.deleteFramePageFiles.mockImplementation(async () => {
			order.push("files");
			return { deleted: 3 };
		});
		mocks.deleteFrameOfDeletedProject.mockImplementation(async () => {
			order.push("row");
			return 1;
		});

		const res = await deleteProjectAttachmentsFromStorageActivity({
			projectId: "p",
		});

		expect(mocks.listFramesOfDeletedProject).toHaveBeenCalledWith("p");
		expect(mocks.deleteFramePageFiles).toHaveBeenCalledWith(
			{ organizationId: "org-1", userId: "owner-1", frameId: "f1" },
			{ bucket: "workspace-documents" },
		);
		expect(mocks.deleteFrameOfDeletedProject).toHaveBeenCalledWith({
			projectId: "p",
			frameId: "f1",
		});
		expect(order).toEqual(["files", "row"]);
		expect(res).toEqual({ deleted: 3, pages: 3 });
	});

	it("unlinks Workspace pages and keeps them and their files", async () => {
		mocks.listFramesOfDeletedProject.mockResolvedValue({
			workspaceFrameIds: ["w1", "w2"],
			artifactFrames: [],
		});

		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });

		expect(mocks.detachFramesFromProject).toHaveBeenCalledWith({
			projectId: "p",
			frameIds: ["w1", "w2"],
		});
		expect(mocks.deleteFramePageFiles).not.toHaveBeenCalled();
		expect(mocks.deleteFrameOfDeletedProject).not.toHaveBeenCalled();
	});

	it("does not unlink anything when there is no Workspace page", async () => {
		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });

		expect(mocks.detachFramesFromProject).not.toHaveBeenCalled();
		expect(mocks.deleteFramePageFiles).not.toHaveBeenCalled();
	});

	it("keeps the row and throws when a page's files cannot be deleted", async () => {
		mocks.listFramesOfDeletedProject.mockResolvedValue({
			workspaceFrameIds: [],
			artifactFrames: [artifact("f1")],
		});
		mocks.deleteFramePageFiles.mockRejectedValue(
			new Error("Could not delete 1 stored file(s) of the page"),
		);

		await expect(
			deleteProjectAttachmentsFromStorageActivity({ projectId: "p" }),
		).rejects.toThrow("Could not delete 1 stored file(s)");

		expect(mocks.deleteFrameOfDeletedProject).not.toHaveBeenCalled();
	});

	it("still sweeps the attachments when the pages fail, and fails once", async () => {
		mocks.listFramesOfDeletedProject.mockResolvedValue({
			workspaceFrameIds: [],
			artifactFrames: [artifact("f1")],
		});
		mocks.deleteFramePageFiles.mockRejectedValue(new Error("store down"));
		mocks.listObjects.mockResolvedValueOnce({
			objects: [obj("story-attachments/p/s/a.png")],
			nextContinuationToken: undefined,
		});
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 1, errors: [] });

		await expect(
			deleteProjectAttachmentsFromStorageActivity({ projectId: "p" }),
		).rejects.toThrow("store down");

		expect(mocks.deleteObjects).toHaveBeenCalledTimes(1);
	});

	it("passes a page with no organization to the helper under its owner", async () => {
		mocks.listFramesOfDeletedProject.mockResolvedValue({
			workspaceFrameIds: [],
			artifactFrames: [artifact("f1", null)],
		});

		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });

		expect(mocks.deleteFramePageFiles).toHaveBeenCalledWith(
			{ organizationId: null, userId: "owner-1", frameId: "f1" },
			{ bucket: "workspace-documents" },
		);
	});

	it("is idempotent: a second run over what is left deletes nothing more", async () => {
		mocks.listFramesOfDeletedProject
			.mockResolvedValueOnce({
				workspaceFrameIds: [],
				artifactFrames: [artifact("f1")],
			})
			.mockResolvedValueOnce({
				workspaceFrameIds: [],
				artifactFrames: [],
			});

		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });
		await deleteProjectAttachmentsFromStorageActivity({ projectId: "p" });

		expect(mocks.deleteFramePageFiles).toHaveBeenCalledTimes(1);
		expect(mocks.deleteFrameOfDeletedProject).toHaveBeenCalledTimes(1);
	});
});

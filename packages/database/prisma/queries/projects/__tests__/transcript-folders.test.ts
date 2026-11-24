/**
 * OneDrive transcript folder queries (Fizzy #3507).
 *
 * What these promise the UI and the sync: counts that add up and say what
 * happened to each file, a reconnect that offers again only what could not be
 * copied, a disconnect that touches no imported transcript, and a read that
 * never records a file twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	folderFindMany: vi.fn(),
	folderUpsert: vi.fn(),
	folderUpdateMany: vi.fn(),
	fileGroupBy: vi.fn(),
	fileFindMany: vi.fn(),
	fileUpdateMany: vi.fn(),
	fileCreateMany: vi.fn(),
	fileFindUnique: vi.fn(),
	transaction: vi.fn(),
	txContextCreate: vi.fn(),
	txFileUpdate: vi.fn(),
	executeRaw: vi.fn(),
	documentFolderFindMany: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		$transaction: db.transaction,
		projectTranscriptFolder: {
			findMany: db.folderFindMany,
			upsert: db.folderUpsert,
			updateMany: db.folderUpdateMany,
		},
		projectTranscriptFolderFile: {
			groupBy: db.fileGroupBy,
			findMany: db.fileFindMany,
			updateMany: db.fileUpdateMany,
			createMany: db.fileCreateMany,
			findUnique: db.fileFindUnique,
		},
	},
}));

import { FolderConnectRefusedError } from "../document-folders";
import {
	connectTranscriptFolders,
	createFolderFileContext,
	disconnectTranscriptFolder,
	listTranscriptFolders,
	recordDiscoveredFolderFiles,
} from "../transcript-folders";

beforeEach(() => {
	vi.clearAllMocks();
	db.transaction.mockImplementation(async (ops: unknown) =>
		typeof ops === "function"
			? ops({
					$executeRaw: db.executeRaw,
					projectContext: { create: db.txContextCreate },
					projectTranscriptFolder: { upsert: db.folderUpsert },
					projectTranscriptFolderFile: { update: db.txFileUpdate },
					projectDocumentFolder: {
						findMany: db.documentFolderFindMany,
					},
				})
			: Promise.all(ops as Promise<unknown>[]),
	);
	db.folderUpsert.mockImplementation(async () => ({ id: "folder-1" }));
	db.fileUpdateMany.mockResolvedValue({ count: 0 });
	db.documentFolderFindMany.mockResolvedValue([]);
});

describe("connectTranscriptFolders", () => {
	it("reconnects as the person connecting, reading the folder from scratch", async () => {
		await connectTranscriptFolders({
			projectId: "project-1",
			userId: "user-2",
			organizationId: "org-1",
			folders: [
				{ driveId: "drive-1", itemId: "item-1", name: "Transcripts" },
			],
		});

		const upsert = db.folderUpsert.mock.calls[0]?.[0];
		expect(upsert.where).toEqual({
			projectId_driveId_itemId: {
				projectId: "project-1",
				driveId: "drive-1",
				itemId: "item-1",
			},
		});
		expect(upsert.update).toMatchObject({
			userId: "user-2",
			disconnectedAt: null,
			lastSyncError: null,
			discoveredAt: null,
		});
	});

	it("offers again only the files that could not be copied", async () => {
		await connectTranscriptFolders({
			projectId: "project-1",
			userId: "user-1",
			folders: [
				{ driveId: "drive-1", itemId: "item-1", name: "Transcripts" },
			],
		});

		expect(db.fileUpdateMany).toHaveBeenCalledWith({
			where: {
				folderId: { in: ["folder-1"] },
				status: "FAILED",
				contextId: null,
			},
			data: { status: "PENDING", reason: null },
		});
	});
});

describe("connectTranscriptFolders refusing document folders", () => {
	const documentFolder = {
		driveId: "drive-1",
		itemId: "item-docs",
		name: "Case studies",
		drivePath: "/Sales/Case studies",
	};

	async function refusal(promise: Promise<unknown>) {
		const error = await promise.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FolderConnectRefusedError);
		expect(db.folderUpsert).not.toHaveBeenCalled();
		return error as FolderConnectRefusedError;
	}

	it("refuses a folder that is a connected document folder, naming it", async () => {
		db.documentFolderFindMany.mockResolvedValue([documentFolder]);

		const error = await refusal(
			connectTranscriptFolders({
				projectId: "project-1",
				userId: "user-1",
				folders: [
					{
						driveId: "drive-1",
						itemId: "item-docs",
						name: "Case studies",
					},
				],
			}),
		);
		expect(error.reason).toBe("SAME_AS_DOCUMENT_FOLDER");
		expect(error.existingFolderName).toBe("Case studies");
		expect(db.documentFolderFindMany.mock.calls[0]?.[0].where).toEqual({
			projectId: "project-1",
			disconnectedAt: null,
		});
	});

	it("refuses a folder holding a connected document folder when its path is given", async () => {
		db.documentFolderFindMany.mockResolvedValue([documentFolder]);

		const error = await refusal(
			connectTranscriptFolders({
				projectId: "project-1",
				userId: "user-1",
				folders: [
					{
						driveId: "drive-1",
						itemId: "item-sales",
						name: "Sales",
						drivePath: "/Sales",
					},
				],
			}),
		);
		expect(error.reason).toBe("OVERLAPS_DOCUMENT_FOLDER");
	});
});

describe("disconnectTranscriptFolder", () => {
	it("stops the folder and touches nothing it imported", async () => {
		db.folderUpdateMany.mockResolvedValue({ count: 1 });

		expect(
			await disconnectTranscriptFolder({
				projectId: "project-1",
				folderId: "folder-1",
			}),
		).toBe(true);
		const call = db.folderUpdateMany.mock.calls[0]?.[0];
		expect(call.where).toEqual({
			id: "folder-1",
			projectId: "project-1",
			disconnectedAt: null,
		});
		expect(Object.keys(call.data)).toEqual(["disconnectedAt"]);
		expect(db.fileUpdateMany).not.toHaveBeenCalled();
	});
});

describe("recordDiscoveredFolderFiles", () => {
	it("never records a file twice, so a second read is safe", async () => {
		await recordDiscoveredFolderFiles({
			folderId: "folder-1",
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			files: [
				{
					driveItemId: "a",
					name: "a.vtt",
					size: 10,
					status: "PENDING",
				},
			],
		});

		expect(db.fileCreateMany.mock.calls[0]?.[0].skipDuplicates).toBe(true);
	});

	it("records a recording too large for the size column, instead of failing the folder", async () => {
		await recordDiscoveredFolderFiles({
			folderId: "folder-1",
			projectId: "project-1",
			userId: "user-1",
			files: [
				{
					driveItemId: "big",
					name: "All hands.mp4",
					size: 3 * 1024 * 1024 * 1024,
					status: "SKIPPED",
					reason: "Not a supported transcript format.",
				},
			],
		});

		expect(db.fileCreateMany.mock.calls[0]?.[0].data[0].size).toBeNull();
	});
});

describe("createFolderFileContext", () => {
	const params = {
		fileId: "file-1",
		projectId: "project-1",
		s3Path: "projects/project-1/ctx_folder_file-1.vtt",
		s3Bucket: "contexts",
		originalFilename: "Standup.vtt",
		mimeType: "text/vtt",
		fileSize: 10,
		metadata: { provider: "onedrive-folder" },
		userId: "user-1",
		organizationId: "org-1",
	};

	it("creates the context and claims the file in one transaction", async () => {
		db.txContextCreate.mockResolvedValue({ id: "context-1" });
		db.txFileUpdate.mockResolvedValue({});

		expect(await createFolderFileContext(params)).toEqual({
			contextId: "context-1",
		});
		expect(db.txFileUpdate).toHaveBeenCalledWith({
			where: { id: "file-1", contextId: null },
			data: { contextId: "context-1", status: "IMPORTING" },
		});
	});

	it("returns the context another attempt already attached", async () => {
		db.txContextCreate.mockResolvedValue({ id: "context-2" });
		db.txFileUpdate.mockRejectedValue(
			Object.assign(new Error("not found"), { code: "P2025" }),
		);
		db.fileFindUnique.mockResolvedValue({ contextId: "context-1" });

		expect(await createFolderFileContext(params)).toEqual({
			contextId: "context-1",
		});
	});
});

describe("listTranscriptFolders", () => {
	it("adds the counts up, and counts a file already in the project as skipped", async () => {
		db.folderFindMany.mockResolvedValue([
			{
				id: "folder-1",
				driveId: "drive-1",
				itemId: "item-1",
				name: "Transcripts",
				webUrl: null,
				connectedAt: new Date("2026-11-06T10:00:00Z"),
				lastSyncAt: null,
				lastSyncError: null,
				discoveredAt: null,
				userId: "user-1",
				user: { name: "Alex Example" },
			},
		]);
		const group = (status: string, n: number) => ({
			folderId: "folder-1",
			status,
			_count: { _all: n },
		});
		db.fileGroupBy.mockResolvedValue([
			group("IMPORTED", 5),
			group("DUPLICATE", 1),
			group("SKIPPED", 2),
			group("FAILED", 1),
			group("PENDING", 3),
			group("IMPORTING", 1),
		]);
		db.fileFindMany.mockResolvedValue([
			{
				folderId: "folder-1",
				name: "Deck.pptx",
				status: "SKIPPED",
				reason: "Not a supported transcript format.",
			},
		]);

		const [folder] = await listTranscriptFolders("project-1");

		expect(folder?.counts).toEqual({
			discovered: 13,
			imported: 5,
			skipped: 3,
			failed: 1,
			inProgress: 4,
		});
		expect(folder?.discoveryComplete).toBe(false);
		expect(folder?.connectedByName).toBe("Alex Example");
		expect(folder?.problems).toEqual([
			{
				name: "Deck.pptx",
				status: "SKIPPED",
				reason: "Not a supported transcript format.",
			},
		]);
	});

	it("lists no disconnected folder", async () => {
		db.folderFindMany.mockResolvedValue([]);

		expect(await listTranscriptFolders("project-1")).toEqual([]);
		expect(db.folderFindMany.mock.calls[0]?.[0].where).toEqual({
			projectId: "project-1",
			disconnectedAt: null,
		});
	});
});

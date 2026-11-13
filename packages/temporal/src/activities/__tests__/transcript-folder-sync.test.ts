/**
 * Importing transcripts from a connected OneDrive folder (Fizzy #3507).
 *
 * What the card pins: only files directly in the folder, the upload's own
 * formats and size limit with a visible reason for anything skipped, no file
 * imported twice, and a connection that stops working shown on the folder as
 * a reconnect, not as a run of failed files.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getFolder: vi.fn(),
	getFile: vi.fn(),
	listActive: vi.fn(),
	listPending: vi.fn(),
	recordFiles: vi.fn(),
	recordRead: vi.fn(),
	setOutcome: vi.fn(),
	createFolderFileContext: vi.fn(),
	ownConnection: vi.fn(),
	canCreate: vi.fn(),
	projectFindUnique: vi.fn(),
	contextFindUnique: vi.fn(),
	contextDeleteMany: vi.fn(),
	executeTool: vi.fn(),
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canCreateProjectContexts: mocks.canCreate,
	createFolderFileContext: mocks.createFolderFileContext,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectContext: {
			findUnique: mocks.contextFindUnique,
			deleteMany: mocks.contextDeleteMany,
		},
	},
	getTranscriptFolder: mocks.getFolder,
	getTranscriptFolderFile: mocks.getFile,
	listActiveTranscriptFolderIds: mocks.listActive,
	listPendingFolderFileIds: mocks.listPending,
	recordDiscoveredFolderFiles: mocks.recordFiles,
	recordTranscriptFolderRead: mocks.recordRead,
	resolveOwnWorkflowIntegrationForProvider: mocks.ownConnection,
	setFolderFileOutcome: mocks.setOutcome,
	TRANSCRIPT_FOLDER_FILE_STATUS: {
		PENDING: "PENDING",
		IMPORTING: "IMPORTING",
		IMPORTED: "IMPORTED",
		DUPLICATE: "DUPLICATE",
		SKIPPED: "SKIPPED",
		FAILED: "FAILED",
	},
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.executeTool,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected"),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "contexts" } } },
}));

vi.mock("@repo/storage", () => ({
	uploadFile: mocks.uploadFile,
	deleteFile: mocks.deleteFile,
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../meeting-transcript-upload", () => ({
	ALREADY_ADDED: "This file has already been added to this project.",
}));

import {
	importTranscriptFolderFile,
	readTranscriptFolder,
	recordTranscriptFolderFileOutcome,
} from "../transcript-folder-sync";

const FOLDER = {
	id: "folder-1",
	projectId: "project-1",
	driveId: "drive-1",
	itemId: "item-1",
	name: "Transcripts",
	disconnectedAt: null,
	userId: "user-1",
	organizationId: "org-1",
};

function driveItem(overrides: Record<string, unknown>) {
	return {
		id: "x",
		name: "x.vtt",
		driveId: "drive-1",
		isFolder: false,
		childCount: null,
		size: 100,
		webUrl: null,
		lastModified: null,
		...overrides,
	};
}

function folderFile(overrides: Record<string, unknown> = {}) {
	return {
		id: "file-1",
		projectId: "project-1",
		driveItemId: "drive-item-1",
		name: "Planning 2026-03-04.vtt",
		size: 100,
		status: "PENDING",
		contextId: null,
		folder: {
			id: "folder-1",
			name: "Transcripts",
			driveId: "drive-1",
			disconnectedAt: null,
			userId: "user-1",
			organizationId: "org-1",
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getFolder.mockResolvedValue(FOLDER);
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.canCreate.mockResolvedValue(true);
	mocks.listPending.mockResolvedValue(["file-1"]);
	mocks.createFolderFileContext.mockResolvedValue({ contextId: "context-1" });
	mocks.ownConnection.mockResolvedValue({ id: "conn-1" });
	mocks.uploadFile.mockResolvedValue(undefined);
	mocks.deleteFile.mockResolvedValue(undefined);
});

describe("readTranscriptFolder", () => {
	it("records the folder's own files, skipping what cannot be imported, and not nested folders", async () => {
		mocks.executeTool.mockResolvedValue({
			items: [
				driveItem({ id: "a", name: "Standup.vtt" }),
				driveItem({ id: "b", name: "Deck.pptx" }),
				driveItem({
					id: "c",
					name: "Huge.txt",
					size: 30 * 1024 * 1024,
				}),
				driveItem({
					id: "d",
					name: "2025",
					isFolder: true,
					size: null,
				}),
			],
			truncated: false,
		});

		const result = await readTranscriptFolder({
			folderId: "folder-1",
			limit: 20,
		});

		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_children",
			{ driveId: "drive-1", itemId: "item-1" },
			"user-1",
			"org-1",
			"conn-1",
		);
		expect(mocks.ownConnection).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
		const recorded = mocks.recordFiles.mock.calls[0]?.[0];
		expect(
			recorded.files.map((f: { driveItemId: string }) => f.driveItemId),
		).toEqual(["a", "b", "c"]);
		expect(recorded.files[0]).toMatchObject({ status: "PENDING" });
		expect(recorded.files[1]).toMatchObject({
			status: "SKIPPED",
			reason: expect.stringContaining(
				"Not a supported transcript format",
			),
		});
		expect(recorded.files[2]).toMatchObject({
			status: "SKIPPED",
			reason: expect.stringContaining("Too large"),
		});
		expect(mocks.recordRead).toHaveBeenCalledWith({
			folderId: "folder-1",
			complete: true,
		});
		expect(mocks.listPending).toHaveBeenCalledWith("folder-1", 20);
		expect(result).toEqual({ pendingFileIds: ["file-1"] });
	});

	it("keeps counts provisional while the folder was not listed in full", async () => {
		mocks.executeTool.mockResolvedValue({ items: [], truncated: true });

		await readTranscriptFolder({ folderId: "folder-1", limit: 20 });

		expect(mocks.recordRead).toHaveBeenCalledWith({
			folderId: "folder-1",
			complete: false,
		});
	});

	it("asks for a reconnect when the Microsoft connection stopped working", async () => {
		mocks.executeTool.mockRejectedValue(
			new Error(
				"Microsoft not connected. Please connect your Microsoft account.",
			),
		);

		const result = await readTranscriptFolder({
			folderId: "folder-1",
			limit: 20,
		});

		expect(result).toEqual({ pendingFileIds: [] });
		expect(mocks.recordRead.mock.calls[0]?.[0].error).toContain(
			"Reconnect the folder",
		);
		expect(mocks.recordFiles).not.toHaveBeenCalled();
	});

	it("asks for a reconnect rather than read with a connection shared by someone else", async () => {
		mocks.ownConnection.mockResolvedValue(null);

		expect(
			await readTranscriptFolder({ folderId: "folder-1", limit: 20 }),
		).toEqual({ pendingFileIds: [] });
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.recordRead.mock.calls[0]?.[0].error).toContain(
			"Reconnect the folder",
		);
	});

	it("stops when the person who connected it may no longer add context", async () => {
		mocks.canCreate.mockResolvedValue(false);

		const result = await readTranscriptFolder({
			folderId: "folder-1",
			limit: 20,
		});

		expect(result).toEqual({ pendingFileIds: [] });
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.recordRead.mock.calls[0]?.[0].error).toContain(
			"can no longer add context",
		);
	});

	it("reads nothing from a disconnected folder", async () => {
		mocks.getFolder.mockResolvedValue({
			...FOLDER,
			disconnectedAt: new Date(),
		});

		expect(
			await readTranscriptFolder({ folderId: "folder-1", limit: 20 }),
		).toEqual({ pendingFileIds: [] });
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});
});

describe("importTranscriptFolderFile", () => {
	it("copies the file into storage as a pending OneDrive transcript", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.executeTool.mockResolvedValue({
			status: "ok",
			name: "Planning 2026-03-04.vtt",
			size: 6,
			bytes: Buffer.from("WEBVTT"),
		});

		const result = await importTranscriptFolderFile({ fileId: "file-1" });

		expect(result).toEqual({
			outcome: "ingest",
			contextId: "context-1",
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		const [path, bytes, options] = mocks.uploadFile.mock.calls[0] ?? [];
		// One object per file, so a retried step overwrites rather than adds.
		expect(path).toBe("projects/project-1/ctx_folder_file-1.vtt");
		expect(bytes.toString()).toBe("WEBVTT");
		expect(options).toEqual({
			bucket: "contexts",
			contentType: "text/vtt",
		});
		// Created and attached to the file in one step.
		expect(mocks.createFolderFileContext.mock.calls[0]?.[0]).toMatchObject({
			fileId: "file-1",
			projectId: "project-1",
			s3Path: "projects/project-1/ctx_folder_file-1.vtt",
			originalFilename: "Planning 2026-03-04.vtt",
			userId: "user-1",
			organizationId: "org-1",
			metadata: {
				provider: "onedrive-folder",
				transcriptSource: "onedrive",
				meetingSubject: "Planning 2026-03-04",
				transcriptFolderId: "folder-1",
			},
		});
		// Read with the connector's own connection, never a shared one.
		expect(mocks.executeTool.mock.calls[0]?.[4]).toBe("conn-1");
	});

	it("reads nothing for someone who lost access while the file waited", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.canCreate.mockResolvedValue(false);

		expect(await importTranscriptFolderFile({ fileId: "file-1" })).toEqual({
			outcome: "waiting",
		});
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.recordRead.mock.calls[0]?.[0].error).toContain(
			"can no longer add context",
		);
	});

	it("waits for a reconnect when the connector has no Microsoft connection of their own", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.ownConnection.mockResolvedValue(null);

		expect(await importTranscriptFolderFile({ fileId: "file-1" })).toEqual({
			outcome: "waiting",
		});
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});

	it("does not copy a file twice when the step runs again", async () => {
		mocks.getFile.mockResolvedValue(
			folderFile({ status: "IMPORTING", contextId: "context-9" }),
		);

		const result = await importTranscriptFolderFile({ fileId: "file-1" });

		expect(result).toMatchObject({
			outcome: "ingest",
			contextId: "context-9",
		});
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.createFolderFileContext).not.toHaveBeenCalled();
	});

	it("skips a file that turns out too large, with the reason", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.executeTool.mockResolvedValue({
			status: "too_large",
			name: "x.vtt",
			size: 99_999_999,
		});

		expect(await importTranscriptFolderFile({ fileId: "file-1" })).toEqual({
			outcome: "done",
		});
		expect(mocks.setOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			status: "SKIPPED",
			reason: expect.stringContaining("Too large"),
		});
		expect(mocks.uploadFile).not.toHaveBeenCalled();
	});

	it("skips a file deleted since it was listed", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.executeTool.mockResolvedValue({ status: "gone" });

		await importTranscriptFolderFile({ fileId: "file-1" });

		expect(mocks.setOutcome.mock.calls[0]?.[0]).toMatchObject({
			status: "SKIPPED",
		});
	});

	it("leaves the file waiting, and the folder asking for a reconnect, when the connection fails", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.executeTool.mockRejectedValue(
			new Error("Microsoft not connected."),
		);

		expect(await importTranscriptFolderFile({ fileId: "file-1" })).toEqual({
			outcome: "waiting",
		});
		expect(mocks.setOutcome).not.toHaveBeenCalled();
		expect(mocks.recordRead.mock.calls[0]?.[0].error).toContain(
			"Reconnect the folder",
		);
	});

	it("lets any other failure throw, so the activity retries it", async () => {
		mocks.getFile.mockResolvedValue(folderFile());
		mocks.executeTool.mockRejectedValue(new Error("Graph 503"));

		await expect(
			importTranscriptFolderFile({ fileId: "file-1" }),
		).rejects.toThrow("Graph 503");
	});

	it("leaves a file of a disconnected folder waiting", async () => {
		mocks.getFile.mockResolvedValue(
			folderFile({
				folder: { ...folderFile().folder, disconnectedAt: new Date() },
			}),
		);

		expect(await importTranscriptFolderFile({ fileId: "file-1" })).toEqual({
			outcome: "waiting",
		});
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});
});

describe("recordTranscriptFolderFileOutcome", () => {
	it("marks a read file imported", async () => {
		mocks.getFile.mockResolvedValue(folderFile({ contextId: "context-1" }));
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "COMPLETED",
		});

		await recordTranscriptFolderFileOutcome({ fileId: "file-1" });

		expect(mocks.setOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			status: "IMPORTED",
		});
	});

	it("records a file the project already had as such, and removes the copy made for it", async () => {
		mocks.getFile.mockResolvedValue(folderFile({ contextId: "context-1" }));
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "FAILED",
			extractionError:
				"This file has already been added to this project.",
			s3Path: "projects/project-1/ctx_1.vtt",
			s3Bucket: "contexts",
		});

		await recordTranscriptFolderFileOutcome({ fileId: "file-1" });

		expect(mocks.setOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			status: "DUPLICATE",
			reason: "Already in this project.",
			clearContext: true,
		});
		expect(mocks.contextDeleteMany).toHaveBeenCalledWith({
			where: { id: "context-1", extractionStatus: "FAILED" },
		});
		expect(mocks.deleteFile).toHaveBeenCalledWith(
			"projects/project-1/ctx_1.vtt",
			{ bucket: "contexts" },
		);
	});

	it("keeps the reason a file could not be read", async () => {
		mocks.getFile.mockResolvedValue(folderFile({ contextId: "context-1" }));
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "FAILED",
			extractionError: "There is no text in this file.",
		});

		await recordTranscriptFolderFileOutcome({ fileId: "file-1" });

		expect(mocks.setOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			status: "FAILED",
			reason: "There is no text in this file.",
		});
		expect(mocks.contextDeleteMany).not.toHaveBeenCalled();
	});

	it("leaves a file still being read for the next pass", async () => {
		mocks.getFile.mockResolvedValue(folderFile({ contextId: "context-1" }));
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "EXTRACTING",
		});

		await recordTranscriptFolderFileOutcome({ fileId: "file-1" });

		expect(mocks.setOutcome).not.toHaveBeenCalled();
	});
});

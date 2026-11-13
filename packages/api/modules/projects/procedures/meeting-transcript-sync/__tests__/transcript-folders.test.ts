/**
 * Connecting OneDrive transcript folders (Fizzy #3507).
 *
 * Pinned here: the folder list comes from the caller's own OneDrive, a missing
 * Microsoft connection is a connect prompt rather than an error, a folder is
 * connected only once the caller can actually read it, connecting wakes the
 * project's sync at once, and the input never names a project's organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	connectFolders: vi.fn(),
	disconnectFolder: vi.fn(),
	listFolders: vi.fn(),
	executeTool: vi.fn(),
	signalWithStart: vi.fn(),
	ownConnection: vi.fn(),
	recordRead: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	connectTranscriptFolders: mocks.connectFolders,
	db: { project: { findUnique: mocks.projectFindUnique } },
	disconnectTranscriptFolder: mocks.disconnectFolder,
	listTranscriptFolders: mocks.listFolders,
	recordTranscriptFolderRead: mocks.recordRead,
	resolveOwnWorkflowIntegrationForProvider: mocks.ownConnection,
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.executeTool,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected"),
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { signalWithStart: mocks.signalWithStart },
	}),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const build = () => {
		const chain: Record<string, unknown> = {};
		for (const k of ["use", "route", "input"]) {
			chain[k] = () => chain;
		}
		chain.handler = (fn: unknown) => fn;
		return chain;
	};
	return {
		tenantProtectedProcedure: build(),
		requireProjectPermission: () => undefined,
		Permissions: {
			PROJECT_UPDATE: "project:update",
			PROJECT_READ: "project:read",
		},
	};
});

import {
	browseTranscriptFoldersProcedure,
	connectTranscriptFoldersProcedure,
	disconnectTranscriptFolderProcedure,
	listTranscriptFoldersProcedure,
} from "../transcript-folders";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const browse = browseTranscriptFoldersProcedure as unknown as Handler;
const connect = connectTranscriptFoldersProcedure as unknown as Handler;
const list = listTranscriptFoldersProcedure as unknown as Handler;
const disconnect = disconnectTranscriptFolderProcedure as unknown as Handler;

const CONTEXT = { user: { id: "user-1" }, session: {} };
const FOLDER = {
	driveId: "drive-1",
	itemId: "folder-1",
	name: "Transcripts",
	webUrl: "https://example-my.sharepoint.com/Transcripts",
};

function item(overrides: Record<string, unknown>) {
	return {
		id: "x",
		name: "x",
		driveId: "drive-1",
		isFolder: false,
		childCount: null,
		size: 10,
		webUrl: null,
		lastModified: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.connectFolders.mockResolvedValue([{ id: "f-1" }]);
	mocks.signalWithStart.mockResolvedValue({});
	mocks.executeTool.mockResolvedValue({ items: [], truncated: false });
	mocks.ownConnection.mockResolvedValue({ id: "conn-1" });
	mocks.recordRead.mockResolvedValue(undefined);
});

describe("browseFolders", () => {
	it("lists the folders of the caller's own OneDrive, and what this level would import", async () => {
		mocks.executeTool.mockResolvedValue({
			items: [
				item({
					id: "a",
					name: "Meetings",
					isFolder: true,
					childCount: 4,
				}),
				item({ id: "b", name: "Standup.vtt" }),
				item({ id: "c", name: "Deck.pptx" }),
			],
			truncated: false,
		});

		const result = await browse({
			input: { projectId: "project-1" },
			context: CONTEXT,
		});

		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_children",
			{ driveId: undefined, itemId: undefined, maxItems: 1000 },
			"user-1",
			"org-1",
			"conn-1",
		);
		expect(result).toEqual({
			folders: [
				{
					driveId: "drive-1",
					itemId: "a",
					name: "Meetings",
					childCount: 4,
					webUrl: null,
				},
			],
			transcriptFileCount: 1,
			truncated: false,
		});
	});

	it("answers a missing Microsoft connection with a connect prompt", async () => {
		mocks.executeTool.mockRejectedValue(
			new Error("Microsoft not connected."),
		);

		await expect(
			browse({ input: { projectId: "project-1" }, context: CONTEXT }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "MICROSOFT_NOT_CONNECTED" },
		});
	});

	it("refuses an organization that is not the project's", async () => {
		await expect(
			browse({
				input: { projectId: "project-1", organizationId: "org-2" },
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});
});

describe("connectFolders", () => {
	it("connects folders the caller can read, as the caller, and wakes the sync", async () => {
		const result = await connect({
			input: { projectId: "project-1", folders: [FOLDER] },
			context: CONTEXT,
		});

		expect(result).toEqual({ connected: 1, importStarted: true });
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_children",
			{ driveId: "drive-1", itemId: "folder-1", maxItems: 1 },
			"user-1",
			"org-1",
			"conn-1",
		);
		expect(mocks.connectFolders).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			folders: [FOLDER],
		});
		expect(mocks.signalWithStart).toHaveBeenCalledWith(
			"transcriptFolderSyncWorkflow",
			expect.objectContaining({
				workflowId: "transcript-folder-sync-project-1",
				args: [{ projectId: "project-1" }],
				signal: "syncTranscriptFoldersNow",
			}),
		);
	});

	it("connects nothing when one folder cannot be read", async () => {
		mocks.executeTool.mockRejectedValue(
			new Error("This folder no longer exists in OneDrive."),
		);

		await expect(
			connect({
				input: { projectId: "project-1", folders: [FOLDER] },
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
	});

	it("says so on the folder when importing could not be started, so Reconnect retries", async () => {
		mocks.signalWithStart.mockRejectedValue(new Error("Temporal down"));

		expect(
			await connect({
				input: { projectId: "project-1", folders: [FOLDER] },
				context: CONTEXT,
			}),
		).toEqual({ connected: 1, importStarted: false });
		expect(mocks.recordRead).toHaveBeenCalledWith({
			folderId: "f-1",
			error: "Importing could not be started. Reconnect the folder to try again.",
		});
	});

	it("never browses with a connection someone else shared", async () => {
		mocks.ownConnection.mockResolvedValue(null);

		await expect(
			browse({ input: { projectId: "project-1" }, context: CONTEXT }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "MICROSOFT_NOT_CONNECTED" },
		});
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.ownConnection).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
	});

	it("refuses an organization that is not the project's", async () => {
		await expect(
			connect({
				input: {
					projectId: "project-1",
					organizationId: "org-2",
					folders: [FOLDER],
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});
});

describe("listFolders and disconnectFolder", () => {
	it("lists the project's folders", async () => {
		mocks.listFolders.mockResolvedValue([{ id: "f-1" }]);

		expect(
			await list({ input: { projectId: "project-1" }, context: CONTEXT }),
		).toEqual({ folders: [{ id: "f-1" }] });
		expect(mocks.listFolders).toHaveBeenCalledWith("project-1");
	});

	it("disconnects a folder of this project", async () => {
		mocks.disconnectFolder.mockResolvedValue(true);

		expect(
			await disconnect({
				input: { projectId: "project-1", folderId: "f-1" },
				context: CONTEXT,
			}),
		).toEqual({ disconnected: true });
		expect(mocks.disconnectFolder).toHaveBeenCalledWith({
			projectId: "project-1",
			folderId: "f-1",
		});
	});

	it("says a folder of another project, or one already disconnected, is not found", async () => {
		mocks.disconnectFolder.mockResolvedValue(false);

		await expect(
			disconnect({
				input: { projectId: "project-1", folderId: "f-9" },
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

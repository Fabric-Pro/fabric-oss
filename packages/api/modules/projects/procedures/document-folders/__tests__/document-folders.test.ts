/**
 * OneDrive and SharePoint document folders (Fizzy #2808).
 *
 * Pinned here: every procedure answers NOT_FOUND while the feature is off and
 * refuses an organization that is not the project's; only listing is open to
 * viewers and guests, who get the reduced projection; folders are read through
 * the caller's own Microsoft connection, and what is stored about a folder
 * comes from Graph, not from the client; overlapping folders are refused by
 * name; every lifecycle change writes an audit row without the description's
 * text; and connecting, reconnecting, syncing and confirming removals wake the
 * project's sync with the project's organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class FolderConnectRefusedError extends Error {
		constructor(
			readonly reason: string,
			readonly folderName: string,
			readonly existingFolderName: string | null,
		) {
			super(reason);
		}
	}
	return {
		FolderConnectRefusedError,
		projectFindUnique: vi.fn(),
		folderFindFirst: vi.fn(),
		folderFindMany: vi.fn(),
		folderCount: vi.fn(),
		transcriptFindMany: vi.fn(),
		isFeatureEnabled: vi.fn(),
		connectFolders: vi.fn(),
		listFolders: vi.fn(),
		describeFolder: vi.fn(),
		disconnectFolder: vi.fn(),
		confirmRemovals: vi.fn(),
		finishRead: vi.fn(),
		ownConnection: vi.fn(),
		executeTool: vi.fn(),
		signalWithStart: vi.fn(),
		audit: vi.fn(),
		hasProjectPermission: vi.fn(),
	};
});

vi.mock("@repo/database", async (importOriginal) => ({
	// The real rule, so the picker counts the files an import would take.
	classifyDocumentFolderFile: (
		await importOriginal<typeof import("@repo/database")>()
	).classifyDocumentFolderFile,
	confirmDocumentFolderRemovals: mocks.confirmRemovals,
	connectDocumentFolders: mocks.connectFolders,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectDocumentFolder: {
			findFirst: mocks.folderFindFirst,
			findMany: mocks.folderFindMany,
			count: mocks.folderCount,
		},
		projectTranscriptFolder: { findMany: mocks.transcriptFindMany },
	},
	describeDocumentFolder: mocks.describeFolder,
	disconnectDocumentFolder: mocks.disconnectFolder,
	DOCUMENT_FOLDER_DESCRIPTION_MAX: 500,
	DOCUMENT_FOLDER_MAX_PER_PROJECT: 20,
	DOCUMENT_FOLDER_PROBLEM_CODE: { SYNC_START_FAILED: "SYNC_START_FAILED" },
	finishDocumentFolderRead: mocks.finishRead,
	FolderConnectRefusedError: mocks.FolderConnectRefusedError,
	isFeatureEnabled: mocks.isFeatureEnabled,
	listDocumentFolders: mocks.listFolders,
	resolveOwnWorkflowIntegrationForProvider: mocks.ownConnection,
}));

// The real path helper, from its own file: the whole Microsoft module would
// also load AI setup that the database mock above does not provide.
vi.mock("@repo/integrations/microsoft", async () => ({
	driveItemPath: (
		await vi.importActual<
			typeof import("../../../../../../integrations/src/microsoft/drive-folder")
		>("../../../../../../integrations/src/microsoft/drive-folder")
	).driveItemPath,
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

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
}));

/**
 * The procedure builder, reduced to what the tests read: each handler keeps
 * the permission its middleware asked for and its input schema.
 */
vi.mock("../../../../../orpc/procedures", () => {
	type State = { permission?: string; schema?: unknown };
	const chain = (state: State): Record<string, unknown> => ({
		use: (mw: { permission?: string } | undefined) =>
			chain({ ...state, permission: mw?.permission }),
		route: () => chain(state),
		input: (schema: unknown) => chain({ ...state, schema }),
		handler: (fn: object) => Object.assign(fn, state),
	});
	return {
		tenantProtectedProcedure: chain({}),
		requireProjectPermission: (permission: string) => ({ permission }),
		userHasProjectPermission: mocks.hasProjectPermission,
		Permissions: {
			PROJECT_UPDATE: "project:update",
			PROJECT_READ: "project:read",
		},
	};
});

import {
	browseDocumentFoldersProcedure,
	confirmDocumentFolderRemovalsProcedure,
	connectDocumentFoldersProcedure,
	disconnectDocumentFolderProcedure,
	listDocumentFoldersProcedure,
	reconnectDocumentFolderProcedure,
	syncDocumentFoldersNowProcedure,
	updateDocumentFolderDescriptionProcedure,
} from "..";

type Procedure = ((args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>) & {
	permission?: string;
	schema?: {
		safeParse: (value: unknown) => { success: boolean };
	};
};

const browse = browseDocumentFoldersProcedure as unknown as Procedure;
const connect = connectDocumentFoldersProcedure as unknown as Procedure;
const reconnect = reconnectDocumentFolderProcedure as unknown as Procedure;
const list = listDocumentFoldersProcedure as unknown as Procedure;
const describeFolder =
	updateDocumentFolderDescriptionProcedure as unknown as Procedure;
const syncNow = syncDocumentFoldersNowProcedure as unknown as Procedure;
const confirm = confirmDocumentFolderRemovalsProcedure as unknown as Procedure;
const disconnect = disconnectDocumentFolderProcedure as unknown as Procedure;

const ALL: Array<[string, Procedure, Record<string, unknown>]> = [
	["browse", browse, { level: { kind: "roots" } }],
	[
		"connect",
		connect,
		{ folders: [{ driveId: "drive-1", itemId: "folder-1" }] },
	],
	["reconnect", reconnect, { folderId: "f-1" }],
	["list", list, {}],
	[
		"updateDescription",
		describeFolder,
		{ folderId: "f-1", description: "x" },
	],
	["syncNow", syncNow, {}],
	["confirmRemovals", confirm, { folderId: "f-1", expectedCount: 70 }],
	["disconnect", disconnect, { folderId: "f-1" }],
];

const CONTEXT = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: {},
};

function call(
	procedure: Procedure,
	input: Record<string, unknown> = {},
	context: Record<string, unknown> = CONTEXT,
) {
	return procedure({ input: { projectId: "project-1", ...input }, context });
}

/** Answers Graph calls by method name; a function answers from the args. */
function graph(answers: Record<string, unknown>) {
	mocks.executeTool.mockImplementation(
		async (method: string, args: Record<string, unknown>) => {
			const answer = answers[method];
			if (typeof answer === "function") {
				return answer(args);
			}
			if (answer instanceof Error) {
				throw answer;
			}
			if (answer === undefined) {
				throw new Error(`unexpected Graph call ${method}`);
			}
			return answer;
		},
	);
}

function driveItem(overrides: Record<string, unknown> = {}) {
	return {
		status: "ok",
		item: {
			id: "folder-1",
			name: "Sales",
			driveId: "drive-1",
			driveType: "business",
			provider: "onedrive",
			isFolder: true,
			webUrl: "https://example-my.sharepoint.com/Sales",
			parentPath: "/",
			...overrides,
		},
	};
}

function auditRows(action: string) {
	return mocks.audit.mock.calls
		.map(([, row]) => row as Record<string, unknown>)
		.filter((row) => row.action === action);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.ownConnection.mockResolvedValue({ id: "conn-1" });
	mocks.signalWithStart.mockResolvedValue({});
	mocks.finishRead.mockResolvedValue(undefined);
	mocks.transcriptFindMany.mockResolvedValue([]);
	mocks.hasProjectPermission.mockResolvedValue(true);
	mocks.folderFindFirst.mockResolvedValue({
		id: "f-1",
		name: "Sales",
		driveId: "drive-1",
		itemId: "folder-1",
		siteId: null,
		siteName: null,
		heldRemovalCount: 70,
	});
	mocks.folderCount.mockResolvedValue(1);
});

describe("permissions and gating", () => {
	it("opens only listing to viewers and guests", () => {
		for (const [name, procedure] of ALL) {
			expect(procedure.permission, name).toBe(
				name === "list" ? "project:read" : "project:update",
			);
		}
	});

	it.each(ALL)(
		"%s answers NOT_FOUND while the feature is off",
		async (_name, procedure, input) => {
			mocks.isFeatureEnabled.mockResolvedValue(false);

			await expect(call(procedure, input)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
				"CLOUD_DRIVE_FOLDERS",
				"org-1",
			);
			expect(mocks.executeTool).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);

	it.each(ALL)(
		"%s answers NOT_FOUND for a project without an organization",
		async (_name, procedure, input) => {
			mocks.projectFindUnique.mockResolvedValue({
				id: "project-1",
				organizationId: null,
			});

			await expect(call(procedure, input)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		},
	);

	it.each(ALL)(
		"%s refuses an organization that is not the project's",
		async (_name, procedure, input) => {
			await expect(
				call(procedure, { ...input, organizationId: "org-2" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.executeTool).not.toHaveBeenCalled();
			expect(mocks.connectFolders).not.toHaveBeenCalled();
			expect(mocks.listFolders).not.toHaveBeenCalled();
			expect(mocks.signalWithStart).not.toHaveBeenCalled();
		},
	);
});

describe("list", () => {
	it("gives an editor the full projection", async () => {
		mocks.listFolders.mockResolvedValue([{ id: "f-1", readerUserId: "u" }]);

		expect(await call(list)).toEqual({
			view: "editor",
			folders: [{ id: "f-1", readerUserId: "u" }],
		});
		expect(mocks.hasProjectPermission).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			permission: "project:update",
		});
		expect(mocks.listFolders).toHaveBeenCalledWith({
			projectId: "project-1",
			view: "editor",
		});
	});

	it("gives a viewer or guest the reduced projection", async () => {
		mocks.hasProjectPermission.mockResolvedValue(false);
		mocks.listFolders.mockResolvedValue([{ id: "f-1" }]);

		expect(await call(list)).toEqual({
			view: "viewer",
			folders: [{ id: "f-1" }],
		});
		expect(mocks.listFolders).toHaveBeenCalledWith({
			projectId: "project-1",
			view: "viewer",
		});
	});
});

describe("updateDescription", () => {
	it("stores the description and audits that it changed, never its text", async () => {
		mocks.describeFolder.mockResolvedValue({
			name: "Sales",
			previous: null,
			description: "Signed customer case studies",
		});

		expect(
			await call(describeFolder, {
				folderId: "f-1",
				description: "Signed customer\ncase studies",
			}),
		).toEqual({ description: "Signed customer case studies" });
		expect(mocks.describeFolder).toHaveBeenCalledWith({
			projectId: "project-1",
			folderId: "f-1",
			description: "Signed customer\ncase studies",
		});
		const [row] = auditRows("project.document_folder.updated");
		expect(row).toMatchObject({
			organizationId: "org-1",
			projectId: "project-1",
			resource: {
				type: "project_document_folder",
				id: "f-1",
				name: "Sales",
			},
			metadata: { descriptionSet: true, previouslySet: false },
		});
		expect(JSON.stringify(row)).not.toContain("case studies");
	});

	it("refuses a description over 500 characters", () => {
		const schema = describeFolder.schema;
		expect(
			schema?.safeParse({
				projectId: "project-1",
				folderId: "f-1",
				description: "x".repeat(501),
			}).success,
		).toBe(false);
		expect(
			schema?.safeParse({
				projectId: "project-1",
				folderId: "f-1",
				description: "x".repeat(500),
			}).success,
		).toBe(true);
		expect(
			schema?.safeParse({
				projectId: "project-1",
				folderId: "f-1",
				description: null,
			}).success,
		).toBe(true);
	});

	it("says a folder of another project, or a disconnected one, is not found", async () => {
		mocks.describeFolder.mockResolvedValue(null);

		await expect(
			call(describeFolder, { folderId: "f-9", description: "x" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("disconnect", () => {
	it("stops reading the folder, keeps its files, and audits it", async () => {
		mocks.disconnectFolder.mockResolvedValue({ name: "Sales" });

		expect(await call(disconnect, { folderId: "f-1" })).toEqual({
			disconnected: true,
		});
		expect(mocks.disconnectFolder).toHaveBeenCalledWith({
			projectId: "project-1",
			folderId: "f-1",
		});
		expect(auditRows("project.document_folder.disconnected")).toEqual([
			expect.objectContaining({
				organizationId: "org-1",
				projectId: "project-1",
				resource: {
					type: "project_document_folder",
					id: "f-1",
					name: "Sales",
				},
			}),
		]);
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
	});

	it("says a folder of another project, or one already disconnected, is not found", async () => {
		mocks.disconnectFolder.mockResolvedValue(null);

		await expect(
			call(disconnect, { folderId: "f-9" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("connect", () => {
	beforeEach(() => {
		graph({ get_drive_item: driveItem() });
		mocks.connectFolders.mockResolvedValue([
			{
				folderId: "f-1",
				driveId: "drive-1",
				itemId: "folder-1",
				name: "Sales",
				reconnected: false,
				previousUserId: null,
				readerEpoch: 0,
			},
		]);
	});

	it("connects a folder the caller can read, as described by Graph, audits it and wakes the sync", async () => {
		const result = await call(connect, {
			folders: [
				{
					driveId: "drive-1",
					itemId: "folder-1",
					description: "Signed customer case studies",
				},
			],
		});

		expect(result).toEqual({
			folders: [{ folderId: "f-1", name: "Sales", reconnected: false }],
			importStarted: true,
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"get_drive_item",
			{ driveId: "drive-1", itemId: "folder-1" },
			"user-1",
			"org-1",
			"conn-1",
		);
		expect(mocks.connectFolders).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			folders: [
				{
					provider: "onedrive",
					driveId: "drive-1",
					itemId: "folder-1",
					name: "Sales",
					webUrl: "https://example-my.sharepoint.com/Sales",
					drivePath: "/Sales",
					siteId: null,
					siteName: null,
					libraryName: null,
					description: "Signed customer case studies",
				},
			],
			transcriptFolderPaths: [],
		});
		const rows = auditRows("project.document_folder.connected");
		expect(rows).toEqual([
			expect.objectContaining({
				organizationId: "org-1",
				projectId: "project-1",
				resource: {
					type: "project_document_folder",
					id: "f-1",
					name: "Sales",
				},
				metadata: { provider: "onedrive", hasDescription: true },
			}),
		]);
		expect(JSON.stringify(rows)).not.toContain("case studies");
		expect(mocks.signalWithStart).toHaveBeenCalledWith(
			"documentFolderSyncWorkflow",
			{
				taskQueue: "project-documents",
				workflowId: "document-folder-sync-project-1",
				args: [{ projectId: "project-1", organizationId: "org-1" }],
				signal: "syncDocumentFoldersNow",
				signalArgs: [],
			},
		);
	});

	it("stores a library root under its real id, with the library and site Graph names", async () => {
		graph({
			get_drive_item: driveItem({
				id: "root-id",
				name: "root",
				driveId: "lib-1",
				driveType: "documentLibrary",
				provider: "sharepoint",
				parentPath: null,
			}),
			list_sharepoint_site_drives: {
				status: "ok",
				drives: [
					{
						id: "lib-1",
						name: "Documents",
						driveType: "documentLibrary",
						provider: "sharepoint",
						webUrl: null,
					},
				],
			},
			search_sharepoint_sites: {
				status: "ok",
				sites: [
					{ id: "site-9", name: "Marketing Archive", webUrl: null },
					{ id: "site-1", name: "Marketing Team", webUrl: null },
				],
			},
		});

		await call(connect, {
			folders: [
				{
					driveId: "lib-1",
					itemId: "root",
					siteId: "site-1",
					siteName: "Marketing",
				},
			],
		});

		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_sharepoint_site_drives",
			{ siteId: "site-1" },
			"user-1",
			"org-1",
			"conn-1",
		);
		expect(mocks.connectFolders.mock.calls[0][0].folders).toEqual([
			expect.objectContaining({
				provider: "sharepoint",
				driveId: "lib-1",
				itemId: "root-id",
				name: "Documents",
				drivePath: "/",
				siteId: "site-1",
				siteName: "Marketing Team",
				libraryName: "Documents",
			}),
		]);
	});

	it("leaves the site unnamed when Graph's search does not find it", async () => {
		graph({
			get_drive_item: driveItem({
				driveId: "lib-1",
				driveType: "documentLibrary",
				provider: "sharepoint",
				parentPath: "/Plans",
			}),
			list_sharepoint_site_drives: {
				status: "ok",
				drives: [{ id: "lib-1", name: "Documents" }],
			},
			search_sharepoint_sites: { status: "ok", sites: [] },
		});

		await call(connect, {
			folders: [
				{
					driveId: "lib-1",
					itemId: "folder-1",
					siteId: "site-1",
					siteName: "Made up",
				},
			],
		});

		expect(mocks.connectFolders.mock.calls[0][0].folders).toEqual([
			expect.objectContaining({
				drivePath: "/Plans/Sales",
				siteId: "site-1",
				siteName: null,
				libraryName: "Documents",
			}),
		]);
	});

	it("refuses a SharePoint folder whose library is not in the named site", async () => {
		graph({
			get_drive_item: driveItem({
				driveId: "lib-1",
				driveType: "documentLibrary",
				provider: "sharepoint",
			}),
			list_sharepoint_site_drives: {
				status: "ok",
				drives: [{ id: "lib-2", name: "Other" }],
			},
		});

		await expect(
			call(connect, {
				folders: [
					{ driveId: "lib-1", itemId: "folder-1", siteId: "site-1" },
				],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});

	it("refuses a SharePoint folder chosen without its site", async () => {
		graph({
			get_drive_item: driveItem({
				driveType: "documentLibrary",
				provider: "sharepoint",
			}),
		});

		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});

	it("answers a caller without a Microsoft connection of their own with a connect prompt", async () => {
		mocks.ownConnection.mockResolvedValue(null);

		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "MICROSOFT_NOT_CONNECTED" },
		});
		expect(mocks.ownConnection).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});

	it("answers a revoked connection with a connect prompt", async () => {
		graph({ get_drive_item: new Error("Microsoft not connected.") });

		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "MICROSOFT_NOT_CONNECTED" },
		});
	});

	it("connects nothing when one folder cannot be read", async () => {
		graph({
			get_drive_item: ({ itemId }: { itemId: string }) =>
				itemId === "folder-2"
					? {
							status: "failed",
							httpStatus: 404,
							retryAfterSeconds: null,
						}
					: driveItem(),
		});

		await expect(
			call(connect, {
				folders: [
					{ driveId: "drive-1", itemId: "folder-1" },
					{ driveId: "drive-1", itemId: "folder-2" },
				],
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { driveId: "drive-1", itemId: "folder-2" },
		});
		expect(mocks.connectFolders).not.toHaveBeenCalled();
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("answers a Graph read that fails outright with try-again, not Graph's words", async () => {
		graph({
			get_drive_item: new Error(
				"Microsoft Graph API error while reading the item: 500 internalError",
			),
		});

		const failed = call(connect, {
			folders: [{ driveId: "drive-1", itemId: "folder-1" }],
		});
		await expect(failed).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		await expect(failed).rejects.not.toThrow(/internalError/);
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});

	it("refuses a file, or an item in no OneDrive or SharePoint drive", async () => {
		graph({ get_drive_item: driveItem({ isFolder: false }) });
		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		graph({
			get_drive_item: driveItem({ driveType: null, provider: null }),
		});
		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});

	it("says so on the folders when the sync could not be started, and still returns them", async () => {
		mocks.signalWithStart.mockRejectedValue(new Error("Temporal down"));

		expect(
			await call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).toEqual({
			folders: [{ folderId: "f-1", name: "Sales", reconnected: false }],
			importStarted: false,
		});
		// At the epoch the connect returned, so a later reconnect's state
		// is not overwritten.
		expect(mocks.finishRead).toHaveBeenCalledWith({
			folderId: "f-1",
			readerEpoch: 0,
			problemCode: "SYNC_START_FAILED",
		});
	});

	it("refuses a folder inside a connected document folder, naming it", async () => {
		mocks.connectFolders.mockRejectedValue(
			new mocks.FolderConnectRefusedError(
				"OVERLAPS_DOCUMENT_FOLDER",
				"Case studies",
				"Sales",
			),
		);

		const refused = call(connect, {
			folders: [{ driveId: "drive-1", itemId: "folder-1" }],
		});

		await expect(refused).rejects.toMatchObject({
			code: "CONFLICT",
			data: {
				code: "OVERLAPS_DOCUMENT_FOLDER",
				existingFolderName: "Sales",
			},
		});
		await expect(refused).rejects.toThrow(/"Sales"/);
		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
	});

	it("checks connected transcript folders in the same drive by their Graph paths", async () => {
		mocks.transcriptFindMany.mockResolvedValue([
			{ driveId: "drive-1", itemId: "t-1" },
		]);
		graph({
			get_drive_item: ({ itemId }: { itemId: string }) =>
				itemId === "t-1"
					? driveItem({
							id: "t-1",
							name: "Transcripts",
							parentPath: "/Sales",
						})
					: driveItem(),
		});
		mocks.connectFolders.mockRejectedValue(
			new mocks.FolderConnectRefusedError(
				"OVERLAPS_TRANSCRIPT_FOLDER",
				"Sales",
				"Transcripts",
			),
		);

		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "OVERLAPS_TRANSCRIPT_FOLDER" },
		});
		expect(mocks.transcriptFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				disconnectedAt: null,
				driveId: { in: ["drive-1"] },
			},
			select: { driveId: true, itemId: true },
		});
		expect(
			mocks.connectFolders.mock.calls[0][0].transcriptFolderPaths,
		).toEqual([
			{
				driveId: "drive-1",
				itemId: "t-1",
				drivePath: "/Sales/Transcripts",
			},
		]);
	});

	it("lets a transcript folder gone from the drive pass, and refuses one it cannot check", async () => {
		mocks.transcriptFindMany.mockResolvedValue([
			{ driveId: "drive-1", itemId: "t-1" },
		]);
		const transcriptAnswer = { status: "failed", httpStatus: 404 };
		graph({
			get_drive_item: ({ itemId }: { itemId: string }) =>
				itemId === "t-1" ? transcriptAnswer : driveItem(),
		});

		await call(connect, {
			folders: [{ driveId: "drive-1", itemId: "folder-1" }],
		});
		expect(
			mocks.connectFolders.mock.calls[0][0].transcriptFolderPaths,
		).toEqual([]);

		mocks.connectFolders.mockClear();
		transcriptAnswer.httpStatus = 503;
		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});

	it("refuses the folder past the project's limit, and more than 20 in one call", async () => {
		mocks.connectFolders.mockRejectedValue(
			new mocks.FolderConnectRefusedError(
				"TOO_MANY_FOLDERS",
				"Sales",
				null,
			),
		);

		await expect(
			call(connect, {
				folders: [{ driveId: "drive-1", itemId: "folder-1" }],
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "TOO_MANY_FOLDERS" },
		});

		const folders = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				driveId: "drive-1",
				itemId: `folder-${i}`,
			}));
		expect(
			connect.schema?.safeParse({
				projectId: "project-1",
				folders: folders(21),
			}).success,
		).toBe(false);
		expect(
			connect.schema?.safeParse({
				projectId: "project-1",
				folders: folders(20),
			}).success,
		).toBe(true);
		expect(
			connect.schema?.safeParse({
				projectId: "project-1",
				folders: [
					{
						driveId: "drive-1",
						itemId: "folder-1",
						description: "x".repeat(501),
					},
				],
			}).success,
		).toBe(false);
	});

	it("audits connecting a connected folder again as a reconnect, with both readers", async () => {
		mocks.connectFolders.mockResolvedValue([
			{
				folderId: "f-1",
				driveId: "drive-1",
				itemId: "folder-1",
				name: "Sales",
				reconnected: true,
				previousUserId: "user-0",
				readerEpoch: 4,
			},
		]);

		await call(connect, {
			folders: [{ driveId: "drive-1", itemId: "folder-1" }],
		});

		expect(auditRows("project.document_folder.connected")).toEqual([]);
		expect(auditRows("project.document_folder.reconnected")).toEqual([
			expect.objectContaining({
				metadata: {
					provider: "onedrive",
					previousReaderId: "user-0",
					readerId: "user-1",
				},
			}),
		]);
	});
});

describe("reconnect", () => {
	beforeEach(() => {
		graph({ get_drive_item: driveItem() });
		mocks.connectFolders.mockResolvedValue([
			{
				folderId: "f-1",
				driveId: "drive-1",
				itemId: "folder-1",
				name: "Sales",
				reconnected: true,
				previousUserId: "user-0",
				readerEpoch: 4,
			},
		]);
	});

	it("makes the caller the reader, keeps the description, audits both readers and wakes the sync", async () => {
		expect(await call(reconnect, { folderId: "f-1" })).toEqual({
			folderId: "f-1",
			importStarted: true,
		});
		expect(mocks.folderFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "f-1",
					projectId: "project-1",
					disconnectedAt: null,
				},
			}),
		);
		const params = mocks.connectFolders.mock.calls[0][0];
		expect(params).toMatchObject({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(params.folders).toHaveLength(1);
		expect(params.folders[0]).toMatchObject({
			driveId: "drive-1",
			itemId: "folder-1",
			provider: "onedrive",
		});
		expect(params.folders[0]).not.toHaveProperty("description");
		expect(auditRows("project.document_folder.reconnected")).toEqual([
			expect.objectContaining({
				resource: {
					type: "project_document_folder",
					id: "f-1",
					name: "Sales",
				},
				metadata: {
					provider: "onedrive",
					previousReaderId: "user-0",
					readerId: "user-1",
				},
			}),
		]);
		expect(mocks.signalWithStart).toHaveBeenCalledTimes(1);
	});

	it("reconnects the stored folder even when Graph spells its ids differently", async () => {
		graph({
			get_drive_item: driveItem({ id: "FOLDER-1", driveId: "DRIVE-1" }),
		});

		await call(reconnect, { folderId: "f-1" });

		expect(mocks.connectFolders.mock.calls[0][0].folders[0]).toMatchObject({
			driveId: "drive-1",
			itemId: "folder-1",
		});
	});

	it("says a folder that is not connected to this project is not found", async () => {
		mocks.folderFindFirst.mockResolvedValue(null);

		await expect(
			call(reconnect, { folderId: "f-9" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.connectFolders).not.toHaveBeenCalled();
	});

	it("records the problem when the sync could not be started", async () => {
		mocks.signalWithStart.mockRejectedValue(new Error("Temporal down"));

		expect(await call(reconnect, { folderId: "f-1" })).toEqual({
			folderId: "f-1",
			importStarted: false,
		});
		expect(mocks.finishRead).toHaveBeenCalledWith({
			folderId: "f-1",
			readerEpoch: 4,
			problemCode: "SYNC_START_FAILED",
		});
	});
});

describe("syncNow", () => {
	it("wakes the sync, starting it when it had ended", async () => {
		expect(await call(syncNow)).toEqual({ syncStarted: true });
		expect(mocks.folderCount).toHaveBeenCalledWith({
			where: { projectId: "project-1", disconnectedAt: null },
		});
		expect(mocks.signalWithStart).toHaveBeenCalledWith(
			"documentFolderSyncWorkflow",
			expect.objectContaining({
				workflowId: "document-folder-sync-project-1",
				args: [{ projectId: "project-1", organizationId: "org-1" }],
				signal: "syncDocumentFoldersNow",
			}),
		);
	});

	it("says there is nothing to sync when no folder is connected", async () => {
		mocks.folderCount.mockResolvedValue(0);

		await expect(call(syncNow)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
	});

	it("says the sync could not be reached, without touching the folders", async () => {
		mocks.signalWithStart.mockRejectedValue(new Error("Temporal down"));

		await expect(call(syncNow)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(mocks.finishRead).not.toHaveBeenCalled();
	});
});

describe("confirmRemovals", () => {
	it("confirms held removals, audits them before waking the sync", async () => {
		mocks.confirmRemovals.mockResolvedValue({
			status: "confirmed",
			retired: 70,
		});

		expect(
			await call(confirm, { folderId: "f-1", expectedCount: 70 }),
		).toEqual({
			status: "confirmed",
			retired: 70,
			syncStarted: true,
		});
		expect(mocks.confirmRemovals).toHaveBeenCalledWith({
			projectId: "project-1",
			folderId: "f-1",
			expectedCount: 70,
		});
		const [row] = auditRows("project.document_folder.removals_confirmed");
		expect(row).toMatchObject({
			organizationId: "org-1",
			projectId: "project-1",
			resource: {
				type: "project_document_folder",
				id: "f-1",
				name: "Sales",
			},
			metadata: { heldRemovalCount: 70, retiredCount: 70 },
		});
		expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.signalWithStart.mock.invocationCallOrder[0],
		);
	});

	it("audits and wakes nothing when nothing is held", async () => {
		mocks.confirmRemovals.mockResolvedValue({ status: "nothing_held" });

		expect(
			await call(confirm, { folderId: "f-1", expectedCount: 70 }),
		).toEqual({
			status: "nothing_held",
		});
		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
	});

	it("removes, audits and wakes nothing when the held count changed, and returns the new count", async () => {
		mocks.confirmRemovals.mockResolvedValue({
			status: "stale",
			heldRemovalCount: 64,
		});

		expect(
			await call(confirm, { folderId: "f-1", expectedCount: 70 }),
		).toEqual({ status: "stale", heldRemovalCount: 64 });
		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.signalWithStart).not.toHaveBeenCalled();
	});

	it("takes the held count the editor saw as a whole number of files", () => {
		const parse = (input: Record<string, unknown>) =>
			confirm.schema?.safeParse({
				projectId: "project-1",
				folderId: "f-1",
				...input,
			}).success;

		expect(parse({ expectedCount: 70 })).toBe(true);
		expect(parse({ expectedCount: 0 })).toBe(true);
		expect(parse({})).toBe(false);
		expect(parse({ expectedCount: -1 })).toBe(false);
		expect(parse({ expectedCount: 1.5 })).toBe(false);
	});

	it("says a folder that is not connected to this project is not found", async () => {
		mocks.folderFindFirst.mockResolvedValue(null);

		await expect(
			call(confirm, { folderId: "f-9", expectedCount: 70 }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.folderFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "f-9",
					projectId: "project-1",
					disconnectedAt: null,
				},
			}),
		);
		expect(mocks.confirmRemovals).not.toHaveBeenCalled();
	});

	it("keeps the confirmation when the sync could not be woken, and says so", async () => {
		mocks.confirmRemovals.mockResolvedValue({
			status: "confirmed",
			retired: 70,
		});
		mocks.signalWithStart.mockRejectedValue(new Error("Temporal down"));

		expect(
			await call(confirm, { folderId: "f-1", expectedCount: 70 }),
		).toEqual({
			status: "confirmed",
			retired: 70,
			syncStarted: false,
		});
		expect(mocks.finishRead).not.toHaveBeenCalled();
	});
});

describe("browse", () => {
	const SITE = {
		id: "site-1",
		name: "Marketing",
		webUrl: "https://example.sharepoint.com/sites/marketing",
	};

	function file(overrides: Record<string, unknown>) {
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

	it("offers My OneDrive and the SharePoint sites the caller follows", async () => {
		graph({
			list_followed_sharepoint_sites: { status: "ok", sites: [SITE] },
		});

		expect(await call(browse, { level: { kind: "roots" } })).toEqual({
			level: "roots",
			oneDrive: { status: "available" },
			sharePoint: {
				status: "available",
				followedSites: [
					{
						siteId: "site-1",
						name: "Marketing",
						webUrl: "https://example.sharepoint.com/sites/marketing",
					},
				],
			},
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_followed_sharepoint_sites",
			{},
			"user-1",
			"org-1",
			"conn-1",
		);
	});

	it("says SharePoint is unavailable for a personal account, keeping My OneDrive", async () => {
		graph({ list_followed_sharepoint_sites: { status: "unavailable" } });

		expect(await call(browse, { level: { kind: "roots" } })).toEqual({
			level: "roots",
			oneDrive: { status: "available" },
			sharePoint: { status: "unavailable" },
		});
	});

	it("fails only the SharePoint root when the followed sites cannot be read", async () => {
		graph({ list_followed_sharepoint_sites: new Error("socket hang up") });

		expect(await call(browse, { level: { kind: "roots" } })).toEqual({
			level: "roots",
			oneDrive: { status: "available" },
			sharePoint: { status: "error" },
		});
	});

	it("answers a revoked connection with a connect prompt, and a missing one before any Graph call", async () => {
		graph({
			list_followed_sharepoint_sites: new Error(
				"Microsoft not connected.",
			),
		});
		await expect(
			call(browse, { level: { kind: "roots" } }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "MICROSOFT_NOT_CONNECTED" },
		});

		mocks.executeTool.mockClear();
		mocks.ownConnection.mockResolvedValue(null);
		await expect(
			call(browse, { level: { kind: "folders" } }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});

	it("searches SharePoint sites", async () => {
		graph({ search_sharepoint_sites: { status: "ok", sites: [SITE] } });

		expect(
			await call(browse, { level: { kind: "sites", search: "market" } }),
		).toEqual({
			level: "sites",
			status: "available",
			sites: [
				{
					siteId: "site-1",
					name: "Marketing",
					webUrl: "https://example.sharepoint.com/sites/marketing",
				},
			],
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"search_sharepoint_sites",
			{ query: "market" },
			"user-1",
			"org-1",
			"conn-1",
		);

		graph({ search_sharepoint_sites: { status: "unavailable" } });
		expect(
			await call(browse, { level: { kind: "sites", search: "market" } }),
		).toEqual({ level: "sites", status: "unavailable" });
	});

	it("lists a site's document libraries", async () => {
		graph({
			list_sharepoint_site_drives: {
				status: "ok",
				drives: [
					{
						id: "lib-1",
						name: "Documents",
						driveType: "documentLibrary",
						provider: "sharepoint",
						webUrl: "https://example.sharepoint.com/sites/marketing/Shared%20Documents",
					},
					{
						id: "other",
						name: "Personal",
						driveType: "business",
						provider: "onedrive",
						webUrl: null,
					},
				],
			},
		});

		expect(
			await call(browse, { level: { kind: "drives", siteId: "site-1" } }),
		).toEqual({
			level: "drives",
			siteId: "site-1",
			status: "available",
			libraries: [
				{
					driveId: "lib-1",
					name: "Documents",
					webUrl: "https://example.sharepoint.com/sites/marketing/Shared%20Documents",
				},
			],
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_sharepoint_site_drives",
			{ siteId: "site-1" },
			"user-1",
			"org-1",
			"conn-1",
		);
	});

	it("lists the folders of My OneDrive with what this level would import", async () => {
		graph({
			list_drive_children: {
				items: [
					file({
						id: "a",
						name: "Sales",
						isFolder: true,
						childCount: 4,
						webUrl: "https://example-my.sharepoint.com/Sales",
						size: null,
					}),
					file({ id: "b", name: "Plan.pdf" }),
					file({ id: "c", name: "Notes.docx" }),
					file({ id: "d", name: "Deck.pptx" }),
					file({
						id: "e",
						name: "Photo.png",
						size: 15 * 1024 * 1024,
					}),
				],
				truncated: false,
			},
		});

		expect(await call(browse, { level: { kind: "folders" } })).toEqual({
			level: "folders",
			driveId: null,
			itemId: null,
			folders: [
				{
					driveId: "drive-1",
					itemId: "a",
					name: "Sales",
					childCount: 4,
					webUrl: "https://example-my.sharepoint.com/Sales",
				},
			],
			supportedFileCount: 2,
			truncated: false,
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_children",
			{ driveId: undefined, itemId: undefined, maxItems: 1000 },
			"user-1",
			"org-1",
			"conn-1",
		);
	});

	it("opens a library at its root", async () => {
		graph({ list_drive_children: { items: [], truncated: false } });

		await call(browse, { level: { kind: "folders", driveId: "lib-1" } });

		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_children",
			{ driveId: "lib-1", itemId: "root", maxItems: 1000 },
			"user-1",
			"org-1",
			"conn-1",
		);
	});

	it("refuses a folder named without its drive", async () => {
		await expect(
			call(browse, { level: { kind: "folders", itemId: "a" } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});

	it("answers a folder Graph cannot read without Graph's own words", async () => {
		graph({
			list_drive_children: new Error(
				"Microsoft Graph API error while listing the folder: 500 internalError",
			),
		});

		const failed = call(browse, {
			level: { kind: "folders", driveId: "drive-1", itemId: "a" },
		});
		await expect(failed).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		await expect(failed).rejects.not.toThrow(/internalError/);
	});

	it("accepts only the known levels, and a site search with words in it", () => {
		const parse = (level: unknown) =>
			browse.schema?.safeParse({ projectId: "project-1", level }).success;
		expect(parse({ kind: "roots" })).toBe(true);
		expect(parse({ kind: "sites", search: "market" })).toBe(true);
		expect(parse({ kind: "sites", search: "  " })).toBe(false);
		expect(parse({ kind: "drives" })).toBe(false);
		expect(parse({ kind: "shared" })).toBe(false);
	});
});

/**
 * Reading, confirming, deleting and importing OneDrive, SharePoint and
 * Google Drive document folders (Fizzy #2808).
 *
 * What these pin: a folder is read only with its reader's own connection,
 * while the feature is on, the reader may still add context and the project's
 * organization is the folder's; a read that fails, is refused or truncated
 * removes nothing and says why; a removal needs every candidate's lookup; a
 * context is released only after its vectors, row and stored copy are gone;
 * and an import claims nothing once the folder is disconnected.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canCreate: vi.fn(),
	claim: vi.fn(),
	complete: vi.fn(),
	createContext: vi.fn(),
	finishRead: vi.fn(),
	getFile: vi.fn(),
	isFeatureEnabled: vi.fn(),
	listNeedingDeletion: vi.fn(),
	syncState: vi.fn(),
	listPending: vi.fn(),
	reconcile: vi.fn(),
	recordOutcome: vi.fn(),
	lookupsThrottled: vi.fn(),
	ownConnection: vi.fn(),
	startRead: vi.fn(),
	tombstone: vi.fn(),
	projectFindUnique: vi.fn(),
	folderFindUnique: vi.fn(),
	folderFindMany: vi.fn(),
	fileFindFirst: vi.fn(),
	fileFindUnique: vi.fn(),
	contextFindUnique: vi.fn(),
	executeTool: vi.fn(),
	deleteProjectContext: vi.fn(),
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
	googleHasScope: vi.fn(),
	googleDetails: vi.fn(),
	googleTree: vi.fn(),
	googleLookup: vi.fn(),
	googleDownload: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canCreateProjectContexts: mocks.canCreate,
	claimDocumentFolderFile: mocks.claim,
	completeDocumentFolderFileDeletion: mocks.complete,
	createDocumentFolderFileContext: mocks.createContext,
	DOCUMENT_FOLDER_DELETIONS_PER_PASS: 200,
	DOCUMENT_FOLDER_FAILURE_CODE: {
		DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
		PROCESSING_FAILED: "PROCESSING_FAILED",
	},
	DOCUMENT_FOLDER_FILE_STATUS: {
		PENDING: "PENDING",
		IMPORTING: "IMPORTING",
		IMPORTED: "IMPORTED",
		SKIPPED: "SKIPPED",
		FAILED: "FAILED",
		EXCLUDED: "EXCLUDED",
		REFRESHING: "REFRESHING",
	},
	DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE: {
		TOO_LARGE: "TOO_LARGE",
		THROTTLED: "THROTTLED",
		PARTIAL_READ: "PARTIAL_READ",
		MASS_REMOVAL: "MASS_REMOVAL",
	},
	DOCUMENT_FOLDER_PROBLEM_CODE: {
		RECONNECT: "RECONNECT",
		NO_ACCESS: "NO_ACCESS",
		FOLDER_GONE: "FOLDER_GONE",
		SYNC_START_FAILED: "SYNC_START_FAILED",
	},
	DOCUMENT_FOLDER_SKIP_CODE: {
		UNSUPPORTED: "UNSUPPORTED",
		TOO_BIG: "TOO_BIG",
		CAP_REACHED: "CAP_REACHED",
		NOT_DOWNLOADABLE: "NOT_DOWNLOADABLE",
	},
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectDocumentFolder: {
			findUnique: mocks.folderFindUnique,
			findMany: mocks.folderFindMany,
		},
		projectDocumentFolderFile: {
			findFirst: mocks.fileFindFirst,
			findUnique: mocks.fileFindUnique,
		},
		projectContext: { findUnique: mocks.contextFindUnique },
	},
	finishDocumentFolderRead: mocks.finishRead,
	getDocumentFolderFileForImport: mocks.getFile,
	isFeatureEnabled: mocks.isFeatureEnabled,
	listDocumentFolderFilesNeedingDeletion: mocks.listNeedingDeletion,
	listDocumentFolderSyncState: mocks.syncState,
	listPendingDocumentFolderFileIds: mocks.listPending,
	reconcileDocumentFolderListing: mocks.reconcile,
	recordDocumentFolderFileOutcome: mocks.recordOutcome,
	recordDocumentFolderLookupsThrottled: mocks.lookupsThrottled,
	resolveOwnWorkflowIntegrationForProvider: mocks.ownConnection,
	startDocumentFolderRead: mocks.startRead,
	tombstoneDocumentFolderFiles: mocks.tombstone,
}));

// The real path helper, from its own file: the whole Microsoft module would
// also load AI setup that the database mock above does not provide.
vi.mock("@repo/integrations/microsoft", async () => ({
	driveItemPath: (
		await vi.importActual<
			typeof import("../../../../integrations/src/microsoft/drive-folder")
		>("../../../../integrations/src/microsoft/drive-folder")
	).driveItemPath,
	executeMicrosoftTeamsTool: mocks.executeTool,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected"),
}));

// Google Drive's reads and the stored grant, below the real Google adapter.
vi.mock("@repo/integrations/google", async () => ({
	...(await vi.importActual<
		typeof import("../../../../integrations/src/google/connection-errors")
	>("../../../../integrations/src/google/connection-errors")),
	getGoogleDriveAccessToken: vi.fn(async () => "token"),
	hasGoogleDriveReadonlyScope: mocks.googleHasScope,
}));

vi.mock("../../../../integrations/src/google/drive-folder", () => ({
	getGoogleDriveItemDetails: mocks.googleDetails,
	listGoogleDriveFolderTree: mocks.googleTree,
	lookupGoogleDriveItemsInFolder: mocks.googleLookup,
	downloadGoogleDriveFile: mocks.googleDownload,
	listGoogleDriveFolderChildren: vi.fn(),
	listGoogleDrivePlaces: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	deleteProjectContext: mocks.deleteProjectContext,
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

import {
	confirmDocumentFolderCandidates,
	finishDocumentFolderContextDeletion,
	importDocumentFolderFile,
	listDocumentFolderDeletions,
	listDocumentFolderImports,
	listDocumentFoldersToSync,
	markDocumentFolderFileDownloadFailed,
	readDocumentFolder,
	recordDocumentFolderFileProcessing,
} from "../document-folder-sync";

const FOLDER = {
	id: "folder-1",
	projectId: "project-1",
	provider: "onedrive",
	driveId: "drive-1",
	itemId: "item-1",
	name: "Specs",
	drivePath: "/Specs",
	userId: "user-1",
	organizationId: "org-1",
	readerEpoch: 3,
};

const ROOT = {
	status: "ok",
	item: {
		id: "item-1",
		name: "Specs v2",
		driveId: "drive-1",
		driveType: "business",
		provider: "onedrive",
		isFolder: true,
		webUrl: "https://example.com/specs",
		parentPath: "/Team",
	},
};

const TREE_FILE = {
	id: "drive-item-1",
	name: "plan.pdf",
	relativePath: "sub/plan.pdf",
	size: 100,
	mimeType: "application/pdf",
	quickXorHash: "abc+/=",
	lastModified: "2026-11-01T00:00:00.000Z",
	contentVersion: "quickXorHash:abc+/=",
};

/** Answers Graph calls by method name. */
function graph(answers: Record<string, unknown>) {
	mocks.executeTool.mockImplementation(async (method: string) => {
		const answer = answers[method];
		if (answer instanceof Error) {
			throw answer;
		}
		if (answer === undefined) {
			throw new Error(`unexpected Graph call ${method}`);
		}
		return answer;
	});
}

function importFile(overrides: Record<string, unknown> = {}) {
	return {
		id: "file-1",
		folderId: "folder-1",
		projectId: "project-1",
		driveItemId: "drive-item-1",
		name: "plan.pdf",
		relativePath: "plan.pdf",
		size: 100,
		status: "PENDING",
		contextId: null,
		latestVersion: "quickXorHash:abc+/=",
		importedVersion: null,
		retiredAt: null,
		folder: {
			id: "folder-1",
			provider: "onedrive",
			driveId: "drive-1",
			userId: "user-1",
			organizationId: "org-1",
			disconnectedAt: null,
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.startRead.mockResolvedValue(FOLDER);
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.canCreate.mockResolvedValue(true);
	mocks.ownConnection.mockResolvedValue({ id: "connection-1" });
	mocks.googleHasScope.mockResolvedValue(true);
	mocks.finishRead.mockResolvedValue(undefined);
	mocks.reconcile.mockResolvedValue({
		status: "applied",
		counts: {},
		candidates: [],
	});
	mocks.tombstone.mockResolvedValue({
		status: "retired",
		retiredFileIds: [],
	});
	mocks.folderFindUnique.mockResolvedValue({
		...FOLDER,
		disconnectedAt: null,
	});
});

describe("listDocumentFoldersToSync", () => {
	it("reports nothing due while the feature is off, but keeps the workflow alive", async () => {
		mocks.syncState.mockResolvedValue({
			anyConnected: true,
			dueFolderIds: ["folder-1"],
			nextReadAfter: null,
		});
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			listDocumentFoldersToSync({ projectId: "project-1" }),
		).resolves.toEqual({
			anyConnected: true,
			dueFolderIds: [],
			nextReadAfter: null,
		});
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"CLOUD_DRIVE_FOLDERS",
			"org-1",
		);
	});

	it("passes the earliest throttled time on as an ISO string", async () => {
		const at = new Date("2026-11-23T10:00:00.000Z");
		mocks.syncState.mockResolvedValue({
			anyConnected: true,
			dueFolderIds: [],
			nextReadAfter: at,
		});

		await expect(
			listDocumentFoldersToSync({ projectId: "project-1" }),
		).resolves.toEqual({
			anyConnected: true,
			dueFolderIds: [],
			nextReadAfter: at.toISOString(),
		});
	});
});

describe("readDocumentFolder", () => {
	const read = () =>
		readDocumentFolder({ folderId: "folder-1", passId: "pass-1" });

	it("reconciles a complete listing under the pass id and returns its candidates", async () => {
		graph({
			get_drive_item: ROOT,
			list_drive_tree: { status: "complete", files: [TREE_FILE] },
		});
		mocks.reconcile.mockResolvedValue({
			status: "applied",
			counts: {},
			candidates: [{ fileId: "f9", driveItemId: "d9" }],
		});

		await expect(read()).resolves.toEqual({
			complete: true,
			candidates: [{ fileId: "f9", driveItemId: "d9" }],
			nextReadAfter: null,
		});
		expect(mocks.reconcile).toHaveBeenCalledWith({
			folderId: "folder-1",
			passId: "pass-1",
			readerEpoch: 3,
			root: {
				name: "Specs v2",
				webUrl: "https://example.com/specs",
				drivePath: "/Team/Specs v2",
			},
			files: [
				{
					driveItemId: "drive-item-1",
					name: "plan.pdf",
					relativePath: "sub/plan.pdf",
					size: 100,
					mimeType: "application/pdf",
					lastModified: "2026-11-01T00:00:00.000Z",
					contentVersion: "quickXorHash:abc+/=",
				},
			],
			complete: true,
		});
		// The reader's own connection, never a shared one.
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_tree",
			{ driveId: "drive-1", itemId: "item-1" },
			"user-1",
			"org-1",
			"connection-1",
			expect.objectContaining({ onProgress: expect.any(Function) }),
		);
		expect(mocks.finishRead).toHaveBeenCalledWith({
			folderId: "folder-1",
			readerEpoch: 3,
			problemCode: undefined,
			nextReadAfter: null,
		});
	});

	it("keeps a connected drive root's own name and path, which Graph calls root", async () => {
		mocks.startRead.mockResolvedValue({
			...FOLDER,
			name: "Documents",
			drivePath: "/",
		});
		graph({
			get_drive_item: {
				status: "ok",
				item: { ...ROOT.item, name: "root", parentPath: null },
			},
			list_drive_tree: { status: "complete", files: [] },
		});

		await read();

		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				root: {
					name: "Documents",
					webUrl: "https://example.com/specs",
					drivePath: "/",
				},
			}),
		);
	});

	it("gives a reader without project access a problem and no listing", async () => {
		mocks.canCreate.mockResolvedValue(false);

		await expect(read()).resolves.toMatchObject({ complete: false });
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "NO_ACCESS" }),
		);
	});

	it.each([
		["in another organization", { organizationId: "org-2" }],
		["without an organization", { organizationId: null }],
	])("refuses a project %s", async (_label, project) => {
		mocks.projectFindUnique.mockResolvedValue(project);

		await read();

		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "NO_ACCESS" }),
		);
	});

	it("reads nothing and shows nothing while the feature is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await read();

		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: undefined }),
		);
	});

	it("records a root 404 as a gone folder and changes no count", async () => {
		graph({
			get_drive_item: {
				status: "failed",
				httpStatus: 404,
				retryAfterSeconds: null,
			},
		});

		await expect(read()).resolves.toMatchObject({ complete: false });
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "FOLDER_GONE" }),
		);
	});

	it("records a root 403 from the tree read as no access", async () => {
		graph({
			get_drive_item: ROOT,
			list_drive_tree: {
				status: "root_failed",
				httpStatus: 403,
				retryAfterSeconds: null,
			},
		});

		await read();

		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "NO_ACCESS" }),
		);
	});

	it("records a revoked connection as a reconnect and changes no count", async () => {
		graph({
			get_drive_item: new Error(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		});

		await expect(read()).resolves.toMatchObject({ complete: false });
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "RECONNECT" }),
		);
	});

	it("records a reader with no Microsoft connection of their own as a reconnect", async () => {
		mocks.ownConnection.mockResolvedValue(null);

		await read();

		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "RECONNECT" }),
		);
	});

	it("records a truncated listing with removals paused, and confirms nothing", async () => {
		graph({
			get_drive_item: ROOT,
			list_drive_tree: {
				status: "truncated",
				reason: "scan_limit",
				files: [TREE_FILE],
			},
		});
		mocks.reconcile.mockResolvedValue({
			status: "applied",
			counts: {},
			candidates: [],
		});

		await expect(read()).resolves.toEqual({
			complete: false,
			candidates: [],
			nextReadAfter: null,
		});
		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				complete: false,
				pausedRemovalsCode: "TOO_LARGE",
			}),
		);
	});

	it("sets next-read-after when throttling outlasts the retries", async () => {
		graph({
			get_drive_item: ROOT,
			list_drive_tree: {
				status: "truncated",
				reason: "page_failed",
				httpStatus: 429,
				retryAfterSeconds: 120,
				files: [],
			},
		});
		const before = Date.now();

		const result = await read();

		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				complete: false,
				pausedRemovalsCode: "THROTTLED",
			}),
		);
		const next = Date.parse(result.nextReadAfter ?? "");
		expect(next).toBeGreaterThanOrEqual(before + 120_000);
		const finished = mocks.finishRead.mock.calls[0][0];
		expect(finished.nextReadAfter).toBeInstanceOf(Date);
		expect(finished.nextReadAfter.getTime()).toBe(next);
	});

	it.each([403, 500])(
		"records a subfolder page refused with %i as a partial read, with no wait",
		async (httpStatus) => {
			graph({
				get_drive_item: ROOT,
				list_drive_tree: {
					status: "truncated",
					reason: "page_failed",
					httpStatus,
					retryAfterSeconds: null,
					files: [TREE_FILE],
				},
			});

			await expect(read()).resolves.toEqual({
				complete: false,
				candidates: [],
				nextReadAfter: null,
			});
			expect(mocks.reconcile).toHaveBeenCalledWith(
				expect.objectContaining({
					complete: false,
					pausedRemovalsCode: "PARTIAL_READ",
				}),
			);
			expect(mocks.finishRead.mock.calls[0][0].nextReadAfter).toBeNull();
		},
	);

	it("sets next-read-after when the root itself is throttled", async () => {
		graph({
			get_drive_item: {
				status: "failed",
				httpStatus: 429,
				retryAfterSeconds: 60,
			},
		});

		const result = await read();

		expect(result.nextReadAfter).not.toBeNull();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it("returns nothing when the folder was reconnected during the read", async () => {
		graph({
			get_drive_item: ROOT,
			list_drive_tree: { status: "complete", files: [] },
		});
		mocks.reconcile.mockResolvedValue({ status: "stale" });

		await expect(read()).resolves.toMatchObject({
			complete: false,
			candidates: [],
		});
	});

	it("clears the read-started time after a read that throws", async () => {
		graph({ get_drive_item: new Error("socket hang up") });

		await expect(read()).rejects.toThrow("socket hang up");
		expect(mocks.finishRead).toHaveBeenCalledWith({
			folderId: "folder-1",
			readerEpoch: 3,
			problemCode: undefined,
			nextReadAfter: null,
		});
	});

	it("does nothing for a folder disconnected before the read", async () => {
		mocks.startRead.mockResolvedValue(null);

		await expect(read()).resolves.toMatchObject({ complete: false });
		expect(mocks.finishRead).not.toHaveBeenCalled();
	});
});

describe("confirmDocumentFolderCandidates", () => {
	const candidates = [
		{ fileId: "f-gone", driveItemId: "d-gone" },
		{ fileId: "f-out", driveItemId: "d-out" },
		{ fileId: "f-in", driveItemId: "d-in" },
	];

	it("tombstones only the files confirmed gone or moved out", async () => {
		graph({
			lookup_drive_items: {
				items: [
					{ itemId: "d-gone", state: "gone" },
					{ itemId: "d-out", state: "outside" },
					{ itemId: "d-in", state: "inside" },
				],
			},
		});

		await confirmDocumentFolderCandidates({
			folderId: "folder-1",
			candidates,
		});

		expect(mocks.tombstone).toHaveBeenCalledWith({
			folderId: "folder-1",
			goneFileIds: ["f-gone", "f-out"],
			presentFileIds: ["f-in"],
		});
	});

	it("removes nothing when throttling cut the lookups short, and shows removals paused as throttled", async () => {
		graph({
			lookup_drive_items: {
				items: [
					{ itemId: "d-gone", state: "gone" },
					{ itemId: "d-out", state: "outside" },
					{
						itemId: "d-in",
						state: "unknown",
						httpStatus: 429,
						retryAfterSeconds: 30,
					},
				],
			},
		});

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.tombstone).not.toHaveBeenCalled();
		expect(mocks.lookupsThrottled).toHaveBeenCalledWith({
			folderId: "folder-1",
		});
	});

	it("shows removals paused as throttled when Graph answered 503", async () => {
		graph({
			lookup_drive_items: {
				items: candidates.map((c) => ({
					itemId: c.driveItemId,
					state: "unknown",
					httpStatus: 503,
					retryAfterSeconds: null,
				})),
			},
		});

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.tombstone).not.toHaveBeenCalled();
		expect(mocks.lookupsThrottled).toHaveBeenCalledWith({
			folderId: "folder-1",
		});
	});

	it("removes nothing for an unanswered candidate, without calling it throttled", async () => {
		graph({
			lookup_drive_items: {
				items: [
					{ itemId: "d-gone", state: "gone" },
					{ itemId: "d-out", state: "outside" },
				],
			},
		});

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.tombstone).not.toHaveBeenCalled();
		expect(mocks.lookupsThrottled).not.toHaveBeenCalled();
	});

	it("leaves a file whose own lookup was refused, and removes the rest", async () => {
		graph({
			lookup_drive_items: {
				items: [
					{ itemId: "d-gone", state: "gone" },
					{ itemId: "d-out", state: "outside" },
					{
						itemId: "d-in",
						state: "unknown",
						httpStatus: 403,
						retryAfterSeconds: null,
					},
				],
			},
		});

		await confirmDocumentFolderCandidates({
			folderId: "folder-1",
			candidates,
		});

		expect(mocks.tombstone).toHaveBeenCalledWith({
			folderId: "folder-1",
			goneFileIds: ["f-gone", "f-out"],
			presentFileIds: [],
		});
	});

	it("removes nothing, and keeps any hold, when no lookup answered", async () => {
		graph({
			lookup_drive_items: {
				items: candidates.map((c) => ({
					itemId: c.driveItemId,
					state: "unknown",
					httpStatus: 403,
					retryAfterSeconds: null,
				})),
			},
		});

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.tombstone).not.toHaveBeenCalled();
		expect(mocks.lookupsThrottled).not.toHaveBeenCalled();
	});

	it("still settles the folder after a complete read with no candidates", async () => {
		await confirmDocumentFolderCandidates({
			folderId: "folder-1",
			candidates: [],
		});

		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.tombstone).toHaveBeenCalledWith({
			folderId: "folder-1",
			goneFileIds: [],
			presentFileIds: [],
		});
	});

	it("passes a mass-removal hold through", async () => {
		graph({
			lookup_drive_items: {
				items: candidates.map((c) => ({
					itemId: c.driveItemId,
					state: "gone",
				})),
			},
		});
		mocks.tombstone.mockResolvedValue({ status: "held", heldCount: 3 });

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "held", heldCount: 3 });
	});

	it("removes nothing when the reader's connection was revoked before the lookup", async () => {
		graph({
			lookup_drive_items: new Error(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		});

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.tombstone).not.toHaveBeenCalled();
	});

	it("looks nothing up for a reader who lost access", async () => {
		mocks.canCreate.mockResolvedValue(false);

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-1",
				candidates,
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.tombstone).not.toHaveBeenCalled();
	});
});

describe("importDocumentFolderFile", () => {
	beforeEach(() => {
		mocks.claim.mockResolvedValue(true);
		mocks.createContext.mockResolvedValue({
			status: "created",
			contextId: "ctx-1",
		});
		mocks.fileFindUnique.mockResolvedValue({ storageKey: null });
		mocks.deleteFile.mockResolvedValue(undefined);
	});

	const PDF_DOWNLOAD = {
		status: "ok",
		name: "plan.pdf",
		size: 100,
		mimeType: "application/pdf",
		bytes: Buffer.from("pdf"),
	};

	it("claims, downloads within the limit, stores under the organization and project, and creates the context", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({
			download_drive_item: {
				status: "ok",
				name: "plan.pdf",
				size: 100,
				mimeType: "application/pdf",
				bytes: Buffer.from("pdf"),
			},
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({
			outcome: "process",
			contextId: "ctx-1",
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.claim).toHaveBeenCalledWith({
			fileId: "file-1",
			version: "quickXorHash:abc+/=",
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"download_drive_item",
			{
				driveId: "drive-1",
				itemId: "drive-item-1",
				maxBytes: 20 * 1024 * 1024,
			},
			"user-1",
			"org-1",
			"connection-1",
		);
		const [key] = mocks.uploadFile.mock.calls[0];
		expect(key).toMatch(
			/^org-1\/projects\/project-1\/document-folders\/file-1\/[0-9a-f]{32}\.pdf$/,
		);
		expect(mocks.createContext).toHaveBeenCalledWith(
			expect.objectContaining({ fileId: "file-1", s3Path: key }),
		);
	});

	it("skips a file its name and Graph type leave unsupported, and stores nothing", async () => {
		mocks.getFile.mockResolvedValue(importFile({ name: "deck.pptx" }));
		graph({
			download_drive_item: {
				status: "ok",
				name: "deck.pptx",
				size: 100,
				mimeType:
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				bytes: Buffer.from("pptx"),
			},
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.createContext).not.toHaveBeenCalled();
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: null,
			outcome: "SKIPPED",
			skipCode: "UNSUPPORTED",
		});
	});

	it("types a file by Graph's type when its name alone names none, as the listing did", async () => {
		mocks.getFile.mockResolvedValue(importFile({ name: "notes" }));
		graph({
			download_drive_item: {
				status: "ok",
				name: "notes",
				size: 100,
				mimeType: "application/pdf",
				bytes: Buffer.from("pdf"),
			},
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toMatchObject({ outcome: "process", contextId: "ctx-1" });
		const [key, , options] = mocks.uploadFile.mock.calls[0];
		expect(key).toMatch(/\.pdf$/);
		expect(options).toMatchObject({ contentType: "application/pdf" });
		expect(mocks.createContext).toHaveBeenCalledWith(
			expect.objectContaining({
				originalFilename: "notes",
				mimeType: "application/pdf",
			}),
		);
		expect(mocks.recordOutcome).not.toHaveBeenCalled();
	});

	it("skips a downloaded file over its type's limit as too big, and stores nothing", async () => {
		mocks.getFile.mockResolvedValue(importFile({ name: "photo.png" }));
		graph({
			download_drive_item: {
				status: "ok",
				name: "photo.png",
				size: 15 * 1024 * 1024,
				mimeType: "image/png",
				bytes: Buffer.from("png"),
			},
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: null,
			outcome: "SKIPPED",
			skipCode: "TOO_BIG",
		});
	});

	it("skips a download that passes the byte cap mid-stream as too big", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({
			download_drive_item: {
				status: "too_large",
				name: "plan.pdf",
				size: 30 * 1024 * 1024,
			},
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: null,
			outcome: "SKIPPED",
			skipCode: "TOO_BIG",
		});
	});

	it("claims nothing and starts nothing for a folder disconnected since the read", async () => {
		mocks.getFile.mockResolvedValue(
			importFile({
				folder: {
					...importFile().folder,
					disconnectedAt: new Date(),
				},
			}),
		);

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "waiting" });
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});

	it("claims nothing while the feature is off", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "waiting" });
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it("resumes a claim that already made its context", async () => {
		mocks.getFile.mockResolvedValue(
			importFile({ status: "IMPORTING", contextId: "ctx-1" }),
		);
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "PENDING",
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toMatchObject({ outcome: "process", contextId: "ctx-1" });
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.executeTool).not.toHaveBeenCalled();
	});

	it("skips a file the context refuses as unsupported, and deletes the copy it stored", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({ download_drive_item: PDF_DOWNLOAD });
		mocks.createContext.mockResolvedValue({ status: "unsupported" });

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: null,
			outcome: "SKIPPED",
			skipCode: "UNSUPPORTED",
		});
		const [key] = mocks.uploadFile.mock.calls[0];
		expect(mocks.deleteFile).toHaveBeenCalledWith(key, {
			bucket: "contexts",
		});
	});

	it("keeps the stored copy when the row already holds a context under the same key", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({ download_drive_item: PDF_DOWNLOAD });
		mocks.createContext.mockResolvedValue({ status: "not_claimable" });
		// Another attempt already attached a context stored under this key.
		mocks.fileFindUnique.mockImplementation(async () => ({
			storageKey: mocks.uploadFile.mock.calls[0][0],
		}));

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
		expect(mocks.fileFindUnique).toHaveBeenCalled();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
		expect(mocks.recordOutcome).not.toHaveBeenCalled();
	});

	it("settles the file even when the unused copy cannot be deleted", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({ download_drive_item: PDF_DOWNLOAD });
		mocks.createContext.mockResolvedValue({ status: "not_claimable" });
		mocks.deleteFile.mockRejectedValueOnce(new Error("storage down"));

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
	});

	it("records a file deleted since the listing as a failed download, and stores nothing", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({ download_drive_item: { status: "gone" } });

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: null,
			outcome: "FAILED",
			failureCode: "DOWNLOAD_FAILED",
		});
		expect(mocks.uploadFile).not.toHaveBeenCalled();
	});

	it("downloads nothing when another attempt holds the claim", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		mocks.claim.mockResolvedValue(false);

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "done" });
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.uploadFile).not.toHaveBeenCalled();
		expect(mocks.recordOutcome).not.toHaveBeenCalled();
	});

	it("leaves the claim to wait for a reconnect when the connection fails mid-download", async () => {
		mocks.getFile.mockResolvedValue(importFile());
		graph({
			download_drive_item: new Error("Microsoft not connected."),
		});

		await expect(
			importDocumentFolderFile({ fileId: "file-1" }),
		).resolves.toEqual({ outcome: "waiting" });
		expect(mocks.recordOutcome).not.toHaveBeenCalled();
	});
});

describe("finishDocumentFolderContextDeletion", () => {
	const input = {
		fileId: "file-1",
		contextId: "ctx-1",
		organizationId: "org-1",
	};

	beforeEach(() => {
		mocks.fileFindFirst.mockResolvedValue({ storageKey: "org-1/key.pdf" });
		mocks.contextFindUnique.mockResolvedValue(null);
		mocks.complete.mockResolvedValue("PENDING");
		mocks.deleteProjectContext.mockResolvedValue(undefined);
		mocks.deleteFile.mockResolvedValue(undefined);
	});

	it("deletes vectors strictly, confirms the row is gone, deletes the stored copy, then releases", async () => {
		const order: string[] = [];
		mocks.deleteProjectContext.mockImplementation(async () => {
			order.push("vectors");
		});
		mocks.deleteFile.mockImplementation(async () => {
			order.push("storage");
		});
		mocks.complete.mockImplementation(async () => {
			order.push("release");
			return "PENDING";
		});

		await expect(
			finishDocumentFolderContextDeletion(input),
		).resolves.toEqual({ released: true });
		expect(mocks.deleteProjectContext).toHaveBeenCalledWith(
			"ctx-1",
			"org-1",
			undefined,
			{ strict: true },
		);
		expect(mocks.deleteFile).toHaveBeenCalledWith("org-1/key.pdf", {
			bucket: "contexts",
		});
		expect(mocks.complete).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: "ctx-1",
			deletionConfirmed: true,
		});
		expect(order).toEqual(["vectors", "storage", "release"]);
	});

	it("keeps the context id when the strict vector delete fails", async () => {
		mocks.deleteProjectContext.mockRejectedValue(new Error("qdrant down"));

		await expect(
			finishDocumentFolderContextDeletion(input),
		).rejects.toThrow("qdrant down");
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
	});

	it("keeps the context id while the context row is still there", async () => {
		mocks.contextFindUnique.mockResolvedValue({ id: "ctx-1" });

		await expect(
			finishDocumentFolderContextDeletion(input),
		).resolves.toEqual({ released: false });
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
	});
});

describe("listDocumentFolderDeletions", () => {
	const row = (n: number) => ({
		fileId: `file-${n}`,
		folderId: "folder-1",
		contextId: `ctx-${n}`,
		storageKey: null,
	});

	beforeEach(() => {
		mocks.folderFindMany.mockResolvedValue([
			{ id: "folder-1", userId: "user-1", organizationId: "org-1" },
		]);
	});

	it("lists one pass's share with the reader and the project's organization", async () => {
		mocks.listNeedingDeletion.mockResolvedValue([row(1)]);

		await expect(
			listDocumentFolderDeletions({ projectId: "project-1" }),
		).resolves.toEqual({
			deletions: [
				{
					fileId: "file-1",
					contextId: "ctx-1",
					projectId: "project-1",
					userId: "user-1",
					organizationId: "org-1",
				},
			],
		});
		expect(mocks.listNeedingDeletion).toHaveBeenCalledWith({
			projectId: "project-1",
			limit: 200,
		});
	});

	it("deletes nothing while the feature is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			listDocumentFolderDeletions({ projectId: "project-1" }),
		).resolves.toEqual({ deletions: [] });
		expect(mocks.listNeedingDeletion).not.toHaveBeenCalled();
	});

	it("deletes nothing for a project without an organization", async () => {
		mocks.projectFindUnique.mockResolvedValue({ organizationId: null });

		await expect(
			listDocumentFolderDeletions({ projectId: "project-1" }),
		).resolves.toEqual({ deletions: [] });
		expect(mocks.listNeedingDeletion).not.toHaveBeenCalled();
	});

	it("skips a folder whose organization is not the project's", async () => {
		mocks.listNeedingDeletion.mockResolvedValue([row(1)]);
		mocks.folderFindMany.mockResolvedValue([
			{ id: "folder-1", userId: "user-1", organizationId: "org-2" },
		]);

		await expect(
			listDocumentFolderDeletions({ projectId: "project-1" }),
		).resolves.toEqual({ deletions: [] });
	});
});

describe("listDocumentFolderImports", () => {
	it("names the folder's waiting files", async () => {
		mocks.listPending.mockResolvedValue(["file-1"]);

		await expect(
			listDocumentFolderImports({ folderId: "folder-1", limit: 20 }),
		).resolves.toEqual({ fileIds: ["file-1"] });
		expect(mocks.listPending).toHaveBeenCalledWith({
			folderId: "folder-1",
			limit: 20,
		});
	});

	it("names none while the feature is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			listDocumentFolderImports({ folderId: "folder-1", limit: 20 }),
		).resolves.toEqual({ fileIds: [] });
		expect(mocks.listPending).not.toHaveBeenCalled();
	});

	it("names none for a disconnected folder", async () => {
		mocks.folderFindUnique.mockResolvedValue({
			...FOLDER,
			disconnectedAt: new Date(),
		});

		await expect(
			listDocumentFolderImports({ folderId: "folder-1", limit: 20 }),
		).resolves.toEqual({ fileIds: [] });
		expect(mocks.listPending).not.toHaveBeenCalled();
	});
});

describe("recording an import's outcome", () => {
	beforeEach(() => {
		mocks.recordOutcome.mockResolvedValue("IMPORTED");
	});

	it("records a processing failure as failed", async () => {
		await expect(
			recordDocumentFolderFileProcessing({
				fileId: "file-1",
				contextId: "ctx-1",
				processing: "failed",
			}),
		).resolves.toEqual({ settled: true });
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: "ctx-1",
			outcome: "FAILED",
			failureCode: "PROCESSING_FAILED",
		});
	});

	it("leaves a context an earlier run is still reading for the next pass", async () => {
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "EXTRACTING",
		});

		await expect(
			recordDocumentFolderFileProcessing({
				fileId: "file-1",
				contextId: "ctx-1",
				processing: "unknown",
			}),
		).resolves.toEqual({ settled: false });
		expect(mocks.recordOutcome).not.toHaveBeenCalled();
	});

	it("records what an earlier run's processing came to", async () => {
		mocks.contextFindUnique.mockResolvedValue({
			extractionStatus: "FAILED",
		});

		await recordDocumentFolderFileProcessing({
			fileId: "file-1",
			contextId: "ctx-1",
			processing: "unknown",
		});

		expect(mocks.recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "FAILED" }),
		);
	});

	it("settles nothing when a failed download had no claim to record on", async () => {
		mocks.recordOutcome.mockResolvedValue(null);

		await expect(
			markDocumentFolderFileDownloadFailed({ fileId: "file-1" }),
		).resolves.toEqual({ settled: false });
		expect(mocks.recordOutcome).toHaveBeenCalledWith({
			fileId: "file-1",
			contextId: null,
			outcome: "FAILED",
			failureCode: "DOWNLOAD_FAILED",
		});
	});
});

describe("Google Drive folders", () => {
	const GOOGLE_FOLDER = {
		...FOLDER,
		id: "folder-g",
		provider: "googledrive",
		driveId: "root-g",
		itemId: "gfolder-1",
		name: "Briefs",
		drivePath: "/Clients/Briefs",
	};

	const GOOGLE_ROOT = {
		status: "ok",
		item: {
			id: "gfolder-1",
			name: "Briefs",
			driveId: "root-g",
			driveType: null,
			provider: "googledrive",
			isFolder: true,
			webUrl: "https://example.com/briefs",
			parentPath: "/Clients",
			drivePath: "/Clients/Briefs",
			ancestorIds: ["gclients", "root-g"],
		},
	};

	const GOOGLE_FILE = {
		id: "gfile-1",
		name: "Brief.docx",
		relativePath: "Brief.docx",
		size: null,
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		quickXorHash: null,
		lastModified: "2026-11-02T00:00:00.000Z",
		contentVersion: "version:7",
	};

	const readGoogle = () =>
		readDocumentFolder({ folderId: "folder-g", passId: "pass-1" });

	beforeEach(() => {
		mocks.startRead.mockResolvedValue(GOOGLE_FOLDER);
		mocks.folderFindUnique.mockResolvedValue({
			...GOOGLE_FOLDER,
			disconnectedAt: null,
		});
		mocks.googleDetails.mockResolvedValue(GOOGLE_ROOT);
		mocks.googleTree.mockResolvedValue({
			status: "complete",
			files: [GOOGLE_FILE],
		});
	});

	it("lists through the Google adapter and records the root's path and ancestor ids", async () => {
		mocks.googleTree.mockResolvedValue({
			status: "complete",
			files: [
				GOOGLE_FILE,
				{
					...GOOGLE_FILE,
					id: "gfile-2",
					name: "Locked.pdf",
					relativePath: "Locked.pdf",
					size: 10,
					mimeType: "application/pdf",
					contentVersion: "md5:abc",
					notDownloadable: true,
				},
			],
		});

		await expect(readGoogle()).resolves.toMatchObject({ complete: true });
		expect(mocks.ownConnection).toHaveBeenCalledWith(
			"GOOGLE_DRIVE",
			"user-1",
			"org-1",
		);
		expect(mocks.executeTool).not.toHaveBeenCalled();
		expect(mocks.reconcile).toHaveBeenCalledWith({
			folderId: "folder-g",
			passId: "pass-1",
			readerEpoch: 3,
			root: {
				name: "Briefs",
				webUrl: "https://example.com/briefs",
				drivePath: "/Clients/Briefs",
				ancestorIds: ["gclients", "root-g"],
			},
			files: [
				{
					driveItemId: "gfile-1",
					name: "Brief.docx",
					relativePath: "Brief.docx",
					size: null,
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					lastModified: "2026-11-02T00:00:00.000Z",
					contentVersion: "version:7",
				},
				{
					driveItemId: "gfile-2",
					name: "Locked.pdf",
					relativePath: "Locked.pdf",
					size: 10,
					mimeType: "application/pdf",
					lastModified: "2026-11-02T00:00:00.000Z",
					contentVersion: "md5:abc",
					notDownloadable: true,
				},
			],
			complete: true,
		});
	});

	it("gives a reader whose grant lacks drive.readonly the reconnect problem, and lists nothing", async () => {
		mocks.googleHasScope.mockResolvedValue(false);

		await expect(readGoogle()).resolves.toMatchObject({ complete: false });
		expect(mocks.googleDetails).not.toHaveBeenCalled();
		expect(mocks.googleTree).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "RECONNECT" }),
		);
	});

	it("gives an expired Google session the reconnect problem, and lists nothing", async () => {
		mocks.googleDetails.mockRejectedValue(
			new Error("Google session expired"),
		);

		await expect(readGoogle()).resolves.toMatchObject({ complete: false });
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "RECONNECT" }),
		);
	});

	it("waits out a throttled root read and removes nothing", async () => {
		mocks.googleDetails.mockResolvedValue({
			status: "failed",
			httpStatus: 429,
			retryAfterSeconds: 3600,
		});
		const before = Date.now();

		const result = await readGoogle();

		expect(
			new Date(result.nextReadAfter ?? 0).getTime(),
		).toBeGreaterThanOrEqual(before + 3600 * 1000);
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: undefined }),
		);
	});

	it("records a root 404 as a gone folder", async () => {
		mocks.googleDetails.mockResolvedValue({
			status: "failed",
			httpStatus: 404,
			retryAfterSeconds: null,
		});

		await readGoogle();

		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.finishRead).toHaveBeenCalledWith(
			expect.objectContaining({ problemCode: "FOLDER_GONE" }),
		);
	});

	it("records an incomplete Drive search as a partial read, with removals paused", async () => {
		mocks.googleTree.mockResolvedValue({
			status: "truncated",
			reason: "incomplete",
			files: [GOOGLE_FILE],
		});

		await expect(readGoogle()).resolves.toMatchObject({
			complete: false,
			candidates: [],
		});
		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				complete: false,
				pausedRemovalsCode: "PARTIAL_READ",
			}),
		);
	});

	it("leaves a candidate whose Google lookup did not answer", async () => {
		mocks.googleLookup.mockResolvedValue({
			items: [
				{
					itemId: "gfile-1",
					state: "unknown",
					httpStatus: 403,
					retryAfterSeconds: null,
				},
			],
		});

		await expect(
			confirmDocumentFolderCandidates({
				folderId: "folder-g",
				candidates: [{ fileId: "file-g", driveItemId: "gfile-1" }],
			}),
		).resolves.toEqual({ status: "skipped" });
		expect(mocks.googleLookup).toHaveBeenCalledWith(expect.anything(), {
			folderItemId: "gfolder-1",
			itemIds: ["gfile-1"],
			onProgress: expect.any(Function),
		});
		expect(mocks.tombstone).not.toHaveBeenCalled();
	});

	describe("importing", () => {
		const googleImport = (overrides: Record<string, unknown> = {}) =>
			importFile({
				driveItemId: "gfile-1",
				name: "Brief.docx",
				latestVersion: "version:7",
				folder: {
					id: "folder-g",
					provider: "googledrive",
					driveId: "root-g",
					userId: "user-1",
					organizationId: "org-1",
					disconnectedAt: null,
				},
				...overrides,
			});

		beforeEach(() => {
			mocks.claim.mockResolvedValue(true);
			mocks.createContext.mockResolvedValue({
				status: "created",
				contextId: "ctx-g",
			});
			mocks.fileFindUnique.mockResolvedValue({ storageKey: null });
			mocks.deleteFile.mockResolvedValue(undefined);
		});

		it("skips a file Google will not hand over as not downloadable, storing nothing", async () => {
			mocks.getFile.mockResolvedValue(googleImport());
			mocks.googleDownload.mockResolvedValue({
				status: "not_downloadable",
				name: "Brief.docx",
			});

			await expect(
				importDocumentFolderFile({ fileId: "file-1" }),
			).resolves.toEqual({ outcome: "done" });
			expect(mocks.uploadFile).not.toHaveBeenCalled();
			expect(mocks.createContext).not.toHaveBeenCalled();
			expect(mocks.recordOutcome).toHaveBeenCalledWith({
				fileId: "file-1",
				contextId: null,
				outcome: "SKIPPED",
				skipCode: "NOT_DOWNLOADABLE",
			});
		});

		it("stores a native Google Doc's DOCX export as the context", async () => {
			mocks.getFile.mockResolvedValue(googleImport());
			mocks.googleDownload.mockResolvedValue({
				status: "ok",
				name: "Brief.docx",
				size: 2048,
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				bytes: Buffer.from("docx"),
			});

			await expect(
				importDocumentFolderFile({ fileId: "file-1" }),
			).resolves.toMatchObject({
				outcome: "process",
				contextId: "ctx-g",
			});
			expect(mocks.googleDownload).toHaveBeenCalledWith(
				expect.anything(),
				{ itemId: "gfile-1", maxBytes: 20 * 1024 * 1024 },
			);
			const [key, , options] = mocks.uploadFile.mock.calls[0];
			expect(key).toMatch(
				/^org-1\/projects\/project-1\/document-folders\/file-1\/[0-9a-f]{32}\.docx$/,
			);
			expect(options).toMatchObject({
				contentType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			});
			expect(mocks.createContext).toHaveBeenCalledWith(
				expect.objectContaining({
					originalFilename: "Brief.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					fileSize: 2048,
				}),
			);
		});
	});

	it("reads a OneDrive and a Google folder of one project each through its own drive", async () => {
		mocks.startRead.mockImplementation(
			async (input: { folderId: string }) =>
				input.folderId === "folder-g" ? GOOGLE_FOLDER : FOLDER,
		);
		graph({
			get_drive_item: ROOT,
			list_drive_tree: { status: "complete", files: [TREE_FILE] },
		});

		await readDocumentFolder({ folderId: "folder-1", passId: "pass-1" });
		await readDocumentFolder({ folderId: "folder-g", passId: "pass-1" });

		expect(mocks.ownConnection.mock.calls.map((call) => call[0])).toEqual([
			"MICROSOFT_GRAPH",
			"GOOGLE_DRIVE",
		]);
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_tree",
			{ driveId: "drive-1", itemId: "item-1" },
			"user-1",
			"org-1",
			"connection-1",
			expect.objectContaining({ onProgress: expect.any(Function) }),
		);
		expect(mocks.googleTree).toHaveBeenCalledTimes(1);
		expect(mocks.googleTree).toHaveBeenCalledWith(expect.anything(), {
			itemId: "gfolder-1",
			onProgress: expect.any(Function),
		});
		const reconciled = mocks.reconcile.mock.calls.map((call) => ({
			folderId: call[0].folderId,
			files: call[0].files.map(
				(file: { driveItemId: string }) => file.driveItemId,
			),
		}));
		expect(reconciled).toEqual([
			{ folderId: "folder-1", files: ["drive-item-1"] },
			{ folderId: "folder-g", files: ["gfile-1"] },
		]);
	});
});

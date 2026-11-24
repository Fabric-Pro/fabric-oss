/**
 * Document-folder queries. The first part checks the pure reconciliation plan
 * by applying it to ledger rows and reading the rows that result, so those
 * cases read as the file lifecycle itself. The rest runs the queries against
 * a mocked client: what each writes, under which conditions, and what it
 * returns to the sync and the procedures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	transaction: vi.fn(),
	executeRaw: vi.fn(),
	queryRaw: vi.fn(),
	folderFindMany: vi.fn(),
	folderFindFirst: vi.fn(),
	folderFindUnique: vi.fn(),
	folderUpsert: vi.fn(),
	folderUpdate: vi.fn(),
	folderUpdateMany: vi.fn(),
	fileFindMany: vi.fn(),
	fileFindFirst: vi.fn(),
	fileFindUnique: vi.fn(),
	fileCreateMany: vi.fn(),
	fileUpdateMany: vi.fn(),
	fileGroupBy: vi.fn(),
	fileCount: vi.fn(),
	transcriptFindMany: vi.fn(),
	contextFindMany: vi.fn(),
	contextFindUnique: vi.fn(),
	contextCreate: vi.fn(),
	contextUpdateMany: vi.fn(),
}));

vi.mock("../../../client", () => {
	const client = {
		$transaction: m.transaction,
		$executeRaw: m.executeRaw,
		$queryRaw: m.queryRaw,
		projectDocumentFolder: {
			findMany: m.folderFindMany,
			findFirst: m.folderFindFirst,
			findUnique: m.folderFindUnique,
			upsert: m.folderUpsert,
			update: m.folderUpdate,
			updateMany: m.folderUpdateMany,
		},
		projectDocumentFolderFile: {
			findMany: m.fileFindMany,
			findFirst: m.fileFindFirst,
			findUnique: m.fileFindUnique,
			createMany: m.fileCreateMany,
			updateMany: m.fileUpdateMany,
			groupBy: m.fileGroupBy,
			count: m.fileCount,
		},
		projectTranscriptFolder: { findMany: m.transcriptFindMany },
		projectContext: {
			findMany: m.contextFindMany,
			findUnique: m.contextFindUnique,
			create: m.contextCreate,
			updateMany: m.contextUpdateMany,
		},
	};
	return { db: client };
});

import {
	claimDocumentFolderFile,
	classifyDocumentFolderFile,
	completeDocumentFolderFileDeletion,
	confirmDocumentFolderRemovals,
	connectDocumentFolders,
	createDocumentFolderFileContext,
	type DocumentFolderLedgerRow,
	type DocumentFolderListedFile,
	describeDocumentFolder,
	disconnectDocumentFolder,
	FolderConnectRefusedError,
	finishDocumentFolderRead,
	foldersOverlap,
	listDocumentFolderFilesNeedingDeletion,
	listDocumentFolderSyncState,
	listDocumentFolders,
	listPendingDocumentFolderFileIds,
	normalizeDocumentFolderDescription,
	planDocumentFolderReconcile,
	reconcileDocumentFolderListing,
	recordDocumentFolderFileOutcome,
	recordDocumentFolderLookupsThrottled,
	startDocumentFolderRead,
	tombstoneDocumentFolderFiles,
} from "../document-folders";

/** Every `updateMany` on the file table, in call order. */
const fileUpdates = () =>
	m.fileUpdateMany.mock.calls.map((call) => call[0]) as Array<{
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	}>;

beforeEach(() => {
	vi.clearAllMocks();
	m.transaction.mockImplementation(async (fn: unknown) => {
		const { db } = await import("../../../client");
		return (fn as (tx: unknown) => Promise<unknown>)(db);
	});
	m.executeRaw.mockResolvedValue(0);
	m.folderFindMany.mockResolvedValue([]);
	m.transcriptFindMany.mockResolvedValue([]);
	m.fileFindMany.mockResolvedValue([]);
	m.fileUpdateMany.mockResolvedValue({ count: 1 });
	m.folderUpdateMany.mockResolvedValue({ count: 1 });
	m.contextFindMany.mockResolvedValue([]);
	m.contextUpdateMany.mockResolvedValue({ count: 1 });
	m.folderUpsert.mockImplementation(
		async (args: {
			where: { projectId_driveId_itemId: { itemId: string } };
		}) => ({
			id: `folder-${args.where.projectId_driveId_itemId.itemId}`,
			readerEpoch: 4,
		}),
	);
});

describe("connectDocumentFolders", () => {
	const selection = (
		itemId: string,
		drivePath: string,
		overrides: Record<string, unknown> = {},
	) => ({
		provider: "sharepoint" as const,
		driveId: "drive-1",
		itemId,
		name: drivePath.split("/").pop() ?? itemId,
		drivePath,
		...overrides,
	});

	const connect = (
		folders: ReturnType<typeof selection>[],
		transcriptFolderPaths: Array<{
			driveId: string;
			itemId: string;
			drivePath: string | null;
		}> = [],
	) =>
		connectDocumentFolders({
			projectId: "project-1",
			userId: "user-2",
			organizationId: "org-1",
			folders,
			transcriptFolderPaths,
		});

	async function refusal(promise: Promise<unknown>) {
		const error = await promise.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FolderConnectRefusedError);
		return error as FolderConnectRefusedError;
	}

	it("takes the project's connect lock before reading what is connected", async () => {
		await connect([selection("item-a", "/Sales")]);

		expect(m.executeRaw).toHaveBeenCalledTimes(1);
		expect(m.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			m.folderFindMany.mock.invocationCallOrder[0] as number,
		);
	});

	it("refuses a folder that is a connected transcript folder, naming it", async () => {
		m.transcriptFindMany.mockResolvedValue([
			{ driveId: "drive-1", itemId: "item-a", name: "Meetings" },
		]);

		const error = await refusal(
			connect([selection("item-a", "/Meetings")]),
		);
		expect(error.reason).toBe("SAME_AS_TRANSCRIPT_FOLDER");
		expect(error.existingFolderName).toBe("Meetings");
		expect(m.folderUpsert).not.toHaveBeenCalled();
	});

	it("refuses a folder containing a connected transcript folder in the same drive", async () => {
		m.transcriptFindMany.mockResolvedValue([
			{ driveId: "drive-1", itemId: "item-t", name: "Meetings" },
		]);

		const error = await refusal(
			connect(
				[selection("item-a", "/Team")],
				[
					{
						driveId: "drive-1",
						itemId: "item-t",
						drivePath: "/Team/Meetings",
					},
				],
			),
		);
		expect(error.reason).toBe("OVERLAPS_TRANSCRIPT_FOLDER");
		expect(error.existingFolderName).toBe("Meetings");
	});

	it("refuses a folder inside a connected document folder, naming it", async () => {
		m.folderFindMany.mockResolvedValue([
			{
				id: "folder-sales",
				driveId: "drive-1",
				itemId: "item-sales",
				name: "Sales",
				drivePath: "/Sales",
				disconnectedAt: null,
				userId: "user-1",
			},
		]);

		const error = await refusal(
			connect([selection("item-cs", "/Sales/Case studies")]),
		);
		expect(error.reason).toBe("OVERLAPS_DOCUMENT_FOLDER");
		expect(error.folderName).toBe("Case studies");
		expect(error.existingFolderName).toBe("Sales");
	});

	it("refuses two selected folders where one holds the other", async () => {
		const error = await refusal(
			connect([
				selection("item-sales", "/Sales"),
				selection("item-cs", "/Sales/Case studies"),
			]),
		);
		expect(error.reason).toBe("OVERLAPS_DOCUMENT_FOLDER");
	});

	it("refuses the 21st document folder", async () => {
		m.folderFindMany.mockResolvedValue(
			Array.from({ length: 20 }, (_, i) => ({
				id: `folder-${i}`,
				driveId: "drive-2",
				itemId: `item-${i}`,
				name: `F${i}`,
				drivePath: `/F${i}`,
				disconnectedAt: null,
				userId: "user-1",
			})),
		);

		const error = await refusal(connect([selection("item-new", "/New")]));
		expect(error.reason).toBe("TOO_MANY_FOLDERS");
	});

	it("connects a new folder with its description stored on one line", async () => {
		const [result] = await connect([
			selection("item-a", "/Sales", {
				description: "Signed customer\ncase studies",
				siteId: "site-1",
				siteName: "Example Sales",
				libraryName: "Documents",
			}),
		]);

		const upsert = m.folderUpsert.mock.calls[0]?.[0];
		expect(upsert.create).toMatchObject({
			projectId: "project-1",
			provider: "sharepoint",
			drivePath: "/Sales",
			description: "Signed customer case studies",
			siteName: "Example Sales",
			userId: "user-2",
			organizationId: "org-1",
		});
		expect(result).toEqual({
			folderId: "folder-item-a",
			driveId: "drive-1",
			itemId: "item-a",
			name: "Sales",
			reconnected: false,
			previousUserId: null,
			readerEpoch: 4,
		});
		expect(upsert.select).toEqual({ id: true, readerEpoch: true });
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
	});

	it("on reconnect makes the person the reader of the folder, its files and its contexts", async () => {
		m.folderFindMany.mockResolvedValue([
			{
				id: "folder-item-a",
				driveId: "drive-1",
				itemId: "item-a",
				name: "Sales",
				drivePath: "/Sales",
				disconnectedAt: null,
				userId: "user-1",
			},
		]);
		m.fileFindMany.mockResolvedValue([
			{ contextId: "context-1" },
			{ contextId: "context-2" },
		]);

		const [result] = await connect([selection("item-a", "/Sales")]);

		const upsert = m.folderUpsert.mock.calls[0]?.[0];
		expect(upsert.update).toMatchObject({
			userId: "user-2",
			disconnectedAt: null,
			readerEpoch: { increment: 1 },
			// A read still running as the previous reader stops showing.
			readStartedAt: null,
			problemCode: null,
			pausedRemovalsCode: null,
			heldRemovalCount: null,
		});
		expect(upsert.update).not.toHaveProperty("description");
		expect(fileUpdates()).toEqual([
			{
				where: { folderId: "folder-item-a" },
				data: { userId: "user-2", missCount: 0 },
			},
			{
				where: {
					folderId: "folder-item-a",
					status: "FAILED",
					contextId: null,
					retiredAt: null,
				},
				data: { status: "PENDING", failureCode: null },
			},
		]);
		expect(m.contextUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["context-1", "context-2"] },
				projectId: "project-1",
			},
			data: { userId: "user-2" },
		});
		expect(result).toMatchObject({
			reconnected: true,
			previousUserId: "user-1",
		});
	});
});

describe("listDocumentFolders", () => {
	beforeEach(() => {
		m.folderFindMany.mockResolvedValue([
			{
				id: "folder-1",
				provider: "sharepoint",
				driveId: "drive-1",
				itemId: "item-1",
				name: "Sales",
				webUrl: "https://example.com/sales",
				drivePath: "/Sales",
				siteId: "site-1",
				siteName: "Example Sales",
				libraryName: "Documents",
				description: "Signed customer case studies",
				connectedAt: new Date("2026-11-20T10:00:00Z"),
				readStartedAt: null,
				lastReadAt: new Date("2026-11-21T10:00:00Z"),
				lastListingComplete: true,
				discoveredAt: new Date("2026-11-20T10:05:00Z"),
				pausedRemovalsCode: "MASS_REMOVAL",
				heldRemovalCount: 70,
				problemCode: null,
				nextReadAfter: null,
				userId: "user-1",
				user: { name: "Alex Example" },
			},
		]);
		const group = (status: string, n: number) => ({
			folderId: "folder-1",
			status,
			_count: { _all: n },
		});
		m.fileGroupBy.mockResolvedValue([
			group("IMPORTED", 5),
			group("SKIPPED", 2),
			group("FAILED", 1),
			group("EXCLUDED", 1),
			group("PENDING", 3),
			group("REFRESHING", 1),
		]);
		m.fileFindMany.mockResolvedValue([
			{
				id: "file-1",
				folderId: "folder-1",
				name: "Deck.pptx",
				relativePath: "Deck.pptx",
				status: "SKIPPED",
				skipCode: "UNSUPPORTED",
				failureCode: null,
			},
		]);
	});

	it("gives editors the reader, the identifiers and the files needing attention", async () => {
		const [folder] = await listDocumentFolders({
			projectId: "project-1",
			view: "editor",
		});

		expect(folder).toMatchObject({
			driveId: "drive-1",
			itemId: "item-1",
			siteId: "site-1",
			webUrl: "https://example.com/sales",
			readerUserId: "user-1",
			readerName: "Alex Example",
			heldRemovalCount: 70,
			counts: {
				found: 13,
				imported: 5,
				skipped: 2,
				failed: 1,
				excluded: 1,
				inProgress: 4,
			},
		});
		expect(folder?.attention).toEqual([
			{
				id: "file-1",
				name: "Deck.pptx",
				relativePath: "Deck.pptx",
				status: "SKIPPED",
				skipCode: "UNSUPPORTED",
				failureCode: null,
			},
		]);
		expect(m.fileGroupBy.mock.calls[0]?.[0].where).toMatchObject({
			retiredAt: null,
		});
	});

	it("never gives viewers the reader's identity, drive identifiers or web addresses", async () => {
		const [folder] = await listDocumentFolders({
			projectId: "project-1",
			view: "viewer",
		});

		for (const key of [
			"readerUserId",
			"readerName",
			"userId",
			"driveId",
			"itemId",
			"siteId",
			"webUrl",
			"attention",
		]) {
			expect(folder).not.toHaveProperty(key);
		}
		expect(folder).toMatchObject({
			name: "Sales",
			siteName: "Example Sales",
			description: "Signed customer case studies",
			counts: { imported: 5 },
		});
		expect(m.folderFindMany.mock.calls[0]?.[0].select).not.toHaveProperty(
			"user",
		);
	});

	it("names each folder's own files needing attention, however many another folder has", async () => {
		const folder = (id: string) => ({
			id,
			provider: "onedrive",
			driveId: "drive-1",
			itemId: `item-${id}`,
			name: id,
			webUrl: null,
			drivePath: `/${id}`,
			siteId: null,
			siteName: null,
			libraryName: null,
			description: null,
			connectedAt: new Date("2026-11-20T10:00:00Z"),
			readStartedAt: null,
			lastReadAt: null,
			lastListingComplete: true,
			discoveredAt: null,
			pausedRemovalsCode: null,
			heldRemovalCount: null,
			problemCode: null,
			nextReadAfter: null,
			userId: "user-1",
			user: { name: null },
		});
		m.folderFindMany.mockResolvedValue([folder("big"), folder("small")]);
		m.fileGroupBy.mockResolvedValue([]);
		// The big folder's 30 files over the cap were updated last.
		const files = [
			...Array.from({ length: 30 }, (_, i) => ({
				id: `big-${i}`,
				folderId: "big",
				name: `${i}.pdf`,
				relativePath: `${i}.pdf`,
				status: "SKIPPED",
				skipCode: "CAP_REACHED",
				failureCode: null,
				updatedAt: new Date(Date.UTC(2026, 10, 23, 12, i)),
			})),
			{
				id: "small-0",
				folderId: "small",
				name: "Broken.docx",
				relativePath: "Broken.docx",
				status: "FAILED",
				skipCode: null,
				failureCode: "DOWNLOAD_FAILED",
				updatedAt: new Date("2026-11-22T12:00:00Z"),
			},
		];
		m.fileFindMany.mockImplementation(
			async (args: {
				where: { folderId: string | { in: string[] } };
				take: number;
			}) => {
				const wanted =
					typeof args.where.folderId === "string"
						? [args.where.folderId]
						: args.where.folderId.in;
				return files
					.filter((file) => wanted.includes(file.folderId))
					.sort(
						(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
					)
					.slice(0, args.take)
					.map(({ updatedAt: _updatedAt, ...file }) => file);
			},
		);

		const [big, small] = await listDocumentFolders({
			projectId: "project-1",
			view: "editor",
		});

		expect(big?.attention).toHaveLength(10);
		expect(small?.attention.map((file) => file.id)).toEqual(["small-0"]);
	});
});

describe("describeDocumentFolder and disconnectDocumentFolder", () => {
	it("stores the description cleaned and reports the previous one", async () => {
		m.folderFindFirst.mockResolvedValue({
			name: "Sales",
			description: "Old",
		});

		expect(
			await describeDocumentFolder({
				projectId: "project-1",
				folderId: "folder-1",
				description: "New\r\ntext",
			}),
		).toEqual({ name: "Sales", previous: "Old", description: "New text" });
		expect(m.folderUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "folder-1",
				projectId: "project-1",
				disconnectedAt: null,
			},
			data: { description: "New text" },
		});
	});

	it("disconnects without touching any file or context", async () => {
		m.folderFindFirst.mockResolvedValue({ name: "Sales" });

		expect(
			await disconnectDocumentFolder({
				projectId: "project-1",
				folderId: "folder-1",
			}),
		).toEqual({ name: "Sales" });
		const call = m.folderUpdateMany.mock.calls[0]?.[0];
		expect(call.where).toEqual({
			id: "folder-1",
			projectId: "project-1",
			disconnectedAt: null,
		});
		expect(Object.keys(call.data)).toEqual(["disconnectedAt"]);
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
		expect(m.contextUpdateMany).not.toHaveBeenCalled();
	});
});

describe("reconcileDocumentFolderListing", () => {
	const lockedFolder = (overrides: Record<string, unknown> = {}) => ({
		id: "folder-1",
		projectId: "project-1",
		userId: "user-1",
		organizationId: "org-1",
		readerEpoch: 3,
		lastPassId: "pass-0",
		disconnectedAt: null,
		discoveredAt: null,
		pausedRemovalsCode: null,
		...overrides,
	});

	const ledgerRow = (
		id: string,
		overrides: Record<string, unknown> = {},
	) => ({
		id: `file-${id}`,
		driveItemId: id,
		name: `${id}.pdf`,
		relativePath: `${id}.pdf`,
		size: BigInt(1000),
		sourceModifiedAt: new Date("2026-11-01T00:00:00Z"),
		status: "IMPORTED",
		skipCode: null,
		contextId: `context-${id}`,
		importedVersion: `quickXorHash:${id}`,
		latestVersion: `quickXorHash:${id}`,
		latestVersionSeenCount: 1,
		excludedVersion: null,
		missCount: 0,
		retiredAt: null,
		...overrides,
	});

	const listed = (id: string, overrides: Record<string, unknown> = {}) => ({
		driveItemId: id,
		name: `${id}.pdf`,
		relativePath: `${id}.pdf`,
		size: 1000,
		mimeType: "application/pdf",
		lastModified: "2026-11-01T00:00:00.000Z",
		contentVersion: `quickXorHash:${id}`,
		...overrides,
	});

	const reconcile = (
		overrides: Partial<
			Parameters<typeof reconcileDocumentFolderListing>[0]
		> = {},
	) =>
		reconcileDocumentFolderListing({
			folderId: "folder-1",
			passId: "pass-1",
			readerEpoch: 3,
			root: { name: "Sales", webUrl: null, drivePath: "/Sales" },
			files: [],
			complete: true,
			now: new Date("2026-11-23T12:00:00Z"),
			...overrides,
		} as Parameters<typeof reconcileDocumentFolderListing>[0]);

	it("changes nothing when the folder was reconnected since the read started", async () => {
		m.queryRaw.mockResolvedValue([lockedFolder({ readerEpoch: 4 })]);

		expect(await reconcile()).toEqual({ status: "stale" });
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
		expect(m.fileCreateMany).not.toHaveBeenCalled();
		expect(m.folderUpdate).not.toHaveBeenCalled();
	});

	it("applies one pass once: a retry returns the candidates and counts nothing again", async () => {
		m.queryRaw.mockResolvedValue([lockedFolder({ lastPassId: "pass-1" })]);
		m.fileFindMany.mockResolvedValue([{ id: "file-a", driveItemId: "a" }]);

		const result = await reconcile();

		expect(result).toMatchObject({
			status: "already_applied",
			candidates: [{ fileId: "file-a", driveItemId: "a" }],
		});
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
		expect(m.fileFindMany.mock.calls[0]?.[0].where).toEqual({
			folderId: "folder-1",
			retiredAt: null,
			missCount: { gte: 2 },
		});
	});

	it("writes new files, renames, misses and the folder's read, each conditionally", async () => {
		m.queryRaw.mockResolvedValue([lockedFolder()]);
		m.fileFindMany.mockResolvedValue([
			ledgerRow("a"),
			ledgerRow("gone", { missCount: 1 }),
		]);
		m.contextFindMany.mockResolvedValue([
			{
				id: "context-a",
				metadata: {
					provider: "sharepoint-documents",
					relativePath: "a.pdf",
				},
				sourceType: null,
				aiInstructions: null,
			},
			{
				id: "context-gone",
				metadata: {},
				sourceType: null,
				aiInstructions: null,
			},
		]);

		const result = await reconcile({
			files: [
				listed("a", { name: "Final.pdf", relativePath: "x/Final.pdf" }),
				listed("new", {
					size: 3_000_000_000,
					mimeType: "application/pdf",
				}),
			],
		});

		expect(result).toMatchObject({
			status: "applied",
			candidates: [{ fileId: "file-gone", driveItemId: "gone" }],
		});
		const created = m.fileCreateMany.mock.calls[0]?.[0];
		expect(created.skipDuplicates).toBe(true);
		expect(created.data[0]).toMatchObject({
			folderId: "folder-1",
			projectId: "project-1",
			driveItemId: "new",
			size: BigInt(3_000_000_000),
			status: "SKIPPED",
			skipCode: "TOO_BIG",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(fileUpdates()).toContainEqual({
			where: {
				id: "file-a",
				retiredAt: null,
				folder: { disconnectedAt: null },
				status: "IMPORTED",
			},
			data: { name: "Final.pdf", relativePath: "x/Final.pdf" },
		});
		expect(fileUpdates()).toContainEqual({
			where: { id: { in: ["file-gone"] }, retiredAt: null },
			data: { missCount: { increment: 1 } },
		});
		// A file seen again is no longer held for removal.
		expect(fileUpdates()).toContainEqual({
			where: { id: { in: ["file-a"] } },
			data: {
				lastSeenAt: new Date("2026-11-23T12:00:00Z"),
				removalHeldAt: null,
			},
		});
		expect(m.contextUpdateMany).toHaveBeenCalledWith({
			where: { id: "context-a", projectId: "project-1" },
			data: {
				originalFilename: "Final.pdf",
				metadata: {
					provider: "sharepoint-documents",
					relativePath: "x/Final.pdf",
				},
			},
		});
		expect(m.folderUpdate.mock.calls[0]?.[0].data).toMatchObject({
			name: "Sales",
			drivePath: "/Sales",
			lastPassId: "pass-1",
			lastListingComplete: true,
			problemCode: null,
			pausedRemovalsCode: null,
			discoveredAt: new Date("2026-11-23T12:00:00Z"),
		});
	});

	it("saves a refreshed file's own guidance before its context is deleted", async () => {
		m.queryRaw.mockResolvedValue([lockedFolder()]);
		m.fileFindMany.mockResolvedValue([
			ledgerRow("a", {
				latestVersion: "quickXorHash:a2",
				latestVersionSeenCount: 1,
			}),
		]);
		m.contextFindMany.mockResolvedValue([
			{
				id: "context-a",
				metadata: {},
				sourceType: "Case study",
				aiInstructions: "Quote figures exactly.",
			},
		]);

		await reconcile({
			files: [listed("a", { contentVersion: "quickXorHash:a2" })],
		});

		expect(fileUpdates()).toContainEqual({
			where: {
				id: "file-a",
				retiredAt: null,
				folder: { disconnectedAt: null },
				status: "IMPORTED",
			},
			data: {
				latestVersionSeenCount: 2,
				status: "REFRESHING",
				savedSourceType: "Case study",
				savedAiInstructions: "Quote figures exactly.",
			},
		});
	});

	it("on a truncated listing records why removals are paused and counts no miss", async () => {
		m.queryRaw.mockResolvedValue([lockedFolder()]);
		m.fileFindMany.mockResolvedValue([ledgerRow("gone", { missCount: 1 })]);
		m.contextFindMany.mockResolvedValue([
			{
				id: "context-gone",
				metadata: {},
				sourceType: null,
				aiInstructions: null,
			},
		]);

		const result = await reconcile({
			complete: false,
			pausedRemovalsCode: "TOO_LARGE",
		});

		expect(result).toMatchObject({ status: "applied", candidates: [] });
		expect(fileUpdates()).toEqual([]);
		expect(m.folderUpdate.mock.calls[0]?.[0].data).toMatchObject({
			lastListingComplete: false,
			pausedRemovalsCode: "TOO_LARGE",
		});
		expect(m.folderUpdate.mock.calls[0]?.[0].data).not.toHaveProperty(
			"discoveredAt",
		);
	});

	it("on a truncated listing keeps a held mass removal and its count", async () => {
		m.queryRaw.mockResolvedValue([
			lockedFolder({ pausedRemovalsCode: "MASS_REMOVAL" }),
		]);

		await reconcile({ complete: false, pausedRemovalsCode: "THROTTLED" });

		const data = m.folderUpdate.mock.calls[0]?.[0].data;
		expect(data).toMatchObject({ lastListingComplete: false });
		expect(data).not.toHaveProperty("pausedRemovalsCode");
		expect(data).not.toHaveProperty("heldRemovalCount");
	});
});

describe("tombstoneDocumentFolderFiles and confirmDocumentFolderRemovals", () => {
	const gone = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: `file-${i}`,
			contextId: null,
		}));

	beforeEach(() => {
		m.queryRaw.mockResolvedValue([
			{
				id: "folder-1",
				projectId: "project-1",
				disconnectedAt: null,
				pausedRemovalsCode: null,
			},
		]);
		m.fileCount.mockResolvedValue(100);
	});

	it("holds 70 of 100 confirmed missing for an editor, removing nothing", async () => {
		const now = new Date("2026-11-23T12:00:00Z");
		m.fileFindMany.mockResolvedValue(gone(70));

		expect(
			await tombstoneDocumentFolderFiles({
				folderId: "folder-1",
				goneFileIds: gone(70).map((f) => f.id),
				presentFileIds: [],
				now,
			}),
		).toEqual({ status: "held", heldCount: 70 });
		expect(fileUpdates().some((u) => "retiredAt" in u.data)).toBe(false);
		expect(m.folderUpdate).toHaveBeenCalledWith({
			where: { id: "folder-1" },
			data: { pausedRemovalsCode: "MASS_REMOVAL", heldRemovalCount: 70 },
		});
		// The hold covers exactly these files, and no other of the folder's.
		const heldIds = gone(70).map((f) => f.id);
		expect(fileUpdates()).toContainEqual({
			where: {
				id: { in: heldIds },
				folderId: "folder-1",
				retiredAt: null,
			},
			data: { removalHeldAt: now },
		});
		expect(fileUpdates()).toContainEqual({
			where: {
				folderId: "folder-1",
				retiredAt: null,
				removalHeldAt: { not: null },
				id: { notIn: heldIds },
			},
			data: { removalHeldAt: null },
		});
	});

	it("tombstones 5 of 100 at once, saving each one's own guidance", async () => {
		const now = new Date("2026-11-23T12:00:00Z");
		m.fileFindMany.mockResolvedValue([
			{ id: "file-0", contextId: "context-0" },
			...gone(5).slice(1),
		]);
		m.contextFindMany.mockResolvedValue([
			{
				id: "context-0",
				sourceType: "Contract",
				aiInstructions: "Cite clauses.",
			},
		]);

		const result = await tombstoneDocumentFolderFiles({
			folderId: "folder-1",
			goneFileIds: gone(5).map((f) => f.id),
			presentFileIds: ["file-9"],
			now,
		});

		expect(result).toEqual({
			status: "retired",
			retiredFileIds: ["file-0", "file-1", "file-2", "file-3", "file-4"],
		});
		expect(fileUpdates()).toContainEqual({
			where: {
				id: { in: ["file-9"] },
				folderId: "folder-1",
				retiredAt: null,
			},
			data: { missCount: 0 },
		});
		expect(fileUpdates()).toContainEqual({
			where: {
				id: "file-0",
				retiredAt: null,
				folder: { disconnectedAt: null },
			},
			data: {
				retiredAt: now,
				removalHeldAt: null,
				savedSourceType: "Contract",
				savedAiInstructions: "Cite clauses.",
			},
		});
		expect(fileUpdates()).toContainEqual({
			where: {
				id: { in: ["file-1", "file-2", "file-3", "file-4"] },
				retiredAt: null,
				folder: { disconnectedAt: null },
			},
			data: { retiredAt: now, removalHeldAt: null },
		});
		// Only rows still missing twice are taken.
		expect(m.fileFindMany.mock.calls[0]?.[0].where).toMatchObject({
			folderId: "folder-1",
			retiredAt: null,
			missCount: { gte: 2 },
		});
	});

	it("confirm tombstones the files its hold covers that are still missing, and clears the hold", async () => {
		m.queryRaw.mockResolvedValue([
			{
				id: "folder-1",
				projectId: "project-1",
				disconnectedAt: null,
				pausedRemovalsCode: "MASS_REMOVAL",
			},
		]);
		m.fileFindMany.mockResolvedValue(gone(68));

		expect(
			await confirmDocumentFolderRemovals({
				projectId: "project-1",
				folderId: "folder-1",
				expectedCount: 68,
			}),
		).toEqual({ status: "confirmed", retired: 68 });
		expect(m.fileFindMany.mock.calls[0]?.[0].where).toEqual({
			folderId: "folder-1",
			retiredAt: null,
			removalHeldAt: { not: null },
			missCount: { gte: 2 },
		});
		expect(m.folderUpdate).toHaveBeenCalledWith({
			where: { id: "folder-1" },
			data: { pausedRemovalsCode: null, heldRemovalCount: null },
		});
	});

	it("confirm does nothing when no removal is held", async () => {
		expect(
			await confirmDocumentFolderRemovals({
				projectId: "project-1",
				folderId: "folder-1",
				expectedCount: 70,
			}),
		).toEqual({ status: "nothing_held" });
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
	});

	it("confirm removes nothing when the hold no longer covers the count the editor saw", async () => {
		m.queryRaw.mockResolvedValue([
			{
				id: "folder-1",
				projectId: "project-1",
				disconnectedAt: null,
				pausedRemovalsCode: "MASS_REMOVAL",
			},
		]);
		m.fileFindMany.mockResolvedValue(gone(64));

		expect(
			await confirmDocumentFolderRemovals({
				projectId: "project-1",
				folderId: "folder-1",
				expectedCount: 70,
			}),
		).toEqual({ status: "stale", heldRemovalCount: 64 });
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
		// The folder shows the count the next confirmation must name.
		expect(m.folderUpdate).toHaveBeenCalledWith({
			where: { id: "folder-1" },
			data: { heldRemovalCount: 64 },
		});
	});

	it("confirm clears a hold that no longer covers any file, removing nothing", async () => {
		m.queryRaw.mockResolvedValue([
			{
				id: "folder-1",
				projectId: "project-1",
				disconnectedAt: null,
				pausedRemovalsCode: "MASS_REMOVAL",
			},
		]);
		m.fileFindMany.mockResolvedValue([]);

		expect(
			await confirmDocumentFolderRemovals({
				projectId: "project-1",
				folderId: "folder-1",
				expectedCount: 70,
			}),
		).toEqual({ status: "stale", heldRemovalCount: 0 });
		expect(m.fileUpdateMany).not.toHaveBeenCalled();
		expect(m.folderUpdate).toHaveBeenCalledWith({
			where: { id: "folder-1" },
			data: { pausedRemovalsCode: null, heldRemovalCount: null },
		});
	});
});

describe("a held mass removal, from hold to confirmation", () => {
	const NOW = new Date("2026-11-23T12:00:00Z");
	type Row = Record<string, unknown>;
	let folder: Row;
	let rows: Row[];

	/**
	 * A row filter as these queries write it. An operator it does not know
	 * fails the test rather than matching, so a green run never comes from a
	 * filter this stand-in ignored.
	 */
	const matches = (row: Row, where: Row): boolean =>
		Object.entries(where).every(([key, condition]) => {
			if (key === "folder") {
				// The folder stays connected throughout.
				expect(condition).toEqual({ disconnectedAt: null });
				return true;
			}
			const value = row[key];
			if (
				condition === null ||
				typeof condition !== "object" ||
				condition instanceof Date
			) {
				return value === condition;
			}
			return Object.entries(condition).every(([operator, arg]) => {
				switch (operator) {
					case "in":
						return (arg as unknown[]).includes(value);
					case "notIn":
						return !(arg as unknown[]).includes(value);
					case "gte":
						return (value as number) >= (arg as number);
					case "not":
						if (arg === null) {
							return value !== null;
						}
						break;
				}
				throw new Error(`unsupported filter ${key}.${operator}`);
			});
		});

	const apply = (row: Row, data: Row) => {
		for (const [key, value] of Object.entries(data)) {
			if (
				value !== null &&
				typeof value === "object" &&
				!(value instanceof Date)
			) {
				const { increment, ...rest } = value as { increment?: number };
				if (increment === undefined || Object.keys(rest).length > 0) {
					throw new Error(`unsupported write ${key}`);
				}
				row[key] = (row[key] as number) + increment;
			} else {
				row[key] = value;
			}
		}
	};

	const row = (i: number, missCount: number): Row => ({
		id: `file-${i}`,
		folderId: "folder-1",
		driveItemId: `item-${i}`,
		name: `${i}.pdf`,
		relativePath: `${i}.pdf`,
		size: BigInt(1000),
		sourceModifiedAt: new Date("2026-11-01T00:00:00Z"),
		status: "IMPORTED",
		skipCode: null,
		contextId: `context-${i}`,
		importedVersion: `quickXorHash:${i}`,
		latestVersion: `quickXorHash:${i}`,
		latestVersionSeenCount: 1,
		excludedVersion: null,
		missCount,
		removalHeldAt: null,
		retiredAt: null,
	});

	const listed = (i: number) => ({
		driveItemId: `item-${i}`,
		name: `${i}.pdf`,
		relativePath: `${i}.pdf`,
		size: 1000,
		mimeType: "application/pdf",
		lastModified: "2026-11-01T00:00:00.000Z",
		contentVersion: `quickXorHash:${i}`,
	});

	const fileIds = (from: number, to: number) =>
		Array.from({ length: to - from }, (_, i) => `file-${from + i}`);
	/** Files 12 to 19, which every listing contains. */
	const stillThere = Array.from({ length: 8 }, (_, i) => 12 + i);
	const retiredIds = () =>
		rows.filter((r) => r.retiredAt !== null).map((r) => r.id);

	beforeEach(() => {
		folder = {
			id: "folder-1",
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			readerEpoch: 3,
			lastPassId: "pass-0",
			disconnectedAt: null,
			discoveredAt: NOW,
			pausedRemovalsCode: null,
			heldRemovalCount: null,
		};
		// Twenty files; 0 to 11 are missing from two complete listings.
		rows = [
			...Array.from({ length: 12 }, (_, i) => row(i, 2)),
			...stillThere.map((i) => row(i, 0)),
		];
		m.queryRaw.mockImplementation(async () => [{ ...folder }]);
		m.folderUpdate.mockImplementation(
			async (args: { where: { id: string }; data: Row }) => {
				expect(args.where).toEqual({ id: "folder-1" });
				Object.assign(folder, args.data);
				return { ...folder };
			},
		);
		m.fileFindMany.mockImplementation(async (args: { where: Row }) =>
			rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
		);
		m.fileCount.mockImplementation(
			async (args: { where: Row }) =>
				rows.filter((r) => matches(r, args.where)).length,
		);
		m.fileUpdateMany.mockImplementation(
			async (args: { where: Row; data: Row }) => {
				const hit = rows.filter((r) => matches(r, args.where));
				for (const r of hit) {
					apply(r, args.data);
				}
				return { count: hit.length };
			},
		);
		m.contextFindMany.mockImplementation(
			async (args: { where: { id: { in: string[] } } }) =>
				args.where.id.in.map((id) => ({
					id,
					metadata: {},
					sourceType: null,
					aiInstructions: null,
				})),
		);
	});

	afterEach(() => {
		// The top-level setup does not replace these, so later tests would
		// otherwise inherit this folder.
		m.queryRaw.mockReset();
		m.folderUpdate.mockReset();
		m.fileCount.mockReset();
	});

	// Lookups confirm 0 to 9 gone; those of 10 and 11 were refused, so the
	// sync passes on only the ten.
	const holdTen = () =>
		tombstoneDocumentFolderFiles({
			folderId: "folder-1",
			goneFileIds: fileIds(0, 10),
			presentFileIds: [],
			now: NOW,
		});

	const confirm = (expectedCount: number) =>
		confirmDocumentFolderRemovals({
			projectId: "project-1",
			folderId: "folder-1",
			expectedCount,
			now: NOW,
		});

	const completeListing = (passId: string, present: number[]) =>
		reconcileDocumentFolderListing({
			folderId: "folder-1",
			passId,
			readerEpoch: 3,
			root: { name: "Sales", webUrl: null, drivePath: "/Sales" },
			files: present.map(listed),
			complete: true,
			now: NOW,
		});

	it("confirm retires exactly the files the hold covered, not those whose lookup was refused", async () => {
		expect(await holdTen()).toEqual({ status: "held", heldCount: 10 });
		expect(retiredIds()).toEqual([]);

		expect(await confirm(10)).toEqual({ status: "confirmed", retired: 10 });
		expect(retiredIds()).toEqual(fileIds(0, 10));
		expect(folder).toMatchObject({
			pausedRemovalsCode: null,
			heldRemovalCount: null,
		});
		expect(rows.filter((r) => r.removalHeldAt !== null)).toEqual([]);
	});

	it("a held file seen again is not retired by the confirmation, even once it is missing twice again", async () => {
		await holdTen();
		await completeListing("pass-1", [0, ...stillThere]);
		await completeListing("pass-2", stillThere);
		await completeListing("pass-3", stillThere);
		expect(rows.find((r) => r.id === "file-0")).toMatchObject({
			missCount: 2,
			removalHeldAt: null,
		});
		expect(folder.pausedRemovalsCode).toBe("MASS_REMOVAL");

		expect(await confirm(9)).toEqual({ status: "confirmed", retired: 9 });
		expect(retiredIds()).toEqual(fileIds(1, 10));
		expect(m.fileCreateMany).not.toHaveBeenCalled();
	});

	it("a confirmation of a count the hold no longer has removes nothing and shows the count it has", async () => {
		await holdTen();
		// File 0 is seen again, so the hold now covers nine files while the
		// folder still shows the ten the editor was asked about.
		await completeListing("pass-1", [0, ...stillThere]);
		expect(folder.heldRemovalCount).toBe(10);

		expect(await confirm(10)).toEqual({
			status: "stale",
			heldRemovalCount: 9,
		});
		expect(retiredIds()).toEqual([]);
		expect(folder).toMatchObject({
			pausedRemovalsCode: "MASS_REMOVAL",
			heldRemovalCount: 9,
		});

		// Asked again with the count the folder now shows, it goes through.
		expect(await confirm(9)).toEqual({ status: "confirmed", retired: 9 });
		expect(retiredIds()).toEqual(fileIds(1, 10));
	});

	it("a partial read keeps the hold and its count", async () => {
		await holdTen();

		await reconcileDocumentFolderListing({
			folderId: "folder-1",
			passId: "pass-1",
			readerEpoch: 3,
			root: { name: "Sales", webUrl: null, drivePath: "/Sales" },
			files: stillThere.map(listed),
			complete: false,
			pausedRemovalsCode: "THROTTLED",
			now: NOW,
		});

		expect(folder).toMatchObject({
			pausedRemovalsCode: "MASS_REMOVAL",
			heldRemovalCount: 10,
			lastListingComplete: false,
		});
		expect(await confirm(10)).toEqual({ status: "confirmed", retired: 10 });
	});
});

describe("recordDocumentFolderLookupsThrottled", () => {
	it("shows removals paused as throttled, leaving a held mass removal as it is", async () => {
		await recordDocumentFolderLookupsThrottled({ folderId: "folder-1" });

		expect(m.folderUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "folder-1",
				disconnectedAt: null,
				// A plain `not` would skip the folders with no code at all.
				OR: [
					{ pausedRemovalsCode: null },
					{ pausedRemovalsCode: { not: "MASS_REMOVAL" } },
				],
			},
			data: { pausedRemovalsCode: "THROTTLED" },
		});
	});
});

describe("import claims and outcomes", () => {
	const guarded = {
		id: "file-1",
		retiredAt: null,
		folder: { disconnectedAt: null },
	};

	it("claims only an unretired pending file of a connected folder, recording its version", async () => {
		expect(
			await claimDocumentFolderFile({
				fileId: "file-1",
				version: "quickXorHash:v1",
			}),
		).toBe(true);
		expect(fileUpdates()[0]).toEqual({
			where: {
				...guarded,
				status: { in: ["PENDING", "IMPORTING"] },
				contextId: null,
			},
			data: {
				status: "IMPORTING",
				importedVersion: "quickXorHash:v1",
				failureCode: null,
				skipCode: null,
			},
		});
	});

	it("changes nothing for a tombstoned row or one in a disconnected folder", async () => {
		m.fileUpdateMany.mockResolvedValue({ count: 0 });
		m.fileFindFirst.mockResolvedValue(null);

		expect(
			await claimDocumentFolderFile({ fileId: "file-1", version: "v" }),
		).toBe(false);
		expect(
			await recordDocumentFolderFileOutcome({
				fileId: "file-1",
				contextId: "context-1",
				outcome: "IMPORTED",
			}),
		).toBeNull();
		expect(m.fileFindFirst.mock.calls[0]?.[0].where).toMatchObject(guarded);
	});

	it("creates the context typed by the upload vocabulary, with the file's saved guidance", async () => {
		m.fileFindFirst.mockResolvedValue({
			id: "file-1",
			projectId: "project-1",
			folderId: "folder-1",
			driveItemId: "item-1",
			relativePath: "specs/a.pdf",
			savedSourceType: "Case study",
			savedAiInstructions: "Quote figures exactly.",
			folder: {
				provider: "sharepoint",
				userId: "user-2",
				organizationId: "org-1",
			},
		});
		m.contextCreate.mockResolvedValue({ id: "context-9" });

		expect(
			await createDocumentFolderFileContext({
				fileId: "file-1",
				s3Path: "projects/project-1/a.pdf",
				s3Bucket: "contexts",
				originalFilename: "a.pdf",
				mimeType: "application/octet-stream",
				fileSize: 1000,
			}),
		).toEqual({ status: "created", contextId: "context-9" });
		expect(m.contextCreate.mock.calls[0]?.[0].data).toMatchObject({
			projectId: "project-1",
			type: "DOCUMENT",
			mimeType: "application/pdf",
			metadata: {
				provider: "sharepoint-documents",
				folderId: "folder-1",
				driveItemId: "item-1",
				relativePath: "specs/a.pdf",
			},
			sourceType: "Case study",
			aiInstructions: "Quote figures exactly.",
			userId: "user-2",
			organizationId: "org-1",
		});
		expect(fileUpdates()[0]).toEqual({
			where: { ...guarded, status: "IMPORTING", contextId: null },
			data: {
				contextId: "context-9",
				storageKey: "projects/project-1/a.pdf",
				savedSourceType: null,
				savedAiInstructions: null,
			},
		});
	});

	it("returns the context another attempt attached first", async () => {
		m.fileFindFirst.mockResolvedValue({
			id: "file-1",
			projectId: "project-1",
			folderId: "folder-1",
			driveItemId: "item-1",
			relativePath: "a.pdf",
			savedSourceType: null,
			savedAiInstructions: null,
			folder: {
				provider: "onedrive",
				userId: "user-2",
				organizationId: "org-1",
			},
		});
		m.contextCreate.mockResolvedValue({ id: "context-2" });
		m.fileUpdateMany.mockResolvedValue({ count: 0 });
		m.fileFindUnique.mockResolvedValue({
			status: "IMPORTING",
			contextId: "context-1",
			retiredAt: null,
		});

		expect(
			await createDocumentFolderFileContext({
				fileId: "file-1",
				s3Path: "k",
				s3Bucket: "b",
				originalFilename: "a.txt",
				mimeType: "text/plain",
				fileSize: 1,
			}),
		).toEqual({ status: "existing", contextId: "context-1" });
	});

	it("records an exclusion at the claimed version when the context was removed mid-import", async () => {
		m.fileFindFirst.mockResolvedValue({
			importedVersion: "quickXorHash:v1",
		});
		m.contextFindUnique.mockResolvedValue(null);

		expect(
			await recordDocumentFolderFileOutcome({
				fileId: "file-1",
				contextId: "context-1",
				outcome: "IMPORTED",
			}),
		).toBe("EXCLUDED");
		expect(fileUpdates()[0]).toEqual({
			where: { ...guarded, status: "IMPORTING", contextId: "context-1" },
			data: {
				status: "EXCLUDED",
				excludedVersion: "quickXorHash:v1",
				contextId: null,
				storageKey: null,
				failureCode: null,
				skipCode: null,
			},
		});
	});

	it("records a download over the byte cap as skipped too big", async () => {
		m.fileFindFirst.mockResolvedValue({ importedVersion: "v1" });

		expect(
			await recordDocumentFolderFileOutcome({
				fileId: "file-1",
				contextId: null,
				outcome: "SKIPPED",
				skipCode: "TOO_BIG",
			}),
		).toBe("SKIPPED");
		expect(fileUpdates()[0]?.data).toEqual({
			status: "SKIPPED",
			skipCode: "TOO_BIG",
			failureCode: null,
		});
	});

	it("records a failure with its code", async () => {
		m.fileFindFirst.mockResolvedValue({ importedVersion: "v1" });
		m.contextFindUnique.mockResolvedValue({ id: "context-1" });

		expect(
			await recordDocumentFolderFileOutcome({
				fileId: "file-1",
				contextId: "context-1",
				outcome: "FAILED",
				failureCode: "PROCESSING_FAILED",
			}),
		).toBe("FAILED");
		expect(fileUpdates()[0]?.data).toEqual({
			status: "FAILED",
			failureCode: "PROCESSING_FAILED",
			skipCode: null,
		});
	});
});

describe("deletion follow-up", () => {
	it("lists rows holding a context that a retirement, refresh or cap move left to delete", async () => {
		m.fileFindMany.mockResolvedValue([
			{
				id: "file-1",
				folderId: "folder-1",
				contextId: "context-1",
				storageKey: "k",
			},
		]);

		expect(
			await listDocumentFolderFilesNeedingDeletion({
				projectId: "project-1",
			}),
		).toEqual([
			{
				fileId: "file-1",
				folderId: "folder-1",
				contextId: "context-1",
				storageKey: "k",
			},
		]);
		const call = m.fileFindMany.mock.calls[0]?.[0];
		expect(call.where).toEqual({
			projectId: "project-1",
			contextId: { not: null },
			// A disconnected folder's files stay as ordinary context.
			folder: { disconnectedAt: null },
			OR: [
				{ retiredAt: { not: null } },
				{ status: "REFRESHING" },
				{ status: "SKIPPED", skipCode: "CAP_REACHED" },
			],
		});
		expect(call.take).toBe(200);
	});

	const deletionRow = (overrides: Record<string, unknown> = {}) => ({
		status: "REFRESHING",
		retiredAt: null,
		lastSeenAt: null,
		latestVersion: "v2",
		excludedVersion: null,
		name: "a.pdf",
		size: BigInt(10),
		...overrides,
	});

	const complete = () =>
		completeDocumentFolderFileDeletion({
			fileId: "file-1",
			contextId: "context-1",
			deletionConfirmed: true,
		});

	it("returns a refreshing file to pending once its old context is confirmed gone", async () => {
		m.fileFindFirst.mockResolvedValue(deletionRow());

		expect(await complete()).toBe("PENDING");
		expect(fileUpdates()[0]).toEqual({
			where: { id: "file-1", contextId: "context-1" },
			data: {
				contextId: null,
				storageKey: null,
				status: "PENDING",
				skipCode: null,
				failureCode: null,
			},
		});
	});

	it("returns a retired file seen again to its exclusion at the same version", async () => {
		m.fileFindFirst.mockResolvedValue(
			deletionRow({
				status: "EXCLUDED",
				retiredAt: new Date("2026-11-20T00:00:00Z"),
				lastSeenAt: new Date("2026-11-21T00:00:00Z"),
				excludedVersion: "v2",
			}),
		);

		expect(await complete()).toBe("EXCLUDED");
		expect(fileUpdates()[0]?.data).toMatchObject({
			contextId: null,
			retiredAt: null,
			missCount: 0,
			status: "EXCLUDED",
		});
	});

	it("returns a retired file seen again at another version to pending", async () => {
		m.fileFindFirst.mockResolvedValue(
			deletionRow({
				status: "IMPORTED",
				retiredAt: new Date("2026-11-20T00:00:00Z"),
				lastSeenAt: new Date("2026-11-21T00:00:00Z"),
			}),
		);

		expect(await complete()).toBe("PENDING");
	});

	it("only clears the context of a retired file not seen since", async () => {
		m.fileFindFirst.mockResolvedValue(
			deletionRow({
				status: "IMPORTED",
				retiredAt: new Date("2026-11-20T00:00:00Z"),
				lastSeenAt: new Date("2026-11-19T00:00:00Z"),
			}),
		);

		expect(await complete()).toBe("IMPORTED");
		expect(fileUpdates()[0]?.data).toEqual({
			contextId: null,
			storageKey: null,
		});
	});
});

describe("listDocumentFolderSyncState", () => {
	it("tells connected from due, and when the next throttled folder may be read", async () => {
		const now = new Date("2026-11-23T12:00:00Z");
		const later = new Date("2026-11-23T12:10:00Z");
		m.folderFindMany.mockResolvedValue([
			{ id: "folder-1", nextReadAfter: null },
			{ id: "folder-2", nextReadAfter: later },
		]);

		expect(
			await listDocumentFolderSyncState({ projectId: "project-1", now }),
		).toEqual({
			anyConnected: true,
			dueFolderIds: ["folder-1"],
			nextReadAfter: later,
		});
	});
});

describe("a read's start and finish", () => {
	it("starts nothing for a disconnected folder", async () => {
		m.folderUpdateMany.mockResolvedValue({ count: 0 });

		expect(await startDocumentFolderRead({ folderId: "folder-1" })).toBe(
			null,
		);
		expect(m.folderUpdateMany.mock.calls[0]?.[0].where).toEqual({
			id: "folder-1",
			disconnectedAt: null,
		});
		expect(m.folderFindUnique).not.toHaveBeenCalled();
	});

	it("applies a finish only for the reader epoch the read started with", async () => {
		const later = new Date("2026-11-23T12:10:00Z");

		await finishDocumentFolderRead({
			folderId: "folder-1",
			readerEpoch: 3,
			nextReadAfter: later,
		});

		expect(m.folderUpdateMany).toHaveBeenCalledWith({
			where: { id: "folder-1", readerEpoch: 3 },
			data: { readStartedAt: null, nextReadAfter: later },
		});
	});

	it("keeps the shown problem when given none, and clears it when given null", async () => {
		await finishDocumentFolderRead({
			folderId: "folder-1",
			readerEpoch: 3,
		});
		await finishDocumentFolderRead({
			folderId: "folder-1",
			readerEpoch: 3,
			problemCode: null,
		});
		await finishDocumentFolderRead({
			folderId: "folder-1",
			readerEpoch: 3,
			problemCode: "NO_ACCESS",
		});

		const data = m.folderUpdateMany.mock.calls.map((call) => call[0].data);
		expect(data[0]).toEqual({ readStartedAt: null, nextReadAfter: null });
		expect(data[1]).toEqual({
			readStartedAt: null,
			nextReadAfter: null,
			problemCode: null,
		});
		expect(data[2]).toEqual({
			readStartedAt: null,
			nextReadAfter: null,
			problemCode: "NO_ACCESS",
		});
	});
});

describe("listPendingDocumentFolderFileIds", () => {
	it("queues the connected folder's waiting and interrupted files, newest first", async () => {
		m.fileFindMany.mockResolvedValue([{ id: "file-2" }, { id: "file-1" }]);

		expect(
			await listPendingDocumentFolderFileIds({
				folderId: "folder-1",
				limit: 25,
			}),
		).toEqual(["file-2", "file-1"]);
		expect(m.fileFindMany).toHaveBeenCalledWith({
			where: {
				folderId: "folder-1",
				retiredAt: null,
				status: { in: ["PENDING", "IMPORTING"] },
				folder: { disconnectedAt: null },
			},
			orderBy: [{ sourceModifiedAt: "desc" }, { id: "asc" }],
			take: 25,
			select: { id: true },
		});
	});
});

// --- The reconciliation plan, without a database ---

const DAY = 24 * 60 * 60 * 1000;

function listed(
	id: string,
	overrides: Partial<DocumentFolderListedFile> = {},
): DocumentFolderListedFile {
	return {
		driveItemId: id,
		name: `${id}.pdf`,
		relativePath: `specs/${id}.pdf`,
		size: 1000,
		mimeType: "application/pdf",
		lastModified: "2026-11-01T00:00:00.000Z",
		contentVersion: `quickXorHash:${id}-v1`,
		...overrides,
	};
}

function row(
	id: string,
	overrides: Partial<DocumentFolderLedgerRow> = {},
): DocumentFolderLedgerRow {
	return {
		id: `file-${id}`,
		driveItemId: id,
		name: `${id}.pdf`,
		relativePath: `specs/${id}.pdf`,
		size: 1000,
		sourceModifiedAt: new Date("2026-11-01T00:00:00.000Z"),
		status: "IMPORTED",
		skipCode: null,
		contextId: `context-${id}`,
		importedVersion: `quickXorHash:${id}-v1`,
		latestVersion: `quickXorHash:${id}-v1`,
		latestVersionSeenCount: 1,
		excludedVersion: null,
		missCount: 0,
		retiredAt: null,
		...overrides,
	};
}

/** Rows as they stand after the plan is written. */
function apply(
	rows: DocumentFolderLedgerRow[],
	plan: ReturnType<typeof planDocumentFolderReconcile>,
): DocumentFolderLedgerRow[] {
	const missed = new Set(plan.missedIds);
	const reset = new Set(plan.resetMissIds);
	return rows.map((current) => {
		const update = plan.updates.find((u) => u.id === current.id);
		const next = { ...current, ...(update?.data ?? {}) };
		if (missed.has(current.id)) {
			next.missCount = current.missCount + 1;
		}
		if (reset.has(current.id)) {
			next.missCount = 0;
		}
		return next as DocumentFolderLedgerRow;
	});
}

function plan(
	rows: DocumentFolderLedgerRow[],
	files: DocumentFolderListedFile[],
	options: { complete?: boolean; liveContextIds?: string[] } = {},
) {
	return planDocumentFolderReconcile({
		rows,
		files,
		complete: options.complete ?? true,
		liveContextIds: new Set(
			options.liveContextIds ??
				rows.flatMap((r) => (r.contextId ? [r.contextId] : [])),
		),
	});
}

describe("classifyDocumentFolderFile", () => {
	it("types a supported file by the upload vocabulary", () => {
		expect(
			classifyDocumentFolderFile({
				name: "a.pdf",
				mimeType: "application/pdf",
				size: 10,
			}),
		).toEqual({ status: "PENDING", skipCode: null });
	});

	it("skips a format the upload vocabulary does not take", () => {
		expect(
			classifyDocumentFolderFile({
				name: "deck.pptx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				size: 10,
			}),
		).toEqual({ status: "SKIPPED", skipCode: "UNSUPPORTED" });
	});

	it("skips a file over its type's size limit", () => {
		expect(
			classifyDocumentFolderFile({
				name: "big.pdf",
				mimeType: "application/pdf",
				size: 21 * 1024 * 1024,
			}),
		).toEqual({ status: "SKIPPED", skipCode: "TOO_BIG" });
	});
});

describe("normalizeDocumentFolderDescription", () => {
	it("collapses line breaks and removes control characters", () => {
		expect(
			normalizeDocumentFolderDescription(
				"  Signed\r\n\n customer\u0007 case\tstudies  ",
			),
		).toBe("Signed customer case studies");
	});

	it("stores an empty description as none", () => {
		expect(normalizeDocumentFolderDescription(" \n ")).toBeNull();
		expect(normalizeDocumentFolderDescription(null)).toBeNull();
	});

	it("keeps at most 500 characters", () => {
		expect(
			normalizeDocumentFolderDescription("a".repeat(600)),
		).toHaveLength(500);
	});
});

describe("foldersOverlap", () => {
	const at = (driveId: string, drivePath: string | null) => ({
		driveId,
		drivePath,
	});

	it("finds a folder inside another, and one containing another", () => {
		expect(
			foldersOverlap(at("d", "/Sales"), at("d", "/Sales/Case studies")),
		).toBe(true);
		expect(
			foldersOverlap(at("d", "/sales/case studies"), at("d", "/Sales")),
		).toBe(true);
	});

	it("does not confuse a sibling whose name starts the same", () => {
		expect(foldersOverlap(at("d", "/Sales"), at("d", "/Sales 2"))).toBe(
			false,
		);
	});

	it("treats the drive root as containing everything in that drive only", () => {
		expect(foldersOverlap(at("d", "/"), at("d", "/Sales"))).toBe(true);
		expect(foldersOverlap(at("d", "/"), at("e", "/Sales"))).toBe(false);
	});

	it("cannot tell without both paths", () => {
		expect(foldersOverlap(at("d", null), at("d", "/Sales"))).toBe(false);
	});
});

describe("planDocumentFolderReconcile", () => {
	describe("removal by complete listings", () => {
		it("counts one miss, makes a second miss a candidate, and resets on sight", () => {
			let rows = [row("a"), row("b")];

			const first = plan(rows, [listed("b")]);
			rows = apply(rows, first);
			expect(rows.find((r) => r.id === "file-a")?.missCount).toBe(1);
			expect(first.candidates).toEqual([]);

			const second = plan(rows, [listed("b")]);
			rows = apply(rows, second);
			expect(second.candidates).toEqual([
				{ fileId: "file-a", driveItemId: "a" },
			]);

			const third = plan(rows, [listed("a"), listed("b")]);
			rows = apply(rows, third);
			expect(rows.find((r) => r.id === "file-a")?.missCount).toBe(0);
			expect(third.candidates).toEqual([]);
		});

		it("on a truncated listing records new files and renames but no misses and no cap moves", () => {
			const rows = [row("a"), row("gone", { missCount: 1 })];
			const result = plan(
				rows,
				[
					listed("a", {
						name: "renamed.pdf",
						relativePath: "x/renamed.pdf",
					}),
					listed("new"),
				],
				{ complete: false },
			);

			expect(result.missedIds).toEqual([]);
			expect(result.resetMissIds).toEqual([]);
			expect(result.candidates).toEqual([]);
			expect(
				result.inserts.map((i) => [i.driveItemId, i.status]),
			).toEqual([["new", "PENDING"]]);
			expect(apply(rows, result)[0]).toMatchObject({
				name: "renamed.pdf",
				relativePath: "x/renamed.pdf",
			});
		});
	});

	describe("rename and move within the folder", () => {
		it("updates name and path, renames the context and starts no refresh", () => {
			const rows = [row("a")];
			const result = plan(rows, [
				listed("a", {
					name: "Final.pdf",
					relativePath: "other/Final.pdf",
				}),
			]);

			expect(apply(rows, result)[0]).toMatchObject({
				status: "IMPORTED",
				name: "Final.pdf",
				relativePath: "other/Final.pdf",
				contextId: "context-a",
			});
			expect(result.renamedContexts).toEqual([
				{
					contextId: "context-a",
					name: "Final.pdf",
					relativePath: "other/Final.pdf",
				},
			]);
			expect(result.counts.refreshQueued).toBe(0);
		});
	});

	describe("content changes", () => {
		const v2 = { contentVersion: "quickXorHash:a-v2" };

		it("starts a refresh only after the same new version is seen in two listings", () => {
			let rows = [row("a")];

			const first = plan(rows, [listed("a", v2)]);
			rows = apply(rows, first);
			expect(rows[0]).toMatchObject({
				status: "IMPORTED",
				latestVersion: "quickXorHash:a-v2",
				latestVersionSeenCount: 1,
			});

			// A read that does not list the file keeps the streak.
			rows = apply(rows, plan(rows, [], { complete: false }));

			const second = plan(rows, [listed("a", v2)]);
			rows = apply(rows, second);
			expect(rows[0]?.status).toBe("REFRESHING");
			expect(second.updates[0]?.saveGuidanceFromContextId).toBe(
				"context-a",
			);
		});

		it("restarts the streak when the file changes again", () => {
			let rows = [row("a")];
			rows = apply(rows, plan(rows, [listed("a", v2)]));
			rows = apply(
				rows,
				plan(rows, [
					listed("a", { contentVersion: "quickXorHash:a-v3" }),
				]),
			);

			expect(rows[0]).toMatchObject({
				status: "IMPORTED",
				latestVersion: "quickXorHash:a-v3",
				latestVersionSeenCount: 1,
			});
		});

		it("sends a failed file holding a context through deletion before it returns to pending", () => {
			let rows = [row("a", { status: "FAILED" })];
			rows = apply(rows, plan(rows, [listed("a", v2)]));
			rows = apply(rows, plan(rows, [listed("a", v2)]));

			expect(rows[0]).toMatchObject({
				status: "REFRESHING",
				contextId: "context-a",
			});
		});

		it("returns a failed file without a context to pending on a stable new version", () => {
			let rows = [row("a", { status: "FAILED", contextId: null })];
			rows = apply(rows, plan(rows, [listed("a", v2)]));
			rows = apply(rows, plan(rows, [listed("a", v2)]));

			expect(rows[0]?.status).toBe("PENDING");
		});

		it("re-checks an unsupported file on a new version", () => {
			const rows = [
				row("a", {
					status: "SKIPPED",
					skipCode: "TOO_BIG",
					contextId: null,
					importedVersion: null,
				}),
			];
			const result = plan(rows, [listed("a", { ...v2, size: 100 })]);

			expect(apply(rows, result)[0]).toMatchObject({
				status: "PENDING",
				skipCode: null,
			});
		});
	});

	describe("contexts removed by hand", () => {
		it("excludes the file, and only a different version brings it back", () => {
			let rows = [row("a")];

			rows = apply(
				rows,
				plan(rows, [listed("a")], { liveContextIds: [] }),
			);
			expect(rows[0]).toMatchObject({
				status: "EXCLUDED",
				contextId: null,
				excludedVersion: "quickXorHash:a-v1",
			});

			rows = apply(
				rows,
				plan(rows, [listed("a")], { liveContextIds: [] }),
			);
			expect(rows[0]?.status).toBe("EXCLUDED");

			rows = apply(
				rows,
				plan(rows, [
					listed("a", { contentVersion: "quickXorHash:a-v2" }),
				]),
			);
			expect(rows[0]).toMatchObject({
				status: "PENDING",
				excludedVersion: null,
			});
		});

		it("excludes an imported file whose context was removed even when the listing misses it", () => {
			const rows = [row("a")];
			const after = apply(rows, plan(rows, [], { liveContextIds: [] }));

			expect(after[0]).toMatchObject({
				status: "EXCLUDED",
				contextId: null,
				excludedVersion: "quickXorHash:a-v1",
				missCount: 1,
			});
		});

		it("returns a retired file to its exclusion when it comes back at the excluded version", () => {
			const rows = [
				row("a", {
					status: "EXCLUDED",
					contextId: null,
					excludedVersion: "quickXorHash:a-v1",
					retiredAt: new Date(),
					missCount: 2,
				}),
			];
			const result = plan(rows, [listed("a")]);

			expect(apply(rows, result)[0]).toMatchObject({
				status: "EXCLUDED",
				retiredAt: null,
				missCount: 0,
			});
		});

		it("returns a retired file to pending at any other version", () => {
			const rows = [
				row("a", {
					contextId: null,
					retiredAt: new Date(),
					missCount: 2,
				}),
			];

			expect(apply(rows, plan(rows, [listed("a")]))[0]).toMatchObject({
				status: "PENDING",
				retiredAt: null,
			});
		});

		it("leaves a retired file alone while its old context is still being deleted", () => {
			const rows = [row("a", { retiredAt: new Date(), missCount: 2 })];
			const result = plan(rows, [listed("a")]);

			expect(apply(rows, result)[0]?.retiredAt).not.toBeNull();
		});
	});

	describe("the import cap", () => {
		const files = Array.from({ length: 600 }, (_, i) =>
			listed(`f${i}`, {
				lastModified: new Date(
					Date.UTC(2026, 0, 1) + i * DAY,
				).toISOString(),
			}),
		);

		it("keeps the 500 most recently modified files and skips the rest", () => {
			const result = plan([], files);
			const pending = result.inserts.filter(
				(i) => i.status === "PENDING",
			);
			const capped = result.inserts.filter(
				(i) => i.skipCode === "CAP_REACHED",
			);

			expect(pending).toHaveLength(500);
			expect(capped).toHaveLength(100);
			expect(capped.map((i) => i.driveItemId)).toContain("f0");
			expect(capped.map((i) => i.driveItemId)).not.toContain("f599");
		});

		it("displaces the oldest imported file when a newer one arrives", () => {
			const rows = files.slice(100).map((f) =>
				row(f.driveItemId, {
					sourceModifiedAt: new Date(f.lastModified as string),
				}),
			);
			const newer = listed("newest", {
				lastModified: new Date(Date.UTC(2028, 0, 1)).toISOString(),
			});
			const result = plan(rows, [...files.slice(100), newer]);
			const after = apply(rows, result);

			expect(result.inserts[0]).toMatchObject({
				driveItemId: "newest",
				status: "PENDING",
			});
			expect(after.find((r) => r.driveItemId === "f100")).toMatchObject({
				status: "SKIPPED",
				skipCode: "CAP_REACHED",
				contextId: "context-f100",
			});
			expect(
				result.updates.find((u) => u.id === "file-f100")
					?.saveGuidanceFromContextId,
			).toBe("context-f100");
		});

		it("does not bring back a capped file on a new version that leaves it outside the window", () => {
			const capped = row("f0", {
				status: "SKIPPED",
				skipCode: "CAP_REACHED",
				contextId: null,
			});
			const rows = [
				capped,
				...files.slice(100).map((f) =>
					row(f.driveItemId, {
						sourceModifiedAt: new Date(f.lastModified as string),
					}),
				),
			];
			const result = plan(rows, [
				listed("f0", {
					contentVersion: "quickXorHash:f0-v2",
					lastModified: files[0]?.lastModified,
				}),
				...files.slice(100),
			]);

			expect(apply(rows, result)[0]).toMatchObject({
				status: "SKIPPED",
				skipCode: "CAP_REACHED",
			});
		});

		it("keeps an unsupported file that becomes supported outside the window skipped for the cap", () => {
			const unsupported = row("old", {
				status: "SKIPPED",
				skipCode: "UNSUPPORTED",
				contextId: null,
				importedVersion: null,
			});
			const rows = [
				unsupported,
				...files.slice(100).map((f) =>
					row(f.driveItemId, {
						sourceModifiedAt: new Date(f.lastModified as string),
					}),
				),
			];
			const result = plan(rows, [
				listed("old", {
					contentVersion: "quickXorHash:old-v2",
					lastModified: files[0]?.lastModified,
				}),
				...files.slice(100),
			]);

			expect(apply(rows, result)[0]).toMatchObject({
				status: "SKIPPED",
				skipCode: "CAP_REACHED",
			});
		});

		it("brings a capped file back into the window only once its old context is deleted", () => {
			const displaced = row("a", {
				status: "SKIPPED",
				skipCode: "CAP_REACHED",
			});

			expect(
				apply([displaced], plan([displaced], [listed("a")]))[0],
			).toMatchObject({
				status: "SKIPPED",
				contextId: "context-a",
			});

			const deleted = { ...displaced, contextId: null };
			expect(
				apply([deleted], plan([deleted], [listed("a")]))[0],
			).toMatchObject({
				status: "PENDING",
				skipCode: null,
			});
		});
	});
});

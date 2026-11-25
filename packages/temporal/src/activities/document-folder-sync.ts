/**
 * Keeping OneDrive, SharePoint and Google Drive document folders in step with
 * the drive (Fizzy #2808). Run by `documentFolderSyncWorkflow`, one project at
 * a time. Each folder is read through the drive adapter of its stored
 * provider; what a read's result means for the folder does not depend on it.
 *
 * A folder is read only with its reader's own drive connection, and every
 * read, confirmation and import first checks again that the project still
 * has an organization, that it is the folder's, that the feature is on for
 * it, and that the reader may still add context to the project. The
 * organization always comes from the project row, never from the workflow.
 *
 * What a read cannot settle removes nothing: a failed, refused, truncated or
 * throttled read records why on the folder, and a removal candidate whose
 * lookup did not answer stays where it is. Drive error text is never stored
 * or logged; download addresses and folder descriptions never are either.
 *
 * Every activity is safe to repeat: the queries they call are conditional on
 * the state they read, and reconciliation applies a pass id once.
 */

import { createHash } from "node:crypto";
import { config } from "@repo/config";
import {
	canCreateProjectContexts,
	claimDocumentFolderFile,
	completeDocumentFolderFileDeletion,
	createDocumentFolderFileContext,
	DOCUMENT_FOLDER_DELETIONS_PER_PASS,
	DOCUMENT_FOLDER_FAILURE_CODE,
	DOCUMENT_FOLDER_FILE_STATUS,
	DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE,
	DOCUMENT_FOLDER_PROBLEM_CODE,
	DOCUMENT_FOLDER_SKIP_CODE,
	type DocumentFolderListedFile,
	type DocumentFolderProblemCode,
	db,
	finishDocumentFolderRead,
	getDocumentFolderFileForImport,
	isFeatureEnabled,
	listDocumentFolderFilesNeedingDeletion,
	listDocumentFolderSyncState,
	listPendingDocumentFolderFileIds,
	reconcileDocumentFolderListing,
	recordDocumentFolderFileOutcome,
	recordDocumentFolderLookupsThrottled,
	startDocumentFolderRead,
	tombstoneDocumentFolderFiles,
} from "@repo/database";
import {
	type DocumentFolderConnection,
	type DocumentFolderDownload,
	type DocumentFolderDriveAdapter,
	type DriveItemPlacement,
	documentFolderDriveAdapter,
} from "@repo/integrations/document-folders";
import { logger } from "@repo/logs";
import { deleteProjectContext } from "@repo/rag";
import { deleteFile, uploadFile } from "@repo/storage";
import {
	contextUploadConfigFor,
	resolveContextUploadMime,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import { heartbeat } from "@temporalio/activity";

const LOG = "[DocumentFolder]";

/** Wait after a throttled drive answer that named no time of its own. */
const DEFAULT_THROTTLE_WAIT_SECONDS = 5 * 60;

/** The most any file type may be: the bound on a download before it is typed. */
const LARGEST_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD_SIZE_LIMITS));

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isThrottled(httpStatus: number): boolean {
	return httpStatus === 429 || httpStatus === 503;
}

function throttledUntil(retryAfterSeconds: number | null): Date {
	return new Date(
		Date.now() +
			(retryAfterSeconds ?? DEFAULT_THROTTLE_WAIT_SECONDS) * 1000,
	);
}

/** What a refused root read means for the folder. */
function rootFailure(failure: {
	httpStatus: number;
	retryAfterSeconds: number | null;
}): { problemCode?: DocumentFolderProblemCode; nextReadAfter?: Date } {
	if (failure.httpStatus === 401) {
		return { problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.RECONNECT };
	}
	if (failure.httpStatus === 403) {
		return { problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.NO_ACCESS };
	}
	if (failure.httpStatus === 404) {
		return { problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.FOLDER_GONE };
	}
	if (isThrottled(failure.httpStatus)) {
		return { nextReadAfter: throttledUntil(failure.retryAfterSeconds) };
	}
	// Anything else is the drive's own trouble: nothing to show, try next pass.
	return {};
}

interface FolderReader {
	projectId: string;
	userId: string;
	organizationId: string | null;
}

type ReaderCheck =
	| {
			ok: true;
			organizationId: string;
			connection: DocumentFolderConnection;
	  }
	/** Refused; a null problem is the feature being off, which shows nothing. */
	| { ok: false; problemCode: DocumentFolderProblemCode | null };

/** The project's organization, from its row; null when it has none. */
async function projectOrganizationId(
	projectId: string,
): Promise<string | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	return project?.organizationId ?? null;
}

function featureOn(organizationId: string): Promise<boolean> {
	return isFeatureEnabled("CLOUD_DRIVE_FOLDERS", organizationId);
}

/**
 * The project's organization, and whether the feature is on for it. A
 * project without one is never read or changed.
 */
async function enabledOrganizationOf(
	projectId: string,
): Promise<{ organizationId: string | null; enabled: boolean }> {
	const organizationId = await projectOrganizationId(projectId);
	if (!organizationId) {
		return { organizationId: null, enabled: false };
	}
	return { organizationId, enabled: await featureOn(organizationId) };
}

/**
 * May this folder be read now, as its reader? Checked before every read,
 * confirmation and import, not only at connect: access can be lost at any
 * time, and nothing private is read or stored for someone who lost it.
 */
async function checkReader(
	folder: FolderReader,
	adapter: DocumentFolderDriveAdapter,
): Promise<ReaderCheck> {
	const organizationId = await projectOrganizationId(folder.projectId);
	if (!organizationId || organizationId !== folder.organizationId) {
		return {
			ok: false,
			problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.NO_ACCESS,
		};
	}
	if (!(await featureOn(organizationId))) {
		return { ok: false, problemCode: null };
	}
	if (!(await canCreateProjectContexts(folder.projectId, folder.userId))) {
		return {
			ok: false,
			problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.NO_ACCESS,
		};
	}
	// The reader's own connection only, never one shared with the
	// organization. One the drive cannot read folders with, such as a Google
	// grant without `drive.readonly`, needs connecting again too.
	const own = await adapter.resolveOwnConnection({
		userId: folder.userId,
		organizationId,
	});
	if (own.status !== "connected") {
		return {
			ok: false,
			problemCode: DOCUMENT_FOLDER_PROBLEM_CODE.RECONNECT,
		};
	}
	return { ok: true, organizationId, connection: own.connection };
}

function heartbeatProgress(progress: { requests: number; items: number }) {
	heartbeat(progress);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface DocumentFolderSyncState {
	anyConnected: boolean;
	dueFolderIds: string[];
	/** ISO time the earliest throttled folder may be read again. */
	nextReadAfter: string | null;
}

/**
 * Whether the project has any connected document folder, and which may be
 * read now. With the feature off nothing is due, so the workflow waits
 * rather than ends.
 */
export async function listDocumentFoldersToSync(input: {
	projectId: string;
}): Promise<DocumentFolderSyncState> {
	const state = await listDocumentFolderSyncState({
		projectId: input.projectId,
	});
	if (!state.anyConnected) {
		return { anyConnected: false, dueFolderIds: [], nextReadAfter: null };
	}
	const { enabled } = await enabledOrganizationOf(input.projectId);
	if (!enabled) {
		return { anyConnected: true, dueFolderIds: [], nextReadAfter: null };
	}
	return {
		anyConnected: true,
		dueFolderIds: state.dueFolderIds,
		nextReadAfter: state.nextReadAfter?.toISOString() ?? null,
	};
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadDocumentFolderOutput {
	/** A complete listing was reconciled: its candidates may be confirmed. */
	complete: boolean;
	/** Files missing from two complete listings, to look up by id. */
	candidates: Array<{ fileId: string; driveItemId: string }>;
	/** ISO time the folder may be read again, when the drive throttled it. */
	nextReadAfter: string | null;
}

/** A read that reconciled nothing, so confirms nothing. */
function nothingRead(nextReadAfter?: Date): ReadDocumentFolderOutput {
	return {
		complete: false,
		candidates: [],
		nextReadAfter: nextReadAfter?.toISOString() ?? null,
	};
}

/**
 * Read one folder: probe its root, list its tree, and reconcile the listing
 * under the workflow's pass id. Marks the read as running for its duration
 * and clears that on every exit, failed or not.
 */
export async function readDocumentFolder(input: {
	folderId: string;
	passId: string;
}): Promise<ReadDocumentFolderOutput> {
	const folder = await startDocumentFolderRead({ folderId: input.folderId });
	if (!folder) {
		return nothingRead();
	}
	let problemCode: DocumentFolderProblemCode | undefined;
	let nextReadAfter: Date | undefined;
	let adapter: DocumentFolderDriveAdapter | undefined;
	try {
		adapter = documentFolderDriveAdapter(folder.provider);
		const check = await checkReader(folder, adapter);
		if (!check.ok) {
			problemCode = check.problemCode ?? undefined;
			return nothingRead();
		}
		const drive = { driveId: folder.driveId, itemId: folder.itemId };

		heartbeat("reading folder root");
		const root = await adapter.getItemDetails(check.connection, drive);
		if (root.status === "failed") {
			({ problemCode, nextReadAfter } = rootFailure(root));
			return nothingRead(nextReadAfter);
		}

		const listing = await adapter.listFolderTree(check.connection, drive, {
			onProgress: heartbeatProgress,
		});
		if (listing.status === "root_failed") {
			({ problemCode, nextReadAfter } = rootFailure(listing));
			return nothingRead(nextReadAfter);
		}

		const files: DocumentFolderListedFile[] = listing.files.map((file) => ({
			driveItemId: file.id,
			name: file.name,
			relativePath: file.relativePath,
			size: file.size,
			mimeType: file.mimeType,
			lastModified: file.lastModified,
			contentVersion: file.contentVersion,
			...(file.notDownloadable ? { notDownloadable: true as const } : {}),
		}));
		const common = {
			folderId: folder.id,
			passId: input.passId,
			readerEpoch: folder.readerEpoch,
			root: {
				// A drive's root, which has no parent, is named `root` by
				// Graph; it keeps the name it was connected under.
				name:
					root.item.parentPath === null
						? folder.name
						: root.item.name,
				webUrl: root.item.webUrl,
				// The folder's own path in its drive, from its parent's.
				drivePath: root.item.drivePath ?? folder.drivePath,
				// Absent where the path decides overlap, or the walk was cut
				// short; the stored ids are then kept.
				...(root.item.ancestorIds
					? { ancestorIds: root.item.ancestorIds }
					: {}),
			},
			files,
		};

		heartbeat("reconciling");
		let result: Awaited<ReturnType<typeof reconcileDocumentFolderListing>>;
		if (listing.status === "complete") {
			result = await reconcileDocumentFolderListing({
				...common,
				complete: true,
			});
		} else {
			// A partial listing records what it found and removes nothing;
			// only a later complete read resumes removals. A page refused by
			// throttling waits for the drive's time; one refused for any other
			// reason, or a search the drive did not finish, is a partial read,
			// tried again on the next pass.
			const throttledPage =
				listing.reason === "page_failed" &&
				isThrottled(listing.httpStatus);
			if (throttledPage) {
				nextReadAfter = throttledUntil(listing.retryAfterSeconds);
			}
			result = await reconcileDocumentFolderListing({
				...common,
				complete: false,
				pausedRemovalsCode:
					listing.reason === "scan_limit"
						? DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.TOO_LARGE
						: throttledPage
							? DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.THROTTLED
							: DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.PARTIAL_READ,
			});
		}
		if (result.status === "disconnected" || result.status === "stale") {
			return nothingRead(nextReadAfter);
		}
		logger.info(`${LOG} Folder read`, {
			folderId: folder.id,
			projectId: folder.projectId,
			complete: listing.status === "complete",
			files: files.length,
			counts: result.counts,
		});
		return {
			complete: listing.status === "complete",
			candidates: listing.status === "complete" ? result.candidates : [],
			nextReadAfter: nextReadAfter?.toISOString() ?? null,
		};
	} catch (error) {
		if (adapter?.isNotConnectedError(errorMessage(error))) {
			problemCode = DOCUMENT_FOLDER_PROBLEM_CODE.RECONNECT;
			return nothingRead(nextReadAfter);
		}
		logger.warn(`${LOG} Folder read failed`, {
			folderId: folder.id,
			projectId: folder.projectId,
			errorName: error instanceof Error ? error.name : typeof error,
		});
		throw error;
	} finally {
		await finishDocumentFolderRead({
			folderId: folder.id,
			readerEpoch: folder.readerEpoch,
			problemCode,
			nextReadAfter: nextReadAfter ?? null,
		});
	}
}

// ---------------------------------------------------------------------------
// Confirming removals
// ---------------------------------------------------------------------------

export type ConfirmDocumentFolderCandidatesOutput =
	| { status: "disconnected" }
	/** Not checked this pass: refused, or a lookup did not answer. */
	| { status: "skipped" }
	| { status: "held"; heldCount: number }
	| { status: "retired"; retiredCount: number };

/**
 * Look a complete read's candidates up by id and tombstone those confirmed
 * gone or moved out. Called after every complete read, with no candidates
 * too, so a settled mass-removal hold is cleared.
 *
 * A lookup cut short by throttling is not acted on at all: the mass-removal
 * hold weighs the files confirmed gone, so acting on part of it could retire
 * a share of the folder that, counted whole, would have been held. The folder
 * then shows removals paused as throttled. A file whose own lookup was
 * refused stays as it is; the others go ahead.
 */
export async function confirmDocumentFolderCandidates(input: {
	folderId: string;
	candidates: Array<{ fileId: string; driveItemId: string }>;
}): Promise<ConfirmDocumentFolderCandidatesOutput> {
	const folder = await db.projectDocumentFolder.findUnique({
		where: { id: input.folderId },
		select: {
			id: true,
			projectId: true,
			provider: true,
			driveId: true,
			itemId: true,
			userId: true,
			organizationId: true,
			disconnectedAt: true,
		},
	});
	if (!folder || folder.disconnectedAt) {
		return { status: "disconnected" };
	}

	let goneFileIds: string[] = [];
	let presentFileIds: string[] = [];
	if (input.candidates.length > 0) {
		const adapter = documentFolderDriveAdapter(folder.provider);
		const check = await checkReader(folder, adapter);
		if (!check.ok) {
			return { status: "skipped" };
		}
		let lookup: { items: DriveItemPlacement[] };
		try {
			heartbeat("looking up candidates");
			lookup = await adapter.lookupItemsInFolder(
				check.connection,
				{
					driveId: folder.driveId,
					folderItemId: folder.itemId,
					itemIds: input.candidates.map((c) => c.driveItemId),
				},
				{ onProgress: heartbeatProgress },
			);
		} catch (error) {
			if (adapter.isNotConnectedError(errorMessage(error))) {
				return { status: "skipped" };
			}
			throw error;
		}
		const placementById = new Map(
			lookup.items.map((item) => [item.itemId, item]),
		);
		// A lookup cut short by throttling leaves the rest of the folder
		// unweighed: act on none of it. One refused for a single file leaves
		// that file where it is, and the rest go ahead.
		const throttled = input.candidates.some((candidate) => {
			const placement = placementById.get(candidate.driveItemId);
			return (
				placement?.state === "unknown" &&
				isThrottled(placement.httpStatus)
			);
		});
		const cutShort =
			throttled ||
			input.candidates.some(
				(candidate) => !placementById.has(candidate.driveItemId),
			);
		const stateOf = (candidate: { driveItemId: string }) =>
			placementById.get(candidate.driveItemId)?.state;
		goneFileIds = input.candidates
			.filter((c) => stateOf(c) === "gone" || stateOf(c) === "outside")
			.map((c) => c.fileId);
		presentFileIds = input.candidates
			.filter((c) => stateOf(c) === "inside")
			.map((c) => c.fileId);
		if (cutShort || goneFileIds.length + presentFileIds.length === 0) {
			if (throttled) {
				await recordDocumentFolderLookupsThrottled({
					folderId: folder.id,
				});
			}
			logger.info(`${LOG} Removal lookups incomplete; nothing removed`, {
				folderId: folder.id,
				candidates: input.candidates.length,
				answered: goneFileIds.length + presentFileIds.length,
			});
			return { status: "skipped" };
		}
	}

	const result = await tombstoneDocumentFolderFiles({
		folderId: folder.id,
		goneFileIds,
		presentFileIds,
	});
	if (result.status === "retired") {
		return {
			status: "retired",
			retiredCount: result.retiredFileIds.length,
		};
	}
	return result;
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

export interface DocumentFolderDeletion {
	fileId: string;
	contextId: string;
	projectId: string;
	/** The folder's reader, who owns the context. */
	userId: string;
	/** The project's organization. */
	organizationId: string;
}

/**
 * Rows holding a context to delete, at most one pass's worth, with what the
 * deletion child needs. Nothing while the feature is off; disconnected
 * folders are never listed, since disconnecting keeps their files.
 */
export async function listDocumentFolderDeletions(input: {
	projectId: string;
}): Promise<{ deletions: DocumentFolderDeletion[] }> {
	const { organizationId, enabled } = await enabledOrganizationOf(
		input.projectId,
	);
	if (!organizationId || !enabled) {
		return { deletions: [] };
	}
	const rows = await listDocumentFolderFilesNeedingDeletion({
		projectId: input.projectId,
		limit: DOCUMENT_FOLDER_DELETIONS_PER_PASS,
	});
	const folders = await db.projectDocumentFolder.findMany({
		where: { id: { in: [...new Set(rows.map((row) => row.folderId))] } },
		select: { id: true, userId: true, organizationId: true },
	});
	const folderById = new Map(folders.map((f) => [f.id, f]));
	const deletions: DocumentFolderDeletion[] = [];
	for (const row of rows) {
		const folder = folderById.get(row.folderId);
		if (!folder || folder.organizationId !== organizationId) {
			continue;
		}
		deletions.push({
			fileId: row.fileId,
			contextId: row.contextId,
			projectId: input.projectId,
			userId: folder.userId,
			organizationId,
		});
	}
	return {
		deletions,
	};
}

/**
 * After the deletion child succeeded: remove the context's vectors strictly,
 * confirm its row is gone, delete the stored copy (project-context deletion
 * leaves it), and only then release the file row. Not gated on the flag or a
 * disconnect: the context is already gone, and this finishes what was begun.
 */
export async function finishDocumentFolderContextDeletion(input: {
	fileId: string;
	contextId: string;
	organizationId: string;
}): Promise<{ released: boolean }> {
	const row = await db.projectDocumentFolderFile.findFirst({
		where: { id: input.fileId, contextId: input.contextId },
		select: { storageKey: true },
	});
	if (!row) {
		return { released: false };
	}
	await deleteProjectContext(
		input.contextId,
		input.organizationId,
		undefined,
		{ strict: true },
	);
	const context = await db.projectContext.findUnique({
		where: { id: input.contextId },
		select: { id: true },
	});
	if (context) {
		logger.warn(`${LOG} Context still present after its deletion`, {
			fileId: input.fileId,
			contextId: input.contextId,
		});
		return { released: false };
	}
	if (row.storageKey) {
		await deleteFile(row.storageKey, {
			bucket: config.storage.bucketNames.projectContexts,
		});
	}
	const status = await completeDocumentFolderFileDeletion({
		fileId: input.fileId,
		contextId: input.contextId,
		deletionConfirmed: true,
	});
	return { released: status !== null };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** A folder's waiting files, newest first; none while it may not be read. */
export async function listDocumentFolderImports(input: {
	folderId: string;
	limit: number;
}): Promise<{ fileIds: string[] }> {
	const folder = await db.projectDocumentFolder.findUnique({
		where: { id: input.folderId },
		select: { projectId: true, organizationId: true, disconnectedAt: true },
	});
	if (!folder || folder.disconnectedAt) {
		return { fileIds: [] };
	}
	const { organizationId, enabled } = await enabledOrganizationOf(
		folder.projectId,
	);
	if (!enabled || organizationId !== folder.organizationId) {
		return { fileIds: [] };
	}
	return {
		fileIds: await listPendingDocumentFolderFileIds({
			folderId: input.folderId,
			limit: input.limit,
		}),
	};
}

export type ImportDocumentFolderFileOutput =
	/** Stored and attached: run the processing child, then record it. */
	| {
			outcome: "process";
			contextId: string;
			projectId: string;
			userId: string;
			organizationId: string;
	  }
	/** Already processed by an earlier attempt: only record what it became. */
	| { outcome: "record"; contextId: string }
	/** Settled here: skipped, gone, or no longer this sync's to import. */
	| { outcome: "done" }
	/** Still waiting on a reconnect, access or the flag; nothing settled. */
	| { outcome: "waiting" };

/**
 * Where a file's stored copy lives: under the organization and project, and
 * fixed per file and version, so a retried attempt writes the same object.
 * The version holds `:`, `|` and base64, so it is hashed.
 */
function documentFolderStorageKey(params: {
	organizationId: string;
	projectId: string;
	fileId: string;
	version: string;
	extension: string;
}): string {
	const version = createHash("sha256")
		.update(params.version)
		.digest("hex")
		.slice(0, 32);
	return `${params.organizationId}/projects/${params.projectId}/document-folders/${params.fileId}/${version}.${params.extension}`;
}

/**
 * Claim one waiting file, download it within the upload size limit, store it
 * and create its context. A claim that already made its context resumes.
 */
export async function importDocumentFolderFile(input: {
	fileId: string;
}): Promise<ImportDocumentFolderFileOutput> {
	const file = await getDocumentFolderFileForImport(input.fileId);
	if (!file || file.retiredAt) {
		return { outcome: "done" };
	}
	const S = DOCUMENT_FOLDER_FILE_STATUS;
	if (file.folder.disconnectedAt) {
		return { outcome: "waiting" };
	}

	const adapter = documentFolderDriveAdapter(file.folder.provider);
	const check = await checkReader(
		{
			projectId: file.projectId,
			userId: file.folder.userId,
			organizationId: file.folder.organizationId,
		},
		adapter,
	);
	if (!check.ok) {
		// The next read records why; recording it here would also clear the
		// folder's next-read-after time.
		return { outcome: "waiting" };
	}

	if (file.contextId) {
		if (file.status !== S.IMPORTING) {
			return { outcome: "done" };
		}
		const context = await db.projectContext.findUnique({
			where: { id: file.contextId },
			select: { extractionStatus: true },
		});
		return context &&
			(context.extractionStatus === "PENDING" ||
				context.extractionStatus === "EXTRACTING")
			? {
					outcome: "process",
					contextId: file.contextId,
					projectId: file.projectId,
					userId: file.folder.userId,
					organizationId: check.organizationId,
				}
			: { outcome: "record", contextId: file.contextId };
	}
	if (
		(file.status !== S.PENDING && file.status !== S.IMPORTING) ||
		!file.latestVersion
	) {
		return { outcome: "done" };
	}
	const version = file.latestVersion;
	if (!(await claimDocumentFolderFile({ fileId: file.id, version }))) {
		return { outcome: "done" };
	}

	heartbeat("downloading file");
	let download: DocumentFolderDownload;
	try {
		download = await adapter.downloadFile(check.connection, {
			driveId: file.folder.driveId,
			itemId: file.driveItemId,
			// The type, and so the type's own limit, is known only once the
			// drive's file type comes back with the download.
			maxBytes: LARGEST_UPLOAD_BYTES,
		});
	} catch (error) {
		if (adapter.isNotConnectedError(errorMessage(error))) {
			// The file is fine; the connection is not. The claim stays and
			// is taken again after a reconnect.
			return { outcome: "waiting" };
		}
		logger.warn(`${LOG} Download failed`, {
			fileId: file.id,
			projectId: file.projectId,
			errorName: error instanceof Error ? error.name : typeof error,
		});
		throw error;
	}

	if (download.status === "too_large") {
		await recordDocumentFolderFileOutcome({
			fileId: file.id,
			contextId: null,
			outcome: "SKIPPED",
			skipCode: DOCUMENT_FOLDER_SKIP_CODE.TOO_BIG,
		});
		return { outcome: "done" };
	}
	if (download.status === "not_downloadable") {
		// Its owner blocked downloads, or Google flagged it: only a new
		// version is looked at again.
		await recordDocumentFolderFileOutcome({
			fileId: file.id,
			contextId: null,
			outcome: "SKIPPED",
			skipCode: DOCUMENT_FOLDER_SKIP_CODE.NOT_DOWNLOADABLE,
		});
		return { outcome: "done" };
	}
	if (download.status === "gone") {
		// Deleted since the listing; the next complete reads retire it.
		await recordDocumentFolderFileOutcome({
			fileId: file.id,
			contextId: null,
			outcome: "FAILED",
			failureCode: DOCUMENT_FOLDER_FAILURE_CODE.DOWNLOAD_FAILED,
		});
		return { outcome: "done" };
	}

	// Typed from the name and the drive's file type, as the listing typed it, so
	// a file the listing found supported is not refused here by name alone.
	const mimeType = resolveContextUploadMime(
		download.mimeType ?? "",
		file.name,
	);
	const format = contextUploadConfigFor(mimeType);
	if (!format || download.size > UPLOAD_SIZE_LIMITS[format.type]) {
		await recordDocumentFolderFileOutcome({
			fileId: file.id,
			contextId: null,
			outcome: "SKIPPED",
			skipCode: format
				? DOCUMENT_FOLDER_SKIP_CODE.TOO_BIG
				: DOCUMENT_FOLDER_SKIP_CODE.UNSUPPORTED,
		});
		return { outcome: "done" };
	}

	const s3Path = documentFolderStorageKey({
		organizationId: check.organizationId,
		projectId: file.projectId,
		fileId: file.id,
		version,
		extension: format.extension,
	});
	const bucket = config.storage.bucketNames.projectContexts;
	heartbeat("storing file");
	await uploadFile(s3Path, download.bytes, { bucket, contentType: mimeType });

	const created = await createDocumentFolderFileContext({
		fileId: file.id,
		s3Path,
		s3Bucket: bucket,
		originalFilename: file.name,
		mimeType,
		fileSize: download.size,
	});
	if (created.status === "created" || created.status === "existing") {
		logger.info(`${LOG} File stored for import`, {
			fileId: file.id,
			contextId: created.contextId,
			projectId: file.projectId,
		});
		return {
			outcome: "process",
			contextId: created.contextId,
			projectId: file.projectId,
			userId: file.folder.userId,
			organizationId: check.organizationId,
		};
	}
	if (created.status === "unsupported") {
		await recordDocumentFolderFileOutcome({
			fileId: file.id,
			contextId: null,
			outcome: "SKIPPED",
			skipCode: DOCUMENT_FOLDER_SKIP_CODE.UNSUPPORTED,
		});
	}
	// Nothing points at the copy just stored, unless the row already holds a
	// context stored under the same key.
	const holder = await db.projectDocumentFolderFile.findUnique({
		where: { id: file.id },
		select: { storageKey: true },
	});
	if (holder?.storageKey !== s3Path) {
		await deleteFile(s3Path, { bucket }).catch((error: unknown) =>
			logger.warn(`${LOG} Unused copy not deleted`, {
				fileId: file.id,
				errorName: error instanceof Error ? error.name : typeof error,
			}),
		);
	}
	return { outcome: "done" };
}

/** The last word when downloading a file kept failing. */
export async function markDocumentFolderFileDownloadFailed(input: {
	fileId: string;
}): Promise<{ settled: boolean }> {
	const status = await recordDocumentFolderFileOutcome({
		fileId: input.fileId,
		contextId: null,
		outcome: "FAILED",
		failureCode: DOCUMENT_FOLDER_FAILURE_CODE.DOWNLOAD_FAILED,
	});
	return { settled: status !== null };
}

/**
 * Record what processing made of a file's context. `unknown` means the child
 * was started by an earlier run; the context's own status then decides, and a
 * context still being read is left for the next pass.
 */
export async function recordDocumentFolderFileProcessing(input: {
	fileId: string;
	contextId: string;
	processing: "succeeded" | "failed" | "unknown";
}): Promise<{ settled: boolean }> {
	let succeeded: boolean;
	if (input.processing === "unknown") {
		const context = await db.projectContext.findUnique({
			where: { id: input.contextId },
			select: { extractionStatus: true },
		});
		if (
			context &&
			context.extractionStatus !== "COMPLETED" &&
			context.extractionStatus !== "FAILED"
		) {
			return { settled: false };
		}
		// A context removed meanwhile is recorded as an exclusion by the
		// outcome query, whatever is passed here.
		succeeded = context?.extractionStatus !== "FAILED";
	} else {
		succeeded = input.processing === "succeeded";
	}
	await recordDocumentFolderFileOutcome(
		succeeded
			? {
					fileId: input.fileId,
					contextId: input.contextId,
					outcome: "IMPORTED",
				}
			: {
					fileId: input.fileId,
					contextId: input.contextId,
					outcome: "FAILED",
					failureCode: DOCUMENT_FOLDER_FAILURE_CODE.PROCESSING_FAILED,
				},
	);
	return { settled: true };
}

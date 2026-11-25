/**
 * Reading Google Drive folders for document folders (Fizzy #2808): the
 * picker's places and folder children, a bounded walk of a folder tree, a
 * folder's details with its path and ancestors, looking files up by id
 * before a removal, and downloading or exporting one file.
 *
 * Every call is a Drive v3 read (`files.list`, `files.get`, `files.export`,
 * `drives.list`) on `www.googleapis.com`, the only host the token is sent
 * to. The results are the provider-neutral shapes the Microsoft reads return
 * (`../microsoft/drive-folder.ts`): a refused read comes back as an HTTP
 * status and a retry hint, classified by Google's reason rather than its
 * status, so a rate-limit 403 reads as throttled and not as no access. A 401
 * throws the token-expired error, which means the person has to reconnect.
 */

import type {
	DocumentFolderDownload,
	DocumentFolderItemDetailsResult,
	DocumentFolderTreeFile,
	DocumentFolderTreeListing,
	DriveItemPlacement,
	DriveReadProgress,
} from "../document-folders/adapter";
import {
	DOCUMENT_FOLDER_BROWSE_MAX_ITEMS,
	readCapped,
	retryAfterSeconds,
} from "../drive-shared";
import {
	DRIVE_TREE_MAX_DEPTH,
	DRIVE_TREE_MAX_ITEMS,
	driveItemPath,
} from "../microsoft/drive-folder";
import { GoogleDriveTokenExpiredError } from "./connection-errors";

const API_HOST = "www.googleapis.com";
const DRIVE_API = `https://${API_HOST}/drive/v3`;

/** `files.list` pages at most 1000 items. */
const LIST_PAGE_SIZE = 1000;
/** `drives.list` pages at most 100 drives. */
const DRIVES_PAGE_SIZE = 100;
/** Google refuses to export a file larger than this, and so does Fabric. */
const EXPORT_MAX_BYTES = 10 * 1024 * 1024;
/** Drive nests folders at most 100 deep; a parent walk stops there. */
const MAX_ANCESTORS = 100;
/** A daily quota refusal waits this long before the next read. */
const DAILY_LIMIT_WAIT_SECONDS = 60 * 60;

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_APPS_MIME_PREFIX = "application/vnd.google-apps.";

/** What Docs, Sheets and Slides are exported as. Other Google types have no export. */
const NATIVE_EXPORTS: Record<string, { mimeType: string; extension: string }> =
	{
		"application/vnd.google-apps.document": {
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			extension: ".docx",
		},
		"application/vnd.google-apps.spreadsheet": {
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			extension: ".xlsx",
		},
		"application/vnd.google-apps.presentation": {
			mimeType: "application/pdf",
			extension: ".pdf",
		},
	};

/** Google's refusals that mean the file is never handed over. */
const NOT_DOWNLOADABLE_REASONS = [
	"cannotDownloadAbusiveFile",
	"fileNotDownloadable",
];

/** How the reads reach Drive: the person's token, asked for per request. */
export interface GoogleDriveClient {
	getAccessToken: () => Promise<string>;
	fetchImpl?: typeof fetch;
}

interface DriveFile {
	id: string;
	name?: string;
	mimeType?: string;
	parents?: string[];
	driveId?: string;
	trashed?: boolean;
	/** int64 fields arrive as strings. */
	size?: string;
	md5Checksum?: string;
	version?: string;
	modifiedTime?: string;
	webViewLink?: string;
	capabilities?: { canDownload?: boolean };
}

interface DriveFailure {
	httpStatus: number;
	retryAfterSeconds: number | null;
}

/** A request through the client's fetch, or the global one. */
function doFetch(
	client: GoogleDriveClient,
	url: string,
	init: RequestInit,
): Promise<Response> {
	return (client.fetchImpl ?? fetch)(url, init);
}

/**
 * One request to Drive with the person's token. The host is checked before
 * the token is attached, and no redirect is followed with it.
 */
async function driveFetch(
	client: GoogleDriveClient,
	url: string,
): Promise<Response> {
	const target = new URL(url);
	if (target.protocol !== "https:" || target.hostname !== API_HOST) {
		throw new Error(
			`Refusing to send a Google token to ${target.hostname}.`,
		);
	}
	const token = await client.getAccessToken();
	const response = await doFetch(client, url, {
		headers: { Authorization: `Bearer ${token}` },
		redirect: "manual",
	});
	if (response.status === 401) {
		await response.body?.cancel();
		throw new GoogleDriveTokenExpiredError();
	}
	return response;
}

/** Every `reason` in a Drive error body; empty when it carries none. */
async function errorReasons(response: Response): Promise<string[]> {
	const body = (await response.json().catch(() => ({}))) as {
		error?: { errors?: Array<{ reason?: string }> };
	};
	return (body.error?.errors ?? [])
		.map((entry) => entry.reason)
		.filter((reason): reason is string => typeof reason === "string");
}

/**
 * A refused read as an HTTP status the sync already understands. Rate
 * limits, which Google answers with a 403 as often as a 429, become a 429;
 * a daily quota refusal becomes a 429 with a long wait. Any other status is
 * kept as Google sent it.
 */
function classifyFailure(response: Response, reasons: string[]): DriveFailure {
	if (reasons.includes("dailyLimitExceeded")) {
		return {
			httpStatus: 429,
			retryAfterSeconds:
				retryAfterSeconds(response) ?? DAILY_LIMIT_WAIT_SECONDS,
		};
	}
	if (
		response.status === 429 ||
		reasons.includes("userRateLimitExceeded") ||
		reasons.includes("rateLimitExceeded")
	) {
		return {
			httpStatus: 429,
			retryAfterSeconds: retryAfterSeconds(response),
		};
	}
	return {
		httpStatus: response.status,
		retryAfterSeconds: retryAfterSeconds(response),
	};
}

async function readFailure(response: Response): Promise<DriveFailure> {
	return classifyFailure(response, await errorReasons(response));
}

async function driveError(response: Response, action: string): Promise<Error> {
	const reasons = await errorReasons(response);
	const failure = classifyFailure(response, reasons);
	return new Error(
		`Google Drive API error while ${action}: ${failure.httpStatus} ${reasons[0] ?? response.statusText}`,
	);
}

function fileUrl(itemId: string, fields: string): string {
	const params = new URLSearchParams({ fields, supportsAllDrives: "true" });
	return `${DRIVE_API}/files/${encodeURIComponent(itemId)}?${params}`;
}

type FileRead = { ok: true; file: DriveFile } | ({ ok: false } & DriveFailure);

/** A refused read's failure, without its `ok` flag. */
function toFailure({
	ok: _ok,
	...failure
}: { ok: false } & DriveFailure): DriveFailure {
	return failure;
}

async function getFile(
	client: GoogleDriveClient,
	itemId: string,
	fields: string,
): Promise<FileRead> {
	const response = await driveFetch(client, fileUrl(itemId, fields));
	if (!response.ok) {
		return { ok: false, ...(await readFailure(response)) };
	}
	return { ok: true, file: (await response.json()) as DriveFile };
}

const LIST_FIELDS =
	"nextPageToken,incompleteSearch,files(id,name,mimeType,size,md5Checksum,version,modifiedTime,webViewLink,capabilities/canDownload)";

/**
 * One page of a folder's children. A shared drive's folder is searched
 * within that drive; a My Drive folder in the person's own files.
 */
function childrenUrl(
	folderId: string,
	sharedDriveId: string | null,
	pageToken: string | undefined,
): string {
	const quoted = folderId.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
	const params = new URLSearchParams({
		q: `'${quoted}' in parents and trashed = false`,
		fields: LIST_FIELDS,
		pageSize: String(LIST_PAGE_SIZE),
		supportsAllDrives: "true",
		includeItemsFromAllDrives: "true",
	});
	if (sharedDriveId) {
		params.set("corpora", "drive");
		params.set("driveId", sharedDriveId);
	}
	if (pageToken) {
		params.set("pageToken", pageToken);
	}
	return `${DRIVE_API}/files?${params}`;
}

interface ListPage {
	files?: DriveFile[];
	nextPageToken?: string;
	incompleteSearch?: boolean;
}

/** The name a native file is imported under: its export's extension added. */
function exportName(name: string, extension: string): string {
	return name.toLowerCase().endsWith(extension)
		? name
		: `${name}${extension}`;
}

/**
 * A file's content version, which tells a changed file from an unchanged
 * one: its checksum, which changes with the content only, or for a Google
 * Doc, Sheet or Slides, which has none, Drive's version of it.
 */
function contentVersion(file: DriveFile): string {
	return file.md5Checksum
		? `md5:${file.md5Checksum}`
		: `version:${file.version ?? ""}`;
}

/** A folder or file the picker shows, typed as a folder read would type it. */
export interface GoogleDriveFolderEntry {
	id: string;
	/** For a Google Doc, Sheet or Slides, the name with its export's extension. */
	name: string;
	isFolder: boolean;
	/** Null for a folder, and for a native file, whose export size is unknown. */
	size: number | null;
	/** For a native file, its export's type. */
	mimeType: string | null;
	webUrl: string | null;
}

type DriveEntry =
	| { kind: "folder"; entry: GoogleDriveFolderEntry }
	| {
			kind: "file";
			entry: GoogleDriveFolderEntry;
			file: Omit<DocumentFolderTreeFile, "relativePath">;
	  };

/**
 * A listed item as a folder or a file, or null for what a folder read never
 * shows: shortcuts, and Google types without an export (Forms, Sites, Maps).
 */
function toDriveEntry(item: DriveFile): DriveEntry | null {
	const name = item.name ?? item.id;
	const webUrl = item.webViewLink ?? null;
	if (item.mimeType === FOLDER_MIME) {
		return {
			kind: "folder",
			entry: {
				id: item.id,
				name,
				isFolder: true,
				size: null,
				mimeType: null,
				webUrl,
			},
		};
	}
	const native = item.mimeType ? NATIVE_EXPORTS[item.mimeType] : undefined;
	if (!native && item.mimeType?.startsWith(GOOGLE_APPS_MIME_PREFIX)) {
		return null;
	}
	const size = native || item.size === undefined ? null : Number(item.size);
	const entry: GoogleDriveFolderEntry = {
		id: item.id,
		name: native ? exportName(name, native.extension) : name,
		isFolder: false,
		size: Number.isFinite(size) ? size : null,
		mimeType: native ? native.mimeType : (item.mimeType ?? null),
		webUrl,
	};
	return {
		kind: "file",
		entry,
		file: {
			id: entry.id,
			name: entry.name,
			size: entry.size,
			mimeType: entry.mimeType,
			quickXorHash: null,
			lastModified: item.modifiedTime ?? null,
			contentVersion: contentVersion(item),
			...(item.capabilities?.canDownload === false
				? { notDownloadable: true as const }
				: {}),
		},
	};
}

/** The folder a read starts from: refused, gone, or the drive it sits in. */
type FolderProbe =
	| { ok: true; id: string; sharedDriveId: string | null }
	| ({ ok: false } & DriveFailure);

async function probeFolder(
	client: GoogleDriveClient,
	itemId: string,
): Promise<FolderProbe> {
	const read = await getFile(client, itemId, "id,driveId,trashed");
	if (!read.ok) {
		return read;
	}
	if (read.file.trashed) {
		return { ok: false, httpStatus: 404, retryAfterSeconds: null };
	}
	return {
		ok: true,
		id: read.file.id,
		sharedDriveId: read.file.driveId ?? null,
	};
}

export interface GoogleDrivePlaces {
	/** The person's My Drive, by its root folder's id. */
	myDrive: { id: string; name: string };
	/** The shared drives the person belongs to; empty when there are none. */
	sharedDrives: Array<{ id: string; name: string }>;
}

/** The picker's top level: My Drive and every shared drive. */
export async function listGoogleDrivePlaces(
	client: GoogleDriveClient,
): Promise<GoogleDrivePlaces> {
	const root = await driveFetch(client, fileUrl("root", "id,name"));
	if (!root.ok) {
		throw await driveError(root, "reading My Drive");
	}
	const myDrive = (await root.json()) as DriveFile;

	const sharedDrives: GoogleDrivePlaces["sharedDrives"] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			pageSize: String(DRIVES_PAGE_SIZE),
			fields: "nextPageToken,drives(id,name)",
		});
		if (pageToken) {
			params.set("pageToken", pageToken);
		}
		const response = await driveFetch(
			client,
			`${DRIVE_API}/drives?${params}`,
		);
		if (!response.ok) {
			throw await driveError(response, "listing shared drives");
		}
		const page = (await response.json()) as {
			drives?: Array<{ id: string; name?: string }>;
			nextPageToken?: string;
		};
		for (const drive of page.drives ?? []) {
			sharedDrives.push({ id: drive.id, name: drive.name ?? drive.id });
		}
		pageToken = page.nextPageToken;
	} while (pageToken);

	return {
		myDrive: { id: myDrive.id, name: myDrive.name ?? "My Drive" },
		sharedDrives,
	};
}

/**
 * The folders and files directly inside a folder, for the picker. `root`
 * opens My Drive; a shared drive opens at its id. Cut short at `maxItems`,
 * or when Drive reports a page not searched in full.
 */
export async function listGoogleDriveFolderChildren(
	client: GoogleDriveClient,
	params: { folderId: string; maxItems?: number },
): Promise<{ items: GoogleDriveFolderEntry[]; truncated: boolean }> {
	const maxItems = params.maxItems ?? DOCUMENT_FOLDER_BROWSE_MAX_ITEMS;
	const folder = await probeFolder(client, params.folderId);
	if (!folder.ok) {
		throw new Error(
			folder.httpStatus === 404
				? "This folder no longer exists in Google Drive, or it has been moved."
				: `Google Drive API error while opening the folder: ${folder.httpStatus}`,
		);
	}
	const items: GoogleDriveFolderEntry[] = [];
	let truncated = false;
	let pageToken: string | undefined;
	do {
		const response = await driveFetch(
			client,
			childrenUrl(folder.id, folder.sharedDriveId, pageToken),
		);
		if (!response.ok) {
			throw await driveError(response, "listing the folder");
		}
		const page = (await response.json()) as ListPage;
		truncated ||= page.incompleteSearch === true;
		for (const item of page.files ?? []) {
			const listed = toDriveEntry(item);
			if (!listed) {
				continue;
			}
			if (items.length >= maxItems) {
				return { items, truncated: true };
			}
			items.push(listed.entry);
		}
		pageToken = page.nextPageToken;
	} while (pageToken);
	return { items, truncated };
}

/**
 * Every file in a folder and its subfolders down to `maxDepth` levels, read
 * breadth-first through `files.list`, as `listDriveFolderTree` reads
 * OneDrive and SharePoint.
 *
 * The connected folder is level 0, so a file inside a level-`maxDepth`
 * folder is listed and a folder below that is not opened. That is the
 * folder's scope, so the listing still counts as complete. Reading stops
 * at the first page Drive refuses (`page_failed`, or `root_failed` for the
 * folder's own first read) and when `maxItems` items have been looked at
 * and one more is left (`scan_limit`). A page Drive did not search in full
 * marks the read `incomplete` once the rest of the tree is read. Shortcuts
 * and Google types without an export are not listed.
 */
export async function listGoogleDriveFolderTree(
	client: GoogleDriveClient,
	params: {
		itemId: string;
		maxDepth?: number;
		maxItems?: number;
		onProgress?: (progress: DriveReadProgress) => void;
	},
): Promise<DocumentFolderTreeListing> {
	const { onProgress } = params;
	const maxDepth = params.maxDepth ?? DRIVE_TREE_MAX_DEPTH;
	const maxItems = params.maxItems ?? DRIVE_TREE_MAX_ITEMS;

	const root = await probeFolder(client, params.itemId);
	let requests = 1;
	if (!root.ok) {
		return { status: "root_failed", ...toFailure(root) };
	}

	const files: DocumentFolderTreeFile[] = [];
	const folders = [{ id: root.id, path: "", depth: 0 }];
	let scanned = 0;
	let incomplete = false;
	for (const folder of folders) {
		let pageToken: string | undefined;
		let firstPage = true;
		do {
			const response = await driveFetch(
				client,
				childrenUrl(folder.id, root.sharedDriveId, pageToken),
			);
			requests++;
			if (!response.ok) {
				const failure = await readFailure(response);
				return folder.depth === 0 && firstPage
					? { status: "root_failed", ...failure }
					: {
							status: "truncated",
							reason: "page_failed",
							...failure,
							files,
						};
			}
			firstPage = false;
			const page = (await response.json()) as ListPage;
			incomplete ||= page.incompleteSearch === true;
			for (const item of page.files ?? []) {
				if (scanned >= maxItems) {
					return { status: "truncated", reason: "scan_limit", files };
				}
				scanned++;
				const listed = toDriveEntry(item);
				if (!listed) {
					continue;
				}
				const relativePath = folder.path
					? `${folder.path}/${listed.entry.name}`
					: listed.entry.name;
				if (listed.kind === "folder") {
					if (folder.depth < maxDepth) {
						folders.push({
							id: listed.entry.id,
							path: relativePath,
							depth: folder.depth + 1,
						});
					}
				} else {
					files.push({ ...listed.file, relativePath });
				}
			}
			onProgress?.({ requests, items: scanned });
			pageToken = page.nextPageToken;
		} while (pageToken);
	}
	if (incomplete) {
		return { status: "truncated", reason: "incomplete", files };
	}
	return { status: "complete", files };
}

/**
 * Where each file is now relative to a connected folder, found by walking
 * its parents towards the folder:
 * - `gone` when Drive answers 404 for the file, or it is in the trash;
 * - `outside` when it moved to another drive, or the walk reaches an item
 *   with no visible parent, or passes `maxDepth` folders without meeting
 *   the folder;
 * - `inside` when the walk meets the folder;
 * - `unknown` when the file or one of its parents could not be read.
 *
 * Nothing is inferred from a listing. Throttling ends the lookups; every
 * file not yet placed is then `unknown`.
 */
export async function lookupGoogleDriveItemsInFolder(
	client: GoogleDriveClient,
	params: {
		folderItemId: string;
		itemIds: string[];
		maxDepth?: number;
		onProgress?: (progress: DriveReadProgress) => void;
	},
): Promise<{ items: DriveItemPlacement[] }> {
	const { itemIds, onProgress } = params;
	const maxDepth = params.maxDepth ?? DRIVE_TREE_MAX_DEPTH;
	const fields = "id,parents,trashed,driveId";

	const placements: DriveItemPlacement[] = [];
	let requests = 0;
	const read = async (id: string): Promise<FileRead> => {
		const result = await getFile(client, id, fields);
		requests++;
		onProgress?.({ requests, items: placements.length });
		return result;
	};
	const unknown = (
		itemId: string,
		failure: DriveFailure,
	): DriveItemPlacement => ({
		itemId,
		state: "unknown",
		httpStatus: failure.httpStatus,
		retryAfterSeconds: failure.retryAfterSeconds,
	});

	// The folder's real id and drive: the connected id may be an alias.
	const folder = await read(params.folderItemId);
	if (!folder.ok) {
		return { items: itemIds.map((itemId) => unknown(itemId, folder)) };
	}
	const folderDriveId = folder.file.driveId ?? null;

	const parentOf = new Map<string, string | null>();
	let throttled: DriveFailure | null = null;
	const place = async (itemId: string): Promise<DriveItemPlacement> => {
		const item = await read(itemId);
		if (!item.ok) {
			if (item.httpStatus === 404) {
				return { itemId, state: "gone" };
			}
			if (item.httpStatus === 429) {
				throttled = item;
			}
			return unknown(itemId, item);
		}
		if (item.file.trashed) {
			return { itemId, state: "gone" };
		}
		// A My Drive folder's file carries no drive; a shared drive's carries
		// that drive. Any other drive means it moved out.
		if ((item.file.driveId ?? null) !== folderDriveId) {
			return { itemId, state: "outside" };
		}
		// `depth` counts the folders between the connected folder and the file.
		let parentId = item.file.parents?.[0] ?? null;
		for (let depth = 0; ; depth++) {
			if (parentId === null) {
				return { itemId, state: "outside" };
			}
			if (parentId === folder.file.id) {
				return { itemId, state: "inside" };
			}
			if (depth === maxDepth) {
				return { itemId, state: "outside" };
			}
			let next = parentOf.get(parentId);
			if (next === undefined) {
				const ancestor = await read(parentId);
				if (!ancestor.ok) {
					if (ancestor.httpStatus === 429) {
						throttled = ancestor;
					}
					return unknown(itemId, ancestor);
				}
				next = ancestor.file.parents?.[0] ?? null;
				parentOf.set(parentId, next);
			}
			parentId = next;
		}
	};

	for (const itemId of itemIds) {
		placements.push(
			throttled ? unknown(itemId, throttled) : await place(itemId),
		);
	}
	return { items: placements };
}

/**
 * One item with what connecting it needs: its name, its drive, its display
 * path below the drive's root, and its ancestors' ids up to that root.
 * Also the probe a folder read starts with, so a refusal is returned as
 * Drive's status, and a trashed item as a 404.
 *
 * A shared drive's item reports the drive's id as its `driveId`; a My Drive
 * item reports the person's root folder id, which My Drive items do not
 * carry themselves.
 */
export async function getGoogleDriveItemDetails(
	client: GoogleDriveClient,
	params: { itemId: string },
): Promise<DocumentFolderItemDetailsResult> {
	const read = await getFile(
		client,
		params.itemId,
		"id,name,mimeType,webViewLink,parents,driveId,trashed",
	);
	if (!read.ok) {
		return { status: "failed", ...toFailure(read) };
	}
	const item = read.file;
	if (item.trashed) {
		return { status: "failed", httpStatus: 404, retryAfterSeconds: null };
	}

	let driveId = item.driveId ?? null;
	if (!driveId) {
		const root = await getFile(client, "root", "id");
		if (!root.ok) {
			return { status: "failed", ...toFailure(root) };
		}
		driveId = root.file.id;
	}

	// Up from the parent to the top: the drive's root, or the highest
	// folder the person can open. Someone the folder was shared with may not
	// be able to open its parents; that ends the walk and still reads the
	// folder. The root's own name is not in the path.
	const ancestorIds: string[] = [];
	const names: string[] = [];
	let parentId = item.parents?.[0] ?? null;
	while (parentId && ancestorIds.length < MAX_ANCESTORS) {
		const parent = await getFile(client, parentId, "id,name,parents");
		if (!parent.ok) {
			if (parent.httpStatus === 403 || parent.httpStatus === 404) {
				break;
			}
			return { status: "failed", ...toFailure(parent) };
		}
		ancestorIds.push(parent.file.id);
		parentId = parent.file.parents?.[0] ?? null;
		if (parentId) {
			names.unshift(parent.file.name ?? parent.file.id);
		}
	}

	const name = item.name ?? item.id;
	const parentPath = item.parents?.length ? `/${names.join("/")}` : null;
	// Ancestors decide overlap only when they reach the drive's root; a
	// walk cut short leaves them out rather than report a partial chain.
	const reachesRoot = (ancestorIds.at(-1) ?? item.id) === driveId;
	return {
		status: "ok",
		item: {
			id: item.id,
			name,
			driveId,
			driveType: null,
			provider: "googledrive",
			isFolder: item.mimeType === FOLDER_MIME,
			webUrl: item.webViewLink ?? null,
			parentPath,
			// A walk cut short knows only part of the path: report none, so
			// a read or reconnect keeps the stored one rather than shorten it.
			drivePath: reachesRoot ? driveItemPath({ name, parentPath }) : null,
			...(reachesRoot ? { ancestorIds } : {}),
		},
	};
}

/** Hosts Google may hand a download off to. The link is sent no token. */
function isGoogleDownloadHost(url: URL): boolean {
	return (
		url.protocol === "https:" &&
		url.hostname.endsWith(".googleusercontent.com")
	);
}

/**
 * One file's bytes, refused past `maxBytes`: a binary file's own bytes
 * (`alt=media`), or a Google Doc, Sheet or Slides exported as DOCX, XLSX or
 * PDF, refused past 10 MB too. A file its owner blocked from download, or
 * that Google flagged, is `not_downloadable`; one deleted or in the trash is
 * `gone`.
 *
 * Both reads stay on Google's API host. A redirect is read by hand and
 * followed only to Google's download host, without the token.
 */
export async function downloadGoogleDriveFile(
	client: GoogleDriveClient,
	params: { itemId: string; maxBytes: number },
): Promise<DocumentFolderDownload> {
	const { itemId } = params;
	const meta = await driveFetch(
		client,
		fileUrl(
			itemId,
			"id,name,mimeType,size,trashed,capabilities/canDownload",
		),
	);
	if (meta.status === 404) {
		await meta.body?.cancel();
		return { status: "gone" };
	}
	if (!meta.ok) {
		throw await driveError(meta, "reading the file");
	}
	const file = (await meta.json()) as DriveFile;
	if (file.trashed) {
		return { status: "gone" };
	}
	const native = file.mimeType ? NATIVE_EXPORTS[file.mimeType] : undefined;
	const name = native
		? exportName(file.name ?? file.id, native.extension)
		: (file.name ?? file.id);
	if (file.capabilities?.canDownload === false) {
		return { status: "not_downloadable", name };
	}

	let maxBytes = params.maxBytes;
	let contentUrl: string;
	if (native) {
		// An export carries no size up front; Google's own cap is 10 MB.
		maxBytes = Math.min(maxBytes, EXPORT_MAX_BYTES);
		const query = new URLSearchParams({ mimeType: native.mimeType });
		contentUrl = `${DRIVE_API}/files/${encodeURIComponent(itemId)}/export?${query}`;
	} else {
		const size = file.size === undefined ? 0 : Number(file.size);
		if (size > maxBytes) {
			return { status: "too_large", name, size };
		}
		const query = new URLSearchParams({
			alt: "media",
			supportsAllDrives: "true",
		});
		contentUrl = `${DRIVE_API}/files/${encodeURIComponent(itemId)}?${query}`;
	}

	const content = await driveFetch(client, contentUrl);
	let download: Response;
	if (content.status >= 300 && content.status < 400) {
		await content.body?.cancel();
		const location = content.headers.get("location");
		let downloadUrl: URL;
		try {
			downloadUrl = new URL(location ?? "", contentUrl);
		} catch {
			// Not the location itself: it may carry a temporary credential.
			throw new Error(
				"Google Drive answered with a download location that is not a URL.",
			);
		}
		if (!location || !isGoogleDownloadHost(downloadUrl)) {
			// The host only: the link's query may carry a credential.
			throw new Error(
				`Google Drive redirected the download to an unexpected host: ${downloadUrl.hostname}`,
			);
		}
		download = await doFetch(client, downloadUrl.toString(), {
			redirect: "error",
		});
	} else {
		download = content;
	}

	if (!download.ok) {
		if (download.status === 404) {
			await download.body?.cancel();
			return { status: "gone" };
		}
		const reasons = await errorReasons(download);
		if (reasons.includes("exportSizeLimitExceeded")) {
			return { status: "too_large", name, size: EXPORT_MAX_BYTES };
		}
		if (
			reasons.some((reason) => NOT_DOWNLOADABLE_REASONS.includes(reason))
		) {
			return { status: "not_downloadable", name };
		}
		const failure = classifyFailure(download, reasons);
		throw new Error(
			`Google Drive download failed: ${failure.httpStatus} ${reasons[0] ?? download.statusText}`,
		);
	}

	const read = await readCapped(download, maxBytes);
	if (!read.ok) {
		return { status: "too_large", name, size: read.size };
	}
	return {
		status: "ok",
		name,
		size: read.size,
		mimeType: native ? native.mimeType : (file.mimeType ?? null),
		bytes: read.bytes,
	};
}

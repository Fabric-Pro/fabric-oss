/**
 * Reading a OneDrive folder for transcript files (Fizzy #3507).
 *
 * Both calls stay inside `Files.Read.All`, which the Microsoft connection
 * already holds for channel recordings (./stream-transcript.ts), so connecting
 * a folder needs no new permission and no re-consent.
 *
 * Only what is directly in a folder is listed. The card leaves nested folders
 * out, and Graph's `delta` cannot help here anyway: on OneDrive for Business it
 * works on a drive's root only, not on a folder inside it.
 */

import { readCapped, retryAfterSeconds } from "../drive-shared";
import { MICROSOFT_DOWNLOAD_TIMEOUT_MS } from "./config/limits";
import { microsoftFetch } from "./request";
import type { GraphFetch } from "./stream-transcript";

/** Graph pages at most 200 children; a folder past this many is cut short. */
const PAGE_SIZE = 200;
const DEFAULT_MAX_ITEMS = 5_000;

export interface DriveFolderItem {
	id: string;
	name: string;
	driveId: string;
	isFolder: boolean;
	/** Children of a folder; null for a file. */
	childCount: number | null;
	size: number | null;
	webUrl: string | null;
	lastModified: string | null;
}

interface GraphDriveItem {
	id: string;
	name: string;
	size?: number;
	webUrl?: string;
	lastModifiedDateTime?: string;
	folder?: { childCount?: number };
	file?: unknown;
	parentReference?: { driveId?: string };
}

async function graphError(response: Response, action: string): Promise<Error> {
	const body = (await response.json().catch(() => ({}))) as {
		error?: { code?: string; message?: string };
	};
	if (response.status === 404) {
		return new Error(
			"This folder no longer exists in OneDrive, or it has been moved.",
		);
	}
	if (response.status === 403) {
		return new Error(
			"This Microsoft account can no longer read this folder. Reconnect it as someone who can.",
		);
	}
	return new Error(
		`Microsoft Graph API error while ${action}: ${response.status} ${body.error?.code ?? response.statusText}`,
	);
}

/**
 * The folders and files directly inside a folder, or inside the signed-in
 * user's OneDrive root when no folder is named.
 */
export async function listDriveFolderChildren(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId?: string;
	itemId?: string;
	maxItems?: number;
}): Promise<{ items: DriveFolderItem[]; truncated: boolean }> {
	const { graphFetch, graphBaseUrl, driveId, itemId } = params;
	const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;
	const folderUrl =
		driveId && itemId
			? itemUrl(graphBaseUrl, driveId, itemId)
			: `${graphBaseUrl}/me/drive/root`;
	let url: string | undefined =
		`${folderUrl}/children?$top=${PAGE_SIZE}&$select=id,name,size,webUrl,lastModifiedDateTime,folder,file,parentReference`;

	const items: DriveFolderItem[] = [];
	while (url) {
		const response = await graphFetch(url);
		if (!response.ok) {
			throw await graphError(response, "listing the folder");
		}
		const page = (await response.json()) as {
			value?: GraphDriveItem[];
			"@odata.nextLink"?: string;
		};
		for (const item of page.value ?? []) {
			items.push({
				id: item.id,
				name: item.name,
				driveId: item.parentReference?.driveId ?? driveId ?? "",
				isFolder: item.folder !== undefined,
				childCount: item.folder ? (item.folder.childCount ?? 0) : null,
				size: typeof item.size === "number" ? item.size : null,
				webUrl: item.webUrl ?? null,
				lastModified: item.lastModifiedDateTime ?? null,
			});
			if (items.length >= maxItems) {
				return { items, truncated: true };
			}
		}
		url = page["@odata.nextLink"];
	}
	return { items, truncated: false };
}

/**
 * Hosts Graph hands out pre-authenticated download links on. The link is sent
 * no token, but it still must not point anywhere else.
 */
const DOWNLOAD_HOSTS = [
	".sharepoint.com",
	".sharepoint.us",
	".sharepoint.de",
	".sharepoint-df.com",
	".1drv.com",
	".onedrive.com",
	".livefilestore.com",
];

function isDownloadHost(url: URL): boolean {
	return (
		url.protocol === "https:" &&
		DOWNLOAD_HOSTS.some((suffix) => url.hostname.endsWith(suffix))
	);
}

export type DriveItemDownload =
	| {
			status: "ok";
			name: string;
			size: number;
			/** The file type Graph reports, which typing the file may need. */
			mimeType: string | null;
			bytes: Buffer;
	  }
	| { status: "too_large"; name: string; size: number }
	| { status: "gone" };

/**
 * One file's bytes, refused past `maxBytes` before or while reading it.
 *
 * The file's metadata gives its name, size and type. Its bytes come from
 * `/content`, which answers with a 302 to a short-lived, pre-authenticated
 * link. The shared request helper follows no redirect, so the token never
 * reaches the file host: the redirect is read by hand, its host checked, and
 * the link fetched with no token. (`@microsoft.graph.downloadUrl` is not used:
 * OneDrive for Business leaves it out of a `$select`ed item.)
 */
export async function downloadDriveItem(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId: string;
	itemId: string;
	maxBytes: number;
	fetchImpl?: typeof fetch;
}): Promise<DriveItemDownload> {
	const { graphFetch, graphBaseUrl, driveId, itemId, maxBytes } = params;
	const itemUrl = `${graphBaseUrl}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;

	const response = await graphFetch(`${itemUrl}?$select=id,name,size,file`);
	if (response.status === 404) {
		return { status: "gone" };
	}
	if (!response.ok) {
		throw await graphError(response, "reading the file");
	}
	const item = (await response.json()) as GraphDriveItem & {
		file?: { mimeType?: string };
	};
	const size = typeof item.size === "number" ? item.size : 0;
	if (size > maxBytes) {
		return { status: "too_large", name: item.name, size };
	}

	const contentUrl = `${itemUrl}/content`;
	const content = await graphFetch(contentUrl, { redirect: "manual" });
	if (content.status === 404) {
		await content.body?.cancel();
		return { status: "gone" };
	}
	let download: Response;
	if (content.status >= 300 && content.status < 400) {
		await content.body?.cancel();
		const location = content.headers.get("location");
		if (!location) {
			throw new Error(
				`Microsoft Graph answered ${content.status} with no download location.`,
			);
		}
		let downloadUrl: URL;
		try {
			downloadUrl = new URL(location, contentUrl);
		} catch {
			// Not the location itself: it carries a temporary credential.
			throw new Error(
				"Microsoft Graph answered with a download location that is not a URL.",
			);
		}
		if (!isDownloadHost(downloadUrl)) {
			// The host only: the link's query carries its temporary credential.
			throw new Error(
				`Microsoft Graph redirected the download to an unexpected host: ${downloadUrl.hostname}`,
			);
		}
		download = await microsoftFetch(
			downloadUrl.toString(),
			{ redirect: "error" },
			{
				timeoutMs: MICROSOFT_DOWNLOAD_TIMEOUT_MS,
				fetchImpl: params.fetchImpl,
			},
		);
	} else if (content.ok) {
		// Graph served the bytes itself rather than redirecting.
		download = content;
	} else {
		throw await graphError(content, "downloading the file");
	}
	if (!download.ok || !download.body) {
		throw new Error(`OneDrive download failed: ${download.status}`);
	}

	// Counted while reading: the size Graph reported is not a promise.
	const read = await readCapped(download, maxBytes);
	if (!read.ok) {
		return { status: "too_large", name: item.name, size: read.size };
	}
	return {
		status: "ok",
		name: item.name,
		size: read.size,
		mimeType: item.file?.mimeType ?? null,
		bytes: read.bytes,
	};
}

// ========== Document folders: OneDrive and SharePoint ==========
//
// A document folder is read with its subfolders, and a file that drops out of
// the listing is confirmed gone by id before anything is removed (see
// listDriveFolderTree and lookupDriveItemsInFolder). Every call here is a
// read inside `Files.Read.All` and `Sites.Read.All`, which the connection
// already holds.

/** How many folders below the connected folder are read. */
export const DRIVE_TREE_MAX_DEPTH = 5;
/** How many items a folder tree read looks at before it stops. */
export const DRIVE_TREE_MAX_ITEMS = DEFAULT_MAX_ITEMS;

export type DriveProvider = "onedrive" | "sharepoint";

/** A SharePoint library is SharePoint; a user's own drive is OneDrive. */
export function driveProviderForDriveType(
	driveType: string | null | undefined,
): DriveProvider | null {
	if (driveType === "documentLibrary") {
		return "sharepoint";
	}
	if (driveType === "business" || driveType === "personal") {
		return "onedrive";
	}
	return null;
}

/**
 * A file's content version, which is stored to tell a changed file from an
 * unchanged one. Graph's `quickXorHash` when it has one; otherwise the size
 * and modified time, which change whenever the content does. The prefixes
 * keep the two forms from ever being equal.
 */
export function driveItemContentVersion(file: {
	quickXorHash: string | null;
	size: number | null;
	lastModified: string | null;
}): string {
	if (file.quickXorHash) {
		return `quickXorHash:${file.quickXorHash}`;
	}
	return `size:${file.size ?? ""}|modified:${file.lastModified ?? ""}`;
}

/** Progress of a long read, reported after every Graph request it makes. */
export interface DriveReadProgress {
	/** Graph requests answered so far. */
	requests: number;
	/** Items listed so far by a tree read, or looked up so far by a lookup. */
	items: number;
}

interface DriveTreeFile {
	id: string;
	name: string;
	/** Path below the connected folder, `/`-separated, ending in the name. */
	relativePath: string;
	size: number | null;
	mimeType: string | null;
	quickXorHash: string | null;
	lastModified: string | null;
	contentVersion: string;
}

/**
 * A folder tree read. Only `complete` lists everything below the folder: a
 * truncated read lists some of it, and a root failure none.
 */
export type DriveTreeListing =
	| { status: "complete"; files: DriveTreeFile[] }
	| { status: "truncated"; reason: "scan_limit"; files: DriveTreeFile[] }
	| {
			status: "truncated";
			reason: "page_failed";
			httpStatus: number;
			retryAfterSeconds: number | null;
			files: DriveTreeFile[];
	  }
	| {
			status: "root_failed";
			httpStatus: number;
			retryAfterSeconds: number | null;
	  };

interface GraphTreeItem {
	id: string;
	name: string;
	size?: number;
	lastModifiedDateTime?: string;
	folder?: unknown;
	file?: { mimeType?: string; hashes?: { quickXorHash?: string } };
}

function itemUrl(graphBaseUrl: string, driveId: string, itemId: string) {
	return `${graphBaseUrl}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
}

/**
 * Every file in a folder and its subfolders down to `maxDepth` levels, read
 * breadth-first through `/children`, which pages at 200.
 *
 * The connected folder is level 0, so a file inside a level-`maxDepth`
 * folder is listed and a folder below that is not opened. That is the
 * folder's scope, so the listing still counts as complete. Reading stops
 * when `maxItems` items have been looked at and one more is left
 * (`scan_limit`), or at the first page Graph refuses (`page_failed`). A
 * refused first page of the folder itself is a `root_failed`. Items that are
 * neither a file nor a folder, such as shortcuts to another drive, are
 * skipped.
 */
export async function listDriveFolderTree(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId: string;
	itemId: string;
	maxDepth?: number;
	maxItems?: number;
	onProgress?: (progress: DriveReadProgress) => void;
}): Promise<DriveTreeListing> {
	const { graphFetch, graphBaseUrl, driveId, onProgress } = params;
	const maxDepth = params.maxDepth ?? DRIVE_TREE_MAX_DEPTH;
	const maxItems = params.maxItems ?? DRIVE_TREE_MAX_ITEMS;

	const files: DriveTreeFile[] = [];
	const folders = [{ itemId: params.itemId, path: "", depth: 0 }];
	let requests = 0;
	let scanned = 0;
	for (const folder of folders) {
		let url: string | undefined =
			`${itemUrl(graphBaseUrl, driveId, folder.itemId)}/children?$top=${PAGE_SIZE}&$select=id,name,size,lastModifiedDateTime,folder,file`;
		while (url) {
			const response = await graphFetch(url);
			if (!response.ok) {
				const failure = {
					httpStatus: response.status,
					retryAfterSeconds: retryAfterSeconds(response),
				};
				return requests === 0
					? { status: "root_failed", ...failure }
					: {
							status: "truncated",
							reason: "page_failed",
							...failure,
							files,
						};
			}
			const page = (await response.json()) as {
				value?: GraphTreeItem[];
				"@odata.nextLink"?: string;
			};
			requests++;
			for (const item of page.value ?? []) {
				if (scanned >= maxItems) {
					return { status: "truncated", reason: "scan_limit", files };
				}
				scanned++;
				const relativePath = folder.path
					? `${folder.path}/${item.name}`
					: item.name;
				if (item.folder !== undefined) {
					if (folder.depth < maxDepth) {
						folders.push({
							itemId: item.id,
							path: relativePath,
							depth: folder.depth + 1,
						});
					}
				} else if (item.file !== undefined) {
					const listed = {
						id: item.id,
						name: item.name,
						relativePath,
						size: typeof item.size === "number" ? item.size : null,
						mimeType: item.file.mimeType ?? null,
						quickXorHash: item.file.hashes?.quickXorHash ?? null,
						lastModified: item.lastModifiedDateTime ?? null,
					};
					files.push({
						...listed,
						contentVersion: driveItemContentVersion(listed),
					});
				}
			}
			onProgress?.({ requests, items: scanned });
			url = page["@odata.nextLink"];
		}
	}
	return { status: "complete", files };
}

interface DriveItemDetails {
	id: string;
	name: string;
	driveId: string;
	driveType: string | null;
	provider: DriveProvider | null;
	isFolder: boolean;
	webUrl: string | null;
	/** The parent folder's path in its drive, such as `/Plans`; null at the root. */
	parentPath: string | null;
}

export type DriveItemDetailsResult =
	| { status: "ok"; item: DriveItemDetails }
	| {
			status: "failed";
			httpStatus: number;
			retryAfterSeconds: number | null;
	  };

/**
 * An item's path in its drive, from its parent's path as Graph reports it:
 * null for the drive's root, which has no parent.
 */
export function driveItemPath(item: {
	name: string;
	parentPath: string | null;
}): string | null {
	if (item.parentPath === null) {
		return null;
	}
	return item.parentPath === "/"
		? `/${item.name}`
		: `${item.parentPath}/${item.name}`;
}

/** Graph's `parentReference.path` is `/drives/{id}/root:/A%20B`; this is `/A B`. */
function pathBelowDriveRoot(path: string | undefined): string | null {
	const marker = path?.indexOf("root:") ?? -1;
	if (!path || marker < 0) {
		return null;
	}
	const rest = path.slice(marker + "root:".length);
	if (!rest) {
		return "/";
	}
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

/**
 * One item with what connecting it needs: its drive's type (and so its
 * provider), name, parent path and web address. Also the probe a folder read
 * starts with, so a failure returns Graph's status instead of throwing.
 * `itemId` may be `root`; the result carries the item's real id.
 */
export async function getDriveItemDetails(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId: string;
	itemId: string;
}): Promise<DriveItemDetailsResult> {
	const { graphFetch, graphBaseUrl, driveId, itemId } = params;
	const response = await graphFetch(
		`${itemUrl(graphBaseUrl, driveId, itemId)}?$select=id,name,webUrl,folder,file,parentReference`,
	);
	if (!response.ok) {
		return {
			status: "failed",
			httpStatus: response.status,
			retryAfterSeconds: retryAfterSeconds(response),
		};
	}
	const item = (await response.json()) as {
		id: string;
		name: string;
		webUrl?: string;
		folder?: unknown;
		parentReference?: {
			driveId?: string;
			driveType?: string;
			path?: string;
		};
	};

	let driveType = item.parentReference?.driveType ?? null;
	if (!driveType) {
		const drive = await graphFetch(
			`${graphBaseUrl}/drives/${encodeURIComponent(driveId)}?$select=id,driveType`,
		);
		if (drive.ok) {
			driveType =
				((await drive.json()) as { driveType?: string }).driveType ??
				null;
		}
	}

	return {
		status: "ok",
		item: {
			id: item.id,
			name: item.name,
			driveId: item.parentReference?.driveId ?? driveId,
			driveType,
			provider: driveProviderForDriveType(driveType),
			isFolder: item.folder !== undefined,
			webUrl: item.webUrl ?? null,
			parentPath: pathBelowDriveRoot(item.parentReference?.path),
		},
	};
}

/**
 * Where an item is now, relative to a connected folder. `unknown` means Graph
 * did not say: it is neither gone nor present.
 */
export type DriveItemPlacement =
	| { itemId: string; state: "inside" }
	| { itemId: string; state: "outside" }
	| { itemId: string; state: "gone" }
	| {
			itemId: string;
			state: "unknown";
			httpStatus: number;
			retryAfterSeconds: number | null;
	  };

/**
 * Looks items up by id to confirm a file missing from the listing is really
 * out of the folder: `gone` when Graph answers 404 (deleted, or in the
 * recycle bin), `outside` when it now sits outside the folder or more than
 * `maxDepth` folders below it, `inside` otherwise.
 *
 * Placement is found by walking up parent ids, which stay the same through
 * renames and moves, rather than by comparing paths. Each folder on the way
 * is read once per call. Graph throttling that outlasts the request helper's
 * retries ends the lookups; every item not yet placed is then `unknown`.
 */
export async function lookupDriveItemsInFolder(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId: string;
	folderItemId: string;
	itemIds: string[];
	maxDepth?: number;
	onProgress?: (progress: DriveReadProgress) => void;
}): Promise<{ items: DriveItemPlacement[] }> {
	const { graphFetch, graphBaseUrl, driveId, itemIds, onProgress } = params;
	const maxDepth = params.maxDepth ?? DRIVE_TREE_MAX_DEPTH;

	type Read =
		| { ok: true; id: string; parentId: string | null }
		| { ok: false; httpStatus: number; retryAfterSeconds: number | null };
	const placements: DriveItemPlacement[] = [];
	let requests = 0;
	const read = async (id: string): Promise<Read> => {
		const response = await graphFetch(
			`${itemUrl(graphBaseUrl, driveId, id)}?$select=id,parentReference`,
		);
		requests++;
		let result: Read;
		if (response.ok) {
			const item = (await response.json()) as {
				id: string;
				parentReference?: { id?: string };
			};
			result = {
				ok: true,
				id: item.id,
				parentId: item.parentReference?.id ?? null,
			};
		} else {
			result = {
				ok: false,
				httpStatus: response.status,
				retryAfterSeconds: retryAfterSeconds(response),
			};
		}
		onProgress?.({ requests, items: placements.length });
		return result;
	};
	const unknown = (
		itemId: string,
		failure: { httpStatus: number; retryAfterSeconds: number | null },
	): DriveItemPlacement => ({
		itemId,
		state: "unknown",
		httpStatus: failure.httpStatus,
		retryAfterSeconds: failure.retryAfterSeconds,
	});

	// The folder's real id: the connected id may be the `root` alias.
	const folder = await read(params.folderItemId);
	if (!folder.ok) {
		return { items: itemIds.map((itemId) => unknown(itemId, folder)) };
	}

	const parentOf = new Map<string, string | null>();
	let throttled: {
		httpStatus: number;
		retryAfterSeconds: number | null;
	} | null = null;
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
		// `depth` counts the folders between the connected folder and the item.
		let parentId = item.parentId;
		for (let depth = 0; ; depth++) {
			if (parentId === null) {
				return { itemId, state: "outside" };
			}
			if (parentId === folder.id) {
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
				next = ancestor.parentId;
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

export interface SharePointSite {
	id: string;
	name: string;
	webUrl: string | null;
}

/**
 * `unavailable` is how a Microsoft account without SharePoint, such as a
 * personal one, answers: Graph refuses `/sites` with a 4xx.
 */
export type SharePointSiteList =
	| { status: "ok"; sites: SharePointSite[] }
	| { status: "unavailable" };

interface GraphSite {
	id: string;
	displayName?: string;
	name?: string;
	webUrl?: string;
}

function toSharePointSite(site: GraphSite): SharePointSite {
	return {
		id: site.id,
		name: site.displayName ?? site.name ?? site.id,
		webUrl: site.webUrl ?? null,
	};
}

/** A refusal, not throttling: a 429 that outlasted the retries is an error. */
function isClientError(status: number): boolean {
	return status >= 400 && status < 500 && status !== 429;
}

/** A site id is `host,siteGuid,webGuid`; its commas stay as they are. */
function siteSegment(siteId: string): string {
	return encodeURIComponent(siteId).replaceAll("%2C", ",");
}

/** The first page of SharePoint sites matching a search. */
export async function searchSharePointSites(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	query: string;
}): Promise<SharePointSiteList> {
	const query = params.query.trim();
	if (!query) {
		return { status: "ok", sites: [] };
	}
	const response = await params.graphFetch(
		`${params.graphBaseUrl}/sites?search=${encodeURIComponent(query)}`,
	);
	if (isClientError(response.status)) {
		return { status: "unavailable" };
	}
	if (!response.ok) {
		throw await graphError(response, "searching SharePoint sites");
	}
	const page = (await response.json()) as { value?: GraphSite[] };
	return { status: "ok", sites: (page.value ?? []).map(toSharePointSite) };
}

/**
 * The sites the user follows. Microsoft documents this list as sometimes
 * wrong, so it is a convenience: a failure other than a 4xx lists nothing
 * rather than failing the picker.
 */
export async function listFollowedSharePointSites(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
}): Promise<SharePointSiteList> {
	const response = await params.graphFetch(
		`${params.graphBaseUrl}/me/followedSites`,
	);
	if (isClientError(response.status)) {
		return { status: "unavailable" };
	}
	if (!response.ok) {
		return { status: "ok", sites: [] };
	}
	const page = (await response.json()) as { value?: GraphSite[] };
	return { status: "ok", sites: (page.value ?? []).map(toSharePointSite) };
}

interface SharePointDrive {
	id: string;
	name: string;
	driveType: string | null;
	provider: DriveProvider | null;
	webUrl: string | null;
}

export type SharePointDriveList =
	| { status: "ok"; drives: SharePointDrive[] }
	| { status: "unavailable" };

/** A site's document libraries. */
export async function listSharePointSiteDrives(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	siteId: string;
}): Promise<SharePointDriveList> {
	const response = await params.graphFetch(
		`${params.graphBaseUrl}/sites/${siteSegment(params.siteId)}/drives?$select=id,name,driveType,webUrl`,
	);
	if (isClientError(response.status)) {
		return { status: "unavailable" };
	}
	if (!response.ok) {
		throw await graphError(response, "listing the site's libraries");
	}
	const page = (await response.json()) as {
		value?: Array<{
			id: string;
			name?: string;
			driveType?: string;
			webUrl?: string;
		}>;
	};
	return {
		status: "ok",
		drives: (page.value ?? []).map((drive) => ({
			id: drive.id,
			name: drive.name ?? drive.id,
			driveType: drive.driveType ?? null,
			provider: driveProviderForDriveType(drive.driveType),
			webUrl: drive.webUrl ?? null,
		})),
	};
}

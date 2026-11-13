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
	const folder =
		driveId && itemId
			? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`
			: "/me/drive/root";
	let url: string | undefined =
		`${graphBaseUrl}${folder}/children?$top=${PAGE_SIZE}&$select=id,name,size,webUrl,lastModifiedDateTime,folder,file,parentReference`;

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
	| { status: "ok"; name: string; size: number; bytes: Buffer }
	| { status: "too_large"; name: string; size: number }
	| { status: "gone" };

/**
 * One file's bytes, refused past `maxBytes` before or while reading it.
 *
 * Graph's `/content` answers with a redirect, which the shared request helper
 * refuses on purpose, so the file is read from its `downloadUrl` instead: a
 * short-lived link that needs no token.
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
	const fetchImpl = params.fetchImpl ?? fetch;

	const response = await graphFetch(
		`${graphBaseUrl}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=id,name,size,file,@microsoft.graph.downloadUrl`,
	);
	if (response.status === 404) {
		return { status: "gone" };
	}
	if (!response.ok) {
		throw await graphError(response, "reading the file");
	}
	const item = (await response.json()) as GraphDriveItem & {
		"@microsoft.graph.downloadUrl"?: string;
	};
	const size = typeof item.size === "number" ? item.size : 0;
	if (size > maxBytes) {
		return { status: "too_large", name: item.name, size };
	}

	const link = item["@microsoft.graph.downloadUrl"];
	const downloadUrl = link ? new URL(link) : null;
	if (!downloadUrl || !isDownloadHost(downloadUrl)) {
		throw new Error("Microsoft Graph returned no usable download link.");
	}

	const download = await fetchImpl(downloadUrl, { redirect: "error" });
	if (!download.ok || !download.body) {
		throw new Error(`OneDrive download failed: ${download.status}`);
	}

	// Counted while reading: the size Graph reported is not a promise.
	const chunks: Uint8Array[] = [];
	let received = 0;
	const reader = download.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel();
			return { status: "too_large", name: item.name, size: received };
		}
		chunks.push(value);
	}
	return {
		status: "ok",
		name: item.name,
		size: received,
		bytes: Buffer.concat(chunks),
	};
}

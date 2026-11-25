/**
 * Reading Google Drive folders for document folders: the bounded walk of a
 * folder tree, looking files up by id before a removal, a folder's details
 * with its path and ancestors, and downloading or exporting one file. Every
 * test talks to a fake Drive that answers by path, and checks that the token
 * reaches no host but Google's API host.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DRIVE_TREE_MAX_DEPTH } from "../../microsoft/drive-folder";
import { isGoogleDriveNotConnectedError } from "../connection-errors";
import {
	downloadGoogleDriveFile,
	type GoogleDriveClient,
	getGoogleDriveItemDetails,
	listGoogleDriveFolderChildren,
	listGoogleDriveFolderTree,
	listGoogleDrivePlaces,
	lookupGoogleDriveItemsInFolder,
} from "../drive-folder";

const API_HOST = "www.googleapis.com";
const TOKEN = "token-example";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface DriveFileRecord {
	id: string;
	name?: string;
	mimeType?: string;
	parents?: string[];
	driveId?: string;
	trashed?: boolean;
	size?: string;
	md5Checksum?: string;
	version?: string;
	modifiedTime?: string;
	webViewLink?: string;
	capabilities?: { canDownload?: boolean };
}

interface ListPage {
	files: DriveFileRecord[];
	incompleteSearch?: boolean;
}

interface FakeDrive {
	/** `files.get` answers, by id; a Response is answered as it is. */
	items?: Record<string, DriveFileRecord | Response>;
	/** `files.list` pages of a folder's children, by folder id. */
	pages?: Record<string, Array<ListPage | Response>>;
	/** `files.get?alt=media` and `files.export` answers, by id. */
	content?: Record<string, Response>;
	/** `drives.list` pages. */
	drives?: Array<{ drives: Array<{ id: string; name: string }> }>;
	/** Anything off Google's API host, by URL. */
	other?: Record<string, Response>;
}

interface RecordedRequest {
	url: URL;
	authorization: string | null;
	redirect: RequestRedirect | undefined;
}

let requests: RecordedRequest[] = [];

afterEach(() => {
	// The token goes to Google's API host and nowhere else, and no redirect
	// is followed with it.
	for (const request of requests) {
		if (request.authorization !== null) {
			expect(request.url.hostname).toBe(API_HOST);
			expect(request.redirect).toBe("manual");
		}
	}
	requests = [];
});

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function driveError(
	status: number,
	reason: string,
	headers?: HeadersInit,
): Response {
	return json(
		{ error: { code: status, message: reason, errors: [{ reason }] } },
		status,
		headers,
	);
}

function bytes(length: number, status = 200): Response {
	return new Response(new Uint8Array(length).fill(7), { status });
}

/** A body sent in chunks, the way a long download arrives. */
function chunked(chunkSize: number, chunks: number): Response {
	let sent = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === chunks) {
				controller.close();
				return;
			}
			sent++;
			controller.enqueue(new Uint8Array(chunkSize));
		},
	});
	return new Response(stream);
}

function fakeDrive(drive: FakeDrive): GoogleDriveClient {
	const pageCursor = new Map<string, number>();
	const fetchImpl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		requests.push({
			url,
			authorization: headers.get("authorization"),
			redirect: init?.redirect,
		});
		if (url.hostname !== API_HOST) {
			return (
				drive.other?.[url.toString()] ??
				new Response(null, { status: 599 })
			);
		}
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		const path = url.pathname;
		if (path === "/drive/v3/drives") {
			const index = Number(url.searchParams.get("pageToken") ?? "0");
			const page = drive.drives?.[index] ?? { drives: [] };
			const next = index + 1 < (drive.drives?.length ?? 0);
			return json({
				...page,
				...(next ? { nextPageToken: String(index + 1) } : {}),
			});
		}
		if (path === "/drive/v3/files") {
			const parent = /^'([^']+)' in parents/.exec(
				url.searchParams.get("q") ?? "",
			)?.[1];
			if (!parent) {
				return json({ error: { code: 400 } }, 400);
			}
			const token = url.searchParams.get("pageToken");
			const index = token ? Number(token.split(":")[1]) : 0;
			pageCursor.set(parent, index);
			const pages = drive.pages?.[parent] ?? [{ files: [] }];
			const page = pages[index];
			if (page === undefined) {
				return json({ error: { code: 400 } }, 400);
			}
			if (page instanceof Response) {
				return page;
			}
			const next = index + 1 < pages.length;
			return json({
				...page,
				...(next ? { nextPageToken: `${parent}:${index + 1}` } : {}),
			});
		}
		const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
		if (exported) {
			return (
				drive.content?.[decodeURIComponent(exported[1] ?? "")] ??
				driveError(404, "notFound")
			);
		}
		const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (file) {
			const id = decodeURIComponent(file[1] ?? "");
			if (url.searchParams.get("alt") === "media") {
				return drive.content?.[id] ?? driveError(404, "notFound");
			}
			const item = drive.items?.[id];
			if (item === undefined) {
				return driveError(404, "notFound");
			}
			return item instanceof Response ? item : json(item);
		}
		return json({ error: { code: 400 } }, 400);
	};
	return { getAccessToken: async () => TOKEN, fetchImpl };
}

function folder(
	id: string,
	parents: string[] | undefined,
	extra: Partial<DriveFileRecord> = {},
): DriveFileRecord {
	return { id, name: id, mimeType: FOLDER_MIME, parents, ...extra };
}

function pdf(id: string, extra: Partial<DriveFileRecord> = {}) {
	return {
		id,
		name: `${id}.pdf`,
		mimeType: "application/pdf",
		size: "10",
		md5Checksum: `md5-${id}`,
		version: "3",
		modifiedTime: "2026-11-01T00:00:00.000Z",
		...extra,
	};
}

function tree(drive: FakeDrive) {
	return listGoogleDriveFolderTree(fakeDrive(drive), { itemId: "top" });
}

const TOP = { top: folder("top", ["root-id"]) };

describe("listGoogleDriveFolderTree", () => {
	it("lists every file across a folder's pages and its subfolder", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [
					{ files: [pdf("a"), folder("sub", ["top"])] },
					{ files: [pdf("b")] },
				],
				sub: [{ files: [pdf("c")] }],
			},
		});
		expect(listing.status).toBe("complete");
		expect(
			listing.status !== "root_failed" &&
				listing.files.map((file) => file.relativePath),
		).toEqual(["a.pdf", "b.pdf", "sub/c.pdf"]);
	});

	it("marks a listing with an incomplete page as truncated", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [{ files: [pdf("a")], incompleteSearch: true }],
			},
		});
		expect(listing).toMatchObject({
			status: "truncated",
			reason: "incomplete",
			files: [expect.objectContaining({ id: "a" })],
		});
	});

	it("keeps the files already read when a subfolder's page fails", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [{ files: [pdf("a"), folder("sub", ["top"])] }],
				sub: [driveError(500, "backendError")],
			},
		});
		expect(listing).toEqual({
			status: "truncated",
			reason: "page_failed",
			httpStatus: 500,
			retryAfterSeconds: null,
			files: [expect.objectContaining({ id: "a" })],
		});
	});

	it("reports a rate-limited page as throttled, with Google's wait", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [{ files: [folder("sub", ["top"])] }],
				sub: [
					driveError(403, "userRateLimitExceeded", {
						"Retry-After": "12",
					}),
				],
			},
		});
		expect(listing).toMatchObject({
			status: "truncated",
			reason: "page_failed",
			httpStatus: 429,
			retryAfterSeconds: 12,
		});
	});

	it("reads a tree deeper than the depth cap down to the cap, as complete", async () => {
		const pages: Record<string, ListPage[]> = {};
		let parent = "top";
		for (let level = 1; level <= DRIVE_TREE_MAX_DEPTH + 1; level++) {
			const id = `level-${level}`;
			pages[parent] = [{ files: [folder(id, [parent])] }];
			parent = id;
		}
		pages[parent] = [{ files: [pdf("deep")] }];
		(pages.top as ListPage[])[0]?.files.push(pdf("shallow"));
		(pages[`level-${DRIVE_TREE_MAX_DEPTH}`] as ListPage[])[0]?.files.push(
			pdf("at-cap"),
		);

		const listing = await tree({ items: TOP, pages });
		expect(listing.status).toBe("complete");
		const ids =
			listing.status === "complete" ? listing.files.map((f) => f.id) : [];
		expect(ids).toEqual(["shallow", "at-cap"]);
		// The file below the cap is out of the folder's scope.
		expect(ids).not.toContain("deep");
		expect(
			requests.some((request) =>
				request.url.searchParams
					.get("q")
					?.startsWith(`'level-${DRIVE_TREE_MAX_DEPTH + 1}'`),
			),
		).toBe(false);
	});

	it("truncates a tree with more items than the scan cap", async () => {
		const listing = await listGoogleDriveFolderTree(
			fakeDrive({
				items: TOP,
				pages: { top: [{ files: [pdf("a"), pdf("b"), pdf("c")] }] },
			}),
			{ itemId: "top", maxItems: 2 },
		);
		expect(listing).toMatchObject({
			status: "truncated",
			reason: "scan_limit",
			files: [
				expect.objectContaining({ id: "a" }),
				expect.objectContaining({ id: "b" }),
			],
		});
	});

	it("leaves shortcuts and Google types without an export out", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [
					{
						files: [
							{
								id: "shortcut",
								name: "Elsewhere",
								mimeType:
									"application/vnd.google-apps.shortcut",
							},
							{
								id: "form",
								name: "Survey",
								mimeType: "application/vnd.google-apps.form",
							},
							pdf("a"),
						],
					},
				],
			},
		});
		expect(
			listing.status === "complete" && listing.files.map((f) => f.id),
		).toEqual(["a"]);
	});

	it("types Google Docs and Sheets by their export", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [
					{
						files: [
							{
								id: "doc",
								name: "Plan",
								mimeType:
									"application/vnd.google-apps.document",
								version: "41",
							},
							{
								id: "sheet",
								name: "Budget",
								mimeType:
									"application/vnd.google-apps.spreadsheet",
								version: "7",
							},
						],
					},
				],
			},
		});
		expect(listing.status === "complete" && listing.files).toEqual([
			expect.objectContaining({
				name: "Plan.docx",
				relativePath: "Plan.docx",
				mimeType: DOCX_MIME,
				size: null,
			}),
			expect.objectContaining({
				name: "Budget.xlsx",
				mimeType: XLSX_MIME,
			}),
		]);
	});

	it("versions a binary file by its checksum and a native file by its version", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [
					{
						files: [
							pdf("a", { md5Checksum: "abc", version: "9" }),
							{
								id: "doc",
								name: "Plan",
								mimeType:
									"application/vnd.google-apps.document",
								version: "41",
							},
						],
					},
				],
			},
		});
		expect(
			listing.status === "complete" &&
				listing.files.map((file) => file.contentVersion),
		).toEqual(["md5:abc", "version:41"]);
	});

	it("marks a file the owner blocked from download", async () => {
		const listing = await tree({
			items: TOP,
			pages: {
				top: [
					{
						files: [
							pdf("blocked", {
								capabilities: { canDownload: false },
							}),
							pdf("open", {
								capabilities: { canDownload: true },
							}),
						],
					},
				],
			},
		});
		expect(listing.status === "complete" && listing.files).toEqual([
			expect.objectContaining({ id: "blocked", notDownloadable: true }),
			expect.not.objectContaining({ notDownloadable: true }),
		]);
	});

	it("reads a shared drive's folder within that drive", async () => {
		await tree({
			items: { top: folder("top", ["drive-1"], { driveId: "drive-1" }) },
			pages: { top: [{ files: [] }] },
		});
		const list = requests.find(
			(request) => request.url.pathname === "/drive/v3/files",
		);
		expect(list?.url.searchParams.get("corpora")).toBe("drive");
		expect(list?.url.searchParams.get("driveId")).toBe("drive-1");
		expect(list?.url.searchParams.get("supportsAllDrives")).toBe("true");
	});

	it("reports a trashed folder as gone, reading none of it", async () => {
		const listing = await tree({
			items: { top: folder("top", ["root-id"], { trashed: true }) },
		});
		expect(listing).toEqual({
			status: "root_failed",
			httpStatus: 404,
			retryAfterSeconds: null,
		});
	});

	it("reports a folder the reader cannot open as a root failure", async () => {
		const listing = await tree({
			items: { top: driveError(403, "insufficientFilePermissions") },
		});
		expect(listing).toEqual({
			status: "root_failed",
			httpStatus: 403,
			retryAfterSeconds: null,
		});
	});

	it("raises the not-connected error on a 401", async () => {
		await expect(
			tree({ items: { top: driveError(401, "authError") } }),
		).rejects.toSatisfy((error: Error) =>
			isGoogleDriveNotConnectedError(error.message),
		);
	});
});

describe("lookupGoogleDriveItemsInFolder", () => {
	function lookup(
		items: Record<string, DriveFileRecord | Response>,
		itemIds: string[],
	) {
		return lookupGoogleDriveItemsInFolder(fakeDrive({ items }), {
			folderItemId: "top",
			itemIds,
		});
	}

	it("places a file two levels below the folder inside", async () => {
		const result = await lookup(
			{
				...TOP,
				mid: folder("mid", ["top"]),
				low: folder("low", ["mid"]),
				file: pdf("file", { parents: ["low"] }),
			},
			["file"],
		);
		expect(result.items).toEqual([{ itemId: "file", state: "inside" }]);
	});

	it("places a file whose parents reach the drive root without the folder outside", async () => {
		const result = await lookup(
			{
				...TOP,
				"root-id": folder("root-id", undefined),
				other: folder("other", ["root-id"]),
				file: pdf("file", { parents: ["other"] }),
			},
			["file"],
		);
		expect(result.items).toEqual([{ itemId: "file", state: "outside" }]);
	});

	it("places a file whose next parent the reader cannot see outside", async () => {
		// Drive leaves out the parents a reader cannot see.
		const result = await lookup(
			{
				...TOP,
				mid: folder("mid", undefined),
				file: pdf("file", { parents: ["mid"] }),
			},
			["file"],
		);
		expect(result.items).toEqual([{ itemId: "file", state: "outside" }]);
	});

	it("reports a deleted or trashed file as gone", async () => {
		const result = await lookup(
			{
				...TOP,
				trashed: pdf("trashed", { parents: ["top"], trashed: true }),
			},
			["deleted", "trashed"],
		);
		expect(result.items).toEqual([
			{ itemId: "deleted", state: "gone" },
			{ itemId: "trashed", state: "gone" },
		]);
	});

	it("leaves a throttled or failed read unknown", async () => {
		const result = await lookup(
			{
				...TOP,
				limited: driveError(403, "userRateLimitExceeded", {
					"Retry-After": "30",
				}),
			},
			["limited", "after"],
		);
		expect(result.items).toEqual([
			{
				itemId: "limited",
				state: "unknown",
				httpStatus: 429,
				retryAfterSeconds: 30,
			},
			// Throttling ends the lookups: the rest are not read at all.
			{
				itemId: "after",
				state: "unknown",
				httpStatus: 429,
				retryAfterSeconds: 30,
			},
		]);
		expect(
			requests.some((request) => request.url.pathname.endsWith("/after")),
		).toBe(false);
	});

	it("leaves a file unknown when Drive answers 503", async () => {
		const result = await lookup(
			{ ...TOP, file: driveError(503, "backendError") },
			["file"],
		);
		expect(result.items).toEqual([
			{
				itemId: "file",
				state: "unknown",
				httpStatus: 503,
				retryAfterSeconds: null,
			},
		]);
	});

	it("leaves a file unknown when one of its parents cannot be read", async () => {
		const result = await lookup(
			{
				...TOP,
				file: pdf("file", { parents: ["mid"] }),
			},
			["file"],
		);
		expect(result.items).toEqual([
			{
				itemId: "file",
				state: "unknown",
				httpStatus: 404,
				retryAfterSeconds: null,
			},
		]);
	});

	it("places a file deeper than the depth cap outside", async () => {
		const items: Record<string, DriveFileRecord> = { ...TOP };
		let parent = "top";
		for (let level = 1; level <= DRIVE_TREE_MAX_DEPTH + 1; level++) {
			items[`level-${level}`] = folder(`level-${level}`, [parent]);
			parent = `level-${level}`;
		}
		items.file = pdf("file", { parents: [parent] });
		const result = await lookup(items, ["file"]);
		expect(result.items).toEqual([{ itemId: "file", state: "outside" }]);
	});

	it("places a My Drive folder's file that moved into a shared drive outside", async () => {
		const result = await lookup(
			{
				...TOP,
				file: pdf("file", { parents: ["top"], driveId: "drive-9" }),
			},
			["file"],
		);
		expect(result.items).toEqual([{ itemId: "file", state: "outside" }]);
	});

	it("places a shared-drive folder's file in another drive outside", async () => {
		const result = await lookup(
			{
				top: folder("top", ["drive-1"], { driveId: "drive-1" }),
				file: pdf("file", { parents: ["top"], driveId: "drive-2" }),
			},
			["file"],
		);
		expect(result.items).toEqual([{ itemId: "file", state: "outside" }]);
	});

	it("asks Drive for the fields the placement needs, across drives", async () => {
		await lookup({ ...TOP, file: pdf("file", { parents: ["top"] }) }, [
			"file",
		]);
		const read = requests.find((request) =>
			request.url.pathname.endsWith("/file"),
		);
		expect(read?.url.searchParams.get("supportsAllDrives")).toBe("true");
		expect(read?.url.searchParams.get("fields")).toBe(
			"id,parents,trashed,driveId",
		);
	});
});

describe("getGoogleDriveItemDetails", () => {
	it("details a shared-drive folder with its path and ancestors", async () => {
		const result = await getGoogleDriveItemDetails(
			fakeDrive({
				items: {
					q3: folder("q3", ["plans"], {
						name: "Q3",
						driveId: "drive-1",
						webViewLink:
							"https://drive.google.com/drive/folders/q3",
					}),
					plans: folder("plans", ["drive-1"], {
						name: "Plans",
						driveId: "drive-1",
					}),
					"drive-1": folder("drive-1", undefined, {
						name: "Team",
						driveId: "drive-1",
					}),
				},
			}),
			{ itemId: "q3" },
		);
		expect(result).toEqual({
			status: "ok",
			item: {
				id: "q3",
				name: "Q3",
				driveId: "drive-1",
				driveType: null,
				provider: "googledrive",
				isFolder: true,
				webUrl: "https://drive.google.com/drive/folders/q3",
				parentPath: "/Plans",
				drivePath: "/Plans/Q3",
				ancestorIds: ["plans", "drive-1"],
			},
		});
	});

	it("gives a My Drive folder the reader's root folder id as its drive", async () => {
		const result = await getGoogleDriveItemDetails(
			fakeDrive({
				items: {
					root: folder("root-id", undefined, { name: "My Drive" }),
					"root-id": folder("root-id", undefined, {
						name: "My Drive",
					}),
					notes: folder("notes", ["root-id"], { name: "Notes" }),
				},
			}),
			{ itemId: "notes" },
		);
		expect(result).toMatchObject({
			status: "ok",
			item: {
				driveId: "root-id",
				parentPath: "/",
				drivePath: "/Notes",
				ancestorIds: ["root-id"],
			},
		});
	});

	it("details a folder whose parents the reader cannot open, without ancestors", async () => {
		// Another person's folder, shared with this reader: its parent is
		// not theirs to open, and their own root is not above it.
		const result = await getGoogleDriveItemDetails(
			fakeDrive({
				items: {
					root: folder("reader-root", undefined, {
						name: "My Drive",
					}),
					notes: folder("notes", ["owner-folder"], { name: "Notes" }),
				},
			}),
			{ itemId: "notes" },
		);
		expect(result).toMatchObject({
			status: "ok",
			item: { id: "notes", name: "Notes", driveId: "reader-root" },
		});
		expect(result.status === "ok" && "ancestorIds" in result.item).toBe(
			false,
		);
		// A partial name path would overwrite the stored one with a wrong
		// path, so a walk cut short reports none.
		expect(result.status === "ok" && result.item.drivePath).toBeNull();
	});

	it("reports a trashed folder as gone", async () => {
		const result = await getGoogleDriveItemDetails(
			fakeDrive({
				items: {
					notes: folder("notes", ["root-id"], { trashed: true }),
				},
			}),
			{ itemId: "notes" },
		);
		expect(result).toEqual({
			status: "failed",
			httpStatus: 404,
			retryAfterSeconds: null,
		});
	});

	it("reports a daily quota refusal as throttled with a long wait", async () => {
		const result = await getGoogleDriveItemDetails(
			fakeDrive({
				items: { notes: driveError(403, "dailyLimitExceeded") },
			}),
			{ itemId: "notes" },
		);
		expect(result).toMatchObject({ status: "failed", httpStatus: 429 });
		expect(
			result.status === "failed" && result.retryAfterSeconds,
		).toBeGreaterThanOrEqual(3600);
	});
});

describe("downloadGoogleDriveFile", () => {
	function download(drive: FakeDrive, itemId: string, maxBytes = 1_000) {
		return downloadGoogleDriveFile(fakeDrive(drive), { itemId, maxBytes });
	}

	it("streams a binary file's bytes", async () => {
		const result = await download(
			{ items: { a: pdf("a") }, content: { a: bytes(10) } },
			"a",
		);
		expect(result).toMatchObject({
			status: "ok",
			name: "a.pdf",
			size: 10,
			mimeType: "application/pdf",
		});
		expect(result.status === "ok" && result.bytes.length).toBe(10);
	});

	it("stops a binary file whose bytes pass the cap", async () => {
		const result = await download(
			{
				items: { a: pdf("a", { size: "10" }) },
				content: { a: chunked(400, 5) },
			},
			"a",
		);
		expect(result).toMatchObject({ status: "too_large", name: "a.pdf" });
	});

	it("exports a Google Doc as DOCX", async () => {
		const result = await download(
			{
				items: {
					doc: {
						id: "doc",
						name: "Plan",
						mimeType: "application/vnd.google-apps.document",
					},
				},
				content: { doc: bytes(20) },
			},
			"doc",
		);
		expect(result).toMatchObject({
			status: "ok",
			name: "Plan.docx",
			size: 20,
			mimeType: DOCX_MIME,
		});
		const exported = requests.find((request) =>
			request.url.pathname.endsWith("/doc/export"),
		);
		expect(exported?.url.searchParams.get("mimeType")).toBe(DOCX_MIME);
	});

	const DOC = {
		doc: {
			id: "doc",
			name: "Plan",
			mimeType: "application/vnd.google-apps.document",
		},
	};

	it("skips an export Google refuses as too large", async () => {
		const result = await download(
			{
				items: DOC,
				content: { doc: driveError(403, "exportSizeLimitExceeded") },
			},
			"doc",
			50_000_000,
		);
		expect(result).toMatchObject({
			status: "too_large",
			name: "Plan.docx",
		});
	});

	it("stops an export that keeps sending past 10 MB", async () => {
		const result = await download(
			{ items: DOC, content: { doc: chunked(1024 * 1024, 11) } },
			"doc",
			50_000_000,
		);
		expect(result).toMatchObject({
			status: "too_large",
			name: "Plan.docx",
		});
	});

	it("reports a file Google flagged as not downloadable", async () => {
		const result = await download(
			{
				items: { a: pdf("a") },
				content: { a: driveError(403, "cannotDownloadAbusiveFile") },
			},
			"a",
		);
		expect(result).toEqual({ status: "not_downloadable", name: "a.pdf" });
	});

	it("reports a file the owner blocked without reading it", async () => {
		const result = await download(
			{
				items: {
					a: pdf("a", { capabilities: { canDownload: false } }),
				},
			},
			"a",
		);
		expect(result).toEqual({ status: "not_downloadable", name: "a.pdf" });
		expect(
			requests.some((request) => request.url.searchParams.has("alt")),
		).toBe(false);
	});

	it("follows a redirect to Google's download host without the token", async () => {
		const location = "https://doc-0s.example.googleusercontent.com/file-a";
		const result = await download(
			{
				items: { a: pdf("a") },
				content: {
					a: new Response(null, {
						status: 302,
						headers: { location },
					}),
				},
				other: { [location]: bytes(10) },
			},
			"a",
		);
		expect(result).toMatchObject({ status: "ok", size: 10 });
		const followed = requests.find(
			(request) => request.url.toString() === location,
		);
		expect(followed?.authorization).toBeNull();
	});

	it("refuses a redirect to a host that is not Google's", async () => {
		const location = "https://files.example.com/file-a";
		await expect(
			download(
				{
					items: { a: pdf("a") },
					content: {
						a: new Response(null, {
							status: 302,
							headers: { location },
						}),
					},
					other: { [location]: bytes(10) },
				},
				"a",
			),
		).rejects.toThrow("files.example.com");
		expect(
			requests.some(
				(request) => request.url.hostname === "files.example.com",
			),
		).toBe(false);
	});

	it("reports a deleted file as gone", async () => {
		await expect(download({}, "missing")).resolves.toEqual({
			status: "gone",
		});
	});

	it("raises the not-connected error on a 401", async () => {
		await expect(
			download({ items: { a: driveError(401, "authError") } }, "a"),
		).rejects.toSatisfy((error: Error) =>
			isGoogleDriveNotConnectedError(error.message),
		);
	});
});

describe("Google Drive places and folder children", () => {
	it("lists My Drive and every page of shared drives", async () => {
		const places = await listGoogleDrivePlaces(
			fakeDrive({
				items: {
					root: folder("root-id", undefined, { name: "My Drive" }),
				},
				drives: [
					{ drives: [{ id: "drive-1", name: "Team" }] },
					{ drives: [{ id: "drive-2", name: "Design" }] },
				],
			}),
		);
		expect(places).toEqual({
			myDrive: { id: "root-id", name: "My Drive" },
			sharedDrives: [
				{ id: "drive-1", name: "Team" },
				{ id: "drive-2", name: "Design" },
			],
		});
	});

	it("lists no shared drives for an account without any", async () => {
		const places = await listGoogleDrivePlaces(
			fakeDrive({
				items: {
					root: folder("root-id", undefined, { name: "My Drive" }),
				},
			}),
		);
		expect(places.sharedDrives).toEqual([]);
	});

	it("lists a folder's folders and files, typed as the sync types them", async () => {
		const children = await listGoogleDriveFolderChildren(
			fakeDrive({
				items: TOP,
				pages: {
					top: [
						{
							files: [
								folder("sub", ["top"], { name: "Sub" }),
								{
									id: "doc",
									name: "Plan",
									mimeType:
										"application/vnd.google-apps.document",
								},
								{
									id: "shortcut",
									name: "Elsewhere",
									mimeType:
										"application/vnd.google-apps.shortcut",
								},
							],
						},
					],
				},
			}),
			{ folderId: "top" },
		);
		expect(children).toEqual({
			items: [
				expect.objectContaining({
					id: "sub",
					name: "Sub",
					isFolder: true,
				}),
				expect.objectContaining({
					id: "doc",
					name: "Plan.docx",
					isFolder: false,
					mimeType: DOCX_MIME,
				}),
			],
			truncated: false,
		});
	});
});

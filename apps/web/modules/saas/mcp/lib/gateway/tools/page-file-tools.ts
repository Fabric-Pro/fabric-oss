/**
 * Fabric MCP Gateway - Page file tools
 *
 * Files a page keeps: an export people upload, a report to download later. The
 * bytes live in private storage under the page owner's tenant path
 * (`buildFramePageFilePath`), so deleting the page deletes them; what the page
 * can list and read is the record in the host's `$files` collection, which a
 * page cannot write.
 *
 * A file is at most 4 MB and a page holds at most 50 MB. The quota is checked
 * before the bytes are stored and again after the record is written, so two
 * uploads at once cannot both fit when only one does.
 */

import { randomUUID } from "node:crypto";
import {
	deletePageRecords,
	getPageRecord,
	listPageRecords,
	type PageRecordView,
	pageFilesUsage,
	setPageRecords,
} from "@repo/database";
import {
	base64DecodedSize,
	cleanPageFileName,
	FILES_COLLECTION,
	PAGE_FILE_MAX_BYTES,
	PAGE_FILES_MAX_BYTES,
} from "@repo/utils/page-limits";
import { errorResult, jsonResult } from "../tool-results";
import { nonEmptyString } from "./frame-context";
import {
	noInput,
	type OpenedPage,
	type PageInput,
	pageTool,
	refuse,
} from "./page-store";

/** The storage layer and its configuration are loaded on first use. */
const storage = () => import("@repo/storage");
const pageFilesBucket = async () =>
	(await import("@repo/api/modules/frames/lib/page-files")).PAGE_FILES_BUCKET;

const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;
const MAX_RECORD_PAGES = 30;

type StoredFile = {
	name: string;
	contentType: string;
	size: number;
	storageKey: string;
};

type PageFile = { id: string; file: StoredFile; record: PageRecordView };

function storedFileOf(value: PageRecordView["value"]): StoredFile | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const { name, contentType, size, storageKey } = value;
	return typeof name === "string" &&
		typeof contentType === "string" &&
		typeof size === "number" &&
		typeof storageKey === "string"
		? { name, contentType, size, storageKey }
		: null;
}

/** The files recorded for the page, oldest first, up to the most a listing shows. */
async function pageFilesOf(
	page: Pick<OpenedPage, "frameId" | "organizationId">,
	viewerUserId: string,
): Promise<PageFile[]> {
	const files: PageFile[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < MAX_RECORD_PAGES; pages += 1) {
		const listed = await listPageRecords({
			frameId: page.frameId,
			organizationId: page.organizationId,
			viewerUserId,
			collection: FILES_COLLECTION,
			scope: "shared",
			cursor,
			limit: 100,
		});
		for (const record of listed.records) {
			const file = storedFileOf(record.value);
			if (file) {
				files.push({ id: record.key, file, record });
			}
		}
		if (!listed.nextCursor) {
			break;
		}
		cursor = listed.nextCursor;
	}
	return files;
}

type Upload = {
	name: string;
	contentType: string;
	bytes: Buffer;
};

/**
 * What an upload names, with the bytes refused before they are decoded when
 * they would be over the cap and when the string is not base64 at all.
 */
function uploadOf(args: Record<string, unknown>): PageInput<Upload> {
	const name =
		typeof args.name === "string"
			? cleanPageFileName(args.name) || undefined
			: undefined;
	const contentType = nonEmptyString(args.contentType);
	if (!name || !contentType || !CONTENT_TYPE_PATTERN.test(contentType)) {
		return refuse(
			"file",
			"`name` and a `contentType` such as image/png are required.",
		);
	}
	const data = args.dataBase64;
	if (typeof data !== "string" || data.length === 0) {
		return refuse("data", "`dataBase64` is required.");
	}
	const size = base64DecodedSize(data);
	if (size === null) {
		return refuse("data", "`dataBase64` is not valid base64.");
	}
	if (size > PAGE_FILE_MAX_BYTES) {
		return refuse(
			"file_too_large",
			`A file is at most ${PAGE_FILE_MAX_BYTES / (1024 * 1024)} MB.`,
			{ max: PAGE_FILE_MAX_BYTES },
		);
	}
	return {
		ok: true,
		value: { name, contentType, bytes: Buffer.from(data, "base64") },
	};
}

const pageFull = () =>
	errorResult(
		`A page holds at most ${PAGE_FILES_MAX_BYTES / (1024 * 1024)} MB of files.`,
		{ reason: "page_files_full", max: PAGE_FILES_MAX_BYTES },
	);

/** A file that could not be removed is left for the page's own delete to sweep. */
async function removeObject(key: string): Promise<void> {
	try {
		const { deleteFile } = await storage();
		await deleteFile(key, { bucket: await pageFilesBucket() });
	} catch (error) {
		console.warn("[MCP Gateway] page file cleanup failed:", error);
	}
}

const handleUploadPageFile = pageTool(
	{ rate: "write", parse: uploadOf },
	async ({ input, page, session }) => {
		const size = input.bytes.length;
		const usage = {
			frameId: page.frameId,
			organizationId: page.organizationId,
		};
		if ((await pageFilesUsage(usage)).bytes + size > PAGE_FILES_MAX_BYTES) {
			return pageFull();
		}

		const { buildFramePageFilePath, uploadFile } = await storage();
		const id = randomUUID();
		const storageKey = buildFramePageFilePath({
			organizationId: page.organizationId,
			userId: page.ownerUserId,
			frameId: page.frameId,
			fileId: id,
		});
		await uploadFile(storageKey, input.bytes, {
			bucket: await pageFilesBucket(),
			contentType: input.contentType,
			access: "private",
		});

		try {
			await setPageRecords({
				frameId: page.frameId,
				organizationId: page.organizationId,
				actorUserId: session.userId,
				collection: FILES_COLLECTION,
				records: [
					{
						key: id,
						value: {
							name: input.name,
							contentType: input.contentType,
							size,
							storageKey,
						},
						scope: "shared",
						expectedVersion: 0,
					},
				],
				allowReserved: true,
			});
			if ((await pageFilesUsage(usage)).bytes > PAGE_FILES_MAX_BYTES) {
				await deletePageRecords({
					frameId: page.frameId,
					organizationId: page.organizationId,
					actorUserId: session.userId,
					isPageOwner: page.isOwner,
					collection: FILES_COLLECTION,
					keys: [id],
					allowReserved: true,
				});
				await removeObject(storageKey);
				return pageFull();
			}
		} catch (error) {
			await removeObject(storageKey);
			throw error;
		}
		return jsonResult({
			id,
			name: input.name,
			contentType: input.contentType,
			size,
		});
	},
);

const handleListPageFiles = pageTool(
	{ parse: noInput },
	async ({ page, session }) => {
		const files = await pageFilesOf(page, session.userId);
		return jsonResult({
			files: files.map(({ id, file, record }) => ({
				id,
				name: file.name,
				contentType: file.contentType,
				size: file.size,
				uploadedBy: record.createdBy,
				uploadedAt: record.updatedAt,
			})),
			totalBytes: files.reduce((sum, { file }) => sum + file.size, 0),
		});
	},
);

/** The record of one file of the page, or null for an id that names none. */
async function pageFileOf(
	page: OpenedPage,
	viewerUserId: string,
	id: string,
): Promise<PageFile | null> {
	const record = await getPageRecord({
		frameId: page.frameId,
		organizationId: page.organizationId,
		viewerUserId,
		collection: FILES_COLLECTION,
		key: id,
		scope: "shared",
	});
	const file = record ? storedFileOf(record.value) : null;
	return record && file ? { id, file, record } : null;
}

/** The id of the file a call names. */
function fileIdOf(args: Record<string, unknown>): PageInput<string> {
	const id = nonEmptyString(args.id);
	return id ? { ok: true, value: id } : refuse("file", "`id` is required.");
}

const fileNotFound = () =>
	errorResult("File not found.", { reason: "file_not_found" });

const handleReadPageFile = pageTool(
	{ parse: fileIdOf },
	async ({ input: id, page, session }) => {
		const found = await pageFileOf(page, session.userId, id);
		if (!found) {
			return fileNotFound();
		}
		const { buildFramePageFilesPrefix, getStorageProvider } =
			await storage();
		const prefix = buildFramePageFilesPrefix({
			organizationId: page.organizationId,
			userId: page.ownerUserId,
			frameId: page.frameId,
		});
		if (!found.file.storageKey.startsWith(prefix)) {
			return fileNotFound();
		}
		const { data } = await getStorageProvider().downloadFile(
			found.file.storageKey,
			{ bucket: await pageFilesBucket() },
		);
		return jsonResult({
			id,
			name: found.file.name,
			contentType: found.file.contentType,
			size: data.length,
			dataBase64: data.toString("base64"),
		});
	},
);

const handleDeletePageFile = pageTool(
	{ rate: "write", parse: fileIdOf },
	async ({ input: id, page, session }) => {
		const found = await pageFileOf(page, session.userId, id);
		if (!found) {
			return fileNotFound();
		}
		const { deleted } = await deletePageRecords({
			frameId: page.frameId,
			organizationId: page.organizationId,
			actorUserId: session.userId,
			isPageOwner: page.isOwner,
			collection: FILES_COLLECTION,
			keys: [id],
			allowReserved: true,
		});
		if (deleted === 0) {
			return errorResult(
				"Only the person who stored a file, or the page's owner, can delete it.",
				{ reason: "not_yours" },
			);
		}
		await removeObject(found.file.storageKey);
		return jsonResult({ id, deleted: true });
	},
);

export const PAGE_FILE_HANDLERS = new Map([
	["fabric_page_file_upload", handleUploadPageFile],
	["fabric_page_file_list", handleListPageFiles],
	["fabric_page_file_read", handleReadPageFile],
	["fabric_page_file_delete", handleDeletePageFile],
]);

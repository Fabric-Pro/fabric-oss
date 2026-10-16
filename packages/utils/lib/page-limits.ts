/**
 * What a published page may keep, and the small helpers that guard it. Pure
 * and free of dependencies, so the database queries, the tool definitions, the
 * gateway handlers and the page host in the browser all read ONE definition
 * instead of four copies that have to agree.
 */

/** Records one write or delete holds. */
export const PAGE_BATCH_MAX = 25;
/** The most a list returns, and what it returns when no limit is asked for. */
export const PAGE_LIST_MAX = 100;
export const PAGE_LIST_DEFAULT = 50;

export const PAGE_COMMENT_MAX_CHARS = 2_000;

/** Collections the host keeps for itself; a page cannot read or write one through the data tools. */
export const RESERVED_COLLECTION_PREFIX = "$";
export const FILES_COLLECTION = "$files";
export const COMMENTS_COLLECTION = "$comments";
export const RESERVED_PAGE_COLLECTIONS = [
	FILES_COLLECTION,
	COMMENTS_COLLECTION,
] as const;

/** A file a page stores, and what one page holds in all. */
export const PAGE_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const PAGE_FILES_MAX_BYTES = 50 * 1024 * 1024;

/** What a page may hand the viewer to save. */
export const PAGE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** The length of the base64 text of `bytes` bytes, padding included. */
export function base64LengthOf(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}

export const PAGE_DOWNLOAD_MAX_BASE64_LENGTH = base64LengthOf(
	PAGE_DOWNLOAD_MAX_BYTES,
);

/** The Prompt Library and agent-list id of Fabric Agent, the agent every chat history is kept under. */
export const FABRIC_AGENT_ID = "fabric-workspace-assistant";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * How many bytes a base64 string decodes to, from its length alone, or null
 * when it is not base64 (wrong length for the alphabet, or a character outside
 * it). Cheap enough to check before anything is decoded, so a string over a cap
 * is refused without allocating its bytes.
 */
export function base64DecodedSize(value: string): number | null {
	if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
		return null;
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

const MAX_FILE_NAME_CHARS = 100;

/**
 * A file name that is only a name: no directories, no control or reserved
 * characters, no characters that reorder or hide text (bidirectional overrides
 * and isolates, zero-width characters, the byte-order mark), no leading dots,
 * at most 100 characters with its extension kept. Empty when nothing is left of
 * it. Used for the names of files a page stores and for the files it offers the
 * viewer, so a name means the same thing in both.
 */
export function cleanPageFileName(raw: string): string {
	const last = raw.split(/[\\/]/).pop() ?? "";
	const cleaned = last
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
		.replace(/[؜​-‏‪-‮⁠-⁩﻿]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "");
	if (cleaned.length <= MAX_FILE_NAME_CHARS) {
		return cleaned;
	}
	const dot = cleaned.lastIndexOf(".");
	const extension = dot > 0 ? cleaned.slice(dot) : "";
	return `${cleaned.slice(0, MAX_FILE_NAME_CHARS - extension.length)}${extension}`;
}

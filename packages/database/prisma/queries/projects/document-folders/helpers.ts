/**
 * Pure document-folder helpers: descriptions, file classification, folder
 * overlap and file sizes.
 */

import {
	contextUploadConfigFor,
	resolveContextUploadMime,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import { truncateWellFormed } from "@repo/utils/cut-at-code-units";
import { DOCUMENT_FOLDER_DESCRIPTION_MAX } from "./constants";

/**
 * Store a description as the model will see it: one line, without control
 * characters, at most 500 characters. Empty becomes none.
 */
export function normalizeDocumentFolderDescription(
	input: string | null | undefined,
): string | null {
	if (!input) {
		return null;
	}
	const oneLine = input
		.replace(/\s*[\r\n\u2028\u2029]+\s*/gu, " ")
		.replace(/\t/gu, " ")
		.replace(/\p{Cc}/gu, "")
		.trim();
	const cut = truncateWellFormed(
		oneLine,
		DOCUMENT_FOLDER_DESCRIPTION_MAX,
	).trim();
	return cut.length > 0 ? cut : null;
}

/**
 * What the upload vocabulary makes of a file: pending import, or skipped as
 * unsupported or too big. The same rule reads a listing and creates the
 * context, so the two cannot disagree.
 */
export function classifyDocumentFolderFile(file: {
	name: string;
	mimeType: string | null;
	size: number | null;
}):
	| { status: "PENDING"; skipCode: null }
	| {
			status: "SKIPPED";
			skipCode: "UNSUPPORTED" | "TOO_BIG";
	  } {
	const config = contextUploadConfigFor(
		resolveContextUploadMime(file.mimeType ?? "", file.name),
	);
	if (!config) {
		return { status: "SKIPPED", skipCode: "UNSUPPORTED" };
	}
	if (file.size !== null && file.size > UPLOAD_SIZE_LIMITS[config.type]) {
		return { status: "SKIPPED", skipCode: "TOO_BIG" };
	}
	return { status: "PENDING", skipCode: null };
}

function pathSegments(path: string | null): string[] | null {
	if (path === null) {
		return null;
	}
	return path
		.trim()
		.toLowerCase()
		.split("/")
		.filter((segment) => segment.length > 0);
}

/**
 * Whether two folders are the same, or one lies inside the other, judged by
 * their paths in one drive. Drive paths are case-insensitive, and compared by
 * segment so `/Sales` does not contain `/Sales 2`. Unknown paths never overlap.
 */
export function foldersOverlap(
	a: { driveId: string; drivePath: string | null },
	b: { driveId: string; drivePath: string | null },
): boolean {
	if (a.driveId !== b.driveId) {
		return false;
	}
	const left = pathSegments(a.drivePath);
	const right = pathSegments(b.drivePath);
	if (!left || !right) {
		return false;
	}
	const [shorter, longer] =
		left.length <= right.length ? [left, right] : [right, left];
	return shorter.every((segment, index) => longer[index] === segment);
}

/** A file size as the BIGINT column stores it. */
export function toBigIntOrNull(size: number | null): bigint | null {
	return size === null ? null : BigInt(size);
}

/** A file size as the BIGINT column returns it, as a number. */
export function toNumberOrNull(size: bigint | null): number | null {
	return size === null ? null : Number(size);
}

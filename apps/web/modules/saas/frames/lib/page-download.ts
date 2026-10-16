import {
	base64DecodedSize,
	cleanPageFileName,
	PAGE_DOWNLOAD_MAX_BYTES,
} from "@repo/utils/page-limits";

/**
 * What a page may hand the viewer to save: a file of one of a few plain kinds,
 * under a name the host has cleaned, no larger than the host will hold. The page
 * asks and the viewer decides; nothing here saves anything.
 */

const ALLOWED_TYPES: ReadonlyMap<string, string> = new Map([
	["csv", "text/csv"],
	["json", "application/json"],
	["txt", "text/plain"],
	["md", "text/markdown"],
	["pdf", "application/pdf"],
	["png", "image/png"],
	["svg", "image/svg+xml"],
]);

export interface PageDownload {
	filename: string;
	mimeType: string;
	bytes: number;
	dataBase64: string;
}

function bareType(mimeType: string): string {
	return mimeType.split(";")[0].trim().toLowerCase();
}

/**
 * The download to offer the viewer, or why there is none. A name whose extension
 * is not on the list, a type that does not belong to the extension, text that is
 * not base64 and a file over 10 MB are all refused.
 */
export function checkDownload(request: {
	filename: string;
	mimeType: string;
	dataBase64: string;
}): { ok: true; download: PageDownload } | { ok: false; error: string } {
	const filename = cleanPageFileName(request.filename);
	const dot = filename.lastIndexOf(".");
	const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
	const expectedType = ALLOWED_TYPES.get(extension);
	if (!filename || !expectedType) {
		return {
			ok: false,
			error: `A page may offer ${[...ALLOWED_TYPES.keys()].join(", ")} files only.`,
		};
	}
	if (bareType(request.mimeType) !== expectedType) {
		return {
			ok: false,
			error: `A .${extension} file is ${expectedType}, not ${request.mimeType}.`,
		};
	}
	const bytes = base64DecodedSize(request.dataBase64);
	if (bytes === null) {
		return { ok: false, error: "The file could not be read." };
	}
	if (bytes > PAGE_DOWNLOAD_MAX_BYTES) {
		return { ok: false, error: "A download may be at most 10 MB." };
	}
	return {
		ok: true,
		download: {
			filename,
			mimeType: expectedType,
			bytes,
			dataBase64: request.dataBase64,
		},
	};
}

/** "12 KB" for the question the viewer is asked. */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

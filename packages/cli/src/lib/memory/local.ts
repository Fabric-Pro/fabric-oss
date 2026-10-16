/**
 * What the working tree holds under the write folders.
 *
 * Only the folders the server names are looked at, and only what the server
 * would accept there: regular text files with a text extension and no
 * dot-prefixed path segment. Links and special files are never followed, and a
 * file the server would refuse is reported rather than sent, so one bad file
 * cannot block the rest of a write.
 */
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
	classifyContextBytes,
	hasTextExtension,
	MAX_CONTEXT_FILE_BYTES,
} from "../context-sync/classify.js";
import { readFileSafely } from "../instructions/safe-write.js";

interface LocalFile {
	/** Repository-relative, `/`-separated. */
	path: string;
	size: number;
}

export type SkipReason =
	| "not-text-extension"
	| "too-large"
	| "binary"
	| "empty"
	| "link";

export interface LocalScan {
	files: LocalFile[];
	skipped: Array<{ path: string; reason: SkipReason }>;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function scanFolder(
	root: string,
	folder: string,
): Promise<LocalScan> {
	const scan: LocalScan = { files: [], skipped: [] };
	const pending: string[] = [folder];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		let names: string[];
		try {
			names = await readdir(path.join(root, ...directory.split("/")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				continue;
			}
			throw error;
		}
		for (const name of names) {
			const relative = `${directory}/${name}`;
			if (name.startsWith(".")) {
				continue;
			}
			const stats = await lstat(
				path.join(root, ...relative.split("/")),
			).catch(() => null);
			if (stats === null) {
				continue;
			}
			if (stats.isSymbolicLink()) {
				scan.skipped.push({ path: relative, reason: "link" });
			} else if (stats.isDirectory()) {
				pending.push(relative);
			} else if (stats.isFile()) {
				if (!hasTextExtension(relative)) {
					scan.skipped.push({
						path: relative,
						reason: "not-text-extension",
					});
				} else if (stats.size > MAX_CONTEXT_FILE_BYTES) {
					scan.skipped.push({ path: relative, reason: "too-large" });
				} else {
					scan.files.push({ path: relative, size: stats.size });
				}
			}
		}
	}
	scan.files.sort((a, b) => (a.path < b.path ? -1 : 1));
	scan.skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
	return scan;
}

export interface ReadLocal {
	bytes: Uint8Array;
	hash: string;
}

/** The file's bytes and hash, or why it is not something the server takes. */
export async function readLocalFile(
	root: string,
	relative: string,
): Promise<{ ok: true; file: ReadLocal } | { ok: false; reason: SkipReason }> {
	const read = await readFileSafely(root, relative, {
		maxBytes: MAX_CONTEXT_FILE_BYTES,
	});
	if (read === null) {
		return { ok: false, reason: "empty" };
	}
	const classified = classifyContextBytes(read.bytes);
	if (!classified.ok) {
		return { ok: false, reason: classified.reason };
	}
	return {
		ok: true,
		file: { bytes: read.bytes, hash: sha256Hex(read.bytes) },
	};
}

/** The hash of a file's bytes whatever they are, or `null` when it is absent. */
export async function hashLocalFile(
	root: string,
	relative: string,
): Promise<string | null> {
	const read = await readFileSafely(root, relative, {
		maxBytes: 8 * MAX_CONTEXT_FILE_BYTES,
	}).catch(() => null);
	return read === null ? null : sha256Hex(read.bytes);
}

import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileContents } from "./apply.js";
import {
	downloadFilesByUrl,
	type FetchFilesOptions,
	type WantedFile,
} from "./file-downloads.js";
import { readFileSafely, writeFileSafely } from "./safe-write.js";

/** Memory budget for the small-archive path, not a snapshot admission limit. */
export const IN_MEMORY_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export interface StagedFileContents extends FileContents {
	dispose(): Promise<void>;
}

/** Verify downloads in an owned temporary directory before applying any file. */
export async function stageFilesByUrl(
	options: FetchFilesOptions,
): Promise<StagedFileContents> {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-instructions-")),
	);
	const files = new Map<string, WantedFile & { key: string }>();
	const dispose = () => rm(root, { recursive: true, force: true });
	try {
		await downloadFilesByUrl(options, async (file, bytes) => {
			const key = String(files.size);
			files.set(file.path, { ...file, key });
			await writeFileSafely({
				root,
				relativePath: key,
				bytes,
				mode: null,
			});
		});
	} catch (error) {
		await dispose();
		throw error;
	}
	return {
		dispose,
		async get(filePath) {
			const file = files.get(filePath);
			if (!file) {
				return undefined;
			}
			const loaded = await readFileSafely(root, file.key, {
				maxBytes: file.size,
			});
			if (
				!loaded ||
				loaded.bytes.length !== file.size ||
				createHash("sha256").update(loaded.bytes).digest("hex") !==
					file.sha256
			) {
				throw new Error(
					`A staged file does not match the manifest (${filePath}).`,
				);
			}
			return loaded.bytes;
		},
	};
}

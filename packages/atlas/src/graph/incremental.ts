/**
 * Incremental change detection (R9). Compares the current file set against the
 * manifest stored on the previous analysis so re-runs only re-parse/re-describe
 * what changed.
 */
import type { FileRecord } from "./build";
import { hashContent } from "./hash";
import { normalizePath } from "./languages";

/** path -> content hash */
export type FileManifest = Record<string, string>;

export interface ManifestDiff {
	added: string[];
	changed: string[];
	deleted: string[];
	unchanged: string[];
	hasChanges: boolean;
}

export function buildManifest(files: FileRecord[]): FileManifest {
	const manifest: FileManifest = {};
	for (const f of files) {
		manifest[normalizePath(f.path)] = hashContent(f.content);
	}
	return manifest;
}

/**
 * Diff a previous manifest against an already-built current manifest. The
 * memory-bounded analysis path builds `current` for free while streaming source
 * (see `buildTechnicalGraphStreaming`), so it diffs without re-reading/re-hashing
 * any file content. `diffManifest(prev, files)` is the in-memory convenience
 * overload that hashes a fully-materialised `FileRecord[]` first.
 */
export function diffManifests(
	prev: FileManifest | null | undefined,
	current: FileManifest,
): ManifestDiff {
	const prevManifest = prev ?? {};
	const added: string[] = [];
	const changed: string[] = [];
	const unchanged: string[] = [];

	for (const [path, hash] of Object.entries(current)) {
		if (!(path in prevManifest)) {
			added.push(path);
		} else if (prevManifest[path] !== hash) {
			changed.push(path);
		} else {
			unchanged.push(path);
		}
	}
	const deleted = Object.keys(prevManifest).filter((p) => !(p in current));

	return {
		added,
		changed,
		deleted,
		unchanged,
		hasChanges: added.length + changed.length + deleted.length > 0,
	};
}

/**
 * In-memory convenience overload: hash a fully-materialised `FileRecord[]` into a
 * current manifest, then diff it against `prev`. Byte-identical to the previous
 * implementation; the memory-bounded path uses {@link diffManifests} with the
 * manifest the streaming builder already produced.
 */
export function diffManifest(
	prev: FileManifest | null | undefined,
	files: FileRecord[],
): ManifestDiff {
	return diffManifests(prev, buildManifest(files));
}

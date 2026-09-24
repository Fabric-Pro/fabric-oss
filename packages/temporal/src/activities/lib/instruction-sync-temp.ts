/**
 * Where repository sync clones live (design 2026-09-23 §8.2):
 * `<os.tmpdir()>/fabric-instruction-sync/run-*`. The activity's `finally`
 * removes its own directory; the worker sweeps anything a crash left behind
 * at startup. Not re-exported from the activities barrel.
 */
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const SYNC_TEMP_DIR_NAME = "fabric-instruction-sync";
const RUN_PREFIX = "run-";
const STALE_AFTER_MS = 60 * 60 * 1000;

export function syncTempRoot(base: string = tmpdir()): string {
	return path.join(base, SYNC_TEMP_DIR_NAME);
}

export async function createSyncRunDir(base?: string): Promise<string> {
	const root = syncTempRoot(base);
	await mkdir(root, { recursive: true, mode: 0o700 });
	return mkdtemp(path.join(root, RUN_PREFIX));
}

export async function removeSyncRunDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

export async function sweepStaleSyncRunDirs(
	input: { base?: string; olderThanMs?: number; now?: number } = {},
): Promise<{ removed: number }> {
	const root = syncTempRoot(input.base);
	const cutoff =
		(input.now ?? Date.now()) - (input.olderThanMs ?? STALE_AFTER_MS);
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return { removed: 0 };
	}
	let removed = 0;
	for (const name of names) {
		if (!name.startsWith(RUN_PREFIX)) {
			continue;
		}
		const dir = path.join(root, name);
		try {
			if ((await lstat(dir)).mtimeMs < cutoff) {
				await rm(dir, { recursive: true, force: true });
				removed++;
			}
		} catch {
			// Gone already.
		}
	}
	return { removed };
}

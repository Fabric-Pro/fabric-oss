import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSyncRunDir,
	removeSyncRunDir,
	SYNC_TEMP_DIR_NAME,
	sweepStaleSyncRunDirs,
	syncTempRoot,
} from "../instruction-sync-temp";

let base: string;
beforeEach(async () => {
	base = await mkdtemp(path.join(tmpdir(), "sync-temp-test-"));
});
afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("sync temp root", () => {
	it("creates run directories under <tmp>/fabric-instruction-sync and removes them", async () => {
		const dir = await createSyncRunDir(base);
		expect(path.dirname(dir)).toBe(path.join(base, SYNC_TEMP_DIR_NAME));
		expect(path.basename(dir)).toMatch(/^run-/);
		await removeSyncRunDir(dir);
		expect(await readdir(syncTempRoot(base))).toEqual([]);
	});

	it("sweeps only run directories older than the cutoff", async () => {
		const stale = await createSyncRunDir(base);
		const fresh = await createSyncRunDir(base);
		const unrelated = path.join(syncTempRoot(base), "keep-me");
		await mkdir(unrelated);
		const now = Date.now();
		const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
		await utimes(stale, twoHoursAgo, twoHoursAgo);
		await utimes(unrelated, twoHoursAgo, twoHoursAgo);

		expect(await sweepStaleSyncRunDirs({ base, now })).toEqual({
			removed: 1,
		});
		expect((await readdir(syncTempRoot(base))).sort()).toEqual(
			[path.basename(fresh), "keep-me"].sort(),
		);
	});

	it("is a no-op when the root does not exist yet", async () => {
		expect(
			await sweepStaleSyncRunDirs({ base: path.join(base, "absent") }),
		).toEqual({ removed: 0 });
	});
});

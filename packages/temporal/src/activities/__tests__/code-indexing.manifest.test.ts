import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	readFileManifestSliceActivity,
	selectChangedFilesFromManifestActivity,
	walkFileTreeActivity,
} from "../code-indexing";

// Exercises the on-disk manifest mechanism end-to-end at the activity level:
// the full-index slice reads AND the incremental changed-subset path (the code
// that only runs on a webhook push, which can't be triggered live in this env).
describe("on-disk manifest activities", () => {
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(
			path.join(dir, "src", "b.ts"),
			"export const b = 2;\n",
		);
		fs.writeFileSync(
			path.join(dir, "src", "c.tsx"),
			"export const c = 3;\n",
		);
		fs.writeFileSync(path.join(dir, "readme.md"), "# hi\n");
	});

	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("walk writes a manifest and returns only counts (no file list crosses)", async () => {
		const out = await walkFileTreeActivity({ clonePath: dir });
		expect(out.files).toBeUndefined();
		expect(out.manifestPath).toBe(`${dir}.code-index-manifest.json`);
		expect(out.totalFiles).toBe(4);
		expect(fs.existsSync(out.manifestPath as string)).toBe(true);
	});

	it("slice reads cover every file once, hydrating absolutePath from clonePath", async () => {
		const { manifestPath, totalFiles } = await walkFileTreeActivity({
			clonePath: dir,
		});
		const seen: string[] = [];
		for (let i = 0; i < totalFiles; i += 2) {
			const slice = await readFileManifestSliceActivity({
				manifestPath: manifestPath as string,
				clonePath: dir,
				startIndex: i,
				count: 2,
			});
			for (const f of slice.files) {
				expect(f.absolutePath).toBe(path.join(dir, f.relativePath));
				expect(fs.existsSync(f.absolutePath)).toBe(true);
				seen.push(f.relativePath);
			}
		}
		expect(seen.length).toBe(totalFiles);
		expect(new Set(seen).size).toBe(totalFiles); // no gaps, no dupes
	});

	it("incremental selects only changed files into a bounded, index-iterable manifest", async () => {
		const { manifestPath } = await walkFileTreeActivity({ clonePath: dir });
		const changed = ["src/b.ts", "src/c.tsx", "does/not/exist.ts"];
		const sel = await selectChangedFilesFromManifestActivity({
			manifestPath: manifestPath as string,
			clonePath: dir,
			changedFiles: changed,
		});
		expect(sel.manifestPath).toBe(
			`${dir}.code-index-changed-manifest.json`,
		);
		expect(sel.count).toBe(2); // only the two changed paths that exist in the walk

		const slice = await readFileManifestSliceActivity({
			manifestPath: sel.manifestPath,
			clonePath: dir,
			startIndex: 0,
			count: 50,
		});
		expect(slice.files.map((f) => f.relativePath).sort()).toEqual([
			"src/b.ts",
			"src/c.tsx",
		]);
		for (const f of slice.files) {
			expect(f.absolutePath).toBe(path.join(dir, f.relativePath));
		}
	});
});

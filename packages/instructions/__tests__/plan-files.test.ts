import { describe, expect, it } from "vitest";
import { resolveIgnoreGlobs } from "../src/ignore";
import { type PlanFileInput, planSnapshotFiles } from "../src/plan-files";

const DEFAULTS = resolveIgnoreGlobs({
	fabricIgnoreText: null,
	projectGlobs: null,
});
const SMALL = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };

describe("planSnapshotFiles", () => {
	it("keeps valid files in input order with kind and typing, and reports exclusions", () => {
		const plan = planSnapshotFiles({
			files: [
				{ path: "./CLAUDE.md", size: 3 },
				{ path: "node_modules/x/index.js", size: 1 },
				{ path: ".claude/skills/review/SKILL.md", size: 4 },
			],
			ignore: DEFAULTS,
		});
		expect(plan).toEqual({
			ok: true,
			totalBytes: 7,
			excluded: [
				{
					path: "node_modules/x/index.js",
					rule: "**/node_modules/**",
					layer: "default",
				},
			],
			kept: [
				{
					source: { path: "./CLAUDE.md", size: 3 },
					path: "CLAUDE.md",
					kind: "INSTRUCTIONS",
					mimeType: "text/markdown",
					isText: true,
				},
				{
					source: { path: ".claude/skills/review/SKILL.md", size: 4 },
					path: ".claude/skills/review/SKILL.md",
					kind: "SKILL",
					mimeType: "text/markdown",
					isText: true,
				},
			],
		});
	});

	it("carries the caller's own fields through untouched on `source`", () => {
		const plan = planSnapshotFiles({
			files: [
				{ path: "run.sh", repoPath: "tools/run.sh", gitMode: "100755" },
			],
			ignore: DEFAULTS,
		});
		expect(plan.ok && plan.kept[0]?.source).toEqual({
			path: "run.sh",
			repoPath: "tools/run.sh",
			gitMode: "100755",
		});
	});

	it.each([
		[
			"invalid path, reported with the RAW input path",
			[{ path: "../escape.md", size: 1 }],
			{ code: "invalid_path", path: "../escape.md", reason: "traversal" },
		],
		[
			"a case-insensitive collision",
			[
				{ path: "A.md", size: 1 },
				{ path: "a.md", size: 1 },
			],
			{ code: "duplicate_path", path: "a.md" },
		],
		[
			"a file named like an earlier file's folder",
			[
				{ path: "docs/a.md", size: 1 },
				{ path: "Docs", size: 1 },
			],
			{
				code: "file_directory_conflict",
				path: "Docs",
				conflictsWith: "docs/a.md",
			},
		],
		[
			"a path under an earlier file",
			[
				{ path: "docs", size: 1 },
				{ path: "docs/a.md", size: 1 },
			],
			{
				code: "file_directory_conflict",
				path: "docs/a.md",
				conflictsWith: "docs",
			},
		],
		[
			"a name Windows cannot write",
			[{ path: "docs/con.md", size: 1 }],
			{
				code: "non_portable_name",
				path: "docs/con.md",
				refusal: {
					ok: false,
					reason: "reserved_device_name",
					segment: "con.md",
				},
			},
		],
		[
			"a single file over the per-file cap",
			[{ path: "big.md", size: 11 }],
			{ code: "file_too_large", path: "big.md", size: 11 },
		],
		[
			"everything excluded",
			[{ path: ".git/HEAD", size: 1 }],
			{ code: "nothing_kept" },
		],
		[
			"more kept files than the cap",
			[
				{ path: "a.md", size: 1 },
				{ path: "b.md", size: 1 },
				{ path: "c.md", size: 1 },
			],
			{ code: "too_many_files", count: 3, max: 2 },
		],
		[
			"more bytes than the total cap",
			[
				{ path: "a.md", size: 8 },
				{ path: "b.md", size: 8 },
			],
			{ code: "total_too_large", totalBytes: 16, max: 15 },
		],
	] as const)("refuses %s", (_label, files, refusal) => {
		// Explicit type argument: each row's `files` literal has its own
		// per-row shape (from `as const`), so TypeScript cannot infer one `T`
		// for `planSnapshotFiles<T>` across the union of all the rows.
		// Naming `PlanFileInput` sidesteps that inference, without changing
		// what is asserted.
		expect(
			planSnapshotFiles<PlanFileInput>({
				files,
				ignore: DEFAULTS,
				limits: SMALL,
			}),
		).toEqual({ ok: false, refusal });
	});

	it("judges collisions and portability only on KEPT paths, after ignore rules", () => {
		// Both spellings sit under an excluded folder, so neither can refuse the tree.
		const plan = planSnapshotFiles({
			files: [
				{ path: "node_modules/A.md", size: 1 },
				{ path: "node_modules/a.md", size: 1 },
				{ path: "node_modules/con.md", size: 1 },
				{ path: "CLAUDE.md", size: 1 },
			],
			ignore: DEFAULTS,
		});
		expect(plan.ok && plan.kept.map((k) => k.path)).toEqual(["CLAUDE.md"]);
	});

	it("judges a file-versus-folder clash only on KEPT paths", () => {
		// `build` is excluded by a project glob, so `build/out.md` never joins
		// the tree and the `build` file beside it is not refused.
		const plan = planSnapshotFiles({
			files: [
				{ path: "build/out.md", size: 1 },
				{ path: "build", size: 1 },
			],
			ignore: resolveIgnoreGlobs({
				fabricIgnoreText: null,
				projectGlobs: ["build/**"],
			}),
		});
		expect(plan.ok && plan.kept.map((k) => k.path)).toEqual(["build"]);
	});

	it("applies no byte caps to files whose size is not known yet (repository planning)", () => {
		const plan = planSnapshotFiles({
			files: [{ path: "a.md" }, { path: "b.md" }],
			ignore: DEFAULTS,
			limits: SMALL,
		});
		expect(plan).toMatchObject({ ok: true, totalBytes: 0 });
	});
});

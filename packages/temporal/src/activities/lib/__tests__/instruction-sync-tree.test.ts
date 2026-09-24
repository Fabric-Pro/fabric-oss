import { describe, expect, it } from "vitest";
import {
	createLsTreeParser,
	fileModeForGitMode,
	sparsePatternFor,
	treesEqual,
} from "../instruction-sync-tree";

const OID = "a".repeat(40);
function record(mode: string, type: string, path: string, oid = OID): string {
	return `${mode} ${type} ${oid}\t${path}\0`;
}

describe("createLsTreeParser", () => {
	it("keeps regular files and executables, re-rooted, and counts every other mode as excluded", () => {
		const parser = createLsTreeParser({
			rootPath: "agents",
			maxEntries: 10,
		});
		const out = Buffer.from(
			record("100644", "blob", "agents/CLAUDE.md") +
				record("100755", "blob", "agents/scripts/run.sh") +
				record("120000", "blob", "agents/link.md") +
				record("160000", "commit", "agents/vendor") +
				record("100664", "blob", "agents/legacy.md"),
		);
		// Split mid-record to prove the parser buffers across chunks.
		expect(parser.push(out.subarray(0, 37))).toBe("ok");
		expect(parser.push(out.subarray(37))).toBe("ok");
		expect(parser.finish()).toEqual({
			files: [
				{
					repoPath: "agents/CLAUDE.md",
					relPath: "CLAUDE.md",
					gitMode: "100644",
					oid: OID,
				},
				{
					repoPath: "agents/scripts/run.sh",
					relPath: "scripts/run.sh",
					gitMode: "100755",
					oid: OID,
				},
			],
			excludedCount: 3,
			underRoot: 5,
		});
	});

	it("keeps repository paths byte-exact, including a backslash and metacharacters", () => {
		const parser = createLsTreeParser({ rootPath: "", maxEntries: 10 });
		parser.push(
			Buffer.from(
				record("100644", "blob", "back\\slash.md") +
					record("100644", "blob", "x[1] #!.md"),
			),
		);
		expect(
			parser.finish().files.map((f) => [f.repoPath, f.relPath]),
		).toEqual([
			["back\\slash.md", "back\\slash.md"],
			["x[1] #!.md", "x[1] #!.md"],
		]);
	});

	it("excludes a path whose bytes are not UTF-8 instead of guessing a name", () => {
		const parser = createLsTreeParser({ rootPath: "", maxEntries: 10 });
		parser.push(
			Buffer.concat([
				Buffer.from(`100644 blob ${OID}\t`),
				Buffer.from([0x66, 0xff, 0x2e, 0x6d, 0x64]),
				Buffer.from([0]),
			]),
		);
		expect(parser.finish()).toEqual({
			files: [],
			excludedCount: 1,
			underRoot: 1,
		});
	});

	it("ignores an entry outside the root and the root itself", () => {
		const parser = createLsTreeParser({
			rootPath: "agents",
			maxEntries: 10,
		});
		parser.push(
			Buffer.from(
				record("100644", "blob", "agents") +
					record("100644", "blob", "agents-old/x.md"),
			),
		);
		expect(parser.finish()).toEqual({
			files: [],
			excludedCount: 1,
			underRoot: 1,
		});
	});

	it("reports the inventory cap as soon as it is crossed", () => {
		const parser = createLsTreeParser({ rootPath: "", maxEntries: 2 });
		expect(
			parser.push(
				Buffer.from(
					record("100644", "blob", "a.md") +
						record("100644", "blob", "b.md") +
						record("100644", "blob", "c.md"),
				),
			),
		).toBe("limit");
	});

	it("bounds a single NUL-free record instead of buffering it forever (review S4)", () => {
		const parser = createLsTreeParser({ rootPath: "", maxEntries: 10 });
		// One record, deliberately far longer than any real header-plus-path
		// could be, and never terminated by a NUL: a hostile object name, not
		// a slow network.
		const header = Buffer.from(`100644 blob ${OID}\t`);
		const hostileName = Buffer.alloc(4 * 1024 * 1024, "a".charCodeAt(0));
		const wholeRecord = Buffer.concat([header, hostileName]);
		const chunkSize = 64 * 1024;
		const started = Date.now();
		let verdict: "ok" | "limit" = "ok";
		// Fed in 64 KiB chunks, like real stdout data: without the S4 fix,
		// each chunk re-copies and re-scans the whole record so far, which is
		// what made this quadratic rather than linear.
		for (let offset = 0; offset < wholeRecord.length; offset += chunkSize) {
			verdict = parser.push(
				wholeRecord.subarray(offset, offset + chunkSize),
			);
			if (verdict === "limit") {
				break;
			}
		}
		expect(verdict).toBe("limit");
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("accepts a record at the maximum legal path length, split mid-record (review S4 fix round 2)", () => {
		// rootPath and relPath can each legally run up to
		// SNAPSHOT_LIMITS.maxPathBytes (512), so the full repository path in
		// the record -- rootPath + "/" + relPath -- can be over 1 KiB before
		// the header. The original bound (derived from a single
		// maxPathBytes) undercounted this and returned "limit" for a
		// legitimate record depending on where the chunk boundary fell.
		const rootPath = "a".repeat(512);
		const relPath = "b".repeat(512);
		const parser = createLsTreeParser({ rootPath, maxEntries: 10 });
		const whole = Buffer.from(
			record("100644", "blob", `${rootPath}/${relPath}`),
		);
		const splitAt = 700;
		expect(parser.push(whole.subarray(0, splitAt))).toBe("ok");
		expect(parser.push(whole.subarray(splitAt))).toBe("ok");
		const result = parser.finish();
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.relPath).toBe(relPath);
	});
});

describe("sparsePatternFor", () => {
	it.each([
		["CLAUDE.md", "/CLAUDE.md"],
		["x[1].md", "/x\\[1\\].md"],
		["#hash.md", "/\\#hash.md"],
		["!bang.md", "/\\!bang.md"],
		["a b.md", "/a b.md"],
		[" lead.md", "/\\ lead.md"],
		["trail.md ", "/trail.md\\ "],
		["back\\slash.md", "/back\\\\slash.md"],
		["star*?.md", "/star\\*\\?.md"],
	])("anchors %j as a literal pattern", (input, expected) => {
		expect(sparsePatternFor(input)).toBe(expected);
	});
});

describe("fileModeForGitMode", () => {
	it("maps git's two regular-file modes to Unix permissions", () => {
		expect(fileModeForGitMode("100755")).toBe(0o755);
		expect(fileModeForGitMode("100644")).toBe(0o644);
	});
});

describe("treesEqual", () => {
	const kept = [
		{ path: "CLAUDE.md", sha256: "h1", mode: 0o644 },
		{ path: "run.sh", sha256: "h2", mode: 0o755 },
	];

	it("treats a null published mode as 0644", () => {
		expect(
			treesEqual(kept, [
				{ path: "run.sh", sha256: "h2", mode: 0o755 },
				{ path: "CLAUDE.md", sha256: "h1", mode: null },
			]),
		).toBe(true);
	});

	// A mode-only change now moves `computeSnapshotDigest` too (Fizzy #2671),
	// but this remains the check that decides WHETHER a repository-sync
	// version needs publishing at all — it compares the kept git tree
	// against the last published manifest directly, before any digest is
	// computed.
	it("is not equal on a mode-only change", () => {
		expect(
			treesEqual(kept, [
				{ path: "CLAUDE.md", sha256: "h1", mode: null },
				{ path: "run.sh", sha256: "h2", mode: 0o644 },
			]),
		).toBe(false);
	});

	// Fizzy #2671 review: the wire contract admits a full `st_mode`, not only
	// bare permission bits — `isAllowedMode`
	// (`packages/cli/src/lib/instructions/safe-write.ts`) masks with
	// `& 0o7777` and explicitly accepts e.g. `0o100644`. Two representations
	// of the same permission must compare equal here, the same way
	// `computeSnapshotDigest` and `normalizedMode` now treat them.
	it("treats a full st_mode and its bare permission bits as the same mode", () => {
		expect(
			treesEqual(kept, [
				{ path: "CLAUDE.md", sha256: "h1", mode: 0o100644 },
				{ path: "run.sh", sha256: "h2", mode: 0o100755 },
			]),
		).toBe(true);
	});

	it("still reports a real permission difference under a full st_mode", () => {
		expect(
			treesEqual(kept, [
				{ path: "CLAUDE.md", sha256: "h1", mode: 0o100755 },
				{ path: "run.sh", sha256: "h2", mode: 0o100755 },
			]),
		).toBe(false);
	});

	it("is not equal on a content change, an added file or a removed file", () => {
		expect(
			treesEqual(kept, [{ path: "CLAUDE.md", sha256: "h1", mode: null }]),
		).toBe(false);
		expect(
			treesEqual(kept, [
				{ path: "CLAUDE.md", sha256: "hX", mode: null },
				{ path: "run.sh", sha256: "h2", mode: 0o755 },
			]),
		).toBe(false);
		expect(
			treesEqual(kept, [
				{ path: "CLAUDE.md", sha256: "h1", mode: null },
				{ path: "run.sh", sha256: "h2", mode: 0o755 },
				{ path: "extra.md", sha256: "h3", mode: null },
			]),
		).toBe(false);
	});
});

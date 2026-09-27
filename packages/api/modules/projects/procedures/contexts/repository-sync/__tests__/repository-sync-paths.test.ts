/**
 * `./paths` — the one per-path rule set `configure` and `listTree` share
 * (Fizzy #2674): `contextSyncPathSelectable` decides each path, and
 * `canonicalizeContextSyncPaths` refuses exactly what it refuses, with the
 * same code, so the tree never offers a selection `configure` would refuse.
 * The canonical-spelling check is the real `normalizeContextSourcePath`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	)),
	...(await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	)),
}));

import {
	ContextSourcePathError,
	normalizeContextSourcePath,
} from "@repo/database";
import { contextSyncPathSpellingProblem } from "@repo/instructions/context-sync-rules";
import {
	canonicalizeContextSyncExcludedPaths,
	canonicalizeContextSyncPaths,
	contextSyncExcludedPathAllowed,
	contextSyncPathSelectable,
	MAX_CONTEXT_SYNC_EXCLUDED_PATHS,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "../paths";

const TOO_LONG = `docs/${"x".repeat(MAX_CONTEXT_SYNC_PATH_LENGTH)}`;

/** [path, what both answer: selectable, or the refusal's code]. */
const TABLE: Array<[string, "ok" | "INVALID_PATH" | "EXCLUDED_PATH"]> = [
	["", "ok"],
	["docs", "ok"],
	["docs/guide.md", "ok"],
	["docs-archive", "ok"],
	["skills", "ok"],
	[".claude", "ok"],
	["docs/agents", "ok"],
	["docs/fabric.md", "ok"],
	["docs/.fabricrc", "ok"],
	["fabric/notes.md", "ok"],
	[" docs", "INVALID_PATH"],
	["docs ", "INVALID_PATH"],
	["docs\\guides", "INVALID_PATH"],
	["docs/", "INVALID_PATH"],
	["./docs", "INVALID_PATH"],
	["docs//guides", "INVALID_PATH"],
	["/docs", "INVALID_PATH"],
	["docs/../secrets", "INVALID_PATH"],
	["café.md", "INVALID_PATH"],
	[TOO_LONG, "INVALID_PATH"],
	["CLAUDE.md", "EXCLUDED_PATH"],
	["docs/AGENTS.md", "EXCLUDED_PATH"],
	["notes/gemini.md", "EXCLUDED_PATH"],
	["docs/.contextignore", "EXCLUDED_PATH"],
	[".fabric", "EXCLUDED_PATH"],
	[".fabric/notes.md", "EXCLUDED_PATH"],
	[".FABRIC/x.md", "EXCLUDED_PATH"],
	["docs/.Fabric/state.json", "EXCLUDED_PATH"],
	["docs/.fabric", "EXCLUDED_PATH"],
	[".fabric/CLAUDE.md", "EXCLUDED_PATH"],
];

describe("contextSyncPathSelectable and canonicalizeContextSyncPaths agree", () => {
	it.each(TABLE)("%j is %s for both", (path, expected) => {
		const verdict = contextSyncPathSelectable(path);
		const canonical = canonicalizeContextSyncPaths([path]);

		if (expected === "ok") {
			expect(verdict).toEqual({ ok: true });
			expect(canonical).toEqual({ ok: true, paths: [path] });
			return;
		}
		expect(verdict).toMatchObject({ ok: false, code: expected });
		expect(canonical).toMatchObject({ ok: false, code: expected, path });
		if (!verdict.ok && !canonical.ok) {
			expect(canonical.message).toBe(verdict.message);
		}
	});
});

describe(".fabric (Fizzy #2704)", () => {
	it.each([
		".fabric",
		".fabric/notes.md",
		".FABRIC/x.md",
		"docs/.Fabric/state.json",
		"a/b/.fAbRiC/c/d.md",
	])("refuses %j, at any depth and in any case", (path) => {
		const verdict = contextSyncPathSelectable(path);

		expect(verdict).toMatchObject({ ok: false, code: "EXCLUDED_PATH" });
		expect(canonicalizeContextSyncPaths(["docs", path])).toMatchObject({
			ok: false,
			code: "EXCLUDED_PATH",
			path,
		});
	});

	it("matches the whole segment only", () => {
		for (const path of ["docs/.fabricrc", "fabric", "my.fabric/x.md"]) {
			expect(contextSyncPathSelectable(path), path).toEqual({ ok: true });
		}
	});

	it("names the .fabric folder, not a coding-instructions file, in its message", () => {
		const verdict = contextSyncPathSelectable(".fabric/CLAUDE.md");

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.message).toContain(".fabric folder");
		}
	});
});

describe("the length limit", () => {
	it("refuses a path longer than configure's input bound", () => {
		expect(TOO_LONG.length).toBeGreaterThan(MAX_CONTEXT_SYNC_PATH_LENGTH);
		expect(contextSyncPathSelectable(TOO_LONG)).toMatchObject({
			ok: false,
			code: "INVALID_PATH",
		});
	});
});

describe("the shared spelling predicate agrees with normalizeContextSourcePath (Fizzy #2750)", () => {
	/**
	 * What `configure` accepted before the predicate moved to
	 * `@repo/instructions`: its input bound, no surrounding whitespace, no
	 * backslash or trailing slash, and the path is its own storage key.
	 */
	function referenceAccepts(path: string): boolean {
		if (path.length > MAX_CONTEXT_SYNC_PATH_LENGTH) {
			return false;
		}
		if (path.trim() !== path || path.includes("\\") || path.endsWith("/")) {
			return false;
		}
		try {
			return normalizeContextSourcePath(path) === path;
		} catch (error) {
			if (error instanceof ContextSourcePathError) {
				return false;
			}
			throw error;
		}
	}

	const INPUTS: Array<[string, string]> = [
		["a plain folder", "docs"],
		["a plain file", "docs/guide.md"],
		["an NFC name", "docs/caf\u00e9.md"],
		["an NFD name", "docs/cafe\u0301.md"],
		["a KELVIN SIGN, which NFC rewrites", "docs/\u212Aey.md"],
		["exactly the storage-key bound", "d".repeat(512)],
		["one past the storage-key bound", "d".repeat(513)],
		["within configure's bound, past the storage key's", "d".repeat(1024)],
		["over configure's bound", `docs/${"x".repeat(1024)}`],
		["a leading ./", "./docs"],
		["a lone .", "."],
		["a lone ./", "./"],
		["a // inside", "docs//guides"],
		["a leading /", "/docs"],
		["a .. segment", "docs/../secrets"],
		["a lone ..", ".."],
		["a . segment", "docs/./guide.md"],
		["a trailing slash", "docs/"],
		["a backslash", "docs\\guides"],
		["a leading space", " docs"],
		["a trailing space", "docs "],
		["a trailing no-break space", "docs\u00a0"],
		["a space inside a segment", "my docs/a b.md"],
		["a C0 control character", "docs/a\u0001.md"],
		["DEL", "docs/a\u007f.md"],
		["a C1 control character", "docs/a\u0085.md"],
		["a zero-width space", "docs/a\u200b.md"],
		["a bidi override", "docs/\u202ea.md"],
		["a byte-order mark", "\ufeffdocs"],
		["a line separator inside", "docs/a\u2028b.md"],
		["a drive letter", "C:notes.md"],
		["a lower-case drive letter", "c:/notes"],
		["a colon later on", "docs/c:notes.md"],
		["a dotfile", "docs/.env"],
		["a .fabric folder (a rule, not a spelling)", "docs/.fabric"],
	];

	it.each(INPUTS)("%s: %j", (_what, path) => {
		expect(contextSyncPathSpellingProblem(path) === null).toBe(
			referenceAccepts(path),
		);
	});

	it("agrees on every short string over an alphabet of tricky characters", () => {
		const alphabet = [
			"a",
			"/",
			".",
			"\\",
			" ",
			"e",
			"\u0301",
			"\u00e9",
			"\u0000",
			"\u200b",
			"C",
			":",
			"\u212A",
		];
		// A fixed linear congruential generator: the same strings every run.
		let seed = 2750;
		const next = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed;
		};
		let compared = 0;
		for (let i = 0; i < 20_000; i++) {
			const length = 1 + (next() % 7);
			let path = "";
			for (let j = 0; j < length; j++) {
				path += alphabet[next() % alphabet.length];
			}
			expect(contextSyncPathSpellingProblem(path) === null, path).toBe(
				referenceAccepts(path),
			);
			compared++;
		}
		expect(compared).toBe(20_000);
	});

	it("says too-long only past configure's own bound, and leaves the whole repository to the caller", () => {
		expect(contextSyncPathSpellingProblem("d".repeat(1025))).toBe(
			"too-long",
		);
		expect(contextSyncPathSpellingProblem("d".repeat(1024))).toBe(
			"not-canonical",
		);
		expect(contextSyncPathSpellingProblem("")).toBeNull();
	});
});

// =============================================================================
// Left-out paths (Fizzy #2750 §5.2)
// =============================================================================

/** [path, what the left-out rule answers on its own]. */
const EXCLUDED_TABLE: Array<
	[
		string,
		"ok" | "INVALID_PATH" | "EXCLUDED_PATH" | "EXCLUDED_PATH_POLICY_FILE",
	]
> = [
	["docs/drafts", "ok"],
	["docs/guide.md", "ok"],
	["docs/skills", "ok"],
	// Leaving a coding-instructions file out is allowed: a no-op.
	["docs/CLAUDE.md", "ok"],
	["docs/agents.md", "ok"],
	["", "INVALID_PATH"],
	["docs/", "INVALID_PATH"],
	["./docs/a.md", "INVALID_PATH"],
	["docs\\a.md", "INVALID_PATH"],
	// Decomposed (NFD): not its own storage key.
	["docs/cafe\u0301.md", "INVALID_PATH"],
	[TOO_LONG, "INVALID_PATH"],
	["docs/.fabric", "EXCLUDED_PATH"],
	["docs/.Fabric/state.json", "EXCLUDED_PATH"],
	// A policy file is read as policy, never excluded.
	["docs/.contextignore", "EXCLUDED_PATH_POLICY_FILE"],
	["docs/sub/.ContextIgnore", "EXCLUDED_PATH_POLICY_FILE"],
];

describe("contextSyncExcludedPathAllowed and canonicalizeContextSyncExcludedPaths agree", () => {
	it.each(EXCLUDED_TABLE)("%j is %s for both", (path, expected) => {
		const verdict = contextSyncExcludedPathAllowed(path);
		const canonical = canonicalizeContextSyncExcludedPaths([path], [""]);

		if (expected === "ok") {
			expect(verdict).toEqual({ ok: true });
			expect(canonical).toEqual({ ok: true, excludedPaths: [path] });
			return;
		}
		expect(verdict).toMatchObject({ ok: false, code: expected });
		expect(canonical).toMatchObject({ ok: false, code: expected, path });
		if (!verdict.ok && !canonical.ok) {
			expect(canonical.message).toBe(verdict.message);
		}
	});
});

describe("canonicalizeContextSyncExcludedPaths", () => {
	it("drops duplicates and sorts", () => {
		expect(
			canonicalizeContextSyncExcludedPaths(
				["docs/b", "docs/a.md", "docs/b", "notes/x.md"],
				["docs", "notes"],
			),
		).toEqual({
			ok: true,
			excludedPaths: ["docs/a.md", "docs/b", "notes/x.md"],
		});
		expect(canonicalizeContextSyncExcludedPaths([], ["docs"])).toEqual({
			ok: true,
			excludedPaths: [],
		});
	});

	it.each([
		["outside every selected path", "notes/x.md", ["docs"]],
		["equal to a selected path", "docs", ["docs", "notes"]],
		[
			"in a folder whose name only starts like a selected one",
			"docs-archive/a.md",
			["docs"],
		],
		["around a selected path", "docs", ["docs/guides"]],
		[
			"a case variant of a selected folder's contents",
			"Docs/a.md",
			["docs"],
		],
	])(
		"refuses a left-out path %s: EXCLUDED_PATH_OUTSIDE_SELECTION",
		(_label, path, paths) => {
			expect(
				canonicalizeContextSyncExcludedPaths([path], paths),
			).toMatchObject({
				ok: false,
				code: "EXCLUDED_PATH_OUTSIDE_SELECTION",
				path,
			});
		},
	);

	it("refuses a left-out path inside another one: EXCLUDED_PATH_OVERLAP, naming both", () => {
		expect(
			canonicalizeContextSyncExcludedPaths(
				["docs/drafts/2026/a.md", "docs/drafts"],
				["docs"],
			),
		).toMatchObject({
			ok: false,
			code: "EXCLUDED_PATH_OVERLAP",
			path: "docs/drafts/2026/a.md",
			withPath: "docs/drafts",
		});
		// Whole segments only.
		expect(
			canonicalizeContextSyncExcludedPaths(
				["docs/drafts", "docs/drafts-old"],
				["docs"],
			),
		).toEqual({
			ok: true,
			excludedPaths: ["docs/drafts", "docs/drafts-old"],
		});
	});

	it("allows at most 200, counted after duplicates are dropped", () => {
		const many = Array.from(
			{ length: MAX_CONTEXT_SYNC_EXCLUDED_PATHS },
			(_, i) => `docs/f${String(i).padStart(3, "0")}.md`,
		);
		expect(MAX_CONTEXT_SYNC_EXCLUDED_PATHS).toBe(200);
		expect(
			canonicalizeContextSyncExcludedPaths([...many, ...many], ["docs"]),
		).toMatchObject({ ok: true });
		expect(
			canonicalizeContextSyncExcludedPaths(
				[...many, "docs/one-more.md"],
				["docs"],
			),
		).toMatchObject({ ok: false, code: "TOO_MANY_EXCLUDED_PATHS" });
	});

	it("checks each path's own rule before the selection", () => {
		expect(
			canonicalizeContextSyncExcludedPaths(
				["notes/x.md", "docs/.contextignore"],
				["docs"],
			),
		).toMatchObject({ ok: false, code: "EXCLUDED_PATH_POLICY_FILE" });
	});
});

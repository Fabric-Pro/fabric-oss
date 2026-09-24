/**
 * `./paths` — the one per-path rule set `configure` and `listTree` share
 * (Fizzy #2674): `contextSyncPathSelectable` decides each path, and
 * `canonicalizeContextSyncPaths` refuses exactly what it refuses, with the
 * same code, so the tree never offers a selection `configure` would refuse.
 * The canonical-spelling check is the real `normalizeContextSourcePath`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock(
	"@repo/database",
	async () =>
		await import(
			"@repo/database/prisma/queries/projects/context-source-path"
		),
);

import {
	canonicalizeContextSyncPaths,
	contextSyncPathSelectable,
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

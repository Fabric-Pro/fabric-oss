/**
 * Living Memory's typed "leave out" paths: refused on the same per-path
 * grounds `configure` refuses an excluded path, then checked against the
 * selection the way unticking a row would be.
 */
import { describe, expect, it } from "vitest";
import {
	contextSyncExclusionMessage,
	validateContextSyncExclusionAddition,
} from "../context-sync-exclusion-validation";

const DOCS = { paths: ["docs"], excludedPaths: [] };

describe("validateContextSyncExclusionAddition", () => {
	it("accepts a path strictly inside a selected path", () => {
		expect(
			validateContextSyncExclusionAddition("docs/drafts", DOCS),
		).toEqual({ ok: true, path: "docs/drafts" });
		expect(
			validateContextSyncExclusionAddition("notes/a.md", {
				paths: [""],
				excludedPaths: [],
			}),
		).toEqual({ ok: true, path: "notes/a.md" });
	});

	it("refuses what configure refuses for any left-out path", () => {
		expect(validateContextSyncExclusionAddition("", DOCS)).toEqual({
			ok: false,
			error: { code: "WHOLE_REPOSITORY" },
		});
		for (const path of [
			"docs/",
			"./docs/a.md",
			"docs//a.md",
			"docs\\a.md",
		]) {
			expect(
				validateContextSyncExclusionAddition(path, DOCS),
				path,
			).toEqual({ ok: false, error: { code: "INVALID_PATH", path } });
		}
		const long = `docs/${"x".repeat(508)}`;
		const refusal = validateContextSyncExclusionAddition(long, DOCS);
		expect(refusal).toEqual({
			ok: false,
			error: { code: "PATH_TOO_LONG" },
		});
		expect(
			!refusal.ok && contextSyncExclusionMessage(refusal.error),
		).toEqual({
			key: "excludeErrors.PATH_TOO_LONG",
			values: { max: 512 },
		});
		expect(
			validateContextSyncExclusionAddition(
				`docs/${"x".repeat(507)}`,
				DOCS,
			).ok,
		).toBe(true);
		expect(
			validateContextSyncExclusionAddition("docs/.fabric/lock", DOCS),
		).toEqual({
			ok: false,
			error: { code: "EXCLUDED_FABRIC_PATH", path: "docs/.fabric/lock" },
		});
		expect(
			validateContextSyncExclusionAddition("docs/.ContextIgnore", DOCS),
		).toEqual({
			ok: false,
			error: {
				code: "EXCLUDED_PATH_POLICY_FILE",
				path: "docs/.ContextIgnore",
			},
		});
	});

	it("refuses a path with nothing selected, a selected path, and one outside every selection", () => {
		expect(
			validateContextSyncExclusionAddition("docs/a.md", {
				paths: [],
				excludedPaths: [],
			}),
		).toEqual({ ok: false, error: { code: "NOTHING_SELECTED" } });
		expect(validateContextSyncExclusionAddition("docs", DOCS)).toEqual({
			ok: false,
			error: { code: "SELECTED", path: "docs" },
		});
		for (const path of ["notes/a.md", "docsx/a.md"]) {
			expect(
				validateContextSyncExclusionAddition(path, DOCS),
				path,
			).toEqual({
				ok: false,
				error: { code: "OUTSIDE_SELECTION", path },
			});
		}
	});

	it("refuses a path already left out, and one inside a left-out path, but not one that holds them", () => {
		const selection = { paths: ["docs"], excludedPaths: ["docs/drafts"] };
		expect(
			validateContextSyncExclusionAddition("docs/drafts", selection),
		).toEqual({
			ok: false,
			error: { code: "DUPLICATE", path: "docs/drafts" },
		});
		expect(
			validateContextSyncExclusionAddition("docs/drafts/a.md", selection),
		).toEqual({
			ok: false,
			error: {
				code: "OVERLAP",
				path: "docs/drafts/a.md",
				withPath: "docs/drafts",
			},
		});
		expect(
			validateContextSyncExclusionAddition("docs/guides", {
				paths: ["docs"],
				excludedPaths: ["docs/guides/old"],
			}),
		).toEqual({ ok: true, path: "docs/guides" });
	});
});

describe("contextSyncExclusionMessage", () => {
	it("names the path, and the left-out path it falls inside", () => {
		expect(
			contextSyncExclusionMessage({ code: "WHOLE_REPOSITORY" }),
		).toEqual({ key: "excludeErrors.WHOLE_REPOSITORY" });
		expect(
			contextSyncExclusionMessage({ code: "SELECTED", path: "docs" }),
		).toEqual({ key: "excludeErrors.SELECTED", values: { path: "docs" } });
		expect(
			contextSyncExclusionMessage({
				code: "OVERLAP",
				path: "docs/a/b",
				withPath: "docs/a",
			}),
		).toEqual({
			key: "excludeErrors.OVERLAP",
			values: { path: "docs/a/b", withPath: "docs/a" },
		});
	});
});

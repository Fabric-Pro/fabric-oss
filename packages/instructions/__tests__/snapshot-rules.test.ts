import { describe, expect, it } from "vitest";
import { readFrozenIgnoreGlobs, snapshotRulesLeaveOut } from "../src";

describe("readFrozenIgnoreGlobs", () => {
	it("reads the pair a snapshot froze", () => {
		expect(
			readFrozenIgnoreGlobs({
				layer: "project",
				ignoreGlobs: ["drafts/**"],
				limits: {},
			}),
		).toEqual({ globs: ["drafts/**"], layer: "project" });
	});

	it.each([
		["null", null],
		["an array", []],
		["no layer", { ignoreGlobs: [] }],
		["a layer it does not know", { layer: "other", ignoreGlobs: [] }],
		["globs that are not a list", { layer: "default", ignoreGlobs: "x" }],
		["a glob that is not text", { layer: "default", ignoreGlobs: [1] }],
	])("reads %s as no rules", (_label, value) => {
		expect(readFrozenIgnoreGlobs(value)).toBeNull();
	});
});

describe("snapshotRulesLeaveOut", () => {
	const frozen = { layer: "project", ignoreGlobs: ["drafts/**"] };

	it("leaves out the .fabricignore file, which only an upload of the folder changes", () => {
		expect(snapshotRulesLeaveOut(".fabricignore", frozen)).toBe(true);
	});

	it("leaves out a nested .fabricignore only when the rules do: it is ordinary content below the root", () => {
		expect(snapshotRulesLeaveOut("docs/.fabricignore", frozen)).toBe(false);
	});

	it("leaves out what the snapshot's own frozen rules exclude", () => {
		expect(snapshotRulesLeaveOut("drafts/notes.md", frozen)).toBe(true);
		expect(snapshotRulesLeaveOut("rules/a.md", frozen)).toBe(false);
	});

	it("leaves out the always-excluded paths whatever the snapshot froze, and when it froze nothing readable", () => {
		expect(snapshotRulesLeaveOut("CLAUDE.local.md", frozen)).toBe(true);
		expect(snapshotRulesLeaveOut("nested/CLAUDE.local.md", null)).toBe(
			true,
		);
		expect(snapshotRulesLeaveOut(".git/config", "unreadable")).toBe(true);
		expect(snapshotRulesLeaveOut("rules/a.md", null)).toBe(false);
	});

	it.each([
		["an empty path", ""],
		["a traversal", "../outside.md"],
		["an absolute path", "/etc/passwd"],
		[
			"a path with a backslash, which is not git's separator",
			"rules\\a.md",
		],
		["a path that is not in its normal spelling", "./rules//a.md"],
	])(
		"leaves out %s: it is not a path a version can carry",
		(_label, path) => {
			expect(snapshotRulesLeaveOut(path, frozen)).toBe(true);
		},
	);
});

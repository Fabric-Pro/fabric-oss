/**
 * Path safety, string layer (Fizzy #2539).
 *
 * These are the checks that stand between a server response and a write on
 * somebody's machine, so each rejection gets its own case: a regression here
 * is not a cosmetic one. The filesystem layer — symlinks, containment,
 * atomic writes — is covered in `safe-write.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
	checkRelativePath,
	collisionKey,
	describeRejection,
	findCollision,
	isReservedPath,
} from "../src/lib/instructions/paths.js";

describe("checkRelativePath", () => {
	it.each([
		["AGENTS.md"],
		[".claude/skills/review/SKILL.md"],
		["docs/nested/deep/file.txt"],
		["console.md"],
		["nullable.ts"],
		["a.b.c/d.md"],
	])("accepts %s", (input) => {
		expect(checkRelativePath(input)).toEqual({ ok: true, path: input });
	});

	it.each([
		["../escape.md", "traversal"],
		["a/../../b.md", "traversal"],
		["./a.md", "traversal"],
		["/etc/passwd", "absolute"],
		["C:/Windows/system.ini", "absolute"],
		["a\\b.md", "backslash"],
		["\\\\server\\share\\x", "backslash"],
		["", "empty"],
		["a//b.md", "empty"],
		["dir/", "trailing_separator"],
		["a\u0000b.md", "control_char"],
	])("rejects %s as %s", (input, reason) => {
		const result = checkRelativePath(input);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe(reason);
	});

	/**
	 * Windows resolves these to devices rather than files, with or without an
	 * extension. A manifest using one would make a write look like it
	 * happened while the bytes went nowhere.
	 */
	it.each([
		["NUL", "reserved_device_name"],
		["nul.txt", "reserved_device_name"],
		["docs/CON.md", "reserved_device_name"],
		["com1", "reserved_device_name"],
		["LPT9.json", "reserved_device_name"],
		["aux.md", "reserved_device_name"],
	])("rejects the Windows device name %s", (input, reason) => {
		const result = checkRelativePath(input);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe(reason);
	});

	it.each([
		["AGENTS.md.", "trailing_dot_or_space"],
		["AGENTS.md ", "trailing_dot_or_space"],
		["docs./a.md", "trailing_dot_or_space"],
		["a.md:stream", "forbidden_character"],
		["docs:hidden/a.md", "forbidden_character"],
		// The rest of the set Windows refuses in a filename.
		["a<b.md", "forbidden_character"],
		["a>b.md", "forbidden_character"],
		['a"b.md', "forbidden_character"],
		["a|b.md", "forbidden_character"],
		["a?b.md", "forbidden_character"],
		["a*b.md", "forbidden_character"],
	])("rejects the Win32 alias %s", (input, reason) => {
		const result = checkRelativePath(input);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe(reason);
	});

	it("explains every rejection in one readable line", () => {
		const result = checkRelativePath("../escape.md");
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(describeRejection(result)).toBe(
			"path traversal refused: ../escape.md",
		);
	});
});

describe("isReservedPath", () => {
	it.each([
		[".git/config"],
		[".git/hooks/pre-commit"],
		[".git"],
		[".fabric/instructions.lock"],
		[".GIT/config"],
		// Review round 2, finding 5: the file `init` writes for itself.
		[".claude/settings.local.json"],
		[".claude/Settings.Local.json"],
		[".codex/hooks.json"],
		[".codex/Hooks.json"],
		// Fizzy #2670: reserved by BASENAME, at any depth, unlike the exact
		// root paths above.
		["CLAUDE.local.md"],
		["packages/x/CLAUDE.local.md"],
		["CLAUDE.LOCAL.MD"],
	])("refuses to own %s", (input) => {
		expect(isReservedPath(input)).toBe(true);
	});

	it.each([
		[".gitignore"],
		["AGENTS.md"],
		["docs/.git-notes.md"],
		// Reserving the whole `.claude/` root would refuse the feature's own
		// content; only the one file is off limits.
		[".claude/skills/review/SKILL.md"],
		[".claude/settings.json"],
		[".claude/commands/x.md"],
		[".codex/skills/review/SKILL.md"],
		[".codex/config.toml"],
		// `CLAUDE.md` (no `.local`) and a name that merely contains the
		// reserved basename are ordinary content.
		["CLAUDE.md"],
		["docs/CLAUDE.local.md.txt"],
	])("leaves %s alone", (input) => {
		expect(isReservedPath(input)).toBe(false);
	});
});

describe("collisionKey", () => {
	/**
	 * macOS stores names normalised and compares case-insensitively, so these
	 * pairs are one file with two spellings. Refused everywhere, not only on
	 * macOS: a manifest that loses a file for one developer must not sync
	 * cleanly for another.
	 */
	it("treats NFC and NFD spellings of one name as one file", () => {
		const nfc = "caf\u00e9.md";
		const nfd = "cafe\u0301.md";
		expect(nfc).not.toBe(nfd);
		expect(collisionKey(nfc)).toBe(collisionKey(nfd));
	});

	it("treats case variants as one file", () => {
		expect(collisionKey("README.md")).toBe(collisionKey("readme.md"));
	});

	it("finds the first colliding pair in a manifest", () => {
		expect(findCollision(["a.md", "docs/b.md", "A.md"])).toEqual({
			first: "a.md",
			second: "A.md",
		});
	});

	it("returns null when every path is distinct", () => {
		expect(findCollision(["a.md", "b.md", "docs/a.md"])).toBeNull();
	});
});

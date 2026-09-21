import { describe, expect, it } from "vitest";
import {
	describePortableNameRefusal,
	validatePortableName,
	validateRelativePath,
} from "../src/paths";

describe("validateRelativePath", () => {
	it.each([
		["CLAUDE.md", "CLAUDE.md"],
		["./.claude/agents/a.md", ".claude/agents/a.md"],
		[".claude\\rules\\x.md", ".claude/rules/x.md"],
		["a//b.md", "a/b.md"],
		// Portable-adjacent names that are NOT devices and must stay
		// acceptable: only COM1..COM9 are, and a device name has to be the
		// whole stem.
		["COM10.md", "COM10.md"],
		["connection.md", "connection.md"],
		["getting started.md", "getting started.md"],
	])("normalizes %s to %s", (input, expected) => {
		expect(validateRelativePath(input)).toEqual({
			ok: true,
			path: expected,
		});
	});
	it.each([
		["", "empty"],
		["/etc/passwd", "absolute"],
		["../x.md", "traversal"],
		["a/../../x.md", "traversal"],
		["a/./x.md", "traversal"],
		["C:\\x.md", "drive"],
		["\\\\server\\share\\x.md", "unc"],
		["a\u0000b.md", "control_char"],
		[`${"a/".repeat(33)}x.md`, "too_deep"],
		[`${"a".repeat(600)}.md`, "too_long"],
	])("rejects %s as %s", (input, reason) => {
		expect(validateRelativePath(input)).toEqual({ ok: false, reason });
	});
});

/**
 * Portability is a separate question from structural safety, asked of
 * different paths at a different moment — see `validatePortableName`. Each
 * name below stores fine and then refuses to install through
 * `fabric instructions sync`, whose own guard refuses the WHOLE manifest.
 */
describe("validatePortableName", () => {
	it.each([
		["CON.md", "reserved_device_name"],
		["docs/nul.txt", "reserved_device_name"],
		["LPT9", "reserved_device_name"],
		["a.md.", "trailing_dot_or_space"],
		["a.md ", "trailing_dot_or_space"],
		// A DIRECTORY segment counts too: Windows opens `docs` for `docs.`.
		["docs./y.md", "trailing_dot_or_space"],
		["docs /y.md", "trailing_dot_or_space"],
		["a.md:stream", "forbidden_character"],
		["a<b.md", "forbidden_character"],
		["a>b.md", "forbidden_character"],
		['a"b.md', "forbidden_character"],
		["a|b.md", "forbidden_character"],
		["a?b.md", "forbidden_character"],
		["a*b.md", "forbidden_character"],
		["docs/a*b/c.md", "forbidden_character"],
	])("rejects %s as %s", (input, reason) => {
		expect(validatePortableName(input)).toMatchObject({
			ok: false,
			reason,
		});
	});

	it.each([
		"CLAUDE.md",
		".claude/agents/a.md",
		"COM10.md",
		"connection.md",
		"getting started.md",
		"caf\u00e9.md",
		// Legal everywhere, and refusing them would be a rule the CLI and the
		// server could drift on in the quiet direction.
		"a'b.md",
		"a(b).md",
		"a&b.md",
		"a#b.md",
		"a+b.md",
	])("accepts %s", (input) => {
		expect(validatePortableName(input)).toEqual({ ok: true });
	});

	// Structural questions are the OTHER function's, and this one must not
	// answer them: a delete of a grandfathered path is exempt from
	// portability but never from structural safety.
	it("does not answer structural questions", () => {
		// An absolute path is not a portability problem and this function
		// does not pretend otherwise; `validateRelativePath` is what refuses
		// it, and it runs first on every path and every operation.
		expect(validatePortableName("/etc/passwd")).toEqual({ ok: true });
		expect(validateRelativePath("/etc/passwd")).toEqual({
			ok: false,
			reason: "absolute",
		});
		// `..` does happen to end in a dot, so this function has an opinion
		// about it. Harmless: the structural check has already refused it as
		// traversal by the time portability is ever asked.
		expect(validateRelativePath("../x.md")).toEqual({
			ok: false,
			reason: "traversal",
		});
	});

	it("names the file, the segment and what to do about it", () => {
		const refusal = validatePortableName("docs/CON.md");
		expect(refusal.ok).toBe(false);
		if (refusal.ok) {
			return;
		}
		const message = describePortableNameRefusal("docs/CON.md", refusal);
		expect(message).toContain("docs/CON.md");
		expect(message).toContain("CON.md");
		expect(message).toContain("Rename");
	});
});

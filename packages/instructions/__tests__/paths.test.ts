import { describe, expect, it } from "vitest";
import { validateRelativePath } from "../src/paths";

describe("validateRelativePath", () => {
	it.each([
		["CLAUDE.md", "CLAUDE.md"],
		["./.claude/agents/a.md", ".claude/agents/a.md"],
		[".claude\\rules\\x.md", ".claude/rules/x.md"],
		["a//b.md", "a/b.md"],
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

/**
 * The two pure helpers behind synced knowledge files (Fizzy #2616):
 * `normalizeContextSourcePath`, which turns a caller's relative path into the
 * one stored spelling that keys the row, and `hashContextContent`, the
 * sha256 that makes an unchanged push a no-op.
 *
 * The path rules matter because the path IS the key: two spellings of one
 * file that normalised differently would create two rows, and a path that
 * escaped the tree (`..`, an absolute path) would be a key nobody's working
 * copy can reproduce.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/context-source-path.test.ts
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashContextContent } from "../prisma/queries/projects/context-content-hash";
import {
	ContextSourcePathError,
	MAX_CONTEXT_SOURCE_PATH_LENGTH,
	normalizeContextSourcePath,
	normalizeContextSourcePathPrefix,
} from "../prisma/queries/projects/context-source-path";

function reasonFor(input: string): string | undefined {
	try {
		normalizeContextSourcePath(input);
		return undefined;
	} catch (error) {
		expect(error).toBeInstanceOf(ContextSourcePathError);
		return (error as ContextSourcePathError).reason;
	}
}

describe("normalizeContextSourcePath — accepted spellings", () => {
	it("keeps an already-normal relative path as it is", () => {
		expect(normalizeContextSourcePath("docs/architecture.md")).toBe(
			"docs/architecture.md",
		);
	});

	it("turns Windows separators into POSIX ones", () => {
		expect(normalizeContextSourcePath("docs\\guides\\setup.md")).toBe(
			"docs/guides/setup.md",
		);
	});

	it("collapses repeated separators, mixed or not", () => {
		expect(normalizeContextSourcePath("docs//guides\\\\/setup.md")).toBe(
			"docs/guides/setup.md",
		);
	});

	it("strips a leading ./, however it is spelled", () => {
		expect(normalizeContextSourcePath("./docs/a.md")).toBe("docs/a.md");
		expect(normalizeContextSourcePath(".\\docs\\a.md")).toBe("docs/a.md");
		expect(normalizeContextSourcePath("././docs/a.md")).toBe("docs/a.md");
	});

	it("NFC-normalizes, so a decomposed and a composed name are one key", () => {
		const decomposed = "docs/cafe\u0301.md";
		const composed = "docs/caf\u00e9.md";
		expect(normalizeContextSourcePath(decomposed)).toBe(composed);
		expect(normalizeContextSourcePath(composed)).toBe(composed);
	});

	it("accepts a dotfile and a name that merely contains dots", () => {
		expect(normalizeContextSourcePath(".github/notes..md")).toBe(
			".github/notes..md",
		);
	});

	it("accepts a path of exactly the maximum length", () => {
		const path = `${"a".repeat(MAX_CONTEXT_SOURCE_PATH_LENGTH - 3)}.md`;
		expect(normalizeContextSourcePath(path)).toBe(path);
	});
});

describe("normalizeContextSourcePath — refused paths", () => {
	it.each([
		["", "empty"],
		["./", "empty"],
		["/", "absolute"],
		["/etc/passwd", "absolute"],
		["\\\\server\\share\\a.md", "absolute"],
		["C:\\Users\\dev\\a.md", "absolute"],
		["c:/repo/a.md", "absolute"],
		["D:a.md", "absolute"],
		["../secrets.md", "dot-segment"],
		["docs/../../a.md", "dot-segment"],
		["docs\\..\\a.md", "dot-segment"],
		["docs/./a.md", "dot-segment"],
		["docs/..", "dot-segment"],
		["docs/", "trailing-slash"],
		["docs\\", "trailing-slash"],
		["docs/a\u0000.md", "control-character"],
		["docs/a\n.md", "control-character"],
		["docs/a\u007f.md", "control-character"],
		["docs/a\u0085.md", "control-character"],
		// Format characters (\p{Cf}): invisible, and the basename becomes the
		// default title and the audit resource name.
		["docs/arch\u200Bitecture.md", "control-character"],
		["docs\u200D/a.md", "control-character"],
		["docs/\u202Edm.a", "control-character"],
		["\uFEFFdocs/a.md", "control-character"],
	])("refuses %j as %s", (input, reason) => {
		expect(reasonFor(input)).toBe(reason);
	});

	it("refuses a path one character over the maximum", () => {
		const path = `${"a".repeat(MAX_CONTEXT_SOURCE_PATH_LENGTH - 2)}.md`;
		expect(reasonFor(path)).toBe("too-long");
	});

	it("measures the length after normalizing, not before", () => {
		// Collapsing the separators brings this back under the limit.
		const path = `./${"a".repeat(MAX_CONTEXT_SOURCE_PATH_LENGTH - 3)}.md`;
		expect(normalizeContextSourcePath(path)).toHaveLength(
			MAX_CONTEXT_SOURCE_PATH_LENGTH,
		);
	});

	it("says what was wrong in a message a caller can act on", () => {
		expect(() => normalizeContextSourcePath("../a.md")).toThrow(
			/relative path inside the project/i,
		);
	});
});

// The folder a contexts-list filter selects (Fizzy #2620). It is compared as
// a string prefix of the stored keys above, so it has to come out in the
// same spelling, end in exactly one "/" (so `docs` never selects
// `docs-archive/…`), and refuse anything no stored key could start with.
function prefixReasonFor(input: string): string | undefined {
	try {
		normalizeContextSourcePathPrefix(input);
		return undefined;
	} catch (error) {
		expect(error).toBeInstanceOf(ContextSourcePathError);
		return (error as ContextSourcePathError).reason;
	}
}

describe("normalizeContextSourcePathPrefix — accepted folders", () => {
	it("turns a nested folder into a prefix ending in one slash", () => {
		expect(normalizeContextSourcePathPrefix("docs/guides")).toBe(
			"docs/guides/",
		);
		expect(normalizeContextSourcePathPrefix("docs")).toBe("docs/");
	});

	it("is idempotent with or without the trailing slash", () => {
		expect(normalizeContextSourcePathPrefix("docs/guides/")).toBe(
			"docs/guides/",
		);
		expect(
			normalizeContextSourcePathPrefix(
				normalizeContextSourcePathPrefix("docs/guides"),
			),
		).toBe("docs/guides/");
	});

	it.each(["", ".", "./", "././"])(
		"reads %j as the tree root, which selects every synced file",
		(input) => {
			expect(normalizeContextSourcePathPrefix(input)).toBe("");
		},
	);

	it("strips a leading ./ and NFC-normalizes like a file path", () => {
		expect(normalizeContextSourcePathPrefix("./docs")).toBe("docs/");
		expect(normalizeContextSourcePathPrefix("./notes/cafe\u0301")).toBe(
			"notes/caf\u00e9/",
		);
	});

	it("keeps LIKE metacharacters as plain characters (escaping is the query's job)", () => {
		expect(normalizeContextSourcePathPrefix("my_docs/100%")).toBe(
			"my_docs/100%/",
		);
	});
});

describe("normalizeContextSourcePathPrefix — refused folders", () => {
	it.each([
		["..", "dot-segment"],
		["../docs", "dot-segment"],
		["docs/../secrets", "dot-segment"],
		["docs/.", "dot-segment"],
		["docs\\guides", "backslash"],
		["\\\\server\\share", "backslash"],
		["/", "absolute"],
		["/docs", "absolute"],
		["C:/repo/docs", "absolute"],
		["docs//guides", "empty-segment"],
		["docs//", "empty-segment"],
		[".//docs", "empty-segment"],
		["docs/a\u0000b", "control-character"],
		["docs/\u200Bguides", "control-character"],
	])("refuses %j as %s", (input, reason) => {
		expect(prefixReasonFor(input)).toBe(reason);
	});

	it("refuses a prefix that leaves no room for a file name", () => {
		// The shortest stored path under a folder is the folder, "/", and one
		// character of file name, so the longest usable prefix (folder plus
		// "/") is MAX - 1 characters; a folder of MAX - 1 characters would
		// need a MAX + 1 character path to match.
		const folder = "a".repeat(MAX_CONTEXT_SOURCE_PATH_LENGTH - 1);
		expect(prefixReasonFor(folder)).toBe("too-long");
		expect(normalizeContextSourcePathPrefix(folder.slice(1))).toHaveLength(
			MAX_CONTEXT_SOURCE_PATH_LENGTH - 1,
		);
	});

	it("names the prefix, not the file path, in its message", () => {
		expect(() => normalizeContextSourcePathPrefix("../docs")).toThrow(
			/^sourcePathPrefix may not contain/,
		);
	});
});

describe("hashContextContent", () => {
	it("is the sha256 hex of the UTF-8 bytes", () => {
		const content = "# Notes\n\nCaf\u00e9 \u{1F600}\n";
		expect(hashContextContent(content)).toBe(
			createHash("sha256").update(content, "utf8").digest("hex"),
		);
		expect(hashContextContent(content)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("does not canonicalise: any byte of drift is a different hash", () => {
		expect(hashContextContent("a\n")).not.toBe(hashContextContent("a\r\n"));
		expect(hashContextContent("a")).not.toBe(hashContextContent("a "));
	});
});

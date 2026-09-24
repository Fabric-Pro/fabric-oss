/**
 * The Living Memory sync's file rules (design 2026-09-23 §2, §5.3.1 steps
 * 5–7): the server's twin of `fabric context push`'s.
 *
 * The cases are the CLI's own (`packages/cli/__tests__/context-push.test.ts`,
 * "walk + ignore rules", "classification" and "normalizeContextSourcePath"),
 * restated against a flat inventory of repository paths instead of a walked
 * folder, plus what only the sync has: the protected prefix of a folder
 * whose policy could not be read (the root one protects every managed row),
 * and the basename rule for a directly selected file.
 *
 * `@repo/database` is replaced by its pure path module, so these run without
 * the Prisma client.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/activities/lib/__tests__/context-sync-rules.test.ts
 */
import { createHash } from "node:crypto";
import { hashContextContent } from "@repo/database/prisma/queries/projects/context-content-hash";
import { describe, expect, it, vi } from "vitest";

vi.mock(
	"@repo/database",
	async () =>
		await import(
			"@repo/database/prisma/queries/projects/context-source-path"
		),
);

import {
	buildContextIgnoreRules,
	CONTEXT_IGNORE_FILENAME,
	classifyContextBytes,
	contextStorageKey,
	DEFAULT_CONTEXT_IGNORE_PATTERNS,
	hasTextExtension,
	isExcludedDirectlySelectedFile,
	isRegularFileMode,
	isUnderProtectedPrefix,
	MAX_CONTEXT_FILE_BYTES,
	MAX_CONTEXT_IGNORE_BYTES,
	matchContextEntry,
	protectedPrefixFor,
	relativeToSelectedFolder,
} from "../context-sync-rules";

const REGULAR = "100644";

function kept(
	paths: readonly string[],
	contextIgnore?: string,
	mode = REGULAR,
): string[] {
	const rules = buildContextIgnoreRules({ contextIgnore });
	return paths.filter((p) => matchContextEntry(rules, p, mode) === "kept");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("the default exclusions (the CLI's, and paths.ts's)", () => {
	it("are the CLI's list, in order", () => {
		// packages/cli/src/lib/context-sync/ignore.ts DEFAULT_CONTEXT_IGNORE_PATTERNS
		expect(DEFAULT_CONTEXT_IGNORE_PATTERNS).toEqual([
			".git/",
			".fabric/",
			".claude/",
			".cursor/",
			".codex/",
			"node_modules/",
			"CLAUDE.md",
			"AGENTS.md",
			"GEMINI.md",
			"skills/",
			"agents/",
			"hooks/",
			"rules/",
			"scripts/",
			".contextignore",
		]);
		expect(CONTEXT_IGNORE_FILENAME).toBe(".contextignore");
	});

	it("always leave out tool and coding-instruction paths, at any depth", () => {
		// CLI: "always leaves out tool and coding-instruction paths, at any depth"
		const inventory = [
			"keep.md",
			"docs/keep.md",
			".git/HEAD.txt",
			".fabric/notes.md",
			".claude/memory.md",
			".cursor/rules.md",
			".codex/notes.md",
			"node_modules/pkg/README.md",
			"CLAUDE.md",
			"AGENTS.md",
			"GEMINI.md",
			"docs/CLAUDE.md",
			"skills/review/SKILL.md",
			"docs/agents/writer.md",
			"deep/down/hooks/run.md",
			"rules/style.md",
			"docs/scripts/build.md",
			".contextignore",
		];

		expect(kept(inventory)).toEqual(["keep.md", "docs/keep.md"]);
	});

	it("match case-insensitively, as the CLI's do", () => {
		expect(
			kept(["claude.md", "Skills/x.md", "Docs/Agents.MD", "a.md"]),
		).toEqual(["a.md"]);
	});
});

describe(".contextignore", () => {
	it("applies with gitignore semantics", () => {
		// CLI: "applies .contextignore with gitignore semantics"
		const policy = "drafts/\n*.txt\n!keep.txt\n/top-only.md\n";

		expect(
			kept(
				[
					"a.md",
					"drafts/wip.md",
					"notes.txt",
					"keep.txt",
					"top-only.md",
					"sub/top-only.md",
				],
				policy,
			),
		).toEqual(["a.md", "keep.txt", "sub/top-only.md"]);
		expect(
			buildContextIgnoreRules({ contextIgnore: policy }).ignoresDirectory(
				"drafts",
			),
		).toBe(true);
	});

	it("cannot re-include a default exclusion", () => {
		// CLI: "does not let a user pattern re-include a default exclusion"
		expect(
			kept(
				["CLAUDE.md", "skills/x.md", "AGENTS.md", "a.md"],
				"!CLAUDE.md\n!skills/\n!AGENTS.md\n",
			),
		).toEqual(["a.md"]);
	});

	it("cannot re-include a file under a directory it excludes, so a flat inventory matches the CLI's walk", () => {
		// The walk never descends into an ignored directory; one flat
		// `ls-tree` path must reach the same verdict.
		expect(
			kept(
				["docs/keep.md", "docs/other.md", "a.md"],
				"docs/\n!docs/keep.md\n",
			),
		).toEqual(["a.md"]);
	});

	it("is matched against the path relative to its folder", () => {
		expect(relativeToSelectedFolder("docs", "docs/drafts/wip.md")).toBe(
			"drafts/wip.md",
		);
		expect(relativeToSelectedFolder("docs", "docs")).toBeNull();
		expect(relativeToSelectedFolder("docs", "docs/")).toBeNull();
		expect(
			relativeToSelectedFolder("docs", "docs-archive/a.md"),
		).toBeNull();
		expect(relativeToSelectedFolder("", "docs/a.md")).toBe("docs/a.md");
		expect(relativeToSelectedFolder("", "")).toBeNull();
		// So a folder's own `skills/` pattern applies inside it, relative to
		// it, and a selected folder named like a default is walked into:
		// the defaults match paths BELOW the selection, not the selection.
		const rules = buildContextIgnoreRules();
		const inside = relativeToSelectedFolder("skills", "skills/review.md");
		expect(inside).toBe("review.md");
		expect(matchContextEntry(rules, inside as string, REGULAR)).toBe(
			"kept",
		);
	});

	it("counts only up to 64 KiB", () => {
		expect(MAX_CONTEXT_IGNORE_BYTES).toBe(64 * 1024);
	});
});

describe("entry modes", () => {
	it("reads regular blobs only", () => {
		expect(isRegularFileMode("100644")).toBe(true);
		expect(isRegularFileMode("100755")).toBe(true);
		expect(isRegularFileMode("120000")).toBe(false); // symlink
		expect(isRegularFileMode("160000")).toBe(false); // submodule
		expect(isRegularFileMode("040000")).toBe(false); // tree
	});

	it("treats a link named like an ignored directory as ignored, not as a stray link", () => {
		// CLI: "treats a symlink named like an ignored directory as ignored"
		const rules = buildContextIgnoreRules();
		expect(matchContextEntry(rules, "node_modules", "120000")).toBe(
			"ignored",
		);
		expect(matchContextEntry(rules, "vendor/lib", "160000")).toBe("kept");
		// The same name as a regular file is not the directory pattern.
		expect(matchContextEntry(rules, "node_modules", REGULAR)).toBe("kept");
	});

	it("reports a path the matcher cannot evaluate as unmatchable, never as kept", () => {
		const rules = buildContextIgnoreRules();
		expect(matchContextEntry(rules, "", REGULAR)).toBe("unmatchable");
		expect(matchContextEntry(rules, "./a.md", REGULAR)).toBe("unmatchable");
	});
});

describe("classification", () => {
	it("keeps the text allow-list and nothing else", () => {
		// CLI: "skips every file type outside the text allow-list"
		const files = [
			"a.md",
			"b.markdown",
			"c.txt",
			"d.json",
			"e.yaml",
			"f.yml",
			"UPPER.MD",
			"image.png",
			"code.ts",
			"README",
		];
		expect(files.filter(hasTextExtension)).toEqual([
			"a.md",
			"b.markdown",
			"c.txt",
			"d.json",
			"e.yaml",
			"f.yml",
			"UPPER.MD",
		]);
	});

	it.each([
		[
			"invalid UTF-8",
			new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]),
			"binary",
		],
		["a NUL", new TextEncoder().encode("text\u0000more\n"), "binary"],
		["no bytes", new Uint8Array(), "empty"],
		["whitespace only", new TextEncoder().encode(" \n\t\n"), "empty"],
		["a lone byte-order mark", new Uint8Array([0xef, 0xbb, 0xbf]), "empty"],
		[
			"one byte over 2 MiB",
			new Uint8Array(MAX_CONTEXT_FILE_BYTES + 1).fill(0x78),
			"too-large",
		],
	])("refuses %s as %s", (_case, bytes, reason) => {
		// CLI: "skips invalid UTF-8 and NUL as binary, empty and
		// whitespace-only as empty, and oversize as too-large"
		expect(classifyContextBytes(bytes)).toEqual({ ok: false, reason });
	});

	it("accepts exactly 2 MiB", () => {
		const bytes = new Uint8Array(MAX_CONTEXT_FILE_BYTES).fill(0x79);
		expect(classifyContextBytes(bytes)).toMatchObject({ ok: true });
	});

	it("keeps a byte-order mark, so the stored hash is the hash of the repository's bytes", () => {
		// CLI: "hashes the UTF-8 bytes exactly as the server does, a
		// byte-order mark included"
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x0a]);
		const verdict = classifyContextBytes(withBom);

		expect(verdict.ok).toBe(true);
		if (!verdict.ok) {
			return;
		}
		expect(verdict.content.charCodeAt(0)).toBe(0xfeff);
		expect(hashContextContent(verdict.content)).toBe(sha256(withBom));
	});
});

describe("contextStorageKey (the server's rules, with the CLI's backslash refusal)", () => {
	it.each([
		["docs/a.md", "docs/a.md"],
		// A decomposed name (as macOS writes it) and the composed one are one key.
		["café.md", "café.md"],
		["deep/Nested Folder/a.md", "deep/Nested Folder/a.md"],
	])("stores %j as %j", (repositoryPath, storageKey) => {
		expect(contextStorageKey(repositoryPath)).toEqual({
			ok: true,
			storageKey,
		});
	});

	it.each([
		// CLI plan.ts refuses a backslash before normalising; the normaliser
		// would turn it into a separator.
		["docs\\a.md", "backslash"],
		["", "empty"],
		["/abs.md", "absolute"],
		["C:a.md", "absolute"],
		["docs/../a.md", "dot-segment"],
		["docs/./a.md", "dot-segment"],
		["docs/", "trailing-slash"],
		["a\u0007.md", "control-character"],
		["a​.md", "control-character"],
		["bidi‮name.md", "control-character"],
		[
			`${"d".repeat(200)}/${"e".repeat(200)}/${"f".repeat(110)}.md`,
			"too-long",
		],
	])("refuses %j as invalid-path (%s)", (repositoryPath, detail) => {
		expect(contextStorageKey(repositoryPath)).toEqual({
			ok: false,
			reason: "invalid-path",
			detail,
		});
	});
});

describe("protected prefixes (§5.3.1 step 6)", () => {
	it("protects every managed row when the whole repository's policy is unreadable", () => {
		const prefixes = [protectedPrefixFor("")];

		expect(prefixes).toEqual([""]);
		for (const key of ["a.md", "docs/a.md", "deep/down/x.json"]) {
			expect(isUnderProtectedPrefix(key, prefixes)).toBe(true);
		}
	});

	it("protects the keys under a selected folder, by whole segments", () => {
		const prefixes = [protectedPrefixFor("docs")];

		expect(prefixes).toEqual(["docs/"]);
		expect(isUnderProtectedPrefix("docs/a.md", prefixes)).toBe(true);
		expect(isUnderProtectedPrefix("docs/guides/b.md", prefixes)).toBe(true);
		expect(isUnderProtectedPrefix("docs-archive/a.md", prefixes)).toBe(
			false,
		);
		expect(isUnderProtectedPrefix("notes/a.md", prefixes)).toBe(false);
	});

	it("protects nothing when no policy failed", () => {
		expect(isUnderProtectedPrefix("docs/a.md", [])).toBe(false);
	});
});

describe("a directly selected file (the basename rule, as paths.ts applies it)", () => {
	it.each([
		["CLAUDE.md", true],
		["docs/AGENTS.md", true],
		["notes/gemini.md", true],
		["docs/.contextignore", true],
		["docs/.ContextIgnore", true],
		// Folder patterns do not apply to a directly selected file.
		["skills/x.md", false],
		["agents/plan.md", false],
		["docs/claude.md.bak", false],
		["docs/README.md", false],
	])("%j excluded: %s", (repositoryPath, excluded) => {
		expect(isExcludedDirectlySelectedFile(repositoryPath)).toBe(excluded);
	});
});

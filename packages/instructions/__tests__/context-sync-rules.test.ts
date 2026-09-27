/**
 * Living Memory's file rules, the one canonical copy (Fizzy #2750 §7):
 * the default exclusions, the text extensions, `.fabric`, the policy file,
 * and the two ways the defaults apply — to a directly selected file by its
 * basename, and inside a selected folder relative to it, gitignore style.
 *
 * `@repo/temporal` (the run) and `@repo/api` (`configure`, `listTree`)
 * import this module; the published CLI keeps its own copy, pinned by
 * `context-sync-rules-agree-with-cli.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONTEXT_IGNORE_FILENAME,
	CONTEXT_SYNC_FABRIC_DIRECTORY,
	CONTEXT_TEXT_EXTENSIONS,
	contextSyncBasename,
	contextSyncPathSpellingProblem,
	createContextDefaultRules,
	DEFAULT_CONTEXT_IGNORE_PATTERNS,
	defaultRuleForDirectlySelectedFile,
	hasContextTextExtension,
	isContextIgnorePolicyFile,
	isExcludedDirectlySelectedFile,
	isInContextSyncFabricDirectory,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "../src/context-sync-rules";

describe("the constants", () => {
	it("are the defaults of `fabric context push`, in order", () => {
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
		expect(CONTEXT_SYNC_FABRIC_DIRECTORY).toBe(".fabric");
		expect(CONTEXT_TEXT_EXTENSIONS).toEqual([
			".md",
			".markdown",
			".txt",
			".json",
			".yaml",
			".yml",
		]);
	});
});

describe("a directly selected file: judged by its basename", () => {
	it.each([
		["CLAUDE.md", "CLAUDE.md"],
		["docs/AGENTS.md", "AGENTS.md"],
		["notes/gemini.md", "GEMINI.md"],
		["deep/down/Claude.MD", "CLAUDE.md"],
		["docs/.contextignore", ".contextignore"],
		["docs/.ContextIgnore", ".contextignore"],
	])("%j is left out by the default rule %j, in any case", (file, rule) => {
		expect(defaultRuleForDirectlySelectedFile(file)).toBe(rule);
		expect(isExcludedDirectlySelectedFile(file)).toBe(true);
	});

	it("never applies a folder pattern to a directly selected file", () => {
		for (const file of [
			"skills/x.md",
			"agents/writer.md",
			".claude/memory.md",
			"node_modules/pkg/README.md",
			"docs/scripts/build.md",
		]) {
			expect(defaultRuleForDirectlySelectedFile(file), file).toBeNull();
			expect(isExcludedDirectlySelectedFile(file), file).toBe(false);
		}
	});

	it("leaves out a file with a .fabric segment anywhere, in any case, as no basename rule would", () => {
		for (const file of [
			".fabric/notes.md",
			"docs/.Fabric/state.json",
			"a/.FABRIC/b/c.md",
		]) {
			expect(defaultRuleForDirectlySelectedFile(file), file).toBeNull();
			expect(isExcludedDirectlySelectedFile(file), file).toBe(true);
		}
		expect(isExcludedDirectlySelectedFile("docs/.fabricrc")).toBe(false);
		expect(isExcludedDirectlySelectedFile("my.fabric/x.md")).toBe(false);
	});
});

describe("inside a selected folder: the defaults relative to it, gitignore style", () => {
	const rules = createContextDefaultRules();

	it.each([
		["skills/x.md", "file", "skills/"],
		["docs/skills/review/SKILL.md", "file", "skills/"],
		["Skills/x.md", "file", "skills/"],
		["docs/Agents/writer.md", "file", "agents/"],
		["deep/down/hooks/run.md", "file", "hooks/"],
		[".git/HEAD.txt", "file", ".git/"],
		["node_modules/pkg/README.md", "file", "node_modules/"],
		["CLAUDE.md", "file", "CLAUDE.md"],
		["docs/claude.md", "file", "CLAUDE.md"],
		// A folder named after a file pattern is left out with its contents.
		["docs/CLAUDE.md/notes.md", "file", "CLAUDE.md"],
		["docs/.contextignore", "file", ".contextignore"],
		["skills", "directory", "skills/"],
		["docs/Rules", "directory", "rules/"],
		["docs/.Fabric", "directory", ".fabric/"],
	] as const)("%j (%s) is left out by %j", (relative, kind, rule) => {
		expect(rules.ruleFor(relative, kind)).toBe(rule);
	});

	it("keeps what no default names, and a folder pattern never matches a FILE of that name", () => {
		expect(rules.ruleFor("keep.md", "file")).toBeNull();
		expect(rules.ruleFor("docs/guides/a.md", "file")).toBeNull();
		expect(rules.ruleFor("docs/skills", "file")).toBeNull();
		expect(rules.ruleFor("docs/skills-archive/a.md", "file")).toBeNull();
		expect(rules.ruleFor("docs", "directory")).toBeNull();
	});

	it("judges a link or submodule as a file OR a folder, so a linked node_modules is the folder rule", () => {
		expect(rules.ruleFor("node_modules", "file")).toBeNull();
		expect(rules.ruleFor("node_modules", "other")).toBe("node_modules/");
		expect(rules.ruleFor("docs/AGENTS.md", "other")).toBe("AGENTS.md");
		expect(rules.ruleFor("docs/link.md", "other")).toBeNull();
	});

	it("answers `ignores` as the gitignore matcher does, a trailing slash marking a folder", () => {
		expect(rules.ignores("skills/x.md")).toBe(true);
		expect(rules.ignores("skills")).toBe(false);
		expect(rules.ignores("skills/")).toBe(true);
		expect(rules.ignores("docs/a.md")).toBe(false);
	});

	it("throws for a path the matcher cannot evaluate, as the run's matcher does", () => {
		expect(() => rules.ignores("")).toThrow();
		expect(() => rules.ignores("./docs/a.md")).toThrow();
		expect(() => rules.ruleFor("./docs/a.md", "file")).toThrow();
	});

	it("is the same verdict whether or not a path's rule was asked before (fresh instances too)", () => {
		const other = createContextDefaultRules();
		for (const relative of ["skills/x.md", "a.md", "docs/CLAUDE.md"]) {
			expect(other.ruleFor(relative, "file")).toBe(
				rules.ruleFor(relative, "file"),
			);
			expect(other.ignores(relative)).toBe(rules.ignores(relative));
		}
	});
});

describe("the text extensions", () => {
	it.each([
		"a.md",
		"docs/b.markdown",
		"c.txt",
		"d.json",
		"e.yaml",
		"f.yml",
		"README.MD",
		"x.Json",
		".notes.md",
	])("%j is text", (file) => {
		expect(hasContextTextExtension(file)).toBe(true);
	});

	it.each([
		"a.png",
		"b",
		".md",
		"docs/.yaml",
		"c.md.bak",
		"d.",
		"e.mdx",
		"folder.md/file",
	])("%j is not", (file) => {
		expect(hasContextTextExtension(file)).toBe(false);
	});

	it("reads the extension exactly as node's posix extname does", () => {
		for (const file of [
			"a.md",
			"a.",
			"a",
			".a",
			".a.md",
			"..",
			"...",
			"a..md",
			"dir.x/a",
			"dir/.md",
			"a.b.c",
			"x/y.z/",
			"é.MD",
		]) {
			const expected = [
				".md",
				".markdown",
				".txt",
				".json",
				".yaml",
				".yml",
			].includes(path.posix.extname(file).toLowerCase());
			expect(hasContextTextExtension(file), file).toBe(expected);
		}
	});
});

describe(".fabric and the policy file", () => {
	it("finds a .fabric segment at any depth, in any case, whole segments only", () => {
		for (const p of [
			".fabric",
			".fabric/x",
			"a/.Fabric",
			"a/b/.FABRIC/c.md",
		]) {
			expect(isInContextSyncFabricDirectory(p), p).toBe(true);
		}
		for (const p of ["fabric", "docs/.fabricrc", "my.fabric/x.md", ""]) {
			expect(isInContextSyncFabricDirectory(p), p).toBe(false);
		}
	});

	it("names the policy file by its basename, in any case", () => {
		expect(isContextIgnorePolicyFile(".contextignore")).toBe(true);
		expect(isContextIgnorePolicyFile("docs/.ContextIgnore")).toBe(true);
		expect(isContextIgnorePolicyFile("docs/.contextignore.bak")).toBe(
			false,
		);
		expect(isContextIgnorePolicyFile(".contextignore/x.md")).toBe(false);
	});

	it("reads a basename after the last slash", () => {
		expect(contextSyncBasename("a/b/c.md")).toBe("c.md");
		expect(contextSyncBasename("c.md")).toBe("c.md");
	});
});

describe("a selected or left-out path's spelling and length (Fizzy #2750 §5.2)", () => {
	it("accepts a path that is its own storage key, and leaves the whole repository to the caller", () => {
		for (const accepted of [
			"",
			"docs",
			"docs/guide.md",
			"docs/caf\u00e9",
		]) {
			expect(
				contextSyncPathSpellingProblem(accepted),
				accepted,
			).toBeNull();
		}
	});

	it("refuses every other spelling as not canonical", () => {
		for (const refused of [
			"docs/cafe\u0301",
			" docs",
			"docs ",
			"docs\\a.md",
			"docs/",
			"/docs",
			"./docs",
			"docs//a.md",
			"docs/./a.md",
			"docs/../a.md",
			"docs/a\u0000.md",
			"docs/a\u200b.md",
			"C:docs",
			"d".repeat(513),
		]) {
			expect(contextSyncPathSpellingProblem(refused), refused).toBe(
				"not-canonical",
			);
		}
	});

	it("refuses a path past configure's input bound as too long, before its spelling", () => {
		expect(MAX_CONTEXT_SYNC_PATH_LENGTH).toBe(1024);
		expect(contextSyncPathSpellingProblem(` ${"d".repeat(1024)}`)).toBe(
			"too-long",
		);
	});
});

describe("the module stays browser-safe", () => {
	it("imports a storage-key normalizer that itself imports nothing, so the browser never loads the database package", () => {
		const source = readFileSync(
			path.join(
				import.meta.dirname,
				"../../database/prisma/queries/projects/context-source-path.ts",
			),
			"utf8",
		);
		expect([...source.matchAll(/^import\b/gm)]).toEqual([]);
	});
	it("imports nothing but `ignore` and the dependency-free storage-key normalizer: no Node built-in, no Prisma client", () => {
		const source = readFileSync(
			path.join(import.meta.dirname, "../src/context-sync-rules.ts"),
			"utf8",
		);
		const imports = [
			...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm),
		].map((match) => match[1]);
		expect([...imports].sort()).toEqual([
			"@repo/database/prisma/queries/projects/context-source-path",
			"ignore",
		]);
	});
});

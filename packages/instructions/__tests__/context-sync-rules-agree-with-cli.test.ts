/**
 * The published CLI's copy of Living Memory's file rules must be the
 * canonical one (Fizzy #2750 §7).
 *
 * `fabric context push` (`packages/cli/src/lib/context-sync/ignore.ts` and
 * `classify.ts`) and the repository sync (`../src/context-sync-rules.ts`,
 * which `@repo/temporal` and `@repo/api` import) decide which files of a
 * repository become Living Memory. Were they to disagree, a file would flip
 * between the two owners on every push and every sync.
 *
 * Like `portable-names-agree-with-cli.test.ts`, the CLI modules are imported
 * by relative path on purpose: `@fabricorg/cli` is published and cannot
 * depend on this private package, even as a devDependency.
 */
import { describe, expect, it } from "vitest";
import {
	CONTEXT_TEXT_EXTENSIONS as CLI_TEXT_EXTENSIONS,
	hasTextExtension as cliHasTextExtension,
} from "../../cli/src/lib/context-sync/classify";
import {
	buildContextIgnoreRules as buildCliContextIgnoreRules,
	CONTEXT_IGNORE_FILENAME as CLI_CONTEXT_IGNORE_FILENAME,
	DEFAULT_CONTEXT_IGNORE_PATTERNS as CLI_DEFAULT_PATTERNS,
} from "../../cli/src/lib/context-sync/ignore";
import {
	CONTEXT_IGNORE_FILENAME,
	CONTEXT_TEXT_EXTENSIONS,
	createContextDefaultRules,
	DEFAULT_CONTEXT_IGNORE_PATTERNS,
	hasContextTextExtension,
} from "../src/context-sync-rules";

/** Paths relative to a pushed or selected folder, files and folders. */
const CORPUS = [
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
	"docs/claude.md",
	"Docs/Agents.MD",
	"skills/review/SKILL.md",
	"Skills/x.md",
	"docs/agents/writer.md",
	"deep/down/hooks/run.md",
	"rules/style.md",
	"docs/scripts/build.md",
	".contextignore",
	"docs/.contextignore",
	"docs/CLAUDE.md/notes.md",
	"docs/skills",
	"docs/skills-archive/a.md",
	"docs/.fabricrc",
];

describe("the CLI's rules are the canonical ones", () => {
	it("has the same default exclusions, in the same order, and the same policy filename", () => {
		expect([...CLI_DEFAULT_PATTERNS]).toEqual([
			...DEFAULT_CONTEXT_IGNORE_PATTERNS,
		]);
		expect(CLI_CONTEXT_IGNORE_FILENAME).toBe(CONTEXT_IGNORE_FILENAME);
	});

	it("has the same text extensions", () => {
		expect([...CLI_TEXT_EXTENSIONS].sort()).toEqual(
			[...CONTEXT_TEXT_EXTENSIONS].sort(),
		);
	});

	it("leaves out the same files and folders inside a folder, in any case", () => {
		const cli = buildCliContextIgnoreRules();
		const canonical = createContextDefaultRules();
		for (const relative of CORPUS) {
			expect(canonical.ignores(relative), relative).toBe(
				cli.ignoresFile(relative),
			);
			expect(canonical.ignores(`${relative}/`), `${relative}/`).toBe(
				cli.ignoresDirectory(relative),
			);
		}
	});

	it("reads the same extensions as text", () => {
		for (const file of [
			"a.md",
			"README.MD",
			"b.markdown",
			"c.txt",
			"d.JSON",
			"e.yaml",
			"f.yml",
			"g.png",
			"h",
			".md",
			"i.md.bak",
			"j.",
			"k.mdx",
		]) {
			expect(hasContextTextExtension(file), file).toBe(
				cliHasTextExtension(file),
			);
		}
	});
});

/**
 * Every path the CLI refuses to own must be one the server never publishes.
 *
 * `@fabricorg/cli` reserves paths in `isReservedPath` (the `.git` and
 * `.fabric` roots, the two hook files it writes, `CLAUDE.local.md` at any
 * depth) and refuses a whole published manifest that names one: it is about
 * to write on somebody's disk, so refusing is right. The server's always
 * layer (`ALWAYS_IGNORE_GLOBS`) is the other half of that contract: whatever
 * the CLI reserves, the server must exclude from folder uploads and
 * repository syncs alike, or a project publishes a bundle nobody can install
 * (Fizzy #2704: a repository that committed `.fabric/instructions.lock`).
 *
 * Like `portable-names-agree-with-cli.test.ts`, the CLI module is imported by
 * relative path on purpose: the CLI cannot depend on this private package.
 *
 * The contract is one-directional. The server also excludes paths the CLI
 * does not reserve (`.guild/**`, a nested `.git/` directory), which is fine:
 * a server-only exclusion costs a file the CLI would have accepted, never an
 * uninstallable bundle.
 */

import { describe, expect, it } from "vitest";
import { isReservedPath } from "../../cli/src/lib/instructions/paths";
import { buildIgnoreMatcher, resolveIgnoreGlobs } from "../src/ignore";

/** Paths the CLI reserves: root segments, exact hook files, and the any-depth basename. */
const CLI_RESERVED = [
	".git",
	".git/config",
	".git/hooks/pre-commit",
	".GIT/config",
	".fabric",
	".fabric/instructions.lock",
	".Fabric/instructions.lock",
	".fabric/cache/x.json",
	".claude/settings.local.json",
	".claude/Settings.Local.json",
	".codex/hooks.json",
	"CLAUDE.local.md",
	"packages/web/CLAUDE.local.md",
];

/** Paths the CLI accepts, which the always layer must therefore leave alone. */
const CLI_ACCEPTED = [
	"CLAUDE.md",
	"AGENTS.md",
	".claude/settings.json",
	".claude/skills/review/SKILL.md",
	".codex/prompts/x.md",
	"tools/.fabric/notes.md",
	"docs/git/notes.md",
	".gitignore",
	".fabricignore-notes.md",
];

describe("the server's always layer covers every path the CLI reserves", () => {
	// Under the emptiest configuration: no `.fabricignore` and an explicitly
	// empty project list (which also drops the defaults), so only the always
	// layer stands between a reserved path and a publish.
	const always = buildIgnoreMatcher(
		resolveIgnoreGlobs({ fabricIgnoreText: null, projectGlobs: [] }),
	);

	it.each(CLI_RESERVED)("%s is reserved by the CLI", (path) => {
		expect(isReservedPath(path)).toBe(true);
	});

	it.each(CLI_RESERVED)("%s is always excluded by the server", (path) => {
		expect(always(path)?.layer).toBe("always");
	});

	it.each(CLI_ACCEPTED)("%s is accepted by the CLI", (path) => {
		expect(isReservedPath(path)).toBe(false);
	});

	it.each(CLI_ACCEPTED)("%s is not always-excluded by the server", (path) => {
		expect(always(path)).toBeNull();
	});
});

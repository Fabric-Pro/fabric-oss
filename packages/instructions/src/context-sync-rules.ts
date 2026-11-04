/**
 * Which files a Living Memory repository sync can read: the one canonical
 * copy of its rules (Fizzy #2750 §7, design 2026-09-23 §2, §5.3.1).
 *
 * `@repo/temporal` (the run: `context-sync-rules.ts`), `@repo/api`
 * (`configure` and `listTree`: `contexts/repository-sync/paths.ts`) and the
 * web configure dialog import this module. The published CLI keeps its own
 * copy (`packages/cli/src/lib/context-sync/ignore.ts` and `classify.ts`),
 * because `@fabricorg/cli` cannot depend on this private package;
 * `__tests__/context-sync-rules-agree-with-cli.test.ts` pins the two
 * together. A file the CLI would push and the sync would not (or the
 * reverse) flips between two owners, so change them together.
 *
 * Browser-safe: no Node built-in, no Prisma client, no I/O. `ignore` is plain
 * JavaScript and detects `process` before it reads it; the storage-key
 * normalizer is imported from its own dependency-free module in
 * `@repo/database`, never the package entry.
 *
 * The defaults apply two ways, and which one depends on how the file came
 * to be selected:
 *
 *  - a DIRECTLY selected file is judged by its basename against the default
 *    FILE patterns (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.contextignore`),
 *    case-insensitively (`defaultRuleForDirectlySelectedFile`); the folder
 *    patterns never apply to it, so a directly selected `skills/x.md` syncs;
 *  - a file INSIDE a selected folder is judged by every default pattern,
 *    matched against its path RELATIVE to that folder with gitignore
 *    semantics, case-insensitively, a file under a left-out folder being left
 *    out with it (`createContextDefaultRules`), exactly as
 *    `fabric context push` matches the folder it pushes.
 *
 * A `.fabric` segment anywhere in a repository path, in any case, is the
 * CLI's own state and never syncs (Fizzy #2704), whichever way the file was
 * selected: the `.fabric/` default is matched relative to a selected folder,
 * so it cannot see a `.fabric` that is, or is above, the selection itself.
 *
 * Case: basenames and `.fabric` segments compare with `toLowerCase()`; the
 * folder-relative matcher is `ignore`'s case-insensitive mode. The patterns
 * are ASCII, so the two agree on every name the patterns can match.
 */

import {
	ContextSourcePathError,
	MAX_CONTEXT_SOURCE_PATH_LENGTH,
	normalizeContextSourcePath,
} from "@repo/database/prisma/queries/projects/context-source-path";
import ignore from "ignore";

/** A selected folder's own policy file: read as policy, never synced. */
export const CONTEXT_IGNORE_FILENAME = ".contextignore";

/** The Fabric CLI's state folder (`.fabric/instructions.lock`, …). */
export const CONTEXT_SYNC_FABRIC_DIRECTORY = ".fabric";

/**
 * `fabric context push`'s default exclusions, never overridable by a
 * `.contextignore`: version-control, editor and tool state, generated build output
 * and lock files, and every coding-instruction file or folder at any depth
 * (instructions have their own reviewed path into a project). A trailing `/` makes a pattern name
 * folders only; the others name a file or a folder of that name.
 */
export const DEFAULT_CONTEXT_IGNORE_PATTERNS: readonly string[] = [
	".git/",
	".fabric/",
	".claude/",
	".cursor/",
	".codex/",
	".idea/",
	".vscode/",
	".vs/",
	"node_modules/",
	"dist/",
	"coverage/",
	".next/",
	".turbo/",
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
	"skills/",
	"agents/",
	"hooks/",
	"rules/",
	"scripts/",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	CONTEXT_IGNORE_FILENAME,
];

/** The only extensions a sync reads, compared lower-cased (`README.MD` is text). */
export const CONTEXT_TEXT_EXTENSIONS: readonly string[] = [
	".md",
	".markdown",
	".txt",
	".json",
	".yaml",
	".yml",
];

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(CONTEXT_TEXT_EXTENSIONS);

/** The default FILE patterns (no trailing `/`), keyed lower-cased. */
const DEFAULT_FILE_RULES: ReadonlyMap<string, string> = new Map(
	DEFAULT_CONTEXT_IGNORE_PATTERNS.filter((p) => !p.endsWith("/")).map((p) => [
		p.toLowerCase(),
		p,
	]),
);

/**
 * The longest selected or left-out path `configure` accepts: its input
 * schema's bound. A longer one is refused as too long, before its spelling.
 * Every path must equal its storage key, so this is the storage key's own
 * limit; a larger bound would report a too-long path as not canonical.
 */
export const MAX_CONTEXT_SYNC_PATH_LENGTH = MAX_CONTEXT_SOURCE_PATH_LENGTH;

/**
 * Why a Living Memory selected or left-out path is not one `configure`
 * accepts as spelled, or `null` when it is (Fizzy #2750 §5.2): `too-long`
 * past `MAX_CONTEXT_SYNC_PATH_LENGTH`; otherwise `not-canonical` unless the
 * path is exactly the storage key the sync would derive for it, which is
 * `normalizeContextSourcePath(path) === path` with no surrounding
 * whitespace — NFC, no backslash, no control or format character, no
 * leading `/` or drive letter, no `//`, no `./` or `../`, no `.` or `..`
 * segment, no trailing `/`, and at most 512 characters. `""` (the whole
 * repository) is `null` here; whether it may be selected or left out is
 * the caller's rule.
 *
 * The one predicate for `configure` (`contexts/repository-sync/paths.ts`),
 * the configure dialog's typed paths, and the tree's folders the provider
 * only implied. It calls `normalizeContextSourcePath` itself (the storage
 * key the sync derives), so the two cannot drift.
 */
export function contextSyncPathSpellingProblem(
	path: string,
): "too-long" | "not-canonical" | null {
	if (path === "") {
		return null;
	}
	if (path.length > MAX_CONTEXT_SYNC_PATH_LENGTH) {
		return "too-long";
	}
	if (path.trim() !== path) {
		return "not-canonical";
	}
	try {
		return normalizeContextSourcePath(path) === path
			? null
			: "not-canonical";
	} catch (error) {
		if (error instanceof ContextSourcePathError) {
			return "not-canonical";
		}
		throw error;
	}
}

/** The last segment of a `/`-separated path. */
export function contextSyncBasename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Node's `path.posix.extname`, ported so this module needs no Node
 * built-in: the last `.` of the last segment and what follows it, except
 * that a segment's leading dot (`.env`) and the `..` segment have none.
 */
function posixExtname(path: string): string {
	let startDot = -1;
	let startPart = 0;
	let end = -1;
	let matchedSlash = true;
	// 0: no dot seen yet or only the one ending the name; 1: a dot before it;
	// -1: a non-dot character before it.
	let preDotState = 0;
	for (let i = path.length - 1; i >= 0; --i) {
		const char = path[i];
		if (char === "/") {
			if (!matchedSlash) {
				startPart = i + 1;
				break;
			}
			continue;
		}
		if (end === -1) {
			matchedSlash = false;
			end = i + 1;
		}
		if (char === ".") {
			if (startDot === -1) {
				startDot = i;
			} else if (preDotState !== 1) {
				preDotState = 1;
			}
		} else if (startDot !== -1) {
			preDotState = -1;
		}
	}
	if (
		startDot === -1 ||
		end === -1 ||
		preDotState === 0 ||
		(preDotState === 1 &&
			startDot === end - 1 &&
			startDot === startPart + 1)
	) {
		return "";
	}
	return path.slice(startDot, end);
}

/** `path` ends in one of `CONTEXT_TEXT_EXTENSIONS`, in any case. */
export function hasContextTextExtension(path: string): boolean {
	return TEXT_EXTENSIONS.has(posixExtname(path).toLowerCase());
}

/**
 * `path` has a `.fabric` segment, at any depth and in any case (whole
 * segments only: `.fabricrc` and `my.fabric` are ordinary names).
 */
export function isInContextSyncFabricDirectory(path: string): boolean {
	return path
		.split("/")
		.some(
			(segment) =>
				segment.toLowerCase() === CONTEXT_SYNC_FABRIC_DIRECTORY,
		);
}

/** `path`'s basename is the policy file's name, in any case. */
export function isContextIgnorePolicyFile(path: string): boolean {
	return contextSyncBasename(path).toLowerCase() === CONTEXT_IGNORE_FILENAME;
}

/**
 * The default FILE pattern (as written in `DEFAULT_CONTEXT_IGNORE_PATTERNS`)
 * that a directly selected file's basename names, case-insensitively, or
 * `null`. The folder patterns never apply to a directly selected file, and
 * `.fabric` is not a basename rule (`isExcludedDirectlySelectedFile`).
 */
export function defaultRuleForDirectlySelectedFile(
	path: string,
): string | null {
	return (
		DEFAULT_FILE_RULES.get(contextSyncBasename(path).toLowerCase()) ?? null
	);
}

/**
 * A directly selected file the run leaves out: a `.fabric` segment anywhere,
 * or a basename a default FILE pattern names.
 */
export function isExcludedDirectlySelectedFile(path: string): boolean {
	return (
		isInContextSyncFabricDirectory(path) ||
		defaultRuleForDirectlySelectedFile(path) !== null
	);
}

/**
 * How an entry is matched inside a selected folder: a regular file as a
 * file, a folder as a folder, and anything else (a symbolic link, a
 * submodule), which a walk would see as a link or a folder and never follow,
 * as a file OR a folder, so a linked `node_modules` is the folder rule.
 */
export type ContextSyncEntryKind = "file" | "directory" | "other";

export interface ContextDefaultRules {
	/**
	 * The default patterns' gitignore verdict on one candidate, relative to
	 * the selected folder, `/`-separated; a trailing `/` marks a folder.
	 * Throws for a path the matcher cannot evaluate (empty, `./`- or
	 * `../`-prefixed, absolute), which the run reports as `invalid-path`.
	 */
	ignores(candidate: string): boolean;
	/**
	 * The default pattern (as written) that leaves this entry out, or `null`
	 * when none does. Throws as `ignores` does.
	 */
	ruleFor(relativePath: string, kind: ContextSyncEntryKind): string | null;
}

/**
 * The defaults as they apply inside one selected folder. A fresh instance
 * per use: the matcher caches every path it has answered, so a long-lived
 * shared one would grow without bound.
 */
export function createContextDefaultRules(): ContextDefaultRules {
	const matcher = ignore().add([...DEFAULT_CONTEXT_IGNORE_PATTERNS]);
	const ruleOf = (candidate: string): string | null => {
		const result = matcher.test(candidate);
		return result.ignored ? (result.rule?.pattern ?? null) : null;
	};
	return {
		ignores: (candidate) => matcher.ignores(candidate),
		ruleFor: (relativePath, kind) => {
			if (kind === "file") {
				return ruleOf(relativePath);
			}
			if (kind === "directory") {
				return ruleOf(`${relativePath}/`);
			}
			return ruleOf(relativePath) ?? ruleOf(`${relativePath}/`);
		},
	};
}

/** A selected folder's `.contextignore` counts only up to this size. */
export const MAX_CONTEXT_IGNORE_BYTES = 64 * 1024;

/**
 * A `.contextignore`'s text, or `null` when its bytes are not UTF-8 (the
 * run then cannot evaluate the policy and protects the folder). Fatal, so a
 * stray byte is a refusal rather than a silent U+FFFD; a byte-order mark is
 * dropped, as `ignore` would not read it as part of the first rule.
 */
export function decodeContextIgnore(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Which layer leaves an entry out inside a selected folder. */
export type ContextIgnoreRuleSource = "default" | "contextignore";

export interface ContextIgnoreRules {
	/** Is this file (relative to the folder, `/`-separated) left out? */
	ignoresFile(relativePath: string): boolean;
	/** Is this directory left out, with everything beneath it? */
	ignoresDirectory(relativePath: string): boolean;
	/**
	 * The rule that leaves this entry out, as written (a default pattern, or
	 * the `.contextignore` line), and its layer; `null` when it is kept. The
	 * defaults answer first, as they win. Throws as `ignoresFile` does.
	 */
	ruleFor(
		relativePath: string,
		kind: ContextSyncEntryKind,
	): { rule: string; source: ContextIgnoreRuleSource } | null;
}

/**
 * A selected folder's rules: the defaults, then its `.contextignore`, as the
 * CLI's `buildContextIgnoreRules` builds them (minus `--exclude`, which a
 * sync does not have). Two matchers rather than one pattern list, so a
 * user's `!CLAUDE.md` cannot re-include what the defaults exclude.
 * Case-insensitive, gitignore semantics, and a file under an ignored
 * directory is ignored with it. The run (`@repo/temporal`) and the configure
 * dialog's preview both build their rules here, so they cannot drift.
 *
 * Throws for a `.contextignore` rule over `MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS`
 * (`findContextIgnoreProblem`): such a rule is never handed to the matcher.
 * The matcher itself throws for a path it cannot evaluate (empty,
 * `./`-prefixed).
 */
export function buildContextIgnoreRules(
	input: { contextIgnore?: string | null } = {},
): ContextIgnoreRules {
	const defaults = createContextDefaultRules();
	const user = ignore();
	if (input.contextIgnore) {
		const problem = findContextIgnoreProblem(input.contextIgnore);
		if (problem) {
			throw new Error(
				`.contextignore line ${problem.line} has ${problem.groups} \`**\` groups; at most ${problem.max} can be evaluated`,
			);
		}
		user.add(input.contextIgnore);
	}
	const ignores = (candidate: string) =>
		defaults.ignores(candidate) || user.ignores(candidate);
	const userRuleOf = (candidate: string): string | null => {
		const result = user.test(candidate);
		return result.ignored ? (result.rule?.pattern ?? null) : null;
	};
	const userRuleFor = (relativePath: string, kind: ContextSyncEntryKind) => {
		if (kind === "file") {
			return userRuleOf(relativePath);
		}
		if (kind === "directory") {
			return userRuleOf(`${relativePath}/`);
		}
		return userRuleOf(relativePath) ?? userRuleOf(`${relativePath}/`);
	};
	return {
		ignoresFile: (relativePath) => ignores(relativePath),
		// The trailing slash is what makes a directory-only pattern
		// (`drafts/`) match.
		ignoresDirectory: (relativePath) => ignores(`${relativePath}/`),
		ruleFor: (relativePath, kind) => {
			const fromDefaults = defaults.ruleFor(relativePath, kind);
			if (fromDefaults !== null) {
				return { rule: fromDefaults, source: "default" };
			}
			const fromUser = userRuleFor(relativePath, kind);
			return fromUser === null
				? null
				: { rule: fromUser, source: "contextignore" };
		},
	};
}

/**
 * Why a path is not one `configure` accepts as left out, on its own, or
 * `null` when it is: the whole repository (`""`), a path too long or not in
 * its canonical spelling (`contextSyncPathSpellingProblem`), one with a
 * `.fabric` segment (never synced, so nothing to leave out), or a folder's
 * `.contextignore` (read as policy, never synced). A coding-instructions
 * basename is allowed: leaving one out is a no-op.
 *
 * The one predicate for `configure` (`contexts/repository-sync/paths.ts`)
 * and the configure dialog's typed "leave out" input.
 */
export function contextSyncExclusionProblem(
	path: string,
):
	| "whole-repository"
	| "too-long"
	| "not-canonical"
	| "fabric"
	| "policy-file"
	| null {
	if (path === "") {
		return "whole-repository";
	}
	const spelling = contextSyncPathSpellingProblem(path);
	if (spelling !== null) {
		return spelling;
	}
	if (isInContextSyncFabricDirectory(path)) {
		return "fabric";
	}
	return isContextIgnorePolicyFile(path) ? "policy-file" : null;
}

/**
 * The most `**` groups one `.contextignore` rule may hold.
 *
 * `ignore` turns each `**` into a nested repetition, so a rule's matching
 * time grows with the path's depth to the power of its `**` count, whatever
 * the path's content. Measured with `ignore@7.0.9`, worst case, a rule of K `**` groups each
 * followed by an `a` segment and ending in `c`, against `a/` repeated:
 *
 *   K = 2   9 ms at 256 segments (the deepest path a sync can store: 512
 *           characters), 62 ms at 512 segments
 *   K = 3   500 ms at 256 segments, 7.9 s at 512 segments
 *
 * The run does not evaluate a path longer than a sync can store
 * (`matchContextEntry`), so 256 segments is the deepest the matcher is given.
 * Two is the largest count that stays under 50 ms there;
 * a `docs` rule with two `**` groups around `drafts`, and the usual
 * `node_modules` rule, both fit. A rule over it is never evaluated and never
 * dropped: the sync fails the run and names its line, because dropping it
 * would sync files the rule was meant to exclude.
 */
export const MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS = 2;

/** A `.contextignore` rule the matcher must not be given. */
export type ContextIgnoreProblem = {
	kind: "too-many-double-stars";
	/** 1-based, as an editor numbers the file. */
	line: number;
	/** How many `**` groups the rule holds. */
	groups: number;
	max: number;
};

/**
 * The first `.contextignore` rule `ignore` cannot evaluate in bounded time,
 * or `null`. The one check for every reader of a policy file (the run, and
 * any browser path that evaluates one), so they cannot drift: call it before
 * `ignore().add(text)` and do not add the text when it returns a problem.
 *
 * Reads the file as `ignore` does: blank lines and lines starting with `#`
 * are not rules; every other line is, negations included (a `!` rule is
 * compiled like any other). A run of two or more `*` is one group.
 */
export function findContextIgnoreProblem(
	text: string,
): ContextIgnoreProblem | null {
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (line.startsWith("#")) {
			continue;
		}
		const groups = (line.match(/\*{2,}/g) ?? []).length;
		if (groups > MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS) {
			return {
				kind: "too-many-double-stars",
				line: index + 1,
				groups,
				max: MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS,
			};
		}
	}
	return null;
}

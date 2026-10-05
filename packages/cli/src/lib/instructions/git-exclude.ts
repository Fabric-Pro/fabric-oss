/**
 * Keeping the files `init` writes out of a developer's commits, without
 * touching anything the repository tracks.
 *
 * The hook files (`.claude/settings.local.json`, `.codex/hooks.json`) and an
 * uploaded project's `.fabric/` directory are per-machine. A repository's own
 * `.gitignore` is shared, so adding to it would be a change to the project.
 * `.git/info/exclude` is the local, untracked equivalent: git asks it first,
 * and nobody else ever sees it. That is the only file this module writes.
 *
 * The write is a guarded append. The file is found through git (a linked
 * worktree shares the main checkout's), must be a regular file or absent, and
 * only the lines git does not already honour are added, once.
 */
import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as git from "./git.js";

export type ExcludeResult =
	| { kind: "unchanged" }
	| { kind: "added"; entries: string[] }
	| { kind: "failed"; entries: string[] };

/** A path relative to the work tree's top level, in git's `/` spelling. */
function relativeToTopLevel(
	toplevel: string,
	directory: string,
	file: string,
): string {
	return path
		.relative(toplevel, path.join(directory, file))
		.split(path.sep)
		.join("/");
}

/**
 * Whether a line in `info/exclude` names exactly this path and nothing else.
 * A newline would start another rule, `#` first would make a comment, `!`
 * would negate, and `* ? [ ] \` are patterns: a folder named `a*` would
 * exclude every sibling that starts with `a`.
 */
function isLiteralEntry(entry: string): boolean {
	return !/[\n\r*?[\]\\!]/.test(entry) && !entry.startsWith("#");
}

/**
 * Make sure git ignores each of `files` (relative to `directory`, which is at
 * or below `toplevel`). Never throws: a checkout this cannot read, an
 * `info/exclude` that is a symlink or a directory, a path that could not be
 * written as a literal line, or a write that fails all come back as `failed`,
 * with the entries the person can add themselves.
 */
export async function excludeLocalFiles(input: {
	toplevel: string;
	directory: string;
	files: readonly string[];
	deadline: git.GitDeadline;
}): Promise<ExcludeResult> {
	const entries = input.files.map(
		(file) =>
			`/${relativeToTopLevel(input.toplevel, input.directory, file)}`,
	);
	if (!entries.every(isLiteralEntry)) {
		return { kind: "failed", entries };
	}
	try {
		const missing: string[] = [];
		for (const entry of entries) {
			const ignored = await git.isIgnored(
				input.toplevel,
				entry.slice(1),
				input.deadline,
			);
			if (ignored.kind !== "ok") {
				return { kind: "failed", entries };
			}
			if (!ignored.value) {
				missing.push(entry);
			}
		}
		if (missing.length === 0) {
			return { kind: "unchanged" };
		}

		const file = await git.excludeFilePath(input.toplevel, input.deadline);
		if (file.kind !== "ok") {
			return { kind: "failed", entries: missing };
		}
		await mkdir(path.dirname(file.value), { recursive: true });
		const existing = await lstat(file.value).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			throw error;
		});
		if (existing !== null && !existing.isFile()) {
			return { kind: "failed", entries: missing };
		}
		const text =
			existing === null ? "" : await readFile(file.value, "utf8");
		const present = new Set(text.split(/\r?\n/));
		const toAdd = missing.filter((entry) => !present.has(entry));
		if (toAdd.length === 0) {
			return { kind: "unchanged" };
		}
		const lead = text === "" || text.endsWith("\n") ? "" : "\n";
		await appendFile(file.value, `${lead}${toAdd.join("\n")}\n`, "utf8");
		return { kind: "added", entries: toAdd };
	} catch {
		return { kind: "failed", entries };
	}
}

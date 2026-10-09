#!/usr/bin/env node
// Proves the release decision: `changeset status` must list at least one
// release against the PR's base. Exit 0 means a non-empty release list;
// 1 means empty/missing/unparseable output; 2 means usage or base errors.
//
// `changeset status` ignores untracked files, so a brand-new changeset reads
// as "no changeset". The gate marks untracked .changeset/*.md as
// intent-to-add in a temporary COPY of the index, leaving the real one alone.
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	BaseResolutionError,
	extractBaseArg,
	resolveAndAnnounce,
} from "./lib/resolve-base.mjs";

/** @param {string} text */
function out(text) {
	writeSync(process.stdout.fd, `${text}\n`);
}

/** @param {string} text */
function err(text) {
	writeSync(process.stderr.fd, `${text}\n`);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function git(args, cwd, env = process.env) {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new BaseResolutionError(
			`git ${args.join(" ")} failed: ${result.error?.message ?? String(result.stderr).trim()}`,
		);
	}
	return String(result.stdout);
}

// A signal that lands while spawnSync blocks would kill Node before the
// `finally` in main() runs. A handler keeps Node alive. JS handlers only run
// once the event loop turns, so main() finishes (and cleans up) first, then
// the entry point waits one tick and exits 128 + signal number.
/** @type {NodeJS.Signals | undefined} */
let interrupted;

function installSignalHandlers() {
	for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
		process.on(signal, () => {
			interrupted = signal;
			process.exitCode = 128 + (osConstants.signals[signal] ?? 0);
		});
	}
}

/** @returns {number} exit code */
function main() {
	const { base: explicit, rest } = extractBaseArg(process.argv.slice(2));
	if (rest.length > 0) {
		err(`Unknown argument: ${rest[0]}`);
		err("Usage: pnpm changeset:gate [--base=<ref>]");
		return 2;
	}

	const cwd = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
	const { base } = resolveAndAnnounce({ explicit, cwd });

	const indexPath = resolve(
		cwd,
		git(["rev-parse", "--git-path", "index"], cwd).trim(),
	);
	if (!existsSync(indexPath)) {
		throw new BaseResolutionError(`Git index not found at ${indexPath}.`);
	}

	installSignalHandlers();

	const tempDir = mkdtempSync(join(tmpdir(), "changeset-gate-"));
	try {
		const tempIndex = join(tempDir, "index");
		const outputFile = join(tempDir, "status.json");
		copyFileSync(indexPath, tempIndex);
		const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

		const untracked = git(
			[
				"ls-files",
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				".changeset/*.md",
			],
			cwd,
			env,
		)
			.split("\0")
			.filter(Boolean);
		if (untracked.length > 0) {
			git(["add", "--intent-to-add", "--", ...untracked], cwd, env);
		}

		const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
		// Mirrors what Changesets reads: @changesets/git getChangedChangesetFilesSinceRef
		// (dist/index.mjs:122-135: --diff-filter=d, root and pre/ only) and
		// @changesets/read (dist/index.mjs:6-11, 34-37: no dotfiles, README/AGENTS/CLAUDE/GEMINI.md ignored).
		const badNames = git(
			[
				"diff",
				"-z",
				"--name-only",
				"--diff-filter=d",
				mergeBase,
				"--",
				".changeset",
			],
			cwd,
			env,
		)
			.split("\0")
			.filter((file) => /^\.changeset\/(pre\/)?[^/]+\.md$/.test(file))
			.map((file) => file.slice(file.lastIndexOf("/") + 1))
			.filter(
				(name) =>
					!name.startsWith(".") &&
					!/^README\.md$/i.test(name) &&
					!["AGENTS.md", "CLAUDE.md", "GEMINI.md"].includes(name),
			)
			.filter((name) => !/^[A-Za-z0-9._-]+\.md$/.test(name));
		if (badNames.length > 0) {
			err(
				`changeset:gate: changeset file names must use only letters, digits, '.', '_' and '-': ${badNames.join(", ")}`,
			);
			err(
				"Rename them. (git quotes other names in `git diff --name-only`, which this gate cannot verify.)",
			);
			return 2;
		}

		const status = spawnSync(
			"pnpm",
			[
				"exec",
				"changeset",
				"status",
				`--since=${base}`,
				`--output=${outputFile}`,
			],
			{ cwd, env, encoding: "utf8" },
		);

		/** @type {{ name: string, type: string }[] | undefined} */
		let releases;
		let problem = "";
		if (status.error) {
			problem = `could not run changeset: ${status.error.message}`;
		} else if (!existsSync(outputFile)) {
			problem = "changeset wrote no output file";
		} else {
			try {
				const parsed = JSON.parse(readFileSync(outputFile, "utf8"));
				if (!Array.isArray(parsed?.releases)) {
					problem = "output has no .releases array";
				} else {
					releases = parsed.releases;
				}
			} catch (error) {
				problem = `output is not valid JSON (${error instanceof Error ? error.message : error})`;
			}
		}

		if (status.status !== 0 && !problem) {
			problem = `changeset status exited ${status.status}`;
			releases = undefined;
		}

		if (!releases || releases.length === 0) {
			err(
				`changeset:gate FAILED against ${base}: ${problem || "no releases"}.`,
			);
			if (status.stderr) {
				err(String(status.stderr).trimEnd());
			}
			if (status.stdout) {
				err(String(status.stdout).trimEnd());
			}
			return 1;
		}

		out(`Base: ${base}`);
		for (const release of releases) {
			out(`${release.name}: ${release.type}`);
		}
		return 0;
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

let result;
try {
	result = main();
} catch (error) {
	if (error instanceof BaseResolutionError) {
		err(error.message);
		result = 2;
	} else {
		throw error;
	}
}
// A signal handler that already ran has set the exit code; it wins.
if (!interrupted) {
	process.exitCode = result;
}
// Two setImmediate turns give a signal that arrived during spawnSync a poll phase to be delivered.
await new Promise((done) => setImmediate(done));
await new Promise((done) => setImmediate(done));

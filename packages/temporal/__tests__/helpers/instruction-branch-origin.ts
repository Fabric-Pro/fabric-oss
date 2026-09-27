/**
 * A real git "origin" for the member proposal branch activity tests (Fizzy
 * #2738 plan Tasks 7-8): a repository under `os.tmpdir()` reached over
 * `file://`, built and edited with plumbing only (no checkout of member
 * branches), so a test can play the member's hand edits, merges, rewrites
 * and a refusing hook against the activities' real git steps. Every
 * identity is synthetic.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGitEnv } from "../../src/activities/lib/instruction-sync-git";

export const TEST_MAIL = ["dev", "example.com"].join("@");
const HAND = { name: "Example Member", email: TEST_MAIL };

/** One path's new state in a commit: text, text with a mode, or deleted. */
export type FileChange = string | { content: string; mode: string } | null;

export type Origin = {
	root: string;
	dir: string;
	url: string;
	/** The production git env plus the file protocol, for this test only. */
	env: NodeJS.ProcessEnv;
	base: string;
	git(args: string[], input?: string | Buffer): string;
	/** A commit built on `parents[0]`'s tree (or empty), with `changes` applied. */
	commit(i: {
		parents: string[];
		changes?: Record<string, FileChange>;
		message?: string;
		treeFrom?: string;
	}): string;
	setRef(branch: string, sha: string): void;
	deleteRef(branch: string): void;
	refSha(branch: string): string | null;
	/** `{mode, type, oid}` of `path` at `sha`, or null. */
	entry(
		sha: string,
		file: string,
	): { mode: string; type: string; oid: string } | null;
	content(sha: string, file: string): string;
	message(sha: string): string;
	parents(sha: string): string[];
	hashObject(content: string): string;
	/** A pre-receive hook that refuses every push, as a protected branch would. */
	refusePushes(on: boolean): void;
	cleanup(): void;
};

export function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Builds an origin whose `main` holds `files` (path to content; `#!` files are executable). */
export function createOrigin(files: Record<string, FileChange>): Origin {
	const root = mkdtempSync(path.join(tmpdir(), "branch-activity-"));
	const dir = path.join(root, "origin");
	const baseEnv = {
		PATH: process.env.PATH,
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: HAND.name,
		GIT_AUTHOR_EMAIL: HAND.email,
		GIT_COMMITTER_NAME: HAND.name,
		GIT_COMMITTER_EMAIL: HAND.email,
		GIT_AUTHOR_DATE: "2026-09-26T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-09-26T00:00:00Z",
	};
	let indexCounter = 0;
	const run = (
		args: string[],
		input?: string | Buffer,
		extra: NodeJS.ProcessEnv = {},
	): string =>
		execFileSync("git", args, {
			cwd: dir,
			env: { ...baseEnv, ...extra },
			input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	execFileSync("git", ["init", "-q", "-b", "main", dir], {
		env: baseEnv,
	});
	run(["config", "uploadpack.allowFilter", "true"]);
	run(["config", "uploadpack.allowAnySHA1InWant", "true"]);

	const hashObject = (content: string) =>
		run(["hash-object", "-w", "--stdin"], content);

	const commit: Origin["commit"] = (i) => {
		const indexFile = path.join(root, `index-${indexCounter++}`);
		const env = { GIT_INDEX_FILE: indexFile };
		const treeSource = i.treeFrom ?? i.parents[0];
		if (treeSource) {
			run(["read-tree", treeSource], undefined, env);
		} else {
			run(["read-tree", "--empty"], undefined, env);
		}
		const records: string[] = [];
		for (const [file, change] of Object.entries(i.changes ?? {})) {
			if (change === null) {
				records.push(`0 ${"0".repeat(40)}\t${file}`);
				continue;
			}
			const content =
				typeof change === "string" ? change : change.content;
			const mode =
				typeof change === "string"
					? content.startsWith("#!")
						? "100755"
						: "100644"
					: change.mode;
			records.push(`${mode} ${hashObject(content)}\t${file}`);
		}
		if (records.length > 0) {
			run(
				["update-index", "-z", "--index-info"],
				`${records.join("\0")}\0`,
				env,
			);
		}
		const tree = run(["write-tree"], undefined, env);
		const parentArgs = i.parents.flatMap((p) => ["-p", p]);
		return run(
			["commit-tree", tree, ...parentArgs, "-F", "-"],
			i.message ?? "hand edit",
		);
	};

	const base = commit({ parents: [], changes: files, message: "base" });
	run(["update-ref", "refs/heads/main", base]);

	const hook = path.join(dir, ".git", "hooks", "pre-receive");
	return {
		root,
		dir,
		url: `file://${dir}`,
		env: {
			...buildGitEnv({ home: root }),
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "protocol.file.allow",
			GIT_CONFIG_VALUE_0: "always",
		},
		base,
		git: (args, input) => run(args, input),
		commit,
		setRef: (branch, sha) =>
			run(["update-ref", `refs/heads/${branch}`, sha]),
		deleteRef: (branch) =>
			run(["update-ref", "-d", `refs/heads/${branch}`]),
		refSha: (branch) => {
			try {
				return run([
					"rev-parse",
					"--verify",
					"-q",
					`refs/heads/${branch}`,
				]);
			} catch {
				return null;
			}
		},
		entry: (sha, file) => {
			const line = run(["ls-tree", sha, "--", file]);
			if (line === "") {
				return null;
			}
			const [meta] = line.split("\t");
			const [mode, type, oid] = (meta as string).split(" ");
			return {
				mode: mode as string,
				type: type as string,
				oid: oid as string,
			};
		},
		content: (sha, file) => run(["show", `${sha}:${file}`]),
		message: (sha) => run(["log", "-1", "--format=%B", sha]),
		parents: (sha) =>
			run(["rev-parse", `${sha}^@`])
				.split("\n")
				.filter((l) => l !== ""),
		hashObject,
		refusePushes: (on) => {
			if (on) {
				writeFileSync(
					hook,
					"#!/bin/sh\necho 'protected branch: pushes are not allowed' >&2\nexit 1\n",
				);
				chmodSync(hook, 0o755);
			} else {
				rmSync(hook, { force: true });
			}
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

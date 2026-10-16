/**
 * A real git "origin" for the Living Memory write activity tests (ADR-022): a
 * BARE repository under `os.tmpdir()` reached over `file://`, so a push to its
 * `main` is an ordinary push, and a pre-receive hook can refuse it the way a
 * protected branch is refused. Built with plumbing only. Every identity is
 * synthetic.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildGitEnv } from "../../src/activities/lib/instruction-sync-git";

const MAIL = ["dev", "example.com"].join("@");

export type BareOrigin = {
	root: string;
	url: string;
	/** The production git env plus the file protocol, for this test only. */
	env: NodeJS.ProcessEnv;
	base: string;
	git(args: string[], input?: string): string;
	tip(branch?: string): string | null;
	branches(): string[];
	file(rev: string, file: string): string;
	message(rev: string): string;
	/** A teammate's commit on `main`, from a clone of its own. */
	teammatePush(file: string, content: string): string;
	/** Makes the remote refuse pushes to `main`, as a protected branch does. */
	protectMain(on: boolean): void;
	cleanup(): void;
};

/** Builds an origin whose `main` holds `files` (path to content). */
export function createBareOrigin(files: Record<string, string>): BareOrigin {
	const root = mkdtempSync(path.join(tmpdir(), "memory-write-origin-"));
	const seed = path.join(root, "seed");
	const remote = path.join(root, "remote.git");
	const competitor = path.join(root, "competitor");
	const env = {
		PATH: process.env.PATH,
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	const run = (cwd: string, args: string[], input?: string): string =>
		execFileSync("git", args, {
			cwd,
			env,
			input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	const identity = ["-c", "user.name=Example", "-c", `user.email=${MAIL}`];

	mkdirSync(seed, { recursive: true });
	for (const [file, content] of Object.entries(files)) {
		const full = path.join(seed, ...file.split("/"));
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	run(seed, ["init", "-q", "-b", "main"]);
	run(seed, ["add", "-A"]);
	run(seed, [...identity, "commit", "-q", "-m", "base"]);
	run(root, ["clone", "-q", "--bare", seed, remote]);
	run(remote, ["config", "uploadpack.allowFilter", "true"]);
	run(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
	const hook = path.join(remote, "hooks", "pre-receive");
	writeFileSync(
		hook,
		'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ] && [ -f "$GIT_DIR/protect-main" ]; then\n    echo "protected branch" >&2\n    exit 1\n  fi\ndone\nexit 0\n',
	);
	chmodSync(hook, 0o755);
	run(root, ["clone", "-q", remote, competitor]);

	const tip = (branch = "main"): string | null => {
		try {
			return run(remote, [
				"rev-parse",
				"--verify",
				"-q",
				`refs/heads/${branch}`,
			]);
		} catch {
			return null;
		}
	};
	return {
		root,
		url: pathToFileURL(remote).href,
		env: {
			...buildGitEnv({ home: root }),
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "protocol.file.allow",
			GIT_CONFIG_VALUE_0: "always",
		},
		base: tip() as string,
		git: (args, input) => run(remote, args, input),
		tip,
		branches: () =>
			run(remote, ["for-each-ref", "--format=%(refname:short)"])
				.split("\n")
				.filter(Boolean),
		file: (rev, file) => run(remote, ["show", `${rev}:${file}`]),
		message: (rev) =>
			execFileSync(
				"git",
				["-C", remote, "log", "-n", "1", "--format=%B", rev],
				{ encoding: "utf8" },
			),
		teammatePush: (file, content) => {
			run(competitor, ["fetch", "-q", "origin"]);
			run(competitor, ["reset", "-q", "--hard", "origin/main"]);
			const full = path.join(competitor, ...file.split("/"));
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, content);
			run(competitor, ["add", "-A"]);
			run(competitor, [
				...identity,
				"commit",
				"-q",
				"-m",
				`teammate ${file}`,
			]);
			run(competitor, ["push", "-q", "origin", "HEAD:main"]);
			return run(competitor, ["rev-parse", "HEAD"]);
		},
		protectMain: (on) => {
			const marker = path.join(remote, "protect-main");
			if (on) {
				writeFileSync(marker, "");
			} else {
				rmSync(marker, { force: true });
			}
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

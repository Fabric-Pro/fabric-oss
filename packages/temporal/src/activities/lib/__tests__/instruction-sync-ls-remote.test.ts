import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildGitEnv,
	credentialFreeUrl,
	lsRemoteHead,
} from "../instruction-sync-git";

// Real git against a local file:// repository, like
// instruction-sync-real-git.test.ts. Skipped cleanly where git is absent;
// Task 10's smoke run covers the worker image's git.
let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

let work: string;
let source: string;
let mainSha: string;
let lookAlikeSha: string;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: work,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		encoding: "utf8",
	}).trim();
}

function commit(message: string): string {
	git(source, [
		"-c",
		"user.name=Example",
		"-c",
		"user.email=dev@example.com",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		message,
	]);
	return git(source, ["rev-parse", "HEAD"]);
}

/** The production env, plus the file protocol for this test only. */
function syncEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...buildGitEnv({ home: work }),
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "protocol.file.allow",
		GIT_CONFIG_VALUE_0: "always",
		...overrides,
	};
}

describe.skipIf(!hasGit)("lsRemoteHead against real git (spec §6.1)", () => {
	beforeAll(async () => {
		work = await mkdtemp(path.join(tmpdir(), "sync-ls-remote-"));
		source = path.join(work, "source");
		await mkdir(source);
		git(source, ["init", "-q", "-b", "main"]);
		lookAlikeSha = commit("one");
		// `git ls-remote <url> refs/heads/main` matches patterns from the
		// tail, so it lists this branch too.
		git(source, ["branch", "x/refs/heads/main"]);
		// The only ref ending in refs/heads/gone.
		git(source, ["branch", "x/refs/heads/gone"]);
		mainSha = commit("two");
		// A tag named like a branch that does not exist.
		git(source, ["tag", "release"]);
	});

	afterAll(async () => {
		await rm(work, { recursive: true, force: true });
	});

	it("returns the exact branch's head, not a tail-matching look-alike (Review Focus 2)", async () => {
		expect(mainSha).not.toBe(lookAlikeSha);
		await expect(
			lsRemoteHead({
				cwd: work,
				url: `file://${source}`,
				ref: "main",
				env: syncEnv(),
			}),
		).resolves.toEqual({ kind: "found", sha: mainSha });
	});

	it("reports missing when only a tail-matching look-alike exists", async () => {
		await expect(
			lsRemoteHead({
				cwd: work,
				url: `file://${source}`,
				ref: "gone",
				env: syncEnv(),
			}),
		).resolves.toEqual({ kind: "missing" });
	});

	it("reports missing for a tag of the same name: only refs/heads counts", async () => {
		await expect(
			lsRemoteHead({
				cwd: work,
				url: `file://${source}`,
				ref: "release",
				env: syncEnv(),
			}),
		).resolves.toEqual({ kind: "missing" });
	});

	it("fails, and never reports missing, when the repository cannot be read", async () => {
		await expect(
			lsRemoteHead({
				cwd: work,
				url: `file://${path.join(work, "no-such-repo")}`,
				ref: "main",
				env: syncEnv(),
			}),
		).rejects.toMatchObject({
			name: "GitCommandError",
			kind: "exit",
			label: "ls-remote",
		});
	});

	it("kills a hung ls-remote at its timeout", async () => {
		// A stand-in `git` that never answers: spawn resolves the command on
		// the child env's PATH, so this directory shadows the real binary.
		// `sleep` is named by absolute path because PATH holds only fakeBin.
		const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], {
			encoding: "utf8",
		}).trim();
		const fakeBin = path.join(work, "fake-bin");
		await mkdir(fakeBin, { recursive: true });
		await writeFile(
			path.join(fakeBin, "git"),
			`#!/bin/sh\nexec ${sleepBin} 30\n`,
		);
		await chmod(path.join(fakeBin, "git"), 0o755);
		const started = Date.now();
		await expect(
			lsRemoteHead({
				cwd: work,
				url: `file://${source}`,
				ref: "main",
				env: syncEnv({ PATH: fakeBin }),
				timeoutMs: 200,
			}),
		).rejects.toMatchObject({ kind: "timeout", label: "ls-remote" });
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});

// Outside the skipIf: these refuse before anything spawns, so they need no
// git and run everywhere (Decision 45).
describe("the ls-remote URL sink (spec §8.1)", () => {
	// Each userinfo host is assembled, as in PR 1's instruction-sync-git
	// tests, so no literal is email-shaped for the publication scan.
	it.each([
		["userinfo", `https://token@${"example.com"}/example-org/example-repo`],
		[
			"a password",
			`https://user:secret@${"example.com"}/example-org/example-repo`,
		],
		[
			"a query",
			"https://example.com/example-org/example-repo.git?access_token=secret",
		],
		["a fragment", "https://example.com/example-org/example-repo#secret"],
		[
			"a form that does not round-trip",
			"https://EXAMPLE.com/example-org/example-repo",
		],
	])(
		"lsRemoteHead refuses a URL carrying %s before git spawns",
		async (_label, url) => {
			await expect(
				lsRemoteHead({
					cwd: tmpdir(),
					url,
					ref: "main",
					env: buildGitEnv({ home: tmpdir() }),
				}),
			).rejects.toMatchObject({
				name: "GitCommandError",
				kind: "invalid_argument",
				label: "ls-remote",
			});
		},
	);

	it.each([
		[
			"strips userinfo",
			`https://member@${"example.com"}/example-org/example-repo`,
			"https://example.com/example-org/example-repo",
		],
		[
			"refuses a query",
			"https://example.com/example-org/example-repo.git?access_token=secret",
			null,
		],
		[
			"refuses a fragment",
			"https://example.com/example-org/example-repo#secret",
			null,
		],
	])(
		"credentialFreeUrl, the only URL the poll hands ls-remote, %s",
		(_label, input, expected) => {
			expect(credentialFreeUrl(input)).toBe(expected);
		},
	);
});

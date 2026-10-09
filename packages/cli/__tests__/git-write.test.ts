/**
 * The two writes the session hook may make to an existing checkout, and the
 * reads that decide whether it may (Fizzy #2878), against REAL git.
 *
 * Every test is skipped when `git` is not on PATH. Nothing touches the
 * network: the "remote" is a local bare repository reached over `file://`,
 * the code under test fetches from it, and the developer's own git
 * configuration is kept out of both the fixtures and the code under test the
 * way `git-checkout.test.ts` does it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	commonDir,
	fastForwardTo,
	fetchRef,
	headSha,
	lockFilesPresent,
	upstreamOf,
	worktreesOnBranch,
} from "../src/lib/instructions/git.js";
import {
	fetchFailureOf,
	mergeFailureOf,
} from "../src/lib/instructions/git-write.js";

const hasGit =
	spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const itWithGit = it.skipIf(!hasGit);

const saved: Record<string, string | undefined> = {};
let emptyConfig: string;

const ISOLATED = [
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
];

beforeAll(async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-write-config-"));
	emptyConfig = path.join(dir, "gitconfig");
	await writeFile(emptyConfig, "");
	for (const name of ISOLATED) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.HOME = dir;
	process.env.USERPROFILE = dir;
	process.env.XDG_CONFIG_HOME = dir;
	process.env.GIT_CONFIG_GLOBAL = emptyConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

/** Fixture setup only: the code under test never gets a way to do this. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: emptyConfig,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Example Dev",
			GIT_AUTHOR_EMAIL: "dev@example.com",
			GIT_COMMITTER_NAME: "Example Dev",
			GIT_COMMITTER_EMAIL: "dev@example.com",
		},
	}).trim();
}

async function commit(
	cwd: string,
	file: string,
	contents: string,
): Promise<string> {
	await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
	await writeFile(path.join(cwd, file), contents);
	git(cwd, "add", "--", file);
	git(cwd, "commit", "-q", "-m", `write ${file}`);
	return git(cwd, "rev-parse", "HEAD");
}

const soon = (): number => Date.now() + 60_000;

interface Fixture {
	base: string;
	/** The bare remote. */
	bare: string;
	/** Where new commits are made and pushed to the remote from. */
	seed: string;
	/** A clone of the remote, one commit behind the tip once `advance` ran. */
	checkout: string;
	first: string;
}

/** A bare remote with one commit on `main`, a seed clone and a checkout clone. */
async function fixture(): Promise<Fixture> {
	const base = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-write-")),
	);
	const bare = path.join(base, "remote.git");
	const seed = path.join(base, "seed");
	const checkout = path.join(base, "checkout");
	git(base, "init", "-q", "--bare", "-b", "main", bare);
	git(base, "init", "-q", "-b", "main", seed);
	const first = await commit(seed, "AGENTS.md", "one\n");
	git(seed, "remote", "add", "origin", pathToFileURL(bare).href);
	git(seed, "push", "-q", "origin", "main");
	git(base, "clone", "-q", pathToFileURL(bare).href, checkout);
	return { base, bare, seed, checkout, first };
}

/** One more commit on the remote's `main`. */
async function advance(fx: Fixture, file = "AGENTS.md"): Promise<string> {
	const sha = await commit(fx.seed, file, `${Date.now()}\n`);
	git(fx.seed, "push", "-q", "origin", "main");
	return sha;
}

describe("fetchRef, with real git", () => {
	itWithGit(
		"fetches the branch into its remote-tracking ref and answers the tip, leaving the checkout alone",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);

			const result = await fetchRef(
				fx.checkout,
				"origin",
				"main",
				soon(),
			);

			expect(result).toEqual({ kind: "fetched", tip });
			expect(
				git(fx.checkout, "rev-parse", "refs/remotes/origin/main"),
			).toBe(tip);
			expect(git(fx.checkout, "rev-parse", "HEAD")).toBe(fx.first);
		},
	);

	itWithGit(
		"does not bring tags: a session start fetches only the tracked branch",
		async () => {
			const fx = await fixture();
			git(fx.seed, "tag", "v1");
			git(fx.seed, "push", "-q", "origin", "v1");
			await advance(fx);

			await fetchRef(fx.checkout, "origin", "main", soon());

			expect(git(fx.checkout, "tag", "--list")).toBe("");
		},
	);

	itWithGit("honours a remote set not to follow tags", async () => {
		const fx = await fixture();
		git(fx.checkout, "config", "remote.origin.tagOpt", "--no-tags");
		git(fx.seed, "tag", "v1");
		git(fx.seed, "push", "-q", "origin", "v1");
		await advance(fx);

		await fetchRef(fx.checkout, "origin", "main", soon());

		expect(git(fx.checkout, "tag", "--list")).toBe("");
	});

	itWithGit("answers the tip again when nothing moved", async () => {
		const fx = await fixture();

		const result = await fetchRef(fx.checkout, "origin", "main", soon());

		expect(result).toEqual({ kind: "fetched", tip: fx.first });
	});

	itWithGit(
		"says missing-ref for a branch the remote does not have",
		async () => {
			const fx = await fixture();

			const result = await fetchRef(
				fx.checkout,
				"origin",
				"nope",
				soon(),
			);

			expect(result).toEqual({ kind: "failed", reason: "missing-ref" });
		},
	);

	itWithGit(
		"refuses, as diverged, a branch whose upstream was rewritten, and moves nothing",
		async () => {
			const fx = await fixture();
			await advance(fx);
			await fetchRef(fx.checkout, "origin", "main", soon());
			const before = git(
				fx.checkout,
				"rev-parse",
				"refs/remotes/origin/main",
			);
			// The remote's `main` is moved to a commit that is not a
			// descendant of what the checkout fetched, as a rewrite would.
			git(fx.seed, "checkout", "-q", "-b", "alt", fx.first);
			const rewritten = await commit(fx.seed, "OTHER.md", "rewritten\n");
			git(fx.seed, "push", "-q", "origin", "alt");
			git(fx.bare, "update-ref", "refs/heads/main", rewritten);

			const result = await fetchRef(
				fx.checkout,
				"origin",
				"main",
				soon(),
			);

			expect(result).toEqual({ kind: "failed", reason: "diverged" });
			expect(
				git(fx.checkout, "rev-parse", "refs/remotes/origin/main"),
			).toBe(before);
			expect(before).not.toBe(rewritten);
		},
	);

	itWithGit(
		"answers timed-out, without running git, when the deadline is gone",
		async () => {
			const fx = await fixture();

			const result = await fetchRef(
				fx.checkout,
				"origin",
				"main",
				Date.now() - 1,
			);

			expect(result).toEqual({ kind: "timed-out" });
		},
	);

	itWithGit.each([
		["a remote that reads as an option", "-oProxyCommand=x", "main"],
		["a remote with a space", "my remote", "main"],
		["a branch that reads as an option", "origin", "-main"],
		["a branch with a revision spelling", "origin", "main@{1}"],
		["a branch with a space", "origin", "ma in"],
	])("passes nothing to git for %s", async (_label, remote, ref) => {
		const fx = await fixture();

		const result = await fetchRef(fx.checkout, remote, ref, soon());

		expect(result).toEqual({
			kind: "unavailable",
			reason: "not a branch this will fetch",
		});
	});
});

describe("fastForwardTo, with real git", () => {
	itWithGit(
		"moves a clean checkout to the commit and answers it",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await fetchRef(fx.checkout, "origin", "main", soon());

			const result = await fastForwardTo(fx.checkout, tip, soon());

			expect(result).toEqual({ kind: "merged", head: tip });
			expect(git(fx.checkout, "rev-parse", "HEAD")).toBe(tip);
		},
	);

	itWithGit(
		"refuses, as diverged, a commit that does not descend from HEAD",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await fetchRef(fx.checkout, "origin", "main", soon());
			const local = await commit(fx.checkout, "LOCAL.md", "mine\n");

			const result = await fastForwardTo(fx.checkout, tip, soon());

			expect(result).toEqual({ kind: "failed", reason: "diverged" });
			expect(git(fx.checkout, "rev-parse", "HEAD")).toBe(local);
		},
	);

	itWithGit(
		"leaves a local edit that the move would overwrite, and fails",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await fetchRef(fx.checkout, "origin", "main", soon());
			await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");

			const result = await fastForwardTo(fx.checkout, tip, soon());

			expect(result.kind).toBe("failed");
			expect(git(fx.checkout, "rev-parse", "HEAD")).toBe(fx.first);
		},
	);

	itWithGit.each([
		["a short name", "abc1234"],
		["a branch name", "main"],
		["an option", "--abort"],
		["upper case", "A".repeat(40)],
	])("passes nothing to git for %s", async (_label, sha) => {
		const fx = await fixture();

		const result = await fastForwardTo(fx.checkout, sha, soon());

		expect(result).toEqual({
			kind: "unavailable",
			reason: "not a commit name",
		});
	});

	itWithGit("answers timed-out when the deadline is gone", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await fetchRef(fx.checkout, "origin", "main", soon());

		const result = await fastForwardTo(fx.checkout, tip, Date.now() - 1);

		expect(result).toEqual({ kind: "timed-out" });
		expect(git(fx.checkout, "rev-parse", "HEAD")).toBe(fx.first);
	});
});

describe("upstreamOf, with real git", () => {
	itWithGit(
		"is the remote-tracking branch a clone's branch follows",
		async () => {
			const fx = await fixture();

			const result = await upstreamOf(fx.checkout, "main", soon());

			expect(result).toEqual({ kind: "ok", value: "origin/main" });
		},
	);

	itWithGit("is null for a branch that follows nothing", async () => {
		const fx = await fixture();
		git(fx.checkout, "branch", "scratch");

		const result = await upstreamOf(fx.checkout, "scratch", soon());

		expect(result).toEqual({ kind: "ok", value: null });
	});

	itWithGit(
		"is null for a name that is not a plain branch literal",
		async () => {
			const fx = await fixture();

			const result = await upstreamOf(
				fx.checkout,
				"main@{upstream}",
				soon(),
			);

			expect(result).toEqual({ kind: "ok", value: null });
		},
	);
});

describe("lockFilesPresent, with real git", () => {
	itWithGit("is false in a quiet checkout", async () => {
		const fx = await fixture();

		const result = await lockFilesPresent(fx.checkout, soon());

		expect(result).toEqual({ kind: "ok", value: false });
	});

	itWithGit.each([["index.lock"], ["HEAD.lock"]])(
		"is true while %s exists",
		async (name) => {
			const fx = await fixture();
			await writeFile(path.join(fx.checkout, ".git", name), "");

			const result = await lockFilesPresent(fx.checkout, soon());

			expect(result).toEqual({ kind: "ok", value: true });
		},
	);

	itWithGit(
		"looks at a linked worktree's own lock, not the main checkout's",
		async () => {
			const fx = await fixture();
			const linked = path.join(fx.base, "linked");
			git(fx.checkout, "worktree", "add", "-q", "-b", "other", linked);
			const linkedGitDir = git(linked, "rev-parse", "--git-dir");
			await writeFile(
				path.resolve(
					await realpath(linked),
					linkedGitDir,
					"index.lock",
				),
				"",
			);

			const inLinked = await lockFilesPresent(linked, soon());
			const inMain = await lockFilesPresent(fx.checkout, soon());

			expect(inLinked).toEqual({ kind: "ok", value: true });
			expect(inMain).toEqual({ kind: "ok", value: false });
		},
	);
});

describe("worktreesOnBranch and commonDir, with real git", () => {
	itWithGit("names the work trees that hold a branch", async () => {
		const fx = await fixture();
		const linked = path.join(fx.base, "linked");
		git(fx.checkout, "worktree", "add", "-q", "-b", "other", linked);

		const onMain = await worktreesOnBranch(fx.checkout, "main", soon());
		const onOther = await worktreesOnBranch(fx.checkout, "other", soon());
		const onNone = await worktreesOnBranch(fx.checkout, "release", soon());

		expect(onMain.kind === "ok" && onMain.value.map(normal)).toEqual([
			normal(fx.checkout),
		]);
		expect(onOther.kind === "ok" && onOther.value.map(normal)).toEqual([
			normal(linked),
		]);
		expect(onNone).toEqual({ kind: "ok", value: [] });
	});

	itWithGit(
		"is the main checkout's .git from a linked worktree too",
		async () => {
			const fx = await fixture();
			const linked = path.join(fx.base, "linked");
			git(fx.checkout, "worktree", "add", "-q", "-b", "other", linked);

			const fromMain = await commonDir(fx.checkout, soon());
			const fromLinked = await commonDir(linked, soon());

			const expected = normal(path.join(fx.checkout, ".git"));
			expect(fromMain.kind === "ok" && normal(fromMain.value)).toBe(
				expected,
			);
			expect(fromLinked.kind === "ok" && normal(fromLinked.value)).toBe(
				expected,
			);
		},
	);
});

describe("headSha after a fast-forward, with real git", () => {
	itWithGit("is the commit the merge named", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await fetchRef(fx.checkout, "origin", "main", soon());
		await fastForwardTo(fx.checkout, tip, soon());

		const head = await headSha(fx.checkout, soon());

		expect(head).toEqual({ kind: "ok", value: tip });
	});
});

function normal(file: string): string {
	return path.resolve(file).replace(/\\/g, "/").toLowerCase();
}

describe("how git's refusals are read", () => {
	it.each([
		[
			" ! d0d7e92..a1b2c3d  main -> origin/main  (non-fast-forward)",
			"diverged",
		],
		["error: cannot fast-forward", "diverged"],
		["fatal: couldn't find remote ref refs/heads/nope", "missing-ref"],
		[
			"fatal: could not read Username for 'https://example.com': terminal prompts disabled",
			"auth",
		],
		["remote: Permission denied (publickey).", "auth"],
		[
			"fatal: unable to access 'https://example.com/r/': The requested URL returned error: 403",
			"auth",
		],
		[
			"fatal: unable to access 'https://example.com/r/': Operation timed out after 30001 milliseconds",
			"timeout",
		],
		[
			"fatal: unable to access 'https://example.com/r/': Could not resolve host: example.com",
			"network",
		],
		[
			"fatal: unable to access 'https://example.com/r/': Failed to connect to example.com port 443",
			"network",
		],
		["something git said that no shape here knows", "other"],
		["", "other"],
	] as const)("a fetch that says %j is %s", (stderr, expected) => {
		expect(fetchFailureOf(stderr)).toBe(expected);
	});

	it.each([
		["fatal: Not possible to fast-forward, aborting.", "diverged"],
		["fatal: refusing to merge unrelated histories", "diverged"],
		["fatal: Unable to create '/r/.git/index.lock': File exists.", "busy"],
		[
			"error: Your local changes to the following files would be overwritten by merge:",
			"local-changes",
		],
		[
			"error: The following untracked working tree files would be overwritten by merge:",
			"local-changes",
		],
		["", "other"],
	] as const)("a merge that says %j is %s", (stderr, expected) => {
		expect(mergeFailureOf(stderr)).toBe(expected);
	});
});

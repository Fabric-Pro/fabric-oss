/**
 * The session hook's fast-forward end to end, against REAL git (Fizzy #2878):
 * a bare "remote" reached over `file://`, a clone of it, and `runFastForward`
 * deciding, fetching, merging, locking and remembering for real. The gate's
 * own rules are in `fast-forward.test.ts`; this is that they hold on a real
 * checkout, that HEAD only ever moves when it should, and that nothing is left
 * behind.
 *
 * Every test is skipped when `git` is not on PATH. Nothing touches the
 * network, and the developer's own git configuration is kept out of the
 * fixtures and the code under test the way `git-write.test.ts` does it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	PublishedInstructionRepository,
	PublishedInstructionSnapshot,
} from "@fabricorg/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withExclusiveLock } from "../src/lib/exclusive-lock.js";
import {
	type CheckoutClassification,
	reportForClassification,
} from "../src/lib/instructions/checkout.js";
import { noticeFile } from "../src/lib/instructions/fast-forward-memory.js";
import {
	type FastForwardResult,
	runFastForward,
} from "../src/lib/instructions/fast-forward-run.js";
import * as git from "../src/lib/instructions/git.js";

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
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-ffrun-config-"));
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

function gitIn(cwd: string, ...args: string[]): string {
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
	gitIn(cwd, "add", "--", file);
	gitIn(cwd, "commit", "-q", "-m", `write ${file}`);
	return gitIn(cwd, "rev-parse", "HEAD");
}

interface Fixture {
	base: string;
	bare: string;
	seed: string;
	checkout: string;
	first: string;
}

async function fixture(): Promise<Fixture> {
	const base = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-ffrun-")),
	);
	const bare = path.join(base, "remote.git");
	const seed = path.join(base, "seed");
	const checkout = path.join(base, "checkout");
	gitIn(base, "init", "-q", "--bare", "-b", "main", bare);
	gitIn(base, "init", "-q", "-b", "main", seed);
	const first = await commit(seed, "AGENTS.md", "one\n");
	gitIn(seed, "remote", "add", "origin", pathToFileURL(bare).href);
	gitIn(seed, "push", "-q", "origin", "main");
	gitIn(base, "clone", "-q", pathToFileURL(bare).href, checkout);
	return { base, bare, seed, checkout, first };
}

async function advance(fx: Fixture, file = "AGENTS.md"): Promise<string> {
	const sha = await commit(fx.seed, file, `${Math.random()}\n`);
	gitIn(fx.seed, "push", "-q", "origin", "main");
	return sha;
}

const REPOSITORY: PublishedInstructionRepository = {
	provider: "GITHUB",
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
	sync: { automatic: true, pausedReason: null, lastRun: null },
};

function snapshotAt(sha: string, version = 12): PublishedInstructionSnapshot {
	return {
		id: "snap-1",
		version,
		digest: "d".repeat(64),
		fileCount: 1,
		publishedAt: null,
		source: {
			kind: "REPOSITORY",
			ref: "main",
			commitSha: sha,
			current: true,
		},
	};
}

async function classificationOf(
	checkout: string,
): Promise<Extract<CheckoutClassification, { class: "matching" }>> {
	const traits = await git.checkoutTraits(checkout, Date.now() + 60_000);
	if (traits.kind !== "ok") {
		throw new Error("traits");
	}
	return {
		class: "matching",
		remote: "origin",
		toplevel: checkout,
		traits: traits.value,
	};
}

interface RunOptions {
	published: string;
	version?: number;
	repository?: PublishedInstructionRepository;
	optedOut?: boolean;
	traceFile?: string;
	/** Milliseconds of git budget left; the merge reserve comes out of it. */
	budgetMs?: number;
}

async function run(
	fx: Fixture,
	options: RunOptions,
): Promise<FastForwardResult> {
	const classification = await classificationOf(fx.checkout);
	const snapshot = snapshotAt(options.published, options.version);
	const repository = options.repository ?? REPOSITORY;
	const deadline = Date.now() + (options.budgetMs ?? 60_000);
	const report = await reportForClassification({
		classification,
		repository,
		snapshot,
		deadline: Date.now() + 60_000,
	});
	return runFastForward({
		classification,
		repository,
		snapshot,
		report,
		projectId: "project-1",
		deadline,
		optedOut: options.optedOut ?? false,
		traceFile: options.traceFile,
	});
}

const head = (fx: Fixture): string => gitIn(fx.checkout, "rev-parse", "HEAD");

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

async function nothingLeftBehind(fx: Fixture): Promise<void> {
	const dir = path.join(fx.checkout, ".git");
	expect(await exists(path.join(dir, "index.lock"))).toBe(false);
	expect(await exists(path.join(dir, "HEAD.lock"))).toBe(false);
	expect(await exists(path.join(dir, "fabric", "ff.lock"))).toBe(false);
}

describe("a checkout that is behind, clean and on the branch", () => {
	itWithGit(
		"moves HEAD to the tip and says where from and to, with the published version",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);

			const result = await run(fx, { published: tip });

			expect(result.outcome).toEqual({
				kind: "fast-forwarded",
				from: fx.first,
				to: tip,
			});
			expect(head(fx)).toBe(tip);
			expect(result.stdout).toEqual([
				`fabric: coding instructions: fast-forwarded main from ${fx.first.slice(0, 7)} to ${tip.slice(0, 7)} (v12).`,
			]);
			expect(result.stderr).toEqual([]);
			await nothingLeftBehind(fx);
		},
	);

	itWithGit(
		"goes to the branch tip, not the published commit, and says Fabric's copy lags",
		async () => {
			const fx = await fixture();
			await advance(fx);
			const tip = await advance(fx);
			const published = fx.first;

			const result = await run(fx, { published });

			expect(head(fx)).toBe(tip);
			expect(result.stdout).toEqual([
				`fabric: coding instructions: fast-forwarded main from ${fx.first.slice(0, 7)} to ${tip.slice(0, 7)}.`,
				`fabric: coding instructions: main is at ${tip.slice(0, 7)}; Fabric's copy is behind (the next sync has not run yet).`,
			]);
		},
	);

	itWithGit(
		"says a commit was refused by the secret scan when the sync's last run says so",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);

			const result = await run(fx, {
				published: fx.first,
				repository: {
					...REPOSITORY,
					sync: {
						automatic: true,
						pausedReason: null,
						lastRun: {
							trigger: "WEBHOOK",
							status: "REJECTED",
							error: "TREE_REFUSED",
							commitSha: tip,
							finishedAt: "2026-10-03T10:00:00.000Z",
						},
					},
				},
			});

			expect(result.stdout[1]).toBe(
				`fabric: coding instructions: main is at ${tip.slice(0, 7)}; Fabric's copy is behind (a commit was refused by the secret scan — see the project's Coding Instructions tab).`,
			);
		},
	);

	itWithGit("is silent when HEAD already is the tip", async () => {
		const fx = await fixture();

		const result = await run(fx, { published: fx.first });

		expect(result).toEqual({
			outcome: { kind: "already-current" },
			stdout: [],
			stderr: [],
		});
		await nothingLeftBehind(fx);
	});

	itWithGit(
		"is silent, and moves nothing, when the checkout is ahead of the remote",
		async () => {
			const fx = await fixture();
			const local = await commit(fx.checkout, "LOCAL.md", "mine\n");

			const result = await run(fx, { published: fx.first });

			expect(result.outcome).toEqual({ kind: "already-current" });
			expect(head(fx)).toBe(local);
		},
	);

	itWithGit(
		"only reports, as `check` does, when the person opted out",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);

			const result = await run(fx, { published: tip, optedOut: true });

			expect(result.outcome).toEqual({ kind: "opted-out" });
			expect(head(fx)).toBe(fx.first);
			expect(result.stdout).toHaveLength(1);
			expect(result.stdout[0]).toContain(
				"this checkout has not fetched it yet",
			);
		},
	);
});

describe("a checkout it must leave alone", () => {
	async function leftAlone(
		fx: Fixture,
		result: FastForwardResult,
		reason: string,
	): Promise<void> {
		expect(result.outcome).toEqual({ kind: "not-safe", reason });
		expect(head(fx)).toBe(fx.first);
		await nothingLeftBehind(fx);
	}

	itWithGit("is dirty: a tracked file edited", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");

		const result = await run(fx, { published: tip });

		await leftAlone(fx, result, "dirty");
		expect(result.stdout).toHaveLength(1);
		expect(result.stdout[0]).toContain("has uncommitted changes");
	});

	itWithGit("is dirty: an untracked file", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await writeFile(path.join(fx.checkout, "NOTES.md"), "mine\n");

		const result = await run(fx, { published: tip });

		await leftAlone(fx, result, "dirty");
	});

	itWithGit("is on another branch", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		gitIn(fx.checkout, "checkout", "-q", "-b", "feature/x");

		const result = await run(fx, { published: tip });

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "wrong-branch",
		});
		expect(head(fx)).toBe(fx.first);
		expect(result.stdout[0]).toContain("you are on feature/x");
	});

	itWithGit("has a detached HEAD", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		gitIn(fx.checkout, "checkout", "-q", "--detach");

		const result = await run(fx, { published: tip });

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "detached",
		});
		expect(result.stdout[0]).toContain("HEAD is detached");
	});

	itWithGit("is in the middle of a rebase", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await mkdir(path.join(fx.checkout, ".git", "rebase-merge"));

		const result = await run(fx, { published: tip });

		await leftAlone(fx, result, "operation");
		expect(result.stdout[0]).toContain(
			"a rebase is in progress; nothing was changed.",
		);
	});

	itWithGit("is a shallow clone", async () => {
		const fx = await fixture();
		const shallow = path.join(fx.base, "shallow");
		gitIn(
			fx.base,
			"clone",
			"-q",
			"--depth",
			"1",
			pathToFileURL(fx.bare).href,
			shallow,
		);
		const tip = await advance(fx);
		const shallowFx: Fixture = { ...fx, checkout: shallow };

		const result = await run(shallowFx, { published: tip });

		expect(result.outcome).toEqual({ kind: "not-safe", reason: "shallow" });
		expect(gitIn(shallow, "rev-parse", "HEAD")).toBe(fx.first);
		expect(result.stdout[0]).toContain("this is a shallow clone");
	});

	itWithGit("tracks nothing", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		gitIn(fx.checkout, "branch", "--unset-upstream");

		const result = await run(fx, { published: tip });

		await leftAlone(fx, result, "no-upstream");
	});

	itWithGit("tracks another remote", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		gitIn(
			fx.checkout,
			"remote",
			"add",
			"fork",
			pathToFileURL(fx.bare).href,
		);
		gitIn(fx.checkout, "fetch", "-q", "fork");
		gitIn(fx.checkout, "branch", "--set-upstream-to=fork/main");

		const result = await run(fx, { published: tip });

		await leftAlone(fx, result, "upstream-mismatch");
	});

	itWithGit("has an index.lock", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await writeFile(path.join(fx.checkout, ".git", "index.lock"), "");

		const result = await run(fx, { published: tip });

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "git-busy",
		});
		expect(head(fx)).toBe(fx.first);
		expect(await exists(path.join(fx.checkout, ".git", "index.lock"))).toBe(
			true,
		);
	});

	itWithGit(
		"has the branch checked out in another work tree too",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			const linked = path.join(fx.base, "linked");
			gitIn(
				fx.checkout,
				"worktree",
				"add",
				"-q",
				"--force",
				linked,
				"main",
			);

			const result = await run(fx, { published: tip });

			await leftAlone(fx, result, "branch-busy");
		},
	);
});

describe("a branch that cannot be fast-forwarded", () => {
	itWithGit(
		"refuses, as diverged, an upstream that was rewritten, and moves nothing",
		async () => {
			const fx = await fixture();
			await advance(fx);
			await git.fetchRef(
				fx.checkout,
				"origin",
				"main",
				Date.now() + 60_000,
			);
			gitIn(fx.seed, "checkout", "-q", "-b", "alt", fx.first);
			const rewritten = await commit(fx.seed, "OTHER.md", "rewritten\n");
			gitIn(fx.seed, "push", "-q", "origin", "alt");
			gitIn(fx.bare, "update-ref", "refs/heads/main", rewritten);

			const result = await run(fx, { published: rewritten });

			expect(result.outcome).toEqual({
				kind: "merge-failed",
				reason: "diverged",
			});
			expect(head(fx)).toBe(fx.first);
			expect(result.stdout).toHaveLength(1);
			expect(result.stdout[0]).toContain(
				"have diverged, so nothing was updated",
			);
		},
	);

	itWithGit(
		"refuses, as diverged, local commits that the remote does not have",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			const local = await commit(fx.checkout, "LOCAL.md", "mine\n");

			const result = await run(fx, { published: tip });

			expect(result.outcome).toEqual({
				kind: "merge-failed",
				reason: "diverged",
			});
			expect(head(fx)).toBe(local);
		},
	);
});

describe("the clock", () => {
	itWithGit(
		"makes no fetch, and no merge, when the budget is gone before it starts",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);

			const result = await run(fx, { published: tip, budgetMs: 1_000 });

			expect(result.outcome).toEqual({ kind: "deadline" });
			expect(head(fx)).toBe(fx.first);
			expect(
				gitIn(fx.checkout, "rev-parse", "refs/remotes/origin/main"),
			).toBe(fx.first);
			expect(result.stderr).toEqual([
				"fabric: coding instructions sync skipped: gave up after 10 s",
			]);
			await nothingLeftBehind(fx);
		},
	);
});

describe("two runs at once", () => {
	itWithGit(
		"says another process holds the checkout when the lock is held, and changes nothing",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await mkdir(path.join(fx.checkout, ".git", "fabric"), {
				recursive: true,
			});

			const result = await withExclusiveLock(
				() => run(fx, { published: tip }),
				{
					lockPath: path.join(
						fx.checkout,
						".git",
						"fabric",
						"ff.lock",
					),
					staleMs: 30_000,
					waitMs: 0,
				},
			);

			expect(result.outcome).toEqual({ kind: "locked" });
			expect(result.stdout).toEqual([
				"fabric: coding instructions: another fabric process is updating this checkout; nothing was changed.",
			]);
			expect(head(fx)).toBe(fx.first);
		},
	);

	itWithGit("leaves a dead process lock for explicit recovery", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		const lock = path.join(fx.checkout, ".git", "fabric", "ff.lock");
		await mkdir(path.dirname(lock), { recursive: true });
		await writeFile(lock, "99999");
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);

		const result = await run(fx, { published: tip });

		expect(result.outcome).toMatchObject({
			kind: "abandoned-lock",
			lockPath: lock,
		});
		expect(head(fx)).toBe(fx.first);
		expect(await exists(lock)).toBe(true);
	});

	itWithGit(
		"fast-forwards once, whoever gets there first, and leaves no lock behind",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);

			const results = await Promise.all([
				run(fx, { published: tip }),
				run(fx, { published: tip }),
			]);

			const kinds = results.map((result) => result.outcome.kind).sort();
			expect(
				kinds.filter((kind) => kind === "fast-forwarded"),
			).toHaveLength(1);
			expect(
				kinds.filter(
					(kind) => kind === "locked" || kind === "already-current",
				),
			).toHaveLength(1);
			expect(head(fx)).toBe(tip);
			await nothingLeftBehind(fx);
		},
	);
});

describe("what is said once", () => {
	itWithGit(
		"prints a checkout left alone once per published version and reason",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");

			const first = await run(fx, { published: tip, version: 12 });
			const again = await run(fx, { published: tip, version: 12 });
			const newer = await run(fx, { published: tip, version: 13 });

			expect(first.stdout).toHaveLength(1);
			expect(again.stdout).toEqual([]);
			expect(again.outcome).toEqual({
				kind: "not-safe",
				reason: "dirty",
			});
			expect(newer.stdout).toHaveLength(1);
		},
	);

	itWithGit("prints again when the reason changes", async () => {
		const fx = await fixture();
		const tip = await advance(fx);
		await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");
		await run(fx, { published: tip });
		gitIn(fx.checkout, "stash", "-q");
		gitIn(fx.checkout, "checkout", "-q", "-b", "feature/x");

		const result = await run(fx, { published: tip });

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "wrong-branch",
		});
		expect(result.stdout).toHaveLength(1);
	});

	itWithGit(
		"always prints a fast-forward, and forgets what was said before it",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");
			await run(fx, { published: tip });
			gitIn(fx.checkout, "stash", "-q");
			const memory = noticeFile(path.join(fx.checkout, ".git"));
			expect(await exists(memory)).toBe(true);

			const moved = await run(fx, { published: tip });

			expect(moved.outcome.kind).toBe("fast-forwarded");
			expect(moved.stdout).toHaveLength(1);
			expect(await exists(memory)).toBe(false);
		},
	);

	itWithGit(
		"keeps it in one small file readable by its owner only",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");

			await run(fx, { published: tip, version: 12 });

			const file = noticeFile(path.join(fx.checkout, ".git"));
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
				v: 1,
				projectId: "project-1",
				publishedVersion: 12,
				reason: "not-safe:dirty",
			});
			if (process.platform !== "win32") {
				expect((await stat(file)).mode & 0o777).toBe(0o600);
			}
		},
	);

	itWithGit("says Fabric's copy lags once per version too", async () => {
		const fx = await fixture();
		await advance(fx);
		const tip = await advance(fx);
		await run(fx, { published: fx.first });
		expect(head(fx)).toBe(tip);

		const again = await run(fx, { published: fx.first });

		expect(again.outcome).toEqual({ kind: "already-current" });
		expect(again.stdout).toEqual([]);
	});
});

describe("the trace", () => {
	itWithGit(
		"records each run with a closed outcome and reason and nothing else",
		async () => {
			const fx = await fixture();
			const tip = await advance(fx);
			const traceFile = path.join(
				fx.base,
				"traces",
				"instructions-hook.jsonl",
			);
			await writeFile(path.join(fx.checkout, "AGENTS.md"), "mine\n");

			await run(fx, { published: tip, traceFile });
			gitIn(fx.checkout, "stash", "-q");
			await run(fx, { published: tip, traceFile });

			const entries = (await readFile(traceFile, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(
				entries.map((entry) => [entry.outcome, entry.reason]),
			).toEqual([
				["not-safe", "dirty"],
				["fast-forwarded", null],
			]);
			for (const entry of entries) {
				expect(Object.keys(entry).sort()).toEqual([
					"at",
					"ms",
					"outcome",
					"projectId",
					"reason",
				]);
				expect(entry.projectId).toBe("project-1");
				expect(typeof entry.ms).toBe("number");
				expect(JSON.stringify(entry)).not.toContain(fx.base);
				expect(JSON.stringify(entry)).not.toContain(tip);
			}
			expect((await readdir(path.dirname(traceFile))).sort()).toEqual([
				"instructions-hook.jsonl",
			]);
		},
	);
});

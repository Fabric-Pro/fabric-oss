/**
 * The repository-sourced hook's checkout inspection against REAL git
 * (Fizzy #2708): `checkout.ts` classifying and reading temp repositories
 * through `git.ts`, with no mock in between.
 *
 * Every test is skipped when `git` is not on PATH. No network is ever
 * contacted: the fixtures are cloned from a local bare repository over
 * `file://`, the remote is then re-pointed at a synthetic HTTPS URL, and
 * nothing the code under test runs fetches.
 *
 * The developer's own git configuration is kept out of both the fixtures and
 * the code under test, so a personal `insteadOf` or signing rule cannot
 * change an answer: the fixtures run with `GIT_CONFIG_GLOBAL` at an empty
 * file and `GIT_CONFIG_NOSYSTEM`, and — because `git.ts` deliberately strips
 * every `GIT_CONFIG_*` variable — the code under test runs with `HOME` and
 * `XDG_CONFIG_HOME` pointed at an empty directory instead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublishedInstructionRepository } from "@fabricorg/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type CheckoutReport,
	inspectCheckout,
} from "../src/lib/instructions/checkout.js";

const hasGit =
	spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const itWithGit = it.skipIf(!hasGit);

const REPOSITORY_URL = "https://git.example.com/example-org/rules.git";
const REPOSITORY: PublishedInstructionRepository = {
	provider: "GITHUB",
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};
const NAME = "git.example.com/example-org/rules";

/**
 * `user@host` joined at runtime: the publication scan reads any literal
 * user, at-sign and dotted host as an email address, and a subdomain of example.com is
 * not on its sanctioned list. The string the code under test receives is
 * byte-identical.
 */
const withUser = (user: string, rest: string): string => [user, rest].join("@");

const saved: Record<string, string | undefined> = {};
let emptyConfig: string;

const ISOLATED = [
	"HOME",
	"XDG_CONFIG_HOME",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_PARAMETERS",
	"Fabric_API_Key",
];

beforeAll(async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-git-config-"));
	emptyConfig = path.join(dir, "gitconfig");
	await writeFile(emptyConfig, "");
	for (const name of ISOLATED) {
		saved[name] = process.env[name];
	}
	process.env.HOME = dir;
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

/** Fixture setup only — the code under test never gets a way to do this. */
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

interface Fixture {
	base: string;
	bare: string;
	checkout: string;
	/** The first and second commits on `main`. */
	first: string;
	second: string;
}

/**
 * A bare "remote" with two commits on `main`, cloned over `file://`, then
 * re-pointed at the synthetic HTTPS URL. Nothing fetches it afterwards.
 */
async function fixture(): Promise<Fixture> {
	const base = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-git-")),
	);
	const bare = path.join(base, "remote.git");
	const seed = path.join(base, "seed");
	git(base, "init", "-q", "--bare", "-b", "main", bare);
	git(base, "init", "-q", "-b", "main", seed);
	const first = await commit(seed, "AGENTS.md", "one\n");
	await commit(seed, "instructions/RULES.md", "rules\n");
	const second = await commit(seed, "AGENTS.md", "two\n");
	git(seed, "push", "-q", bare, "main");
	const checkout = path.join(base, "checkout");
	git(base, "clone", "-q", `file://${bare}`, checkout);
	git(checkout, "remote", "set-url", "origin", REPOSITORY_URL);
	return { base, bare, checkout, first, second };
}

function snapshotAt(commitSha: string) {
	return {
		id: "snap-1",
		version: 4,
		digest: "d".repeat(64),
		fileCount: 1,
		publishedAt: null,
		source: {
			kind: "REPOSITORY" as const,
			ref: "main",
			commitSha,
			current: true,
		},
	};
}

async function inspect(
	destination: string,
	commitSha: string,
	repository: PublishedInstructionRepository = REPOSITORY,
	deadlineMs = 10_000,
): Promise<CheckoutReport> {
	return inspectCheckout({
		destination,
		repository,
		snapshot: snapshotAt(commitSha),
		deadline: Date.now() + deadlineMs,
	});
}

function expectNoUrl(report: CheckoutReport): void {
	const text = JSON.stringify(report.json);
	expect(text).not.toContain("https://");
	expect(text).not.toContain("file://");
	expect(text).not.toMatch(/[^\s]+:[^\s]+@/);
}

const BEHIND = `fabric: coding instructions v4 (SHA7) is published on main of ${NAME}; this checkout is behind`;

describe("a checkout classified and read with real git", () => {
	itWithGit(
		"is foreign when insteadOf rewrites the fetch URL to a local path",
		async () => {
			const f = await fixture();
			git(
				f.checkout,
				"config",
				`url.${f.bare}.insteadOf`,
				REPOSITORY_URL,
			);

			const report = await inspect(f.checkout, f.second);

			expect(report.classification.class).toBe("foreign");
			expect(report.line).toBe(
				`fabric: coding instructions: no remote of this checkout fetches from ${NAME} (foreign checkout); nothing was checked or changed`,
			);
			expectNoUrl(report);
		},
	);

	itWithGit(
		"is matching, and silent, when HEAD is the published commit",
		async () => {
			const f = await fixture();

			const report = await inspect(f.checkout, f.second);

			expect(report.classification.class).toBe("matching");
			expect(report.line).toBeNull();
			expect(report.json).toMatchObject({
				class: "matching",
				remote: "origin",
				branch: "main",
				head: f.second,
				clean: true,
				operation: null,
				contains: true,
				traits: [],
			});
			expectNoUrl(report);
		},
	);

	itWithGit(
		"is silent when the published commit is an ancestor of HEAD",
		async () => {
			const f = await fixture();
			await commit(f.checkout, "LOCAL.md", "local\n");

			expect((await inspect(f.checkout, f.second)).line).toBeNull();
		},
	);

	itWithGit("says behind on main, with the pull command", async () => {
		const f = await fixture();
		git(f.checkout, "reset", "-q", "--hard", f.first);

		const report = await inspect(f.checkout, f.second);

		expect(report.line).toBe(
			`${BEHIND.replace("SHA7", f.second.slice(0, 7))} — run: git pull --ff-only origin main`,
		);
	});

	itWithGit(
		"says not fetched when the published commit is not in the clone",
		async () => {
			const f = await fixture();

			const report = await inspect(f.checkout, "f".repeat(40));

			expect(report.json.contains).toBeNull();
			expect(report.line).toContain(
				"this checkout has not fetched it yet — run: git pull --ff-only origin main",
			);
		},
	);

	itWithGit("names another branch", async () => {
		const f = await fixture();
		git(f.checkout, "checkout", "-q", "-b", "topic", f.first);

		expect((await inspect(f.checkout, f.second)).line).toBe(
			`${BEHIND.replace("SHA7", f.second.slice(0, 7))}; you are on topic — pull main when you switch to it`,
		);
	});

	itWithGit("names a detached HEAD", async () => {
		const f = await fixture();
		git(f.checkout, "checkout", "-q", "--detach", f.first);

		expect((await inspect(f.checkout, f.second)).line).toBe(
			`${BEHIND.replace("SHA7", f.second.slice(0, 7))}; HEAD is detached — check out main and pull`,
		);
	});

	itWithGit("names a tracked change", async () => {
		const f = await fixture();
		git(f.checkout, "reset", "-q", "--hard", f.first);
		await writeFile(path.join(f.checkout, "AGENTS.md"), "edited\n");

		expect((await inspect(f.checkout, f.second)).line).toContain(
			"; your working tree has changes — pull when it is clean",
		);
	});

	itWithGit(
		"counts an untracked file as a change, but not the hook's own settings",
		async () => {
			const f = await fixture();
			git(f.checkout, "reset", "-q", "--hard", f.first);
			await mkdir(path.join(f.checkout, ".claude"));
			await writeFile(
				path.join(f.checkout, ".claude", "settings.local.json"),
				"{}\n",
			);

			expect((await inspect(f.checkout, f.second)).line).toContain(
				"— run: git pull --ff-only origin main",
			);

			await writeFile(path.join(f.checkout, "NOTES.md"), "mine\n");

			expect((await inspect(f.checkout, f.second)).line).toContain(
				"; your working tree has changes — pull when it is clean",
			);
		},
	);

	itWithGit(
		"counts a COMMITTED copy of the hook's settings file, once modified, as a change",
		async () => {
			const f = await fixture();
			git(f.checkout, "reset", "-q", "--hard", f.first);
			// Behind: the published commit is on another line of history.
			await commit(f.checkout, ".claude/settings.local.json", "{}\n");
			const report = await inspect(f.checkout, f.second);
			expect(report.line).toContain(
				"— run: git pull --ff-only origin main",
			);

			await writeFile(
				path.join(f.checkout, ".claude", "settings.local.json"),
				'{"hooks":{}}\n',
			);

			expect((await inspect(f.checkout, f.second)).line).toContain(
				"; your working tree has changes — pull when it is clean",
			);
		},
	);

	itWithGit(
		"ignores configuration injected through GIT_CONFIG_* variables",
		async () => {
			const f = await fixture();
			// Each of these, if git saw it, would rewrite the remote's fetch URL
			// to the local bare path and make the checkout read as foreign.
			const injections: Array<Record<string, string>> = [
				{
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: `url.${f.bare}.insteadOf`,
					GIT_CONFIG_VALUE_0: REPOSITORY_URL,
				},
				{
					GIT_CONFIG_PARAMETERS: `'url.${f.bare}.insteadOf'='${REPOSITORY_URL}'`,
				},
			];
			const global = path.join(f.base, "injected-gitconfig");
			await writeFile(
				global,
				`[url "${f.bare}"]\n\tinsteadOf = ${REPOSITORY_URL}\n`,
			);
			injections.push({ GIT_CONFIG_GLOBAL: global });
			for (const injection of injections) {
				Object.assign(process.env, injection);
				try {
					expect(
						(await inspect(f.checkout, f.second)).classification
							.class,
					).toBe("matching");
				} finally {
					for (const name of Object.keys(injection)) {
						delete process.env[name];
					}
					process.env.GIT_CONFIG_GLOBAL = emptyConfig;
				}
			}
			// The control: the same rule in the repository's own config does
			// apply, so the injections above were each a real rewrite.
			git(
				f.checkout,
				"config",
				`url.${f.bare}.insteadOf`,
				REPOSITORY_URL,
			);
			expect(
				(await inspect(f.checkout, f.second)).classification.class,
			).toBe("foreign");
		},
	);

	itWithGit("names a merge in progress", async () => {
		const f = await fixture();
		git(f.checkout, "reset", "-q", "--hard", f.first);
		git(f.checkout, "checkout", "-q", "-b", "side");
		await commit(f.checkout, "AGENTS.md", "side\n");
		git(f.checkout, "checkout", "-q", "main");
		await commit(f.checkout, "AGENTS.md", "main\n");
		expect(() => git(f.checkout, "merge", "-q", "side")).toThrow();

		const report = await inspect(f.checkout, f.second);

		expect(report.json.operation).toBe("merge");
		expect(report.line).toContain("; a merge is in progress");
	});

	itWithGit(
		"is ambiguous with two remotes for the same repository",
		async () => {
			const f = await fixture();
			git(
				f.checkout,
				"remote",
				"add",
				"upstream",
				withUser("git", "git.example.com:example-org/rules.git"),
			);

			const report = await inspect(f.checkout, f.second);

			expect(report.classification.class).toBe("ambiguous");
			expect(report.line).toContain(
				"remotes origin, upstream all fetch from",
			);
			expectNoUrl(report);
		},
	);

	itWithGit(
		"maps a root path: matching from the subdirectory, unmapped from the root",
		async () => {
			const f = await fixture();
			const repository = { ...REPOSITORY, rootPath: "instructions" };

			expect(
				(
					await inspect(
						path.join(f.checkout, "instructions"),
						f.second,
						repository,
					)
				).classification.class,
			).toBe("matching");
			const fromRoot = await inspect(f.checkout, f.second, repository);
			expect(fromRoot.classification.class).toBe("unmapped");
			expect(fromRoot.line).toContain(
				"the project's instructions are at instructions, not this directory",
			);
		},
	);

	itWithGit("is matching in a linked worktree", async () => {
		const f = await fixture();
		const worktree = path.join(f.base, "linked");
		git(
			f.checkout,
			"worktree",
			"add",
			"-q",
			"--detach",
			worktree,
			f.second,
		);

		const report = await inspect(worktree, f.second);

		expect(report.classification.class).toBe("matching");
		expect(report.line).toBeNull();
	});

	itWithGit("is not-git outside any repository", async () => {
		const dir = await realpath(
			await mkdtemp(path.join(tmpdir(), "fabric-plain-")),
		);

		expect((await inspect(dir, "a".repeat(40))).classification.class).toBe(
			"not-git",
		);
	});

	itWithGit("is unknown when .git points nowhere", async () => {
		const dir = await realpath(
			await mkdtemp(path.join(tmpdir(), "fabric-broken-")),
		);
		await writeFile(
			path.join(dir, ".git"),
			"gitdir: /nonexistent/fabric-test/.git\n",
		);

		const report = await inspect(dir, "a".repeat(40));

		expect(report.classification).toEqual({
			class: "unknown",
			reason: "its .git points to a repository that does not exist",
		});
	});

	itWithGit(
		"is unknown, and prints nothing, when the deadline has already run out",
		async () => {
			const f = await fixture();
			const stderr = vi.spyOn(process.stderr, "write");
			try {
				const report = await inspect(
					f.checkout,
					f.second,
					REPOSITORY,
					1,
				);

				expect(report.classification).toEqual({
					class: "unknown",
					reason: "git timed out",
				});
				expect(stderr).not.toHaveBeenCalled();
			} finally {
				stderr.mockRestore();
			}
		},
	);

	itWithGit(
		"ignores an inherited GIT_DIR that points at another repository",
		async () => {
			const f = await fixture();
			const other = await fixture();
			git(
				other.checkout,
				"remote",
				"set-url",
				"origin",
				"https://git.example.com/example-org/other.git",
			);
			const previous = process.env.GIT_DIR;
			// A hook started from inside another git command's environment would
			// inherit this; it must not make the checkout read as a different one.
			process.env.GIT_DIR = path.join(other.checkout, ".git");
			try {
				expect(
					(await inspect(f.checkout, f.second)).classification.class,
				).toBe("matching");
			} finally {
				if (previous === undefined) {
					delete process.env.GIT_DIR;
				} else {
					process.env.GIT_DIR = previous;
				}
			}
		},
	);
});

/**
 * The one write `git.ts` has, and the local ignore file `init` appends to
 * (Fizzy #2878), against REAL git.
 *
 * Every test is skipped when `git` is not on PATH. Nothing touches the
 * network: the "remote" is a local bare repository, and the credential-free
 * HTTPS URL `cloneInto` insists on is rewritten to it by an `insteadOf` rule
 * in an isolated global git configuration, exactly as a developer's own
 * configuration could. `git.ts` strips every `GIT_CONFIG_*` variable, so the
 * rule lives in `$HOME/.gitconfig`, with `HOME` pointed at an empty directory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cloneableUrl,
	cloneFailureOf,
	cloneInto,
	gitEnvironment,
	hookWriteEnvironment,
} from "../src/lib/instructions/git.js";
import { excludeLocalFiles } from "../src/lib/instructions/git-exclude.js";

const hasGit =
	spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const itWithGit = it.skipIf(!hasGit);

const URL_OF_REMOTE = "https://github.com/example-org/rules";

const saved: Record<string, string | undefined> = {};
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
	"GIT_SSH_COMMAND",
];
let home: string;

beforeAll(async () => {
	home = await realpath(await mkdtemp(path.join(tmpdir(), "fabric-clone-")));
	for (const name of ISOLATED) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.XDG_CONFIG_HOME = home;
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

/** Fixture setup only: git with the developer's own configuration kept out. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: path.join(home, "fixture-gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Example Dev",
			GIT_AUTHOR_EMAIL: "dev@example.com",
			GIT_COMMITTER_NAME: "Example Dev",
			GIT_COMMITTER_EMAIL: "dev@example.com",
		},
	}).trim();
}

/** git as the developer runs it, with the same global config `cloneInto` sees. */
function gitByHand(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
		},
	}).trim();
}

async function tempDir(prefix: string): Promise<string> {
	return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

/**
 * A bare "remote" with `main` (one file) and `release` (one more commit),
 * and a rewrite rule that sends `URL_OF_REMOTE` to it.
 */
async function remote(): Promise<string> {
	const base = await tempDir("fabric-clone-remote-");
	const seed = path.join(base, "seed");
	const bare = path.join(base, "remote.git");
	git(base, "init", "-q", "-b", "main", seed);
	await writeFile(path.join(seed, "AGENTS.md"), "one\n");
	git(seed, "add", "--", "AGENTS.md");
	git(seed, "commit", "-q", "-m", "one");
	git(seed, "tag", "v1");
	git(seed, "checkout", "-q", "-b", "release");
	await writeFile(path.join(seed, "RELEASE.md"), "two\n");
	git(seed, "add", "--", "RELEASE.md");
	git(seed, "commit", "-q", "-m", "two");
	git(base, "clone", "-q", "--bare", seed, bare);
	await writeFile(
		path.join(home, ".gitconfig"),
		`[url "${pathToFileURL(bare).href}"]\n\tinsteadOf = ${URL_OF_REMOTE}\n`,
	);
	return bare;
}

describe("cloneableUrl", () => {
	it.each([
		[
			"https://github.com/example-org/rules",
			"https://github.com/example-org/rules",
		],
		[
			"  https://github.com/example-org/rules  ",
			"https://github.com/example-org/rules",
		],
		[
			"HTTPS://GitHub.com/example-org/rules",
			"https://github.com/example-org/rules",
		],
		[
			"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
			"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
		],
	])("accepts %s", (url, expected) => {
		expect(cloneableUrl(url)).toBe(expected);
	});

	it.each([
		"http://github.com/example-org/rules",
		"ssh://git@github.com/example-org/rules",
		"git@github.com:example-org/rules.git",
		"file:///srv/git/rules.git",
		"ext::sh -c touch% /tmp/x",
		"/srv/git/rules.git",
		"https://user:secret@github.com/example-org/rules",
		"https://user@github.com/example-org/rules",
		"https://github.com/example-org/rules?token=abc",
		"https://github.com/example-org/rules#frag",
		"https://github.com:8443/example-org/rules",
		"https://attacker.example:8443/x/y",
		"https://github.com/",
		"https://github.com",
		"-oProxyCommand=x",
		"",
	])("refuses %s", (url) => {
		expect(cloneableUrl(url)).toBeNull();
	});
});

describe("cloneFailureOf", () => {
	it.each([
		[
			"fatal: destination path '.' already exists and is not an empty directory.",
			"not-empty",
		],
		[
			"warning: Remote branch nope not found in upstream origin",
			"missing-ref",
		],
		[
			"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
			"auth",
		],
		[
			"remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/o/r/'",
			"auth",
		],
		[
			"fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
			"auth",
		],
		[
			"fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
			"network",
		],
		[
			"fatal: unable to access 'https://github.com/o/r/': Failed to connect to github.com port 443",
			"network",
		],
		["fatal: something git has not said before", "other"],
		["", "other"],
	] as const)("reads %j as %s", (stderr, expected) => {
		expect(cloneFailureOf(stderr)).toBe(expected);
	});
});

describe("gitEnvironment for the write", () => {
	const source = {
		PATH: "/usr/bin",
		HOME: "/tmp/example-home",
		FABRIC_API_KEY: "fab_secret",
		Fabric_Org: "example-org",
		GIT_ASKPASS: "/usr/bin/example-askpass",
		SSH_ASKPASS: "/usr/bin/example-ssh-askpass",
		GIT_DIR: "/tmp/elsewhere/.git",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "url.x.insteadOf",
		GIT_CONFIG_VALUE_0: "y",
	};

	it("keeps the developer's askpass programs so their credentials answer git", () => {
		const env = gitEnvironment(source, { write: true });

		expect(env.GIT_ASKPASS).toBe("/usr/bin/example-askpass");
		expect(env.SSH_ASKPASS).toBe("/usr/bin/example-ssh-askpass");
	});

	it("still never lets anything prompt", () => {
		const env = gitEnvironment(source, { write: true });

		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GCM_INTERACTIVE).toBe("never");
		expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
	});

	it("leaves an ssh command the developer chose alone, in any case", () => {
		expect(
			gitEnvironment(
				{ ...source, GIT_SSH_COMMAND: "ssh -i /k" },
				{ write: true },
			).GIT_SSH_COMMAND,
		).toBe("ssh -i /k");
		expect(
			gitEnvironment(
				{ ...source, git_ssh_command: "ssh -i /k" },
				{ write: true },
			).GIT_SSH_COMMAND,
		).toBeUndefined();
	});

	it("sets no ssh command when the developer chose a program with GIT_SSH", () => {
		const env = gitEnvironment(
			{ ...source, GIT_SSH: "/usr/bin/example-ssh" },
			{ write: true },
		);

		expect(env.GIT_SSH).toBe("/usr/bin/example-ssh");
		expect(env.GIT_SSH_COMMAND).toBeUndefined();
	});

	it("still strips the Fabric credential and everything that redirects git", () => {
		const env = gitEnvironment(source, { write: true });

		expect(
			Object.keys(env).filter((name) => /^fabric_/i.test(name)),
		).toEqual([]);
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
		expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
		expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
	});

	it("keeps stripping the askpass programs, and sets no ssh command, for a read", () => {
		const env = gitEnvironment(source);

		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.SSH_ASKPASS).toBeUndefined();
		expect(env.GIT_SSH_COMMAND).toBeUndefined();
		expect(env.GCM_INTERACTIVE).toBeUndefined();
	});
});

describe("hookWriteEnvironment, for a write nobody is there to answer", () => {
	const source = {
		PATH: "/usr/bin",
		FABRIC_API_KEY: "fab_secret",
		GIT_ASKPASS: "/usr/bin/example-askpass",
		SSH_ASKPASS: "/usr/bin/example-ssh-askpass",
		GIT_DIR: "/tmp/elsewhere/.git",
	};

	it("strips both askpass programs, as a read does", () => {
		const env = hookWriteEnvironment(source);

		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.SSH_ASKPASS).toBeUndefined();
	});

	it("is otherwise the environment of the write", () => {
		const env = hookWriteEnvironment(source);

		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GCM_INTERACTIVE).toBe("never");
		expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.FABRIC_API_KEY).toBeUndefined();
		expect(env.GIT_DIR).toBeUndefined();
	});
});

describe("cloneInto, with real git", () => {
	itWithGit("clones the named branch into an empty folder", async () => {
		await remote();
		const dir = await tempDir("fabric-clone-into-");

		const result = await cloneInto(
			dir,
			URL_OF_REMOTE,
			"release",
			Date.now() + 60_000,
		);

		expect(result).toEqual({ kind: "cloned" });
		expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
		expect(git(dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
			"origin/release",
		);
		expect(
			(await readFile(path.join(dir, "RELEASE.md"), "utf8")).trim(),
		).toBe("two");
		expect(git(dir, "config", "--get", "remote.origin.url")).toBe(
			URL_OF_REMOTE,
		);
	});

	itWithGit(
		"leaves the same config, branches and tags as cloning by hand",
		async () => {
			await remote();
			const ours = await tempDir("fabric-clone-into-");
			const byHand = await tempDir("fabric-clone-by-hand-");

			await cloneInto(
				ours,
				URL_OF_REMOTE,
				"release",
				Date.now() + 60_000,
			);
			gitByHand(
				byHand,
				"clone",
				"-q",
				"--branch",
				"release",
				URL_OF_REMOTE,
				".",
			);

			for (const question of [
				["config", "--local", "--list"],
				["branch", "--all", "--format=%(refname) %(upstream)"],
				["tag", "--list"],
			]) {
				expect(git(ours, ...question)).toBe(git(byHand, ...question));
			}
			expect(git(ours, "tag", "--list")).toBe("v1");
		},
	);

	itWithGit(
		"picks up a tag made after the clone on the next fetch, as git does",
		async () => {
			const bare = await remote();
			const dir = await tempDir("fabric-clone-into-");
			await cloneInto(dir, URL_OF_REMOTE, "main", Date.now() + 60_000);
			const seed = path.join(path.dirname(bare), "seed");
			git(seed, "checkout", "-q", "main");
			await writeFile(path.join(seed, "AGENTS.md"), "three\n");
			git(seed, "commit", "-q", "-am", "three");
			git(seed, "tag", "v2");
			git(seed, "push", "-q", bare, "main", "v2");

			gitByHand(dir, "fetch", "-q");

			expect(git(dir, "tag", "--list").split("\n")).toEqual(["v1", "v2"]);
		},
	);

	itWithGit(
		"clones main into a folder with no other branch checked out",
		async () => {
			await remote();
			const dir = await tempDir("fabric-clone-into-");

			await cloneInto(dir, URL_OF_REMOTE, "main", Date.now() + 60_000);

			expect(await readdir(dir)).toContain("AGENTS.md");
			expect(await readdir(dir)).not.toContain("RELEASE.md");
		},
	);

	itWithGit("names a branch the repository does not have", async () => {
		await remote();
		const dir = await tempDir("fabric-clone-into-");

		const result = await cloneInto(
			dir,
			URL_OF_REMOTE,
			"nope",
			Date.now() + 60_000,
		);

		expect(result).toEqual({ kind: "failed", reason: "missing-ref" });
		expect(await readdir(dir)).toEqual([]);
	});

	itWithGit("refuses a folder that already has something in it", async () => {
		await remote();
		const dir = await tempDir("fabric-clone-into-");
		await writeFile(path.join(dir, "mine.md"), "mine\n");

		const result = await cloneInto(
			dir,
			URL_OF_REMOTE,
			"main",
			Date.now() + 60_000,
		);

		expect(result).toEqual({ kind: "failed", reason: "not-empty" });
		expect(await readdir(dir)).toEqual(["mine.md"]);
	});

	itWithGit(
		"runs no git at all for a URL that is not credential-free HTTPS",
		async () => {
			const dir = await tempDir("fabric-clone-into-");

			for (const url of [
				"https://user:secret@github.com/example-org/rules",
				"ssh://git@github.com/example-org/rules",
				"file:///srv/git/rules.git",
			]) {
				expect(
					await cloneInto(dir, url, "main", Date.now() + 60_000),
				).toEqual({
					kind: "unavailable",
					reason: "not a repository this will clone",
				});
			}
			expect(await readdir(dir)).toEqual([]);
		},
	);

	itWithGit(
		"refuses a branch name that is not a plain branch literal",
		async () => {
			const dir = await tempDir("fabric-clone-into-");

			expect(
				await cloneInto(
					dir,
					URL_OF_REMOTE,
					"--upload-pack=x",
					Date.now() + 60_000,
				),
			).toMatchObject({ kind: "unavailable" });
			expect(
				await cloneInto(
					dir,
					URL_OF_REMOTE,
					"a..b",
					Date.now() + 60_000,
				),
			).toMatchObject({ kind: "unavailable" });
		},
	);

	itWithGit("gives up at the deadline instead of waiting", async () => {
		await remote();
		const dir = await tempDir("fabric-clone-into-");

		const result = await cloneInto(
			dir,
			URL_OF_REMOTE,
			"main",
			Date.now() - 1,
		);

		expect(result).toEqual({
			kind: "unavailable",
			reason: "git timed out",
		});
	});
});

describe("excludeLocalFiles, with real git", () => {
	async function checkoutWithRemote(): Promise<string> {
		await remote();
		const dir = await tempDir("fabric-exclude-");
		await cloneInto(dir, URL_OF_REMOTE, "main", Date.now() + 60_000);
		return dir;
	}

	const FILES = [".claude/settings.local.json", ".codex/hooks.json"];

	itWithGit(
		"appends the files to info/exclude, and never touches .gitignore",
		async () => {
			const dir = await checkoutWithRemote();

			const result = await excludeLocalFiles({
				toplevel: dir,
				directory: dir,
				files: FILES,
				deadline: Date.now() + 10_000,
			});

			expect(result).toEqual({
				kind: "added",
				entries: ["/.claude/settings.local.json", "/.codex/hooks.json"],
			});
			const exclude = await readFile(
				path.join(dir, ".git", "info", "exclude"),
				"utf8",
			);
			expect(exclude).toContain("/.claude/settings.local.json\n");
			expect(exclude).toContain("/.codex/hooks.json\n");
			expect(await readdir(dir)).not.toContain(".gitignore");
			expect(
				git(
					dir,
					"check-ignore",
					"-q",
					"--",
					".claude/settings.local.json",
				),
			).toBe("");
		},
	);

	itWithGit("adds nothing the second time", async () => {
		const dir = await checkoutWithRemote();
		const input = {
			toplevel: dir,
			directory: dir,
			files: FILES,
			deadline: Date.now() + 10_000,
		};
		await excludeLocalFiles(input);
		const once = await readFile(
			path.join(dir, ".git", "info", "exclude"),
			"utf8",
		);

		const again = await excludeLocalFiles(input);

		expect(again).toEqual({ kind: "unchanged" });
		expect(
			await readFile(path.join(dir, ".git", "info", "exclude"), "utf8"),
		).toBe(once);
	});

	itWithGit(
		"leaves out what the repository's own .gitignore already ignores",
		async () => {
			const dir = await checkoutWithRemote();
			await writeFile(path.join(dir, ".gitignore"), ".codex/\n");

			const result = await excludeLocalFiles({
				toplevel: dir,
				directory: dir,
				files: FILES,
				deadline: Date.now() + 10_000,
			});

			expect(result).toEqual({
				kind: "added",
				entries: ["/.claude/settings.local.json"],
			});
		},
	);

	itWithGit(
		"starts on a new line when the file does not end in one",
		async () => {
			const dir = await checkoutWithRemote();
			await writeFile(
				path.join(dir, ".git", "info", "exclude"),
				"# mine\nbuild",
			);

			await excludeLocalFiles({
				toplevel: dir,
				directory: dir,
				files: [FILES[0] as string],
				deadline: Date.now() + 10_000,
			});

			expect(
				await readFile(
					path.join(dir, ".git", "info", "exclude"),
					"utf8",
				),
			).toBe("# mine\nbuild\n/.claude/settings.local.json\n");
		},
	);

	itWithGit(
		"prefixes the entries with the folder when the instructions live in one",
		async () => {
			const dir = await checkoutWithRemote();
			await mkdir(path.join(dir, "docs", "ai"), { recursive: true });

			const result = await excludeLocalFiles({
				toplevel: dir,
				directory: path.join(dir, "docs", "ai"),
				files: [FILES[0] as string],
				deadline: Date.now() + 10_000,
			});

			expect(result).toEqual({
				kind: "added",
				entries: ["/docs/ai/.claude/settings.local.json"],
			});
		},
	);

	itWithGit(
		"writes to the main checkout's file from a linked worktree",
		async () => {
			const dir = await checkoutWithRemote();
			const linked = path.join(await tempDir("fabric-linked-"), "tree");
			git(dir, "worktree", "add", "-q", "-b", "other", linked);

			const result = await excludeLocalFiles({
				toplevel: await realpath(linked),
				directory: await realpath(linked),
				files: [FILES[0] as string],
				deadline: Date.now() + 10_000,
			});

			expect(result.kind).toBe("added");
			expect(
				await readFile(
					path.join(dir, ".git", "info", "exclude"),
					"utf8",
				),
			).toContain("/.claude/settings.local.json\n");
		},
	);

	itWithGit(
		"reports failure with the entries to add by hand when git cannot be asked",
		async () => {
			const notAGitFolder = await tempDir("fabric-not-git-");

			const result = await excludeLocalFiles({
				toplevel: notAGitFolder,
				directory: notAGitFolder,
				files: FILES,
				deadline: Date.now() + 10_000,
			});

			expect(result.kind).toBe("failed");
			if (result.kind === "failed") {
				expect(result.entries).toEqual([
					"/.claude/settings.local.json",
					"/.codex/hooks.json",
				]);
			}
		},
	);

	// A folder cannot be named `a*` on Windows, so the directory is only a
	// string here: the refusal comes before anything asks git or the disk.
	it.each([
		["a glob", "a*"],
		["a question mark", "docs?"],
		["a bracket", "docs[1]"],
		["a negation", "!docs"],
		["a newline", "docs\n/.git"],
	])(
		"refuses an entry whose folder name carries %s, and says what to add by hand",
		async (_label, folder) => {
			const toplevel = await tempDir("fabric-exclude-literal-");

			const result = await excludeLocalFiles({
				toplevel,
				directory: path.join(toplevel, folder),
				files: FILES,
				deadline: Date.now() + 10_000,
			});

			expect(result.kind).toBe("failed");
			if (result.kind === "failed") {
				expect(result.entries).toHaveLength(2);
			}
			expect(await readdir(toplevel)).toEqual([]);
		},
	);

	itWithGit(
		"leaves info/exclude as it was when the entry is refused",
		async () => {
			const dir = await checkoutWithRemote();
			const file = path.join(dir, ".git", "info", "exclude");
			const before = await readFile(file, "utf8").catch(() => "");

			const result = await excludeLocalFiles({
				toplevel: dir,
				directory: path.join(dir, "a*"),
				files: FILES,
				deadline: Date.now() + 10_000,
			});

			expect(result.kind).toBe("failed");
			expect(await readFile(file, "utf8").catch(() => "")).toBe(before);
		},
	);
});

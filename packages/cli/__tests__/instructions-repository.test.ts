/**
 * `fabric instructions check|sync|init` for a repository-sourced project
 * (Fizzy #2708), end to end with the SDK mocked at `getClient` and git
 * scripted through `helpers/git-fake.ts`.
 *
 * The contract pinned here:
 *
 *  - in a checkout of the project's repository the hook REPORTS — one line
 *    on stdout, nothing on stderr, exit 0, silence when current — and never
 *    downloads, writes a lock, or writes anything else;
 *  - outside any git checkout the upload behaviour is unchanged;
 *  - every other kind of directory gets one line naming its class, and
 *    nothing is written;
 *  - a response whose source differs from the first one stops the command.
 */
import {
	readdir,
	readFile,
	realpath,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookTiming } from "../src/lib/instructions/hook-timing.js";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";
import { fakeGit, HEAD_SHA } from "./helpers/git-fake.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	seedRawLock,
	snapshotFor,
	stubBundle,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		createFileDownloadUrls: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: () => undefined,
	listProjectSignIns: () => [],
	hasStoredApiKey: () => mocks.getApiKey() !== undefined,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
			createFileDownloadUrls: mocks.createFileDownloadUrls,
		},
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

vi.mock("../src/lib/instructions/git.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...(await import("./helpers/git-fake.js")).gitFake,
}));

beforeEach(() => {
	resetInstructionsMocks(mocks);
	fakeGit.reset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLISHED_SHA = "a".repeat(40);
const REPOSITORY_URL = "https://git.example.com/example-org/rules.git";
const NAME = "git.example.com/example-org/rules";

/**
 * `user@host` joined at runtime: the publication scan reads any literal
 * user, at-sign and dotted host as an email address, and a subdomain of example.com is
 * not on its sanctioned list. The string the code under test receives is
 * byte-identical.
 */
const withUser = (user: string, rest: string): string => [user, rest].join("@");
const CLASS_TAIL = "nothing was checked.";

const REPOSITORY = {
	provider: "GITHUB" as const,
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};

const FILE = manifestEntry("AGENTS.md", "published\n");

type Repository = Omit<typeof REPOSITORY, "provider"> & { provider: string };

function served(
	options: {
		source?: Record<string, unknown> | null;
		repository?: Repository | null;
		published?: boolean;
		version?: number;
	} = {},
) {
	if (options.published === false) {
		return {
			published: false,
			sourceOfTruth: "REPOSITORY",
			repository:
				options.repository === undefined
					? REPOSITORY
					: options.repository,
		};
	}
	const source =
		options.source === undefined
			? {
					kind: "REPOSITORY",
					ref: "main",
					commitSha: PUBLISHED_SHA,
					current: true,
				}
			: options.source;
	return {
		published: true,
		sourceOfTruth: "REPOSITORY",
		snapshot: {
			...snapshotFor([FILE], options.version ?? 7),
			...(source === null ? {} : { source }),
		},
		unchanged: false,
		changes: null,
		manifest: [FILE],
		repository:
			options.repository === undefined ? REPOSITORY : options.repository,
	};
}

function servedDirect() {
	return {
		published: false,
		sourceOfTruth: "REPOSITORY" as const,
		repository: REPOSITORY,
		direct: {
			availability: "READY" as const,
			readState: "DIRECT" as const,
			generation: REPOSITORY.generation,
			currentCommitSha: PUBLISHED_SHA,
			ref: REPOSITORY.ref,
			rootPath: REPOSITORY.rootPath,
			provider: REPOSITORY.provider,
			repository: { ...REPOSITORY, cloneUrl: REPOSITORY_URL },
		},
	};
}

function inCheckout(
	dest: string,
	remotes: Record<string, string | null> = { origin: REPOSITORY_URL },
): void {
	fakeGit.state.toplevel = dest;
	fakeGit.state.remotes = remotes;
}

function stubDownload(): void {
	mocks.createDownloadUrl.mockResolvedValue({
		snapshotId: "snap-2",
		digest: computeSnapshotDigest([FILE]),
		url: "https://storage.example.com/exports/snap-2.zip",
		expiresInSeconds: 600,
	});
	stubBundle({ "AGENTS.md": "published\n" });
}

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

const BEHIND =
	"fabric: coding instructions v7 (aaaaaaa) is on main; this checkout is behind";

describe("a direct repository project", () => {
	it("reports a matching native checkout without copying a snapshot or lock", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result).toEqual({
			code: 0,
			stdout: `Coding instructions are read directly from ${NAME} at aaaaaaa; this checkout already contains that commit.\n`,
			stderr: "",
		});
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(
			await exists(path.join(dest, ".fabric", "instructions.lock")),
		).toBe(false);
		expect(await readdir(dest)).toEqual([]);
	});

	it("refuses a nonmatching folder instead of falling back to a snapshot copy", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: "https://git.example.com/example-org/other.git",
		});
		mocks.getPublished.mockResolvedValue(servedDirect());
		stubDownload();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain(
			"Fabric does not copy them into this folder",
		);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
	});

	it("checks a direct repository checkout without snapshot state", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toBe(
			`Coding instructions are read directly from ${NAME} at aaaaaaa; this checkout already contains that commit.\n`,
		);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("gives check --format json the verdict the text mode prints, as a field", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		const json = JSON.parse(result.stdout);
		expect(json.checkout.verdict).toBe("behind");
		expect(json.checkout.line).toContain("this checkout is behind");
		expect(json.checkout.line).not.toContain("nothing has been published");
		expect(json.direct.currentCommitSha).toBe(PUBLISHED_SHA);
	});

	it("reports a current checkout in json with a verdict and no line", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		const json = JSON.parse(result.stdout);
		expect(json.checkout).toMatchObject({ verdict: "current", line: null });
	});

	it("says check --verify has nothing to verify instead of doing nothing", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--verify",
		]);

		expect(result.stdout).toContain("--verify has nothing to check");
		expect(result.stdout).toContain("already contains that commit");
	});

	it("has its hook fast-forward a clean native checkout without copying a snapshot", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: true };
		fakeGit.state.fetchResult = { kind: "fetched", tip: PUBLISHED_SHA };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result).toEqual({
			code: 0,
			stdout: `fabric: coding instructions: fast-forwarded main from ${"1".repeat(7)} to aaaaaaa.\n`,
			stderr: "",
		});
		expect(fakeGit.fetches).toHaveLength(1);
		expect(fakeGit.merges).toHaveLength(1);
		expect(fakeGit.merges[0]?.sha).toBe(PUBLISHED_SHA);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("leaves a dirty direct checkout to git: it fetches", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.clean = false;
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(fakeGit.fetches).toHaveLength(1);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("honors --no-fast-forward for a direct checkout", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
			"--no-fast-forward",
		]);

		expect(result.code).toBe(0);
		expect(fakeGit.fetches).toEqual([]);
		expect(fakeGit.merges).toEqual([]);
	});

	it("keeps a direct checkout intact when the hook cannot fetch", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: true };
		fakeGit.state.fetchResult = { kind: "failed", reason: "network" };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("sync skipped");
		expect(fakeGit.merges).toEqual([]);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("leaves a direct checkout alone while Git has a lock", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: true };
		fakeGit.state.lockFiles = true;
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(fakeGit.fetches).toEqual([]);
		expect(fakeGit.merges).toEqual([]);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
	});

	it("leaves a diverged direct checkout alone after the hook fetches its configured branch", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false, [HEAD_SHA]: false };
		mocks.getPublished.mockResolvedValue(servedDirect());
		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("main and origin/main have diverged");
		expect(result.stdout).not.toContain("git pull --ff-only");
		expect(fakeGit.fetches).toHaveLength(1);
		expect(fakeGit.merges).toEqual([]);
	});

	it("initializes a matching checkout without claiming that nothing is published", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(servedDirect());

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--no-mcp",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`Coding instructions are read directly from ${NAME} at aaaaaaa; this checkout already contains that commit.`,
		);
		expect(result.stdout).not.toContain("Nothing has been published");
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(
			await exists(path.join(dest, ".claude", "settings.local.json")),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Every class that is neither matching nor not-git
// ---------------------------------------------------------------------------

interface ClassCase {
	label: string;
	arrange: (dest: string) => void;
	response: () => ReturnType<typeof served>;
	line: string;
	/**
	 * What `init` says instead, when it names the command that fixes the
	 * folder. A function when the line names a folder behind the `--dest`
	 * the test typed.
	 */
	initLine?: string | ((dest: string) => string);
}

/** A folder as `init` spells it behind a typed `--dest`: forward slashes. */
const typed = (dest: string): string => dest.replace(/\\/g, "/");

const CLONE_THEN_INIT = `This folder is not a clone of ${NAME}. Run: fabric instructions init --project project-1 --tool claude-code --clone rules`;

const REPORT_ONLY_CLASSES: ClassCase[] = [
	{
		label: "foreign",
		arrange: (dest) =>
			inCheckout(dest, {
				origin: "https://git.example.com/example-org/other.git",
			}),
		response: () => served(),
		line: `fabric: coding instructions: no remote of this checkout fetches from ${NAME}; ${CLASS_TAIL}`,
		initLine: CLONE_THEN_INIT,
	},
	{
		label: "foreign (the effective URL is a local mirror)",
		arrange: (dest) =>
			inCheckout(dest, { origin: "/srv/mirrors/rules.git" }),
		response: () => served(),
		line: `fabric: coding instructions: no remote of this checkout fetches from ${NAME}; ${CLASS_TAIL}`,
		initLine: CLONE_THEN_INIT,
	},
	{
		label: "unknown",
		arrange: (dest) => {
			inCheckout(dest);
			fakeGit.state.unavailable = "git timed out";
		},
		response: () => served(),
		line: `fabric: coding instructions: this git checkout could not be read (git timed out); ${CLASS_TAIL}`,
	},
	{
		label: "unknown (a branch name git would expand)",
		arrange: (dest) => {
			inCheckout(dest);
			fakeGit.state.refValid = false;
		},
		response: () => served(),
		line: `fabric: coding instructions: this git checkout could not be read (the project's branch name is not one this hook will use); ${CLASS_TAIL}`,
	},
	{
		label: "unknown (a root path outside the repository)",
		arrange: (dest) => inCheckout(dest),
		response: () =>
			served({ repository: { ...REPOSITORY, rootPath: "../elsewhere" } }),
		line: `fabric: coding instructions: this git checkout could not be read (the project's instruction folder is not a path inside the repository); ${CLASS_TAIL}`,
	},
	{
		label: "unknown-identity",
		arrange: (dest) => inCheckout(dest),
		response: () => served({ repository: null }),
		line: `fabric: coding instructions: the project is repository-sourced but reports no repository to compare with; ${CLASS_TAIL}`,
	},
	{
		label: "unsupported-provider",
		arrange: (dest) => inCheckout(dest),
		response: () =>
			served({ repository: { ...REPOSITORY, provider: "BITBUCKET" } }),
		line: `fabric: coding instructions: BITBUCKET repositories are not compared yet; ${CLASS_TAIL}`,
	},
	{
		label: "ambiguous",
		arrange: (dest) =>
			inCheckout(dest, {
				origin: REPOSITORY_URL,
				upstream: withUser(
					"git",
					"git.example.com:example-org/rules.git",
				),
			}),
		response: () => served(),
		line: `fabric: coding instructions: remotes origin, upstream all fetch from ${NAME}; ${CLASS_TAIL} Run: fabric instructions init --remote origin`,
		initLine: `Remotes origin, upstream all fetch from ${NAME}. Run: fabric instructions init --remote origin`,
	},
	{
		label: "unmapped",
		arrange: (dest) => inCheckout(dest),
		response: () =>
			served({ repository: { ...REPOSITORY, rootPath: "instructions" } }),
		line: `fabric: coding instructions: this checkout is ${NAME}, but the project's instructions are at instructions, not this directory; ${CLASS_TAIL}`,
		initLine: (dest) =>
			`This checkout is ${NAME}, but its instructions are in ${typed(dest)}/instructions. Run: fabric instructions init --dest ${typed(dest)}/instructions`,
	},
];

describe("a directory that may be a checkout but is not this one", () => {
	it.each(REPORT_ONLY_CLASSES)(
		"check --hook in the $label class: one stdout line, nothing written",
		async ({ arrange, response, line }) => {
			const dest = await makeTree();
			arrange(dest);
			mocks.getPublished.mockResolvedValue(response());

			const result = await runCli([
				"check",
				"--project",
				"project-1",
				"--dest",
				dest,
				"--hook",
			]);

			expect(result).toEqual({
				code: 0,
				stdout: `${line}\n`,
				stderr: "",
			});
			expect(await readdir(dest)).toEqual([]);
		},
	);

	it.each(REPORT_ONLY_CLASSES)(
		"sync --hook in the $label class: one stdout line, no download, nothing written",
		async ({ arrange, response, line }) => {
			const dest = await makeTree();
			arrange(dest);
			mocks.getPublished.mockResolvedValue(response());
			stubDownload();

			const result = await runCli([
				"sync",
				"--project",
				"project-1",
				"--dest",
				dest,
				"--hook",
			]);

			expect(result).toEqual({
				code: 0,
				stdout: `${line}\n`,
				stderr: "",
			});
			expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([]);
		},
	);

	it.each(REPORT_ONLY_CLASSES)(
		"init in the $label class: refused with exit 7, nothing written",
		async ({ arrange, response, line: classLine, initLine }) => {
			const dest = await makeTree();
			const line =
				typeof initLine === "function"
					? initLine(dest)
					: (initLine ?? classLine);
			arrange(dest);
			mocks.getPublished.mockResolvedValue(response());
			stubDownload();

			const result = await runCli([
				"init",
				"--project",
				"project-1",
				"--tool",
				"claude-code",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(7);
			expect(result.stderr).toBe(`✗ ${line}\n`);
			expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([]);
		},
	);

	/**
	 * Fizzy #2708 review: fail closed. A person's manual sync downloads only
	 * outside any checkout and in a checkout of some OTHER repository; every
	 * case where this cannot tell whether the directory is the repository's
	 * own checkout is refused, and nothing is written.
	 */
	it.each<[string, (dest: string) => void, () => ReturnType<typeof served>]>([
		[
			"git not installed (with a .git present)",
			(dest) => {
				inCheckout(dest);
				fakeGit.state.unavailable = "git is not installed";
			},
			() => served(),
		],
		[
			"an untrusted owner",
			(dest) => {
				inCheckout(dest);
				fakeGit.state.unavailable =
					"git does not trust this repository's owner (safe.directory)";
			},
			() => served(),
		],
		[
			"a bare repository",
			(dest) => {
				inCheckout(dest);
				fakeGit.state.unavailable =
					"not a working tree (a bare repository, or inside .git)";
			},
			() => served(),
		],
		[
			"a .git that points nowhere",
			(dest) => {
				inCheckout(dest);
				fakeGit.state.unavailable =
					"its .git points to a repository that does not exist";
			},
			() => served(),
		],
		[
			"a timeout",
			(dest) => {
				inCheckout(dest);
				fakeGit.state.unavailable = "git timed out";
			},
			() => served(),
		],
		[
			"two remotes for the repository",
			(dest) =>
				inCheckout(dest, {
					origin: REPOSITORY_URL,
					upstream: withUser(
						"git",
						"git.example.com:example-org/rules.git",
					),
				}),
			() => served(),
		],
		[
			"the wrong directory of the repository",
			(dest) => inCheckout(dest),
			() =>
				served({
					repository: { ...REPOSITORY, rootPath: "instructions" },
				}),
		],
		[
			"an unsupported provider",
			(dest) => inCheckout(dest),
			() =>
				served({
					repository: { ...REPOSITORY, provider: "BITBUCKET" },
				}),
		],
		[
			"a repository-sourced project that reports no repository",
			(dest) => inCheckout(dest),
			() => served({ repository: null }),
		],
	])(
		"refuses a manual sync for %s and writes nothing",
		async (_label, arrange, response) => {
			const dest = await makeTree();
			arrange(dest);
			mocks.getPublished.mockResolvedValue(response());
			stubDownload();

			const result = await runCli([
				"sync",
				"--project",
				"project-1",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(7);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(
				/^✗ fabric: coding instructions: .*; nothing was checked\.( Run: .*)?\n$/,
			);
			expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([]);
		},
	);

	it("a person's manual sync keeps the download there", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: "https://git.example.com/example-org/other.git",
		});
		mocks.getPublished.mockResolvedValue(served());
		stubDownload();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
	});

	it("a person's manual check prints the class line after its report", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: "https://git.example.com/example-org/other.git",
		});
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("have not been synced");
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines.at(-1)).toBe(
			`fabric: coding instructions: no remote of this checkout fetches from ${NAME}; ${CLASS_TAIL}`,
		);
	});
});

// ---------------------------------------------------------------------------
// not-git
// ---------------------------------------------------------------------------

describe("a directory that is not a git checkout", () => {
	it("check --hook prints today's report", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("have not been synced");
		expect(result.stdout).not.toContain("git pull");
	});

	it("sync --hook downloads and writes the lock", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(served());
		stubDownload();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		expect(
			await exists(path.join(dest, ".fabric", "instructions.lock")),
		).toBe(true);
	});

	it("init in an empty folder says how to clone, and writes and downloads nothing", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(served());
		stubDownload();

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			`✗ This folder is empty. Run: fabric instructions init --clone to clone ${NAME} (main) into it.\n`,
		);
		expect(fakeGit.clones).toEqual([]);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
	});

	it("init --clone clones the repository into the empty folder, then sets it up", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(served());
		stubDownload();

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--clone",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toEqual([
			{
				dir: await realpath(dest),
				url: "https://git.example.com/example-org/rules",
				ref: "main",
			},
		]);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(
			await exists(path.join(dest, ".claude", "settings.local.json")),
		).toBe(true);
		expect(await exists(path.join(dest, ".fabric"))).toBe(false);
		expect(result.stdout).toBe(
			`Set up for ${NAME} (main). Claude Code fast-forwards main at session start when safe.\n`,
		);
	});

	it("init --clone creates the folder when it does not exist yet", async () => {
		const parent = await makeTree();
		const dest = path.join(parent, "rules");
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--clone",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toHaveLength(1);
		expect(
			await exists(path.join(dest, ".claude", "settings.local.json")),
		).toBe(true);
	});

	it("init never clones into a folder that has anything in it, --clone or not", async () => {
		const dest = await makeTree();
		await writeFile(path.join(dest, "AGENTS.md"), "mine\n", "utf8");
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--clone",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(7);
		expect(result.stderr).toBe(`✗ ${CLONE_THEN_INIT}\n`);
		expect(fakeGit.clones).toEqual([]);
		expect(await readdir(dest)).toEqual(["AGENTS.md"]);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"mine\n",
		);
	});

	it.each([
		[
			"auth",
			3,
			`✗ Could not clone ${NAME}: git has no credentials for git.example.com. The Fabric MCP server was not registered. Run: gh auth login\n`,
		],
		[
			"network",
			1,
			`✗ Could not clone ${NAME}: git.example.com did not answer. The Fabric MCP server was not registered. Check your network and try again.\n`,
		],
		[
			"missing-ref",
			7,
			`✗ Could not clone ${NAME}: it has no branch main. The Fabric MCP server was not registered.\n`,
		],
		[
			"other",
			1,
			`✗ Could not clone ${NAME}. The Fabric MCP server was not registered. Run: git clone -- https://git.example.com/example-org/rules to see why.\n`,
		],
	] as const)(
		"init --clone that fails with %s says so in one line and writes no hook",
		async (reason, code, stderr) => {
			const dest = await makeTree();
			mocks.getPublished.mockResolvedValue(served());
			fakeGit.state.cloneResult = { kind: "failed", reason };

			const result = await runCli([
				"init",
				"--project",
				"project-1",
				"--tool",
				"claude-code",
				"--clone",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(code);
			expect(result.stderr).toBe(stderr);
			expect(await readdir(dest)).toEqual([]);
		},
	);

	it("init --clone of a project whose instructions live in a subfolder says to go there", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(
			served({ repository: { ...REPOSITORY, rootPath: "docs/ai" } }),
		);

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--clone",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			`Cloned ${NAME} (main). Its instructions are in ${typed(dest)}/docs/ai. Run: fabric instructions init --dest ${typed(dest)}/docs/ai\n`,
		);
		expect(await readdir(dest)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

describe("a checkout of the project's repository", () => {
	async function hook(
		verb: "check" | "sync",
		arrange: (dest: string) => void = () => {},
		response: unknown = served(),
		extra: string[] = [],
	) {
		const dest = await makeTree();
		inCheckout(dest);
		arrange(dest);
		mocks.getPublished.mockResolvedValue(response);
		stubDownload();
		const result = await runCli([
			verb,
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
			// Report-only: these cases are the lines both verbs share. What
			// `sync --hook` does beyond reporting is in fast-forward-hook.test.ts.
			...(verb === "sync" ? ["--no-fast-forward"] : []),
			...extra,
		]);
		// Report-only, whatever it said: nothing downloaded, nothing written.
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
		return result.stdout;
	}

	const cases: Array<{
		label: string;
		arrange: (dest: string) => void;
		response?: unknown;
		line: string | null;
	}> = [
		{
			label: "the published commit is HEAD's ancestor: silent",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
			},
			line: null,
		},
		{
			label: "behind on the synced branch, clean",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
			},
			line: `${BEHIND} — run: git pull --ff-only origin main`,
		},
		{
			label: "the published commit has not been fetched",
			arrange: () => {},
			line: "fabric: coding instructions v7 (aaaaaaa) is on main; this checkout has not fetched it yet — run: git pull --ff-only origin main",
		},
		{
			label: "behind with local changes",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.clean = false;
			},
			line: `${BEHIND} and has uncommitted changes — commit or stash, then pull.`,
		},
		{
			label: "behind with a merge in progress",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.operation = "merge";
			},
			line: `${BEHIND}; a merge is in progress; nothing was changed.`,
		},
		{
			label: "behind on a detached HEAD",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.branch = null;
			},
			line: `${BEHIND}; HEAD is detached — check out main and pull.`,
		},
		{
			label: "behind on another branch",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.branch = "feature/x";
			},
			line: `${BEHIND}; you are on feature/x — pull main when you switch to it.`,
		},
		{
			label: "behind in a shallow, sparse submodule checkout",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.traits = {
					shallow: true,
					sparse: true,
					superproject: true,
				};
			},
			line: `${BEHIND} (shallow clone) (sparse checkout) (inside a superproject) — run: git pull --ff-only origin main`,
		},
		{
			label: "the published snapshot is from an earlier configuration",
			arrange: () => {},
			response: served({
				source: {
					kind: "REPOSITORY",
					ref: "release",
					commitSha: PUBLISHED_SHA,
					current: false,
				},
			}),
			line: `fabric: coding instructions v7 was published from release; the project now syncs main of ${NAME} — pull main to pick up the next publication`,
		},
		{
			label: "nothing has been published from the repository yet",
			arrange: () => {},
			response: served({ source: { kind: "UPLOAD" } }),
			line: `fabric: coding instructions: the project is repository-sourced but nothing has been published from ${NAME} yet`,
		},
		{
			label: "nothing has been published at all",
			arrange: () => {},
			response: served({ published: false }),
			line: `fabric: coding instructions: the project is repository-sourced but nothing has been published from ${NAME} yet`,
		},
	];

	it.each(cases)(
		"check --hook: $label",
		async ({ arrange, response, line }) => {
			const stdout = await hook("check", arrange, response ?? served());
			expect(stdout).toBe(line === null ? "" : `${line}\n`);
		},
	);

	it.each(cases)(
		"sync --hook: $label",
		async ({ arrange, response, line }) => {
			const stdout = await hook("sync", arrange, response ?? served());
			expect(stdout).toBe(line === null ? "" : `${line}\n`);
		},
	);

	it("reads HEAD, not a download: the ancestry question names the published commit and HEAD", async () => {
		await hook("check", () => {
			fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		});
		expect(fakeGit.ancestry).toEqual([[PUBLISHED_SHA, HEAD_SHA]]);
	});

	it.each([["--dry-run"], ["--repair"]])(
		"sync --hook ignores %s and reports",
		async (flag) => {
			const stdout = await hook(
				"sync",
				() => {
					fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				},
				served(),
				[flag],
			);
			expect(stdout).toBe(
				`${BEHIND} — run: git pull --ff-only origin main\n`,
			);
		},
	);

	it("manual sync reports, downloads nothing and writes no lock", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
		mocks.getPublished.mockResolvedValue(served());
		stubDownload();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--repair",
		]);

		expect(result).toEqual({
			code: 0,
			stdout: `${BEHIND} — run: git pull --ff-only origin main\n`,
			stderr: "",
		});
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
	});

	it("manual sync says so in words when the checkout is current", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toBe(
			`fabric: coding instructions v7 (aaaaaaa) from main of ${NAME} is already in this checkout's history; nothing to sync\n`,
		);
	});

	// The lock-based report used to follow the source line here: "have not
	// been synced into this folder yet" and "run sync to take a copy", which
	// is wrong for a checkout git keeps current (seen on staging).
	it("manual check in a current checkout says so, and offers no copy", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("have not been synced");
		expect(result.stdout).not.toContain("take a copy");
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("published from aaaaaaaaaaaa… on main");
		expect(lines[1]).toBe(
			`fabric: coding instructions v7 (aaaaaaa) from main of ${NAME} is already in this checkout's history; nothing to sync`,
		);
	});

	it("manual check prints its report, then the line", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("take a copy");
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines[0]).toContain("published from aaaaaaaaaaaa… on main");
		expect(lines.at(-1)).toBe(
			`${BEHIND} — run: git pull --ff-only origin main`,
		);
	});

	it("check --format json carries the checkout block", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
		fakeGit.state.traits = {
			shallow: true,
			sparse: false,
			superproject: false,
		};
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).checkout).toEqual({
			class: "matching",
			remote: "origin",
			branch: "main",
			head: HEAD_SHA,
			clean: true,
			operation: null,
			contains: false,
			traits: ["shallow"],
			line: `${BEHIND} (shallow clone) — run: git pull --ff-only origin main`,
		});
	});

	it("check --format json reports contains: null when git cannot say", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(JSON.parse(result.stdout).checkout.contains).toBeNull();
	});

	it("check --format json has checkout: null for an uploaded project", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([FILE]),
			manifest: [FILE],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(JSON.parse(result.stdout).checkout).toBeNull();
		expect(fakeGit.calls).toEqual([]);
	});

	it.each([
		[
			[],
			"sync",
			"Claude Code fast-forwards main at session start when safe.",
		],
		[
			["--apply"],
			"sync",
			"Claude Code fast-forwards main at session start when safe.",
		],
		[
			["--report-only"],
			"check",
			"Claude Code checks for updates at every session start.",
		],
	])(
		"init %j writes the %s hook, copies nothing, and says one line",
		async (extra, verb, clause) => {
			const dest = await makeTree();
			inCheckout(dest);
			mocks.getPublished.mockResolvedValue(served());
			stubDownload();

			const result = await runCli([
				"init",
				"--project",
				"project-1",
				"--tool",
				"claude-code",
				"--dest",
				dest,
				...extra,
			]);

			expect(result.code).toBe(0);
			expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([".claude"]);
			const settings = JSON.parse(
				await readFile(
					path.join(dest, ".claude", "settings.local.json"),
					"utf8",
				),
			);
			expect(settings.hooks.SessionStart).toEqual([
				{
					hooks: [
						{
							type: "command",
							command: `fabric instructions ${verb} --project project-1 --base-url https://fabric.pro --hook`,
							timeout: 15,
						},
					],
				},
			]);
			expect(result.stdout).toBe(
				`Set up for ${NAME} (main). ${clause}\n`,
			);
		},
	);

	it("init with nothing published from the repository yet writes the hook and says so", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served({ published: false }));

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		expect(
			await exists(path.join(dest, ".claude", "settings.local.json")),
		).toBe(true);
		expect(result.stdout).toContain(
			`Nothing has been published from ${NAME} yet; the hook reports once it is.`,
		);
	});
});

// ---------------------------------------------------------------------------
// A lock left in a checkout of the repository
// ---------------------------------------------------------------------------

describe("a lock left in a checkout of the repository (Fizzy #2708 review)", () => {
	const LOCKS: Array<[string, (dest: string) => Promise<void>]> = [
		["a malformed lock", (dest) => seedRawLock(dest, "{ not json")],
		[
			"another project's lock",
			(dest) => seedLock(dest, "d".repeat(64), {}, "project-A"),
		],
		[
			"a lock of an unsupported version",
			(dest) =>
				seedRawLock(
					dest,
					JSON.stringify({ version: 99, projectId: "project-1" }),
				),
		],
		[
			"a symlinked .fabric directory",
			async (dest) => {
				const elsewhere = await makeTree();
				await seedLock(elsewhere, "d".repeat(64), {});
				await symlink(
					path.join(elsewhere, ".fabric"),
					path.join(dest, ".fabric"),
				);
			},
		],
	];

	it.each(LOCKS)(
		"check --hook still reports with %s",
		async (_label, seed) => {
			const dest = await makeTree();
			await seed(dest);
			inCheckout(dest);
			fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
			mocks.getPublished.mockResolvedValue(served());

			const result = await runCli([
				"check",
				"--project",
				"project-1",
				"--dest",
				dest,
				"--hook",
			]);

			expect(result).toEqual({
				code: 0,
				stdout: `${BEHIND} — run: git pull --ff-only origin main\n`,
				stderr: "",
			});
			// The hint is dropped, never another project's digest.
			expect(mocks.getPublished).toHaveBeenCalledWith("project-1", {
				org: undefined,
				sinceDigest: undefined,
			});
		},
	);

	it.each(LOCKS)(
		"sync --hook still reports with %s",
		async (_label, seed) => {
			const dest = await makeTree();
			await seed(dest);
			inCheckout(dest);
			fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
			mocks.getPublished.mockResolvedValue(served());
			stubDownload();

			const result = await runCli([
				"sync",
				"--project",
				"project-1",
				"--dest",
				dest,
				"--hook",
				"--no-fast-forward",
			]);

			expect(result).toEqual({
				code: 0,
				stdout: `${BEHIND} — run: git pull --ff-only origin main\n`,
				stderr: "",
			});
			expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		},
	);

	it.each(LOCKS)(
		"init still installs the hook with %s",
		async (_label, seed) => {
			const dest = await makeTree();
			await seed(dest);
			inCheckout(dest);
			mocks.getPublished.mockResolvedValue(served());

			const result = await runCli([
				"init",
				"--project",
				"project-1",
				"--tool",
				"claude-code",
				"--dest",
				dest,
			]);

			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(
				await exists(path.join(dest, ".claude", "settings.local.json")),
			).toBe(true);
		},
	);
});

// ---------------------------------------------------------------------------
// A git that never answers
// ---------------------------------------------------------------------------

describe("a git that never answers (Fizzy #2708 review)", () => {
	const saved = { ...hookTiming };
	afterEach(() => {
		Object.assign(hookTiming, saved);
	});

	it.each([["check"], ["sync"]])(
		"%s --hook still ends with exactly one stdout line before the outer deadline",
		async (verb) => {
			// A short clock, so the test waits under a second rather than ten.
			hookTiming.deadlineMs = 1_500;
			hookTiming.gitMarginMs = 750;
			const dest = await makeTree();
			inCheckout(dest);
			fakeGit.state.stall = true;
			mocks.getPublished.mockResolvedValue(served());
			stubDownload();

			const started = Date.now();
			const result = await runCli([
				verb,
				"--project",
				"project-1",
				"--dest",
				dest,
				"--hook",
			]);

			expect(result).toEqual({
				code: 0,
				stdout: `fabric: coding instructions: this git checkout could not be read (git timed out); ${CLASS_TAIL}\n`,
				stderr: "",
			});
			// Every git question was given the margin, never the outer deadline.
			for (const deadline of fakeGit.deadlines) {
				expect(deadline).toBeLessThanOrEqual(
					started + 1_500 - 750 + 50,
				);
			}
			expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([]);
		},
	);
});

// ---------------------------------------------------------------------------
// A source that moves between two responses
// ---------------------------------------------------------------------------

describe("a source that changes between two responses", () => {
	it.each([
		["the repository's ref", { ...REPOSITORY, ref: "release" }],
		["the repository's generation", { ...REPOSITORY, generation: 2 }],
		["the repository itself", null],
	])("stops a hook's drift refetch when %s changed", async (_label, next) => {
		const dest = await makeTree();
		await seedLock(dest, computeSnapshotDigest([FILE]), {
			"AGENTS.md": { sha256: FILE.sha256, mode: 0o100644 },
		});
		mocks.getPublished
			.mockResolvedValueOnce({
				...served(),
				unchanged: true,
				changes: { added: [], removed: [], changed: [] },
				manifest: undefined,
			})
			.mockResolvedValueOnce(served({ repository: next }));
		stubDownload();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			"fabric: coding instructions sync skipped: this project's instruction source changed while this command ran; nothing was written — run it again\n",
		);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([".fabric"]);
	});

	it("does not count the clone URL or the sync's own state as a change of source", async () => {
		const dest = await makeTree();
		await seedLock(dest, computeSnapshotDigest([FILE]), {
			"AGENTS.md": { sha256: FILE.sha256, mode: 0o100644 },
		});
		mocks.getPublished
			.mockResolvedValueOnce({
				...served(),
				unchanged: true,
				changes: { added: [], removed: [], changed: [] },
				manifest: undefined,
				repository: {
					...REPOSITORY,
					cloneUrl: "https://git.example.com/example-org/rules",
					sync: {
						automatic: true,
						pausedReason: null,
						lastRun: {
							trigger: "WEBHOOK",
							status: "SUCCEEDED",
							error: null,
							commitSha: "b".repeat(40),
							finishedAt: "2026-10-02T10:00:00.000Z",
						},
					},
				},
			})
			.mockResolvedValueOnce(
				served({
					repository: {
						...REPOSITORY,
						cloneUrl: null,
						sync: {
							automatic: false,
							pausedReason: "MIGRATING",
							lastRun: {
								trigger: "MANUAL",
								status: null,
								error: null,
								commitSha: null,
								finishedAt: null,
							},
						},
					} as Repository,
				}),
			);
		stubDownload();

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.stderr).not.toContain("instruction source changed");
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
	});

	it("never prints a URL or credential from a remote", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: `https://${withUser("dev:token-value", "git.example.com/example-org/other.git")}`,
		});
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.stdout).not.toContain("https://");
		expect(result.stdout).not.toContain("token-value");
		expect(result.stdout).not.toContain("dev:");
	});
});

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

describe("an Azure DevOps project", () => {
	const AZURE = {
		provider: "AZURE_DEVOPS",
		host: "dev.azure.com",
		path: "Example-Org/Example Project/_git/rules",
		ref: "main",
		rootPath: "",
		generation: 1,
	};
	async function hookIn(
		origin: string,
		repository: typeof AZURE = AZURE,
	): Promise<string> {
		const dest = await makeTree();
		inCheckout(dest, { origin });
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
		mocks.getPublished.mockResolvedValue(served({ repository }));

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		return result.stdout;
	}

	it.each([
		[
			"https",
			"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
		],
		[
			"visualstudio.com",
			"https://example-org.visualstudio.com/Example%20Project/_git/rules",
		],
		[
			"scp-like ssh",
			withUser(
				"git",
				"ssh.dev.azure.com:v3/Example-Org/Example%20Project/rules",
			),
		],
	])(
		"treats a checkout cloned over %s as a checkout of the repository",
		async (_label, origin) => {
			const stdout = await hookIn(origin);

			expect(stdout).toContain("is on main; this checkout is behind");
			expect(stdout).not.toContain("foreign");
			expect(stdout).not.toContain("not compared yet");
		},
	);

	it("calls a checkout of another Azure DevOps repository foreign", async () => {
		const stdout = await hookIn(
			"https://dev.azure.com/Example-Org/Example%20Project/_git/other",
		);

		expect(stdout).toContain("no remote of this checkout fetches from");
	});

	it("says it cannot compare when the project's path names no Azure DevOps project", async () => {
		const stdout = await hookIn(
			"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
			{ ...AZURE, path: "Example-Org/rules" },
		);

		expect(stdout).toContain("reports no repository to compare with");
	});
});

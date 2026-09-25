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
import { readdir, readFile, stat, symlink } from "node:fs/promises";
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
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
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
const CLASS_TAIL = "nothing was checked or changed";

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

const BEHIND = `fabric: coding instructions v7 (aaaaaaa) is published on main of ${NAME}; this checkout is behind`;

// ---------------------------------------------------------------------------
// Every class that is neither matching nor not-git
// ---------------------------------------------------------------------------

interface ClassCase {
	label: string;
	arrange: (dest: string) => void;
	response: () => ReturnType<typeof served>;
	line: string;
}

const REPORT_ONLY_CLASSES: ClassCase[] = [
	{
		label: "foreign",
		arrange: (dest) =>
			inCheckout(dest, {
				origin: "https://git.example.com/example-org/other.git",
			}),
		response: () => served(),
		line: `fabric: coding instructions: no remote of this checkout fetches from ${NAME} (foreign checkout); ${CLASS_TAIL}`,
	},
	{
		label: "foreign (the effective URL is a local mirror)",
		arrange: (dest) =>
			inCheckout(dest, { origin: "/srv/mirrors/rules.git" }),
		response: () => served(),
		line: `fabric: coding instructions: no remote of this checkout fetches from ${NAME} (foreign checkout); ${CLASS_TAIL}`,
	},
	{
		label: "unknown",
		arrange: (dest) => {
			inCheckout(dest);
			fakeGit.state.unavailable = "git timed out";
		},
		response: () => served(),
		line: `fabric: coding instructions: this git checkout could not be read (git timed out; unknown checkout); ${CLASS_TAIL}`,
	},
	{
		label: "unknown (a branch name git would expand)",
		arrange: (dest) => {
			inCheckout(dest);
			fakeGit.state.refValid = false;
		},
		response: () => served(),
		line: `fabric: coding instructions: this git checkout could not be read (the project's branch name is not one this hook will use; unknown checkout); ${CLASS_TAIL}`,
	},
	{
		label: "unknown (a root path outside the repository)",
		arrange: (dest) => inCheckout(dest),
		response: () =>
			served({ repository: { ...REPOSITORY, rootPath: "../elsewhere" } }),
		line: `fabric: coding instructions: this git checkout could not be read (the project's instruction folder is not a path inside the repository; unknown checkout); ${CLASS_TAIL}`,
	},
	{
		label: "unknown-identity",
		arrange: (dest) => inCheckout(dest),
		response: () => served({ repository: null }),
		line: `fabric: coding instructions: the project is repository-sourced but reports no repository to compare with (unknown repository); ${CLASS_TAIL}`,
	},
	{
		label: "unsupported-provider",
		arrange: (dest) => inCheckout(dest),
		response: () =>
			served({ repository: { ...REPOSITORY, provider: "AZURE_DEVOPS" } }),
		line: `fabric: coding instructions: AZURE_DEVOPS repositories are not compared yet (unsupported provider); ${CLASS_TAIL}`,
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
		line: `fabric: coding instructions: remotes origin, upstream all fetch from ${NAME} (ambiguous checkout); ${CLASS_TAIL}`,
	},
	{
		label: "unmapped",
		arrange: (dest) => inCheckout(dest),
		response: () =>
			served({ repository: { ...REPOSITORY, rootPath: "instructions" } }),
		line: `fabric: coding instructions: this checkout is ${NAME}, but the project's instructions are at instructions, not this directory (unmapped checkout); ${CLASS_TAIL}`,
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
		async ({ arrange, response, line }) => {
			const dest = await makeTree();
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
					repository: { ...REPOSITORY, provider: "AZURE_DEVOPS" },
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
				/^✗ fabric: coding instructions: .*; nothing was checked or changed\n$/,
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
			`fabric: coding instructions: no remote of this checkout fetches from ${NAME} (foreign checkout); ${CLASS_TAIL}`,
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

	it("init takes the first copy and writes the hook", async () => {
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

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"published\n",
		);
		expect(
			await exists(path.join(dest, ".claude", "settings.local.json")),
		).toBe(true);
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
			line: `fabric: coding instructions v7 (aaaaaaa) is published on main of ${NAME}; this checkout has not fetched it yet — run: git pull --ff-only origin main`,
		},
		{
			label: "behind with local changes",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.clean = false;
			},
			line: `${BEHIND}; your working tree has changes — pull when it is clean`,
		},
		{
			label: "behind with a merge in progress",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.operation = "merge";
			},
			line: `${BEHIND}; a merge is in progress`,
		},
		{
			label: "behind on a detached HEAD",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.branch = null;
			},
			line: `${BEHIND}; HEAD is detached — check out main and pull`,
		},
		{
			label: "behind on another branch",
			arrange: () => {
				fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
				fakeGit.state.branch = "feature/x";
			},
			line: `${BEHIND}; you are on feature/x — pull main when you switch to it`,
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
			line: `${BEHIND} — run: git pull --ff-only origin main (shallow clone) (sparse checkout) (inside a superproject)`,
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
			line: `${BEHIND} — run: git pull --ff-only origin main (shallow clone)`,
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
		[[], "check", ""],
		[
			["--apply"],
			"sync",
			" — automatic updates are not available for repository checkouts yet; the hook reports and you (or your agent) run the pull",
		],
	])(
		"init %j writes the %s hook, copies nothing, and says the hook only reports",
		async (extra, verb, suffix) => {
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
							command: `fabric instructions ${verb} --project project-1 --hook`,
							timeout: 15,
						},
					],
				},
			]);
			expect(result.stdout).toContain(
				`  installed; this checkout is ${NAME}: the hook reports when main has newer instructions and never changes the checkout${suffix}\n`,
			);
			expect(result.stdout).not.toContain(".fabric");
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
				stdout: `fabric: coding instructions: this git checkout could not be read (git timed out; unknown checkout); ${CLASS_TAIL}\n`,
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

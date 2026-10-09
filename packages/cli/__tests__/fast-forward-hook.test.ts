/**
 * What `sync --hook` does in a checkout of a repository project, and what
 * `check --hook` never does (Fizzy #2878), through the command layer: the SDK
 * is mocked at `getClient`, git is scripted through `helpers/git-fake.ts`, and
 * the lock, notice and trace files are real files in temp folders.
 */
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookTiming } from "../src/lib/instructions/hook-timing.js";
import { fakeGit, TIP_SHA } from "./helpers/git-fake.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	snapshotFor,
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

vi.mock("../src/lib/instructions/git.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...(await import("./helpers/git-fake.js")).gitFake,
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

let configDir: string;

beforeEach(async () => {
	resetInstructionsMocks(mocks);
	fakeGit.reset();
	configDir = await mkdtemp(path.join(tmpdir(), "fabric-ffhook-config-"));
	mocks.getConfigPath.mockReturnValue(path.join(configDir, "config.json"));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const PUBLISHED_SHA = "a".repeat(40);
const FILE = manifestEntry("AGENTS.md", "published\n");
const NAME = "git.example.com/example-org/rules";
const REPOSITORY = {
	provider: "GITHUB" as const,
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
	sync: { automatic: true, pausedReason: null, lastRun: null },
};

function served(version = 7) {
	return {
		published: true,
		sourceOfTruth: "REPOSITORY",
		snapshot: {
			...snapshotFor([FILE], version),
			source: {
				kind: "REPOSITORY",
				ref: "main",
				commitSha: PUBLISHED_SHA,
				current: true,
			},
		},
		unchanged: false,
		changes: null,
		manifest: [FILE],
		repository: REPOSITORY,
	};
}

function inCheckout(dest: string): void {
	fakeGit.state.toplevel = dest;
	fakeGit.state.remotes = {
		origin: "https://git.example.com/example-org/rules.git",
	};
	// HEAD is behind the published commit, which the remote has too.
	fakeGit.state.ancestors = { [PUBLISHED_SHA]: false };
	fakeGit.state.fetchResult = { kind: "fetched", tip: PUBLISHED_SHA };
}

function hook(verb: "check" | "sync", dest: string, ...extra: string[]) {
	return runCli([
		verb,
		"--project",
		"project-1",
		"--dest",
		dest,
		"--hook",
		...extra,
	]);
}

const writes = (): string[] =>
	fakeGit.calls.filter(
		(call) => call === "fetchRef" || call === "fastForwardTo",
	);

async function traceEntries(): Promise<
	Array<{ outcome: string; reason: string | null; projectId: string }>
> {
	const file = path.join(configDir, "traces", "instructions-hook.jsonl");
	return (await readFile(file, "utf8").catch(() => ""))
		.split("\n")
		.filter((text) => text !== "")
		.map((text) => JSON.parse(text));
}

describe("sync --hook in a checkout of a repository project", () => {
	it("fetches the branch, then fast-forwards to what it fetched, and says so", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(result).toEqual({
			code: 0,
			stdout: `fabric: coding instructions: fast-forwarded main from ${"1".repeat(7)} to aaaaaaa (v7).\n`,
			stderr: "",
		});
		expect(writes()).toEqual(["fetchRef", "fastForwardTo"]);
		expect(fakeGit.fetches).toHaveLength(1);
		expect(fakeGit.fetches[0]).toMatchObject({
			remote: "origin",
			ref: "main",
		});
		expect(fakeGit.merges).toHaveLength(1);
		expect(fakeGit.merges[0]?.sha).toBe(PUBLISHED_SHA);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
	});

	it("goes to the branch tip, not the published commit, and says Fabric's copy lags", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.fetchResult = { kind: "fetched", tip: TIP_SHA };
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(fakeGit.merges[0]?.sha).toBe(TIP_SHA);
		expect(result.stdout).toBe(
			[
				`fabric: coding instructions: fast-forwarded main from ${"1".repeat(7)} to ${"2".repeat(7)}.`,
				`fabric: coding instructions: main is at ${"2".repeat(7)}; Fabric's copy is behind (the next sync has not run yet).`,
				"",
			].join("\n"),
		);
	});

	it("is silent when the checkout already is where the branch is", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.head = PUBLISHED_SHA;
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(fakeGit.merges).toEqual([]);
	});

	it("lets git refuse a blocking local change, says so once per version, and changes nothing", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.clean = false;
		fakeGit.state.mergeResult = {
			kind: "failed",
			reason: "local-changes",
			files: ["AGENTS.md"],
		};
		mocks.getPublished.mockResolvedValue(served());

		const first = await hook("sync", dest);
		const second = await hook("sync", dest);

		expect(first.stdout).toBe(
			"fabric: coding instructions: main is behind origin/main, but local changes would be overwritten (AGENTS.md), so nothing was updated. Stash them or move them to another branch; the next session start updates this checkout on its own.\n",
		);
		expect(second.stdout).toBe("");
	});

	it("fast-forwards past local changes git does not object to", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.clean = false;
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(result.stdout).toContain("fast-forwarded main from");
		expect(writes()).toEqual(["fetchRef", "fastForwardTo"]);
	});

	it("says it again for the next published version", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.clean = false;
		fakeGit.state.mergeResult = {
			kind: "failed",
			reason: "local-changes",
			files: ["AGENTS.md"],
		};
		mocks.getPublished.mockResolvedValue(served(7));
		await hook("sync", dest);
		mocks.getPublished.mockResolvedValue(served(8));

		const next = await hook("sync", dest);

		expect(next.stdout).toContain("local changes would be overwritten");
	});

	it.each([
		[
			"wrong branch",
			() => {
				fakeGit.state.branch = "feature/x";
			},
			"you are on feature/x",
		],
		[
			"a detached HEAD",
			() => {
				fakeGit.state.branch = null;
			},
			"HEAD is detached",
		],
		[
			"a rebase in progress",
			() => {
				fakeGit.state.operation = "rebase";
			},
			"a rebase is in progress; nothing was changed.",
		],
	])(
		"reports %s with the behind line and calls neither write",
		async (_label, arrange, words) => {
			const dest = await makeTree();
			inCheckout(dest);
			arrange();
			mocks.getPublished.mockResolvedValue(served());

			const result = await hook("sync", dest);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain(words);
			expect(writes()).toEqual([]);
		},
	);

	it("tells the agent when git has no credentials, every time, and still exits 0", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.fetchResult = { kind: "failed", reason: "auth" };
		mocks.getPublished.mockResolvedValue(served());

		const first = await hook("sync", dest);
		const second = await hook("sync", dest);

		for (const result of [first, second]) {
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(
				`could not fetch ${NAME}: git has no credentials for git.example.com. Run: gh auth login`,
			);
		}
		expect(fakeGit.merges).toEqual([]);
	});

	it("keeps a network failure to the log", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.fetchResult = { kind: "failed", reason: "network" };
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			`fabric: coding instructions sync skipped: could not fetch ${NAME}: git.example.com did not answer; nothing was updated.\n`,
		);
		expect(result.stdout).toContain("this checkout is behind");
	});

	it("keeps a ran-out budget to the log, makes no merge, and still exits 0", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.fetchResult = { kind: "timed-out" };
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			"fabric: coding instructions sync skipped: gave up after 9.5 s\n",
		);
		expect(fakeGit.merges).toEqual([]);
	});

	it("fast-forwards after a fetch that took the whole fetch budget, on the first run", async () => {
		const saved = { ...hookTiming };
		hookTiming.deadlineMs = 4_000;
		hookTiming.gitMarginMs = 100;
		try {
			const dest = await makeTree();
			inCheckout(dest);
			fakeGit.state.slowFetch = true;
			mocks.getPublished.mockResolvedValue(served());

			const result = await hook("sync", dest);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("fast-forwarded main from");
			expect(fakeGit.merges).toHaveLength(1);
			expect(
				(await traceEntries()).map((entry) => entry.outcome),
			).toEqual(["fast-forwarded"]);
		} finally {
			Object.assign(hookTiming, saved);
		}
	});

	it("traces which stage ran out of budget, and still tells the session where the checkout stands", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.fetchResult = { kind: "timed-out" };
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest);

		expect(result.stdout).toBe(
			"fabric: coding instructions v7 (aaaaaaa) is on main; this checkout is behind — run: git pull --ff-only origin main\n",
		);
		expect(await traceEntries()).toMatchObject([
			{ outcome: "deadline", reason: "fetch" },
		]);
	});

	it("only reports, fetching and merging nothing, with --no-fast-forward", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("sync", dest, "--no-fast-forward");

		expect(result.stdout).toBe(
			"fabric: coding instructions v7 (aaaaaaa) is on main; this checkout is behind — run: git pull --ff-only origin main\n",
		);
		expect(writes()).toEqual([]);
		expect((await traceEntries()).map((entry) => entry.outcome)).toEqual([
			"opted-out",
		]);
	});

	it("writes a trace of each run with no path in it", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		await hook("sync", dest);

		const entries = await traceEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			outcome: "fast-forwarded",
			reason: null,
			projectId: "project-1",
		});
		expect(JSON.stringify(entries)).not.toContain(dest);
	});

	it("is a person's own sync, not a hook's, that only reports", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.stdout).toContain("this checkout is behind");
		expect(writes()).toEqual([]);
	});
});

describe("check --hook", () => {
	it("never fetches or merges, however far behind the checkout is", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		const result = await hook("check", dest);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			"fabric: coding instructions v7 (aaaaaaa) is on main; this checkout is behind — run: git pull --ff-only origin main\n",
		);
		expect(writes()).toEqual([]);
		expect(fakeGit.calls).not.toContain("upstreamOf");
		expect(fakeGit.calls).not.toContain("commonDir");
		expect(await traceEntries()).toEqual([]);
	});
});

describe("a project that is not repository-sourced", () => {
	it("has its hook untouched: sync --hook never asks git anything", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await hook("sync", dest);

		expect(result.code).toBe(0);
		expect(fakeGit.calls).toEqual([]);
	});
});

/**
 * `fabric instructions init` taking over the folder it runs in (Fizzy #2878):
 * every coding tool it finds gets a hook in one run, the per-machine files
 * are kept out of commits through `.git/info/exclude`, and an upload-era lock
 * is retired in a checkout git keeps current. Existing files are never
 * touched.
 *
 * The SDK is mocked at `getClient`, git is scripted through
 * `helpers/git-fake.ts`, and the machine (home folder, PATH) is whatever each
 * test says it is.
 */
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { machine } from "../src/lib/instructions/machine.js";
import { fakeGit } from "./helpers/git-fake.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	snapshotFor,
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

vi.mock("../src/lib/instructions/git.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...(await import("./helpers/git-fake.js")).gitFake,
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

const PUBLISHED_SHA = "a".repeat(40);
const FILE = manifestEntry("AGENTS.md", "published\n");
const REPOSITORY = {
	provider: "GITHUB" as const,
	host: "github.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};
const NAME = "github.com/example-org/rules";
const SET_UP = `Set up for ${NAME} (main).`;

function served() {
	return {
		published: true,
		sourceOfTruth: "REPOSITORY",
		snapshot: {
			...snapshotFor([FILE], 7),
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
		origin: "https://github.com/example-org/rules.git",
	};
	fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
}

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

const realMachine = { ...machine };
let home: string;
let bin: string;

beforeEach(async () => {
	resetInstructionsMocks(mocks);
	fakeGit.reset();
	// An empty home folder and an empty PATH directory: no coding tool at all
	// unless a test puts one there.
	home = await makeTree();
	bin = await makeTree();
	machine.home = () => home;
	machine.env = () => ({ PATH: bin });
	machine.platform = () => process.platform;
	// The CLI itself is installed, so `init` has no reason to warn that the
	// hook cannot find it.
	await putOnPath("fabric");
	mocks.getPublished.mockResolvedValue(served());
});

afterEach(() => {
	Object.assign(machine, realMachine);
	vi.unstubAllGlobals();
});

async function putOnPath(command: string): Promise<void> {
	const file = path.join(
		bin,
		process.platform === "win32" ? `${command}.cmd` : command,
	);
	await writeFile(file, "");
	await chmod(file, 0o755);
}

function init(dest: string, ...extra: string[]) {
	return runCli(["init", "--project", "project-1", "--dest", dest, ...extra]);
}

const CLAUDE_HOOK = path.join(".claude", "settings.local.json");
const CODEX_HOOK = path.join(".codex", "hooks.json");

describe("which coding tools init sets up", () => {
	it("writes a hook for every tool whose folder is in the checkout, in one run", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude"));
		await mkdir(path.join(dest, ".codex"));

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(await exists(path.join(dest, CLAUDE_HOOK))).toBe(true);
		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(true);
		expect(result.stdout).toBe(
			`${SET_UP} Claude Code and Codex fast-forward main at session start when safe. In Codex, run /hooks once to trust the project hook.\n`,
		);
	});

	it("takes one tool from the checkout's folder alone", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".codex"));

		const result = await init(dest);

		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(true);
		expect(await exists(path.join(dest, CLAUDE_HOOK))).toBe(false);
		expect(result.stdout).toBe(
			`${SET_UP} Codex fast-forwards main at session start when safe. In Codex, run /hooks once to trust the project hook.\n`,
		);
	});

	it("finds a tool by its folder in the home directory", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(home, ".claude"));

		const result = await init(dest);

		expect(await exists(path.join(dest, CLAUDE_HOOK))).toBe(true);
		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(false);
		expect(result.stdout).toBe(
			`${SET_UP} Claude Code fast-forwards main at session start when safe.\n`,
		);
	});

	it("finds a tool by its command on PATH, without running it", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await putOnPath("codex");

		await init(dest);

		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(true);
		expect(await exists(path.join(dest, CLAUDE_HOOK))).toBe(false);
	});

	it("falls back to Claude Code, and says so, when it finds no tool", async () => {
		const dest = await makeTree();
		inCheckout(dest);

		const result = await init(dest);

		expect(await exists(path.join(dest, CLAUDE_HOOK))).toBe(true);
		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(false);
		expect(result.stdout).toBe(
			[
				"No coding tool was found on this machine, so the Claude Code hook was written. Run again with --tool codex for Codex.",
				`${SET_UP} Claude Code fast-forwards main at session start when safe.`,
				"",
			].join("\n"),
		);
	});

	it("sets up only the tool named with --tool, whatever else is there", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude"));
		await mkdir(path.join(home, ".codex"));

		await init(dest, "--tool", "codex");

		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(true);
		expect(await exists(path.join(dest, CLAUDE_HOOK))).toBe(false);
	});

	it("replaces its own hook on a second run instead of stacking another", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude"));
		await mkdir(path.join(dest, ".codex"));
		await init(dest);

		const again = await init(dest);

		expect(again.code).toBe(0);
		for (const hook of [CLAUDE_HOOK, CODEX_HOOK]) {
			const settings = JSON.parse(
				await readFile(path.join(dest, hook), "utf8"),
			);
			expect(settings.hooks.SessionStart).toHaveLength(1);
		}
	});

	it("keeps --lessons for Claude Code and never writes a Stop hook for Codex", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude"));
		await mkdir(path.join(dest, ".codex"));

		const result = await init(dest, "--lessons");

		expect(result.code).toBe(0);
		const claude = JSON.parse(
			await readFile(path.join(dest, CLAUDE_HOOK), "utf8"),
		);
		const codex = JSON.parse(
			await readFile(path.join(dest, CODEX_HOOK), "utf8"),
		);
		expect(claude.hooks.Stop).toHaveLength(1);
		expect(codex.hooks.Stop).toBeUndefined();
		expect(result.stdout).toContain(
			"Added a Stop hook for lesson capture.",
		);
	});

	it("refuses --lessons when only Codex is found, before writing anything", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".codex"));

		const result = await init(dest, "--lessons");

		expect(result.code).toBe(2);
		expect(result.stderr).toContain(
			"--lessons is not yet supported for codex",
		);
		expect(await exists(path.join(dest, CODEX_HOOK))).toBe(false);
	});

	it("reports every hook in --format json", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude"));
		await mkdir(path.join(dest, ".codex"));

		const result = await init(dest, "--format", "json");

		const parsed = JSON.parse(result.stdout);
		expect(parsed.hooks.map((hook: { tool: string }) => hook.tool)).toEqual(
			["claude-code", "codex"],
		);
		expect(parsed.hookCommand).toBe(
			"fabric instructions sync --project project-1 --base-url https://fabric.pro --hook",
		);
		expect(parsed.lockRemoved).toBe(false);
	});
});

describe("files already in the folder", () => {
	it("leaves every existing file exactly as it was, including instruction files", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude", "rules"), { recursive: true });
		await writeFile(path.join(dest, "AGENTS.md"), "my own rules\n");
		await writeFile(path.join(dest, "CLAUDE.md"), "mine too\n");
		await writeFile(
			path.join(dest, ".claude", "rules", "lint.md"),
			"lint\n",
		);
		const before = await Promise.all(
			[
				"AGENTS.md",
				"CLAUDE.md",
				path.join(".claude", "rules", "lint.md"),
			].map(async (file) => ({
				file,
				text: await readFile(path.join(dest, file), "utf8"),
				mtime: (await stat(path.join(dest, file))).mtimeMs,
			})),
		);

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(mocks.createFileDownloadUrls).not.toHaveBeenCalled();
		for (const { file, text, mtime } of before) {
			expect(await readFile(path.join(dest, file), "utf8")).toBe(text);
			expect((await stat(path.join(dest, file))).mtimeMs).toBe(mtime);
		}
		expect((await readdir(dest)).sort()).toEqual([
			".claude",
			"AGENTS.md",
			"CLAUDE.md",
		]);
	});
});

describe("the lock an upload-era sync left", () => {
	const LOCK = path.join(".fabric", "instructions.lock");

	it("removes this project's lock in a checkout of the repository, says so in one line, and keeps the files", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await writeFile(path.join(dest, "AGENTS.md"), "tracked by git\n");
		await seedLock(dest, "d".repeat(64), {
			"AGENTS.md": { sha256: "e".repeat(64), mode: 0o100644 },
		});

		const result = await init(dest, "--tool", "claude-code");

		expect(await exists(path.join(dest, LOCK))).toBe(false);
		expect(await exists(path.join(dest, ".fabric"))).toBe(false);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"tracked by git\n",
		);
		expect(result.stdout).toBe(
			`Removed .fabric/instructions.lock: this checkout follows ${NAME} through git now.\n${SET_UP} Claude Code fast-forwards main at session start when safe.\n`,
		);
	});

	it("leaves another project's lock where it is, without a word", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await seedLock(dest, "d".repeat(64), {}, "project-A");

		const result = await init(dest, "--tool", "claude-code");

		expect(await exists(path.join(dest, LOCK))).toBe(true);
		expect(result.stdout).not.toContain("Removed");
	});

	it("leaves a lock it cannot read where it is", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".fabric"));
		await writeFile(path.join(dest, LOCK), "{ not json");

		const result = await init(dest, "--tool", "claude-code");

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, LOCK), "utf8")).toBe(
			"{ not json",
		);
	});
});

describe(".git/info/exclude", () => {
	async function excludeFile(): Promise<string> {
		const dir = await makeTree();
		const file = path.join(dir, "info", "exclude");
		fakeGit.state.excludeFile = file;
		fakeGit.state.ignoreEverything = false;
		return file;
	}

	it("gets the hook files of every tool set up, and .gitignore is never touched", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		await mkdir(path.join(dest, ".claude"));
		await mkdir(path.join(dest, ".codex"));
		const file = await excludeFile();

		const result = await init(dest);

		expect(await readFile(file, "utf8")).toBe(
			"/.claude/settings.local.json\n/.codex/hooks.json\n",
		);
		expect(await exists(path.join(dest, ".gitignore"))).toBe(false);
		expect(result.stdout).not.toContain("exclude");
	});

	it("adds only what git does not already ignore", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		const file = await excludeFile();
		fakeGit.state.ignored = [".claude/settings.local.json"];

		await init(dest, "--tool", "claude-code");

		expect(await exists(file)).toBe(false);
	});

	it("adds the lock directory too for an uploaded project", async () => {
		const dest = await makeTree();
		fakeGit.state.toplevel = dest;
		const file = await excludeFile();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		await init(dest, "--tool", "claude-code");

		expect(await readFile(file, "utf8")).toBe(
			"/.claude/settings.local.json\n/.fabric\n",
		);
	});

	it("is not asked about at all in a folder that is not a git checkout", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await init(dest, "--tool", "claude-code");

		expect(result.code).toBe(0);
		expect(fakeGit.calls).not.toContain("isIgnored");
	});

	it("names the entries to add by hand when git cannot say where its exclude file is", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		fakeGit.state.ignoreEverything = false;
		fakeGit.state.excludeFile = null;

		const result = await init(dest, "--tool", "claude-code");

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			`Could not update .git/info/exclude. Add these to your own ignore rules: /.claude/settings.local.json\n${SET_UP} Claude Code fast-forwards main at session start when safe.\n`,
		);
	});
});

describe("a project whose instructions live in a subfolder", () => {
	it("prefixes the exclude entries with the folder", async () => {
		const toplevel = await makeTree();
		const dest = path.join(toplevel, "docs", "ai");
		await mkdir(dest, { recursive: true });
		fakeGit.state.toplevel = toplevel;
		fakeGit.state.remotes = {
			origin: "https://github.com/example-org/rules.git",
		};
		fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
		fakeGit.state.ignoreEverything = false;
		const file = path.join(await makeTree(), "exclude");
		fakeGit.state.excludeFile = file;
		mocks.getPublished.mockResolvedValue({
			...served(),
			repository: { ...REPOSITORY, rootPath: "docs/ai" },
		});

		const result = await init(dest, "--tool", "claude-code");

		expect(result.code).toBe(0);
		expect(await readFile(file, "utf8")).toBe(
			"/docs/ai/.claude/settings.local.json\n",
		);
	});
});

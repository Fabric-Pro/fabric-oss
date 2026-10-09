/**
 * `fabric instructions init --clone <folder>`: clone the project's repository
 * into a folder of its own and finish setting up inside it, in one run.
 *
 * The folder is made when it is missing, may exist only when it is empty, and
 * is refused before any request is made when it holds anything. A project
 * whose instructions live in a folder of the repository is set up there. The
 * SDK is mocked at `getClient` and git is scripted through
 * `helpers/git-fake.ts`, as in `instructions-repository.test.ts`.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGit } from "./helpers/git-fake.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
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

const NAME = "git.example.com/example-org/rules";

const REPOSITORY = {
	provider: "GITHUB" as const,
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};

/** A repository project with nothing published from it yet: all `init` needs. */
function repositoryProject(rootPath = "") {
	return {
		published: false,
		sourceOfTruth: "REPOSITORY",
		repository: { ...REPOSITORY, rootPath },
	};
}

/** The folder as `init` spells it behind a typed `--dest`: forward slashes. */
const typed = (folder: string): string => folder.replace(/\\/g, "/");

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

function init(parent: string, ...extra: string[]) {
	return runCli([
		"init",
		"--project",
		"project-1",
		"--tool",
		"claude-code",
		"--dest",
		parent,
		...extra,
	]);
}

describe("init --clone <folder>", () => {
	it("makes the folder, clones into it, and sets it up in the same run", async () => {
		const parent = await makeTree();
		mocks.getPublished.mockResolvedValue(repositoryProject());

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toHaveLength(1);
		expect(path.basename(fakeGit.clones[0]?.dir ?? "")).toBe("rules");
		expect(
			await exists(
				path.join(parent, "rules", ".claude", "settings.local.json"),
			),
		).toBe(true);
		expect(result.stdout).toBe(
			`Nothing has been published from ${NAME} yet; the hook reports once it is.\nCloned into ${typed(parent)}/rules. Open your coding tool in that folder.\nSet up for ${NAME} (main). Claude Code fast-forwards main at session start when safe.\n`,
		);
		expect(result.stdout).not.toContain("Run:");
	});

	it("takes a folder that exists and is empty", async () => {
		const parent = await makeTree();
		await mkdir(path.join(parent, "rules"));
		mocks.getPublished.mockResolvedValue(repositoryProject());

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toHaveLength(1);
	});

	it("clones into a missing target inside another checkout without adopting the parent", async () => {
		const parent = await makeTree();
		mocks.getPublished.mockResolvedValue(repositoryProject());
		fakeGit.state.toplevel = parent;
		fakeGit.state.remotes = {
			origin: "https://git.example.com/example-org/other",
		};

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toHaveLength(1);
	});

	it("finishes in the folder of the repository the project's instructions live in", async () => {
		const parent = await makeTree();
		mocks.getPublished.mockResolvedValue(repositoryProject("docs/ai"));
		fakeGit.state.cloneCreates = ["docs/ai"];

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(0);
		expect(
			await exists(
				path.join(
					parent,
					"rules",
					"docs",
					"ai",
					".claude",
					"settings.local.json",
				),
			),
		).toBe(true);
		expect(
			await exists(
				path.join(parent, "rules", ".claude", "settings.local.json"),
			),
		).toBe(false);
		expect(result.stdout).toContain(
			`Cloned into ${typed(parent)}/rules/docs/ai.`,
		);
		expect(result.stdout).not.toContain("Run:");
	});

	it("leaves a non-Git folder alone after identifying the repository", async () => {
		const parent = await makeTree();
		await mkdir(path.join(parent, "rules"));
		await writeFile(path.join(parent, "rules", "notes.txt"), "mine\n");
		mocks.getPublished.mockResolvedValue(repositoryProject());

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(7);
		expect(result.stderr).toBe(
			`✗ This folder is not a clone of ${NAME}. Run: fabric instructions init --project project-1 --tool claude-code --clone rules\n`,
		);
		expect(mocks.getPublished).toHaveBeenCalledOnce();
		expect(fakeGit.clones).toEqual([]);
		expect(await readdir(path.join(parent, "rules"))).toEqual([
			"notes.txt",
		]);
	});

	it("reuses an exact existing clone without replacing its files", async () => {
		const parent = await makeTree();
		const folder = path.join(parent, "rules");
		await mkdir(folder);
		await writeFile(path.join(folder, "notes.txt"), "mine\n");
		mocks.getPublished.mockResolvedValue(repositoryProject());
		fakeGit.state.toplevel = folder;
		fakeGit.state.remotes = {
			origin: "https://git.example.com/example-org/rules",
		};

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toEqual([]);
		expect(await exists(path.join(folder, "notes.txt"))).toBe(true);
		expect(result.stdout).not.toContain("Cloned into");
	});

	it("does not touch an existing clone with the interrupted-checkout signature", async () => {
		const parent = await makeTree();
		const folder = path.join(parent, "rules");
		await mkdir(folder);
		await writeFile(path.join(folder, "AGENTS.md"), "partial\n");
		mocks.getPublished.mockResolvedValue(repositoryProject());
		fakeGit.state.toplevel = folder;
		fakeGit.state.remotes = {
			origin: "https://git.example.com/example-org/rules",
		};
		fakeGit.state.incompleteCheckout = true;

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(7);
		expect(result.stderr).toBe(
			"✗ This folder appears to be an incomplete Git checkout. Fabric left it untouched. Inspect its staged and untracked files with git status, then repair or remove the checkout yourself before running init again.\n",
		);
		expect(fakeGit.clones).toEqual([]);
		expect(
			await exists(path.join(folder, ".claude", "settings.local.json")),
		).toBe(false);
	});

	it("refuses a name that is a file", async () => {
		const parent = await makeTree();
		await writeFile(path.join(parent, "rules"), "a file\n");

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(7);
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("needs --project: there is no checkout yet to find it from", async () => {
		const parent = await makeTree();

		const result = await runCli([
			"init",
			"--tool",
			"claude-code",
			"--dest",
			parent,
			"--clone",
			"rules",
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"✗ --clone <folder> needs --project <id>: there is no checkout yet to find the project from.\n",
		);
		expect(mocks.getPublished).not.toHaveBeenCalled();
		expect(await readdir(parent)).toEqual([]);
	});

	it("says there is nothing to clone for a project whose instructions are uploaded, and makes no folder", async () => {
		const parent = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(7);
		expect(result.stderr).toBe(
			"✗ --clone needs a project whose instructions come from a git repository; this project's are uploaded, so there is nothing to clone.\n",
		);
		expect(fakeGit.clones).toEqual([]);
		expect(await readdir(parent)).toEqual([]);
	});

	it("writes no hook when the clone fails", async () => {
		const parent = await makeTree();
		mocks.getPublished.mockResolvedValue(repositoryProject());
		fakeGit.state.cloneResult = { kind: "failed", reason: "auth" };

		const result = await init(parent, "--clone", "rules");

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Could not clone ${NAME}: git has no credentials for git.example.com. The Fabric MCP server was not registered. Run: gh auth login\n`,
		);
		expect(
			await exists(
				path.join(parent, "rules", ".claude", "settings.local.json"),
			),
		).toBe(false);
	});

	it("leaves a bare --clone as it was: into the folder it is run in, when that is empty", async () => {
		const parent = await makeTree();
		mocks.getPublished.mockResolvedValue(repositoryProject());

		const result = await init(parent, "--clone");

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toHaveLength(1);
		expect(
			await exists(path.join(parent, ".claude", "settings.local.json")),
		).toBe(true);
		expect(result.stdout).not.toContain("Cloned into");
	});
});

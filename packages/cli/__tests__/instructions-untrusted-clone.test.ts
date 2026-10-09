/**
 * Where `init` clones from, and what is printed about it (Fizzy #2878). The
 * clone URL, the branch name and the host come from the deployment's answers:
 *
 *   - the clone URL must name the repository the person is shown, on the
 *     default port, or there is nothing to clone and nobody is asked;
 *   - the URL in a suggested command is shell-quoted, and the branch name and
 *     host in a sentence have their control characters taken out.
 *
 * The SDK is mocked at `getClient`, git is scripted through
 * `helpers/git-fake.ts`, and the terminal is whatever each test makes it.
 */
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGit } from "./helpers/git-fake.js";
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
		resolveCheckout: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
		canPrompt: vi.fn<() => boolean>(),
		confirm: vi.fn<(question: string) => Promise<boolean>>(),
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

vi.mock("../src/lib/instructions/prompt.js", () => ({
	canPrompt: () => mocks.canPrompt(),
	confirm: (question: string) => mocks.confirm(question),
	chooseProject: vi.fn(async () => null),
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
			resolveCheckout: mocks.resolveCheckout,
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

beforeEach(() => {
	resetInstructionsMocks(mocks);
	mocks.resolveCheckout.mockReset();
	mocks.canPrompt.mockReset();
	mocks.canPrompt.mockReturnValue(false);
	mocks.confirm.mockReset();
	mocks.confirm.mockResolvedValue(true);
	fakeGit.reset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const PUBLISHED_SHA = "a".repeat(40);
const FILE = manifestEntry("AGENTS.md", "published\n");
const NAME = "github.com/example-org/rules";

interface Repository {
	provider: "GITHUB" | "GITLAB";
	host: string;
	path: string;
	ref: string;
	rootPath: string;
	generation: number;
	cloneUrl?: string | null;
}

const GITHUB: Repository = {
	provider: "GITHUB",
	host: "github.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
};

function served(repository: Repository) {
	return {
		published: true,
		sourceOfTruth: "REPOSITORY",
		snapshot: {
			...snapshotFor([FILE], 7),
			source: {
				kind: "REPOSITORY",
				ref: repository.ref,
				commitSha: PUBLISHED_SHA,
				current: true,
			},
		},
		unchanged: false,
		changes: null,
		manifest: [FILE],
		repository,
	};
}

function init(dest: string, ...extra: string[]) {
	return runCli([
		"init",
		"--project",
		"project-1",
		"--tool",
		"claude-code",
		"--dest",
		dest,
		...extra,
	]);
}

// ---------------------------------------------------------------------------
// the clone destination
// ---------------------------------------------------------------------------
describe("where init clones from", () => {
	it.each([
		["another host on a port", "https://attacker.example:8443/x/y"],
		[
			"another host with the same path",
			"https://attacker.example/example-org/rules",
		],
		[
			"this host and another repository",
			"https://github.com/someone-else/rules",
		],
		["this host on a port", "https://github.com:8443/example-org/rules"],
	])(
		"never clones from %s, and nobody is asked",
		async (_label, cloneUrl) => {
			const dest = await makeTree();
			mocks.canPrompt.mockReturnValue(true);
			mocks.getPublished.mockResolvedValue(
				served({ ...GITHUB, cloneUrl }),
			);

			const result = await init(dest, "--clone");

			expect(result.code).toBe(7);
			expect(result.stderr).toBe(
				`✗ This deployment did not say where to clone ${NAME} from. Clone it yourself, then run: fabric instructions init\n`,
			);
			expect(fakeGit.clones).toEqual([]);
			expect(mocks.confirm).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([]);
			expect(`${result.stdout}${result.stderr}`).not.toContain(
				"attacker",
			);
		},
	);

	it("does not ask at a terminal either, when the URL it was given is another repository", async () => {
		const dest = await makeTree();
		mocks.canPrompt.mockReturnValue(true);
		mocks.getPublished.mockResolvedValue(
			served({ ...GITHUB, cloneUrl: "https://attacker.example/x/y" }),
		);

		const result = await init(dest);

		expect(result.code).toBe(7);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(fakeGit.clones).toEqual([]);
	});

	it("clones from a URL that names the repository it shows, whatever the capitalisation and suffix", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(
			served({
				...GITHUB,
				cloneUrl: "https://GitHub.com/Example-Org/Rules.git",
			}),
		);

		const result = await init(dest, "--clone");

		expect(result.code).toBe(0);
		expect(fakeGit.clones).toHaveLength(1);
		expect(fakeGit.clones[0]?.url).toBe(
			"https://github.com/Example-Org/Rules.git",
		);
	});

	it("asks at a terminal about the repository it is about to clone", async () => {
		const dest = await makeTree();
		mocks.canPrompt.mockReturnValue(true);
		mocks.getPublished.mockResolvedValue(
			served({
				...GITHUB,
				cloneUrl: "https://github.com/example-org/rules",
			}),
		);

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(mocks.confirm).toHaveBeenCalledWith(
			`Clone ${NAME} (main) into this folder?`,
		);
		expect(fakeGit.clones).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// the URL in a suggested command
// ---------------------------------------------------------------------------
describe("a clone URL in a suggested command", () => {
	const SUBSHELL: Repository = {
		provider: "GITLAB",
		host: "x.example",
		path: "group/$(id)",
		ref: "main",
		rootPath: "",
		generation: 1,
		cloneUrl: "https://x.example/group/$(id)",
	};

	it("is shell-quoted when the folder is not a clone", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(served(SUBSHELL));
		await writeFile(path.join(dest, "notes.txt"), "mine\n", "utf8");

		const result = await init(dest);

		expect(result.code).toBe(7);
		expect(result.stderr).toBe(
			"✗ This folder is not a clone of x.example/group/$(id). Run: fabric instructions init --project project-1 --tool claude-code --clone '$(id)'\n",
		);
	});

	it("is shell-quoted when a clone fails for a reason git has to say", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(served(SUBSHELL));
		fakeGit.state.cloneResult = { kind: "failed", reason: "other" };

		const result = await init(dest, "--clone");

		expect(result.code).toBe(1);
		expect(result.stderr).toBe(
			"✗ Could not clone x.example/group/$(id). The Fabric MCP server was not registered. Run: git clone -- 'https://x.example/group/$(id)' to see why.\n",
		);
	});
});

// ---------------------------------------------------------------------------
// a branch name from the deployment
// ---------------------------------------------------------------------------
describe("a branch name the deployment supplied", () => {
	const ESCAPE = "main\u009b31m";

	it("has its control characters taken out of the line that says how to clone", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(
			served({ ...GITHUB, ref: ESCAPE }),
		);

		const result = await init(dest);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			`✗ This folder is empty. Run: fabric instructions init --clone to clone ${NAME} (main 31m) into it.\n`,
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("\u009b");
	});

	it("has them taken out of the question asked at a terminal", async () => {
		const dest = await makeTree();
		mocks.canPrompt.mockReturnValue(true);
		mocks.confirm.mockResolvedValue(false);
		mocks.getPublished.mockResolvedValue(
			served({ ...GITHUB, ref: ESCAPE }),
		);

		await init(dest);

		expect(mocks.confirm).toHaveBeenCalledWith(
			`Clone ${NAME} (main 31m) into this folder?`,
		);
	});

	it("has them taken out of the line that says the branch is missing", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue(
			served({ ...GITHUB, ref: ESCAPE }),
		);
		fakeGit.state.cloneResult = { kind: "failed", reason: "missing-ref" };

		const result = await init(dest, "--clone");

		expect(result.code).toBe(7);
		expect(result.stderr).toBe(
			`✗ Could not clone ${NAME}: it has no branch main 31m. The Fabric MCP server was not registered.\n`,
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("\u009b");
	});
});

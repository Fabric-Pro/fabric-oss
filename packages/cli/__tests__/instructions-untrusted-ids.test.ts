/**
 * A project id and an organization slug are plain identifiers wherever they
 * cross into a command line, a request or a line of output (Fizzy #2878): the
 * option parser and the resolver's answer both refuse anything else, and
 * nothing of a refused id is printed or written.
 *
 * The SDK is mocked at `getClient` and git is scripted through
 * `helpers/git-fake.ts`.
 */
import { readdir, readFile } from "node:fs/promises";
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
function match(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "project-9",
		projectName: "Rules",
		organizationSlug: "example-org",
		provider: "GITHUB",
		host: "github.com",
		path: "example-org/rules",
		ref: "main",
		rootPath: "",
		cloneUrl: "https://github.com/example-org/rules",
		...overrides,
	};
}

function inCheckout(dest: string): void {
	fakeGit.state.toplevel = dest;
	fakeGit.state.remotes = {
		origin: "https://github.com/example-org/rules.git",
	};
	fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
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
// ids
// ---------------------------------------------------------------------------
describe("a project id and an organization slug", () => {
	const HOSTILE = "x; touch pwned #";

	it("is refused from the resolver's answer, with no hook, and never printed", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.resolveCheckout.mockResolvedValue({
			matches: [match({ projectId: HOSTILE })],
		});

		const result = await runCli([
			"init",
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(4);
		expect(result.stderr).toBe(
			"✗ This checkout's remote (github.com/example-org/rules) is not connected to any project you can see. Connect the repository in Fabric first.\n",
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("pwned");
		expect(await readdir(dest)).toEqual([]);
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("is refused from the resolver's answer even when another match is fine", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.resolveCheckout.mockResolvedValue({
			matches: [
				match({ projectId: "project-ok", rootPath: "" }),
				match({ projectId: HOSTILE, rootPath: "docs" }),
			],
		});

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(4);
		expect(`${result.stdout}${result.stderr}`).not.toContain("pwned");
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it.each([
		["a shell command", HOSTILE],
		["a space", "project 1"],
		["a newline", "project-1\nfabric"],
		["a leading dash", "-project"],
		["a leading dot", ".hidden"],
		["a long id", "p".repeat(65)],
		["nothing", ""],
	])("is refused from --project when it is %s", async (_label, project) => {
		const dest = await makeTree();

		const result = await runCli([
			"init",
			"--project",
			project,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"✗ --project must be a project id: letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters.\n",
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("pwned");
		expect(mocks.getPublished).not.toHaveBeenCalled();
		expect(await readdir(dest)).toEqual([]);
	});

	it("is refused from --org, with no hook written", async () => {
		const dest = await makeTree();

		const result = await init(dest, "--org", HOSTILE);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"✗ --org must be an organization slug: letters, digits, '.', '_' or '-', starting with a letter or digit, at most 64 characters.\n",
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("pwned");
		expect(await readdir(dest)).toEqual([]);
	});

	it("is a skip, not a failure, from a hook that names a hostile id", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"check",
			"--project",
			HOSTILE,
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--project must be a project id");
		expect(result.stderr).not.toContain("pwned");
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it.each([
		"project-1",
		"Project_1.v2",
		"a",
		"0123456789012345678901234567890123456789012345678901234567890123",
	])("accepts %s", async (project) => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"init",
			"--project",
			project,
			"--tool",
			"claude-code",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
	});

	it("has its text taken out of a list the person reads", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.resolveCheckout.mockResolvedValue({
			matches: [
				match({
					projectId: "project-a",
					organizationSlug: "org\u009b31m",
					projectName: `Rules${String.fromCodePoint(0x2028)}A`,
				}),
				match({ projectId: "project-b", projectName: "Rules B" }),
			],
		});

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("project-a");
		expect(result.stderr).not.toContain("\u009b");
		expect(result.stderr).not.toContain(String.fromCodePoint(0x2028));
	});
});

describe("a remote name", () => {
	const HOSTILE = "x; touch pwned #";

	it.each([
		["a shell command", HOSTILE],
		["a command substitution", "$(id)"],
		["a space", "my remote"],
		["a newline", "origin\nfabric"],
		["an option", "-oProxyCommand=x"],
		["an absolute path", "/srv/git"],
		["nothing", ""],
	])(
		"is refused from --remote when it is %s, and no hook is written",
		async (_label, remote) => {
			const dest = await makeTree();
			mocks.getPublished.mockResolvedValue({
				published: false,
				sourceOfTruth: "UPLOAD",
			});

			const result = await init(dest, "--remote", remote);

			expect(result.code).toBe(2);
			expect(result.stderr).toBe(
				"✗ --remote must be the name of a git remote: letters, digits, '.', '_', '-' and '/', starting with a letter, digit, '.' or '_'.\n",
			);
			expect(`${result.stdout}${result.stderr}`).not.toContain("pwned");
			expect(mocks.getPublished).not.toHaveBeenCalled();
			expect(await readdir(dest)).toEqual([]);
		},
	);

	it("is a skip, not a failure, from a hook that names a hostile remote", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--remote",
			HOSTILE,
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"--remote must be the name of a git remote",
		);
		expect(result.stderr).not.toContain("pwned");
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("is carried into the hook when it is a plain remote name", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await init(dest, "--remote", "upstream");

		expect(result.code).toBe(0);
		const hooks = JSON.parse(
			await readFile(
				path.join(dest, ".claude", "settings.local.json"),
				"utf8",
			),
		);
		expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(
			"fabric instructions check --project project-1 --base-url https://fabric.pro --remote upstream --hook",
		);
	});
});

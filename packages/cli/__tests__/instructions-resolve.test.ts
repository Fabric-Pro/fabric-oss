/**
 * `fabric instructions check|sync|init|doctor|push` with no `--project`
 * (Fizzy #2878): the project is found from the checkout's own remotes, the
 * deployment's resolver is asked about them, and the folder the command runs
 * in narrows an answer with several projects before anybody is asked.
 *
 * The SDK is mocked at `getClient` and git is scripted through
 * `helpers/git-fake.ts`, so nothing here depends on the machine's git.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseProject } from "../src/lib/instructions/prompt.js";
import { resolveProjectFromCheckout } from "../src/lib/instructions/resolve-project.js";
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
	fakeGit.reset();
});

afterEach(() => {
	vi.unstubAllGlobals();
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

function match(
	overrides: Partial<{
		projectId: string;
		projectName: string;
		organizationSlug: string | null;
		rootPath: string;
	}> = {},
) {
	return {
		projectId: "project-9",
		projectName: "Rules",
		organizationSlug: "example-org",
		provider: "GITHUB" as const,
		host: "github.com",
		path: "example-org/rules",
		ref: "main",
		rootPath: "",
		cloneUrl: "https://github.com/example-org/rules",
		...overrides,
	};
}

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

function inCheckout(
	dest: string,
	remotes: Record<string, string | null> = {
		origin: "https://github.com/example-org/rules.git",
	},
): void {
	fakeGit.state.toplevel = dest;
	fakeGit.state.remotes = remotes;
	fakeGit.state.ancestors = { [PUBLISHED_SHA]: true };
}

/**
 * `user@host` joined at runtime: the publication scan reads any literal
 * user, at-sign and dotted host as an email address.
 */
const withUser = (user: string, rest: string): string => [user, rest].join("@");

describe("a command run with no --project", () => {
	it.each(["check", "sync"])(
		"%s finds the project from the checkout's remote and carries on with it",
		async (verb) => {
			const dest = await makeTree();
			inCheckout(dest);
			mocks.resolveCheckout.mockResolvedValue({ matches: [match()] });
			mocks.getPublished.mockResolvedValue(served());

			const result = await runCli([verb, "--dest", dest]);

			expect(result.code).toBe(0);
			expect(mocks.resolveCheckout).toHaveBeenCalledWith([
				"https://github.com/example-org/rules",
			]);
			expect(mocks.getPublished).toHaveBeenCalledWith(
				"project-9",
				expect.anything(),
			);
			expect(mocks.withoutContext).toHaveBeenCalled();
		},
	);

	it("asks about every remote once, however many spell the same repository", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: withUser("git", "github.com:example-org/rules.git"),
			upstream: "https://github.com/example-org/rules",
			fork: "https://github.com/someone-else/rules.git",
		});
		mocks.resolveCheckout.mockResolvedValue({ matches: [match()] });
		mocks.getPublished.mockResolvedValue(served());

		await runCli(["check", "--dest", dest]);

		expect(mocks.resolveCheckout).toHaveBeenCalledWith([
			"https://github.com/example-org/rules",
			"https://github.com/someone-else/rules",
		]);
	});

	it("sends no candidate the resolver would refuse for its length", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: `https://github.com/example-org/${"r".repeat(600)}`,
			fork: "https://github.com/someone-else/rules.git",
		});
		mocks.resolveCheckout.mockResolvedValue({ matches: [match()] });
		mocks.getPublished.mockResolvedValue(served());

		await runCli(["check", "--dest", dest]);

		expect(mocks.resolveCheckout).toHaveBeenCalledWith([
			"https://github.com/someone-else/rules",
		]);
	});

	it("looks at one remote only with --remote", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: "https://github.com/example-org/rules.git",
			fork: "https://github.com/someone-else/rules.git",
		});
		mocks.resolveCheckout.mockResolvedValue({ matches: [match()] });
		mocks.getPublished.mockResolvedValue(served());

		await runCli(["check", "--dest", dest, "--remote", "fork"]);

		expect(mocks.resolveCheckout).toHaveBeenCalledWith([
			"https://github.com/someone-else/rules",
		]);
	});

	it("says so when the named remote does not exist", async () => {
		const dest = await makeTree();
		inCheckout(dest);

		const result = await runCli([
			"check",
			"--dest",
			dest,
			"--remote",
			"nope",
		]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"✗ This checkout has no remote named nope. Run again with a remote it has, or with --project <id>.\n",
		);
		expect(mocks.resolveCheckout).not.toHaveBeenCalled();
	});

	it("takes the project whose folder the command runs in when several share the repository", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.resolveCheckout.mockResolvedValue({
			matches: [
				match({ projectId: "project-docs", rootPath: "docs" }),
				match({ projectId: "project-root", rootPath: "" }),
			],
		});
		mocks.getPublished.mockResolvedValue(served());

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(0);
		expect(mocks.getPublished).toHaveBeenCalledWith(
			"project-root",
			expect.anything(),
		);
	});

	it("lists the --project choices and exits 2 when several remain and nobody can be asked", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.resolveCheckout.mockResolvedValue({
			matches: [
				match({ projectId: "project-a", projectName: "Rules A" }),
				match({ projectId: "project-b", projectName: "Rules B" }),
			],
		});

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			[
				"✗ This repository is connected to 2 projects. Run again with one of:",
				"  --project project-a   example-org/Rules A",
				"  --project project-b   example-org/Rules B",
				"",
			].join("\n"),
		);
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("names the repository and exits 4 when no project you can see uses it", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.resolveCheckout.mockResolvedValue({ matches: [] });

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(4);
		expect(result.stderr).toBe(
			"✗ This checkout's remote (github.com/example-org/rules) is not connected to any project you can see. Connect the repository in Fabric first.\n",
		);
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("does not ask the deployment about a host it cannot have connected", async () => {
		const dest = await makeTree();
		inCheckout(dest, {
			origin: "https://git.example.com/example-org/rules.git",
		});

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(4);
		expect(result.stderr).toContain(
			"remote (git.example.com/example-org/rules) is not connected",
		);
		expect(mocks.resolveCheckout).not.toHaveBeenCalled();
	});

	it("says to pass --project outside a git checkout", async () => {
		const dest = await makeTree();

		const result = await runCli(["sync", "--dest", dest]);

		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"✗ This folder is not a git checkout, so its project cannot be found. Run: fabric instructions sync --project <id>\n",
		);
	});

	it("says to pass --project in a checkout with no remote", async () => {
		const dest = await makeTree();
		inCheckout(dest, {});

		const result = await runCli(["check", "--dest", dest]);

		expect(result.code).toBe(2);
		expect(result.stderr).toContain("has no remote");
	});

	it("never resolves under --hook: the hook names its project", async () => {
		const dest = await makeTree();
		inCheckout(dest);

		const result = await runCli(["check", "--dest", dest, "--hook"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"fabric: coding instructions check skipped: this hook names no project. Run: fabric instructions init\n",
		);
		expect(mocks.resolveCheckout).not.toHaveBeenCalled();
	});

	it("keeps an explicit --project as the override and resolves nothing", async () => {
		const dest = await makeTree();
		inCheckout(dest);
		mocks.getPublished.mockResolvedValue(served());

		await runCli(["check", "--project", "project-1", "--dest", dest]);

		expect(mocks.resolveCheckout).not.toHaveBeenCalled();
		expect(mocks.getPublished).toHaveBeenCalledWith(
			"project-1",
			expect.anything(),
		);
	});
});

describe("--base-url", () => {
	it("sends the deployment's origin to the client, whatever path it was given with", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--base-url",
			"https://example.com/app/",
		]);

		expect(mocks.getClient).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: "https://example.com" }),
		);
	});

	it.each(["not a url", "ftp://example.com", ""])(
		"refuses %j",
		async (value) => {
			const dest = await makeTree();

			const result = await runCli([
				"check",
				"--project",
				"project-1",
				"--dest",
				dest,
				"--base-url",
				value,
			]);

			expect(result.code).toBe(2);
			expect(result.stderr).toBe(
				"✗ The deployment address is not a URL. Use --base-url https://example.com\n",
			);
			expect(mocks.getPublished).not.toHaveBeenCalled();
		},
	);
});

describe("resolveProjectFromCheckout with a person to ask", () => {
	const input = (
		dest: string,
		choose: (p: unknown[]) => Promise<number | null>,
	) => ({
		destination: dest,
		verb: "check",
		deadline: Date.now() + 5_000,
		deps: {
			resolveCheckout: async () => ({
				matches: [
					match({ projectId: "project-a", projectName: "Rules A" }),
					match({ projectId: "project-b", projectName: "Rules B" }),
				],
			}),
			choose,
		},
	});

	it("returns the project they pick", async () => {
		const dest = await makeTree();
		inCheckout(dest);

		const picked = await resolveProjectFromCheckout(
			input(dest, async () => 1),
		);

		expect(picked.projectId).toBe("project-b");
	});

	it("lists the choices when they pick nothing valid", async () => {
		const dest = await makeTree();
		inCheckout(dest);

		await expect(
			resolveProjectFromCheckout(input(dest, async () => null)),
		).rejects.toMatchObject({ exitCode: 2 });
	});
});

describe("chooseProject", () => {
	async function answer(typed: string) {
		const reply = new PassThrough();
		const shown = new PassThrough();
		let output = "";
		shown.on("data", (chunk) => {
			output += String(chunk);
		});
		const choice = chooseProject(
			[
				{ id: "project-a", label: "example-org/Rules A" },
				{ id: "project-b", label: "example-org/Rules B" },
			],
			{ input: reply, output: shown },
		);
		reply.write(`${typed}\n`);
		return { index: await choice, output };
	}

	it("lists the projects and returns the zero-based index of the number typed", async () => {
		const { index, output } = await answer("2");

		expect(index).toBe(1);
		expect(output).toContain("  [1] example-org/Rules A");
		expect(output).toContain("  [2] example-org/Rules B");
	});

	it.each(["", "0", "3", "b", "1.5", "-1"])(
		"returns null for %j",
		async (typed) => {
			expect((await answer(typed)).index).toBeNull();
		},
	);
});

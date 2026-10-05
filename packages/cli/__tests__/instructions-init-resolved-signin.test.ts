/**
 * `init` with no `--project` finds the project from the checkout's remote, and
 * finding it can use whatever credential there is, an organization-wide
 * sign-in perhaps. The setup that follows relies on the project's own sign-in,
 * so `init` checks again once the project is known: a key or that project's
 * sign-in passes, an organization-wide sign-in does not.
 *
 * The SDK is mocked at `getClient`, git is scripted through `helpers/git-fake`,
 * and the browser sign-in at `signInWithBrowser`.
 */
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
		getApiKey:
			vi.fn<(origin?: string, project?: string) => string | undefined>(),
		getOAuth: vi.fn<(origin?: string, project?: string) => unknown>(),
		hasStoredApiKey: vi.fn<(origin?: string) => boolean>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
		signInWithBrowser: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: mocks.getOAuth,
	hasStoredApiKey: mocks.hasStoredApiKey,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/oauth/sign-in.js", () => ({
	signInWithBrowser: mocks.signInWithBrowser,
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

const ORIGIN = "https://fabric.pro";
const PROJECT = "project-9";

let hasKey: boolean;
let organizationSignIn: boolean;
let projectSignIns: Set<string>;

beforeEach(() => {
	resetInstructionsMocks(mocks);
	mocks.resolveCheckout.mockReset();
	mocks.signInWithBrowser.mockReset();
	fakeGit.reset();
	hasKey = false;
	organizationSignIn = true;
	projectSignIns = new Set();
	mocks.getApiKey.mockImplementation((_origin, project) =>
		hasKey ||
		organizationSignIn ||
		(project !== undefined && projectSignIns.has(project))
			? "fab_test"
			: undefined,
	);
	mocks.hasStoredApiKey.mockReset();
	mocks.hasStoredApiKey.mockImplementation(() => hasKey);
	mocks.getOAuth.mockReset();
	mocks.getOAuth.mockImplementation((_origin, project) => {
		if (project === undefined) {
			return organizationSignIn ? { accessToken: "fat_org" } : undefined;
		}
		return projectSignIns.has(project)
			? { accessToken: "fat_project" }
			: undefined;
	});
	mocks.getPublished.mockResolvedValue({
		published: false,
		sourceOfTruth: "UPLOAD",
	});
	mocks.resolveCheckout.mockResolvedValue({
		matches: [
			{
				projectId: PROJECT,
				projectName: "Rules",
				organizationSlug: "example-org",
				provider: "GITHUB",
				host: "github.com",
				path: "example-org/rules",
				ref: "main",
				rootPath: "",
				cloneUrl: "https://github.com/example-org/rules",
			},
		],
	});
	vi.stubEnv("CI", "");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function init() {
	const dest = await makeTree();
	fakeGit.state.toplevel = dest;
	fakeGit.state.remotes = {
		origin: "https://github.com/example-org/rules.git",
	};
	return runCli(["init", "--tool", "claude-code", "--dest", dest]);
}

describe("init with no --project, once the checkout has named one", () => {
	it("signs in for that project when only an organization-wide sign-in is stored", async () => {
		mocks.signInWithBrowser.mockImplementation(async () => {
			projectSignIns.add(PROJECT);
			return { name: "Dev", email: "dev@example.com" };
		});

		const result = await init();

		expect(result.code).toBe(0);
		expect(mocks.resolveCheckout).toHaveBeenCalledOnce();
		expect(mocks.signInWithBrowser).toHaveBeenCalledOnce();
		expect(mocks.signInWithBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ origin: ORIGIN, project: PROJECT }),
		);
		expect(result.stderr).toContain(
			`Signed in to ${ORIGIN} for project ${PROJECT} as Dev.`,
		);
		expect(mocks.getPublished).toHaveBeenCalledWith(
			PROJECT,
			expect.anything(),
		);
	});

	it("does not sign in again when the project has a sign-in of its own", async () => {
		projectSignIns.add(PROJECT);

		const result = await init();

		expect(result.code).toBe(0);
		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
	});

	it("does not sign in again when a key is stored, which reaches the project", async () => {
		hasKey = true;

		const result = await init();

		expect(result.code).toBe(0);
		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
	});

	it("stops with the line that signs in for the project, under CI, and writes nothing", async () => {
		vi.stubEnv("CI", "true");

		const result = await init();

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Not signed in to ${ORIGIN}. Run: fabric auth login --base-url ${ORIGIN} --project ${PROJECT}\n`,
		);
		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("resolves with the credential it has, before the project is known", async () => {
		mocks.signInWithBrowser.mockImplementation(async () => {
			projectSignIns.add(PROJECT);
			return { name: "Dev", email: "dev@example.com" };
		});

		await init();

		expect(mocks.getClient).toHaveBeenNthCalledWith(
			1,
			expect.not.objectContaining({ project: expect.anything() }),
		);
	});
});

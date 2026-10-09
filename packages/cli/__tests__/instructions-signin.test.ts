/**
 * Signing in, for `fabric instructions` (Fizzy #2878): a credential belongs to
 * one deployment, `init` signs a person in on the spot when it can, and a
 * session hook never does anything of the kind. Under a hook a sign-in that
 * cannot be used is the one failure the agent hears about, on stdout, with the
 * line that fixes it.
 *
 * The SDK is mocked at `getClient`, the browser sign-in at `signInWithBrowser`,
 * and the terminal is whatever each test makes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuthFailure } from "../src/lib/oauth/auth-failure.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
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
	listProjectSignIns: () => [],
	hasStoredApiKey: mocks.hasStoredApiKey,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/oauth/sign-in.js", () => ({
	signInWithBrowser: mocks.signInWithBrowser,
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

const PRODUCTION = "https://fabric.pro";
const STAGING = "https://staging.example";

/** The deployments a key is stored for. */
let signedInTo: Set<string>;

/** What a browser sign-in is stored for, by deployment, for the organization and for each project. */
let browserSignIns: {
	organization: Set<string>;
	project: Map<string, Set<string>>;
};

function setTerminal(isTTY: boolean): void {
	for (const stream of [process.stdin, process.stderr]) {
		Object.defineProperty(stream, "isTTY", {
			value: isTTY,
			configurable: true,
		});
	}
}

beforeEach(() => {
	resetInstructionsMocks(mocks);
	mocks.signInWithBrowser.mockReset();
	signedInTo = new Set([PRODUCTION]);
	browserSignIns = { organization: new Set(), project: new Map() };
	mocks.getApiKey.mockImplementation((origin) =>
		origin !== undefined && signedInTo.has(origin) ? "fab_test" : undefined,
	);
	mocks.hasStoredApiKey.mockReset();
	mocks.hasStoredApiKey.mockImplementation(
		(origin) => origin !== undefined && signedInTo.has(origin),
	);
	mocks.getOAuth.mockReset();
	mocks.getOAuth.mockImplementation((origin, project) => {
		if (origin === undefined) {
			return undefined;
		}
		const has =
			project === undefined
				? browserSignIns.organization.has(origin)
				: (browserSignIns.project.get(origin)?.has(project) ?? false);
		return has ? { accessToken: "fat_test" } : undefined;
	});
	mocks.getPublished.mockResolvedValue({
		published: false,
		sourceOfTruth: "UPLOAD",
	});
	setTerminal(false);
	// Not under CI unless a test says so: CI runs these tests too.
	vi.stubEnv("CI", "");
});

afterEach(() => {
	for (const stream of [process.stdin, process.stderr]) {
		Reflect.deleteProperty(stream, "isTTY");
	}
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const SIGNED_OUT = (origin: string) =>
	`fabric: coding instructions: not signed in to ${origin} — run: fabric auth login --base-url ${origin} --project project-1\n`;

describe("a session hook with no usable sign-in", () => {
	it("says so on stdout, once, and exits 0, when nothing is stored for the deployment", async () => {
		signedInTo.clear();
		const dest = await makeTree();

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
			stdout: SIGNED_OUT(PRODUCTION),
			stderr: "",
		});
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("asks for the deployment the hook names, not the one the machine happens to use", async () => {
		const dest = await makeTree();

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--base-url",
			STAGING,
			"--hook",
		]);

		expect(mocks.getApiKey).toHaveBeenCalledWith(STAGING, "project-1");
		expect(result.stdout).toBe(SIGNED_OUT(STAGING));
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("says the same when the deployment refuses the credential", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(
			Object.assign(new Error("Unauthorized"), { status: 401 }),
		);

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
			stdout: SIGNED_OUT(PRODUCTION),
			stderr: "",
		});
	});

	it.each(["expired", "wrong-deployment"] as const)(
		"says the same when the sign-in could not be used (%s), whatever the SDK made of it",
		async (kind) => {
			const dest = await makeTree();
			mocks.getPublished.mockImplementation(async () => {
				recordAuthFailure({ kind, origin: PRODUCTION });
				throw new Error("fetch failed");
			});

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
				stdout: SIGNED_OUT(PRODUCTION),
				stderr: "",
			});
		},
	);

	it("never signs anyone in, even with a terminal in front of it", async () => {
		signedInTo.clear();
		setTerminal(true);
		const dest = await makeTree();

		await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
	});

	it("keeps an ordinary failure on stderr", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockRejectedValue(new Error("fetch failed"));

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--hook",
		]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("skipped");
	});
});

describe("a command run by hand with no sign-in", () => {
	it("says the one line to run, with exit 3", async () => {
		signedInTo.clear();
		const dest = await makeTree();

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Not signed in to ${PRODUCTION}. Run: fabric auth login --base-url ${PRODUCTION} --project project-1\n`,
		);
		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
	});
});

describe("init with no sign-in for the deployment", () => {
	const init = (dest: string, ...extra: string[]) =>
		runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			...extra,
		]);

	it("prints the login line and exits 3 under CI, where nobody can finish a browser sign-in", async () => {
		signedInTo.clear();
		vi.stubEnv("CI", "true");
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Not signed in to ${PRODUCTION}. Run: fabric auth login --base-url ${PRODUCTION} --project project-1\n`,
		);
		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("signs in through the browser with no terminal, and hands the URL over on stderr, for an agent running the line", async () => {
		signedInTo.clear();
		vi.stubEnv("CI", "");
		setTerminal(false);
		mocks.signInWithBrowser.mockImplementation(
			async (input: { announce: (url: string) => void }) => {
				input.announce("https://fabric.pro/authorize?state=example");
				signedInTo.add(PRODUCTION);
				return { name: "Dev", email: "dev@example.com" };
			},
		);
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(mocks.signInWithBrowser).toHaveBeenCalledOnce();
		expect(result.stderr).toContain(
			"visit:\n\n  https://fabric.pro/authorize?state=example\n",
		);
		expect(result.stderr).toContain(
			`Signed in to ${PRODUCTION} for project project-1 as Dev.`,
		);
		expect(result.stdout).toContain("Set up.");
	});

	it("does not wait for the browser longer than a fixed bound", async () => {
		signedInTo.clear();
		vi.stubEnv("CI", "");
		mocks.signInWithBrowser.mockImplementation(
			async (input: { signal?: AbortSignal }) => {
				expect(input.signal).toBeInstanceOf(AbortSignal);
				expect(input.signal?.aborted).toBe(false);
				signedInTo.add(PRODUCTION);
				return { name: "Dev", email: "dev@example.com" };
			},
		);
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(mocks.signInWithBrowser).toHaveBeenCalledOnce();
	});

	it("treats CI=false as not being under CI", async () => {
		signedInTo.clear();
		vi.stubEnv("CI", "false");
		mocks.signInWithBrowser.mockImplementation(async () => {
			signedInTo.add(PRODUCTION);
			return { name: "Dev", email: "dev@example.com" };
		});
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(mocks.signInWithBrowser).toHaveBeenCalledOnce();
	});

	it("stops with the one line when the browser sign-in is abandoned, with no terminal", async () => {
		signedInTo.clear();
		vi.stubEnv("CI", "");
		mocks.signInWithBrowser.mockRejectedValue(
			new Error("Timed out waiting for the browser sign-in."),
		);
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Could not sign in to ${PRODUCTION}. Run: fabric auth login --base-url ${PRODUCTION} --project project-1 to see why.\n`,
		);
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});

	it("signs in through the browser first when there is a terminal, then carries on", async () => {
		signedInTo.clear();
		setTerminal(true);
		mocks.signInWithBrowser.mockImplementation(async () => {
			signedInTo.add(PRODUCTION);
			return { name: "Dev", email: "dev@example.com" };
		});
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(mocks.signInWithBrowser).toHaveBeenCalledOnce();
		expect(mocks.signInWithBrowser).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: PRODUCTION,
				origin: PRODUCTION,
				explicit: false,
			}),
		);
		expect(result.stderr).toBe(
			`Signed in to ${PRODUCTION} for project project-1 as Dev.\n`,
		);
		expect(mocks.getPublished).toHaveBeenCalled();
		expect(result.stdout).toContain("Set up.");
	});

	it("says who signed in with the control characters taken out of the name", async () => {
		signedInTo.clear();
		setTerminal(true);
		mocks.signInWithBrowser.mockImplementation(async () => {
			signedInTo.add(PRODUCTION);
			return {
				name: `Dev${String.fromCodePoint(0x9b)}31m${String.fromCodePoint(0x2028)}Admin`,
				email: "dev@example.com",
			};
		});
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe(
			`Signed in to ${PRODUCTION} for project project-1 as Dev 31m Admin.\n`,
		);
	});

	it("signs in to the deployment --base-url names, and says it was chosen", async () => {
		setTerminal(true);
		mocks.signInWithBrowser.mockImplementation(async () => {
			signedInTo.add(STAGING);
			return { name: "Dev", email: "dev@example.com" };
		});
		const dest = await makeTree();

		await init(dest, "--base-url", STAGING);

		expect(mocks.signInWithBrowser).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: STAGING,
				origin: STAGING,
				explicit: true,
			}),
		);
	});

	it("does not sign in again when a credential is already stored for the deployment", async () => {
		setTerminal(true);
		const dest = await makeTree();

		await init(dest);

		expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
	});

	it("stops with one line, and no server text, when the sign-in fails", async () => {
		signedInTo.clear();
		setTerminal(true);
		mocks.signInWithBrowser.mockRejectedValue(
			new Error(
				"The deployment refused the sign-in: invalid_grant (secret-detail)",
			),
		);
		const dest = await makeTree();

		const result = await init(dest);

		expect(result.code).toBe(3);
		expect(result.stderr).toBe(
			`✗ Could not sign in to ${PRODUCTION}. Run: fabric auth login --base-url ${PRODUCTION} --project project-1 to see why.\n`,
		);
		expect(result.stderr).not.toContain("secret-detail");
		expect(mocks.getPublished).not.toHaveBeenCalled();
	});
});

import { FabricAuthError, FabricError } from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLoginCommand } from "../src/commands/auth/login.js";

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

const { mocks } = vi.hoisted(() => ({
	mocks: {
		whoami: vi.fn(),
		getBaseUrl: vi.fn<() => string | undefined>(),
		getOAuth: vi.fn<() => unknown>(),
		saveApiKey: vi.fn(),
		signInWithBrowser: vi.fn(),
		revokeOAuthSession: vi.fn(async () => true),
		printError: vi.fn((_: string, code: number) => {
			throw new ExitSignal(code);
		}),
		printSuccess: vi.fn(),
	},
}));

vi.mock("@fabricorg/sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@fabricorg/sdk")>()),
	FabricClient: class {
		auth = { whoami: mocks.whoami };
		constructor(options: unknown) {
			(FabricClientOptions as { value: unknown }).value = options;
		}
	},
}));

const FabricClientOptions: { value: unknown } = { value: undefined };

vi.mock("../src/lib/config.js", () => ({
	getBaseUrl: mocks.getBaseUrl,
	getOAuth: mocks.getOAuth,
	saveApiKey: mocks.saveApiKey,
}));

vi.mock("../src/lib/oauth/session.js", () => ({
	revokeOAuthSession: mocks.revokeOAuthSession,
}));

vi.mock("../src/lib/oauth/sign-in.js", () => ({
	signInWithBrowser: mocks.signInWithBrowser,
}));

vi.mock("../src/lib/output.js", () => ({
	printError: mocks.printError,
	printSuccess: mocks.printSuccess,
}));

async function runLogin(args: string[]): Promise<void> {
	await buildLoginCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
	mocks.whoami.mockReset();
	mocks.whoami.mockResolvedValue({
		user: { name: "Dev", email: "dev@example.com" },
	});
	mocks.getBaseUrl.mockReset();
	mocks.getBaseUrl.mockReturnValue(undefined);
	mocks.getOAuth.mockReset();
	mocks.getOAuth.mockReturnValue(undefined);
	mocks.saveApiKey.mockReset();
	mocks.revokeOAuthSession.mockClear();
	mocks.printError.mockClear();
	mocks.printSuccess.mockReset();
	FabricClientOptions.value = undefined;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("fabric auth login", () => {
	it("stores an explicitly verified deployment URL with the key", async () => {
		await runLogin([
			"--key",
			"fab_test_key",
			"--base-url",
			"https://deployment.example",
		]);

		expect(FabricClientOptions.value).toEqual({
			apiKey: "fab_test_key",
			baseUrl: "https://deployment.example",
		});
		expect(mocks.saveApiKey).toHaveBeenCalledWith("fab_test_key", {
			baseUrl: "https://deployment.example",
		});
	});

	it("does not persist FABRIC_BASE_URL when it only supplied verification", async () => {
		mocks.getBaseUrl.mockReturnValue("https://environment.example");

		await runLogin(["--key", "fab_test_key"]);

		expect(FabricClientOptions.value).toEqual({
			apiKey: "fab_test_key",
			baseUrl: "https://environment.example",
		});
		expect(mocks.saveApiKey).toHaveBeenCalledWith("fab_test_key", {});
	});

	describe("on a build packed for one deployment", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
			delete process.env.FABRIC_BASE_URL;
		});

		it("keeps the key under the deployment it was packed for", async () => {
			vi.stubGlobal(
				"__FABRIC_BAKED_ORIGIN__",
				"https://deployment.example",
			);
			mocks.getBaseUrl.mockReturnValue("https://deployment.example");

			await runLogin(["--key", "fab_test_key"]);

			expect(mocks.saveApiKey).toHaveBeenCalledWith("fab_test_key", {
				baseUrl: "https://deployment.example",
			});
		});

		it("signs in through the browser to it, and keeps it as the chosen deployment", async () => {
			vi.stubGlobal(
				"__FABRIC_BAKED_ORIGIN__",
				"https://deployment.example",
			);
			mocks.getBaseUrl.mockReturnValue("https://deployment.example");
			mocks.signInWithBrowser.mockResolvedValue({
				name: "Dev",
				email: "dev@example.com",
			});

			await runLogin([]);

			expect(mocks.signInWithBrowser).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "https://deployment.example",
					origin: "https://deployment.example",
					explicit: true,
				}),
			);
		});

		it("lets --base-url name another deployment", async () => {
			vi.stubGlobal(
				"__FABRIC_BAKED_ORIGIN__",
				"https://deployment.example",
			);

			await runLogin([
				"--key",
				"fab_test_key",
				"--base-url",
				"https://other.example",
			]);

			expect(mocks.saveApiKey).toHaveBeenCalledWith("fab_test_key", {
				baseUrl: "https://other.example",
			});
		});

		it("does not persist the deployment when FABRIC_BASE_URL overrides it for this run", async () => {
			vi.stubGlobal(
				"__FABRIC_BAKED_ORIGIN__",
				"https://deployment.example",
			);
			process.env.FABRIC_BASE_URL = "https://environment.example";
			mocks.getBaseUrl.mockReturnValue("https://environment.example");

			await runLogin(["--key", "fab_test_key"]);

			expect(mocks.saveApiKey).toHaveBeenCalledWith("fab_test_key", {});
		});
	});

	it("ends at the server the browser sign-in a key replaces", async () => {
		const signIn = {
			clientId: "client-example",
			redirectUri: "http://127.0.0.1:49152/callback",
			tokenEndpoint: "https://deployment.example/api/auth/oauth2/token",
			accessToken: "fat_access",
			refreshToken: "frt_refresh",
			expiresAt: 1_900_000_000_000,
		};
		mocks.getOAuth.mockReturnValue(signIn);

		await runLogin(["--key", "fab_test_key"]);

		expect(mocks.saveApiKey).toHaveBeenCalledWith("fab_test_key", {});
		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(signIn);
	});

	it("revokes nothing when no browser sign-in was stored", async () => {
		await runLogin(["--key", "fab_test_key"]);

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
	});

	it("keeps invalid or expired key guidance for HTTP 401", async () => {
		mocks.whoami.mockRejectedValue(new FabricAuthError("invalid key"));

		await expect(runLogin(["--key", "fab_test_key"])).rejects.toMatchObject(
			{
				code: 3,
			},
		);

		expect(mocks.printError).toHaveBeenCalledWith(
			"Authentication failed. Check that the key is valid and not expired.",
			3,
		);
		expect(mocks.saveApiKey).not.toHaveBeenCalled();
	});

	it("reports a non-auth HTTP status and the sanitized deployment URL", async () => {
		mocks.whoami.mockRejectedValue(
			new FabricError("reflected fab_secret\u001B[2J response", 404),
		);

		await expect(
			runLogin([
				"--key",
				"fab_test_key",
				"--base-url",
				"https://user:secret@deployment.example/internal",
			]),
		).rejects.toMatchObject({ code: 3 });

		expect(mocks.printError).toHaveBeenCalledWith(
			"Authentication request to https://deployment.example failed with HTTP 404.",
			3,
		);
		expect(mocks.saveApiKey).not.toHaveBeenCalled();
	});

	it("identifies the deployment when the connection cannot be established", async () => {
		mocks.getBaseUrl.mockReturnValue("http://localhost:3001");
		mocks.whoami.mockRejectedValue(
			new FabricError(
				"request to http://user:secret@localhost:3001 failed",
				0,
				"NETWORK_ERROR",
			),
		);

		await expect(runLogin(["--key", "fab_test_key"])).rejects.toMatchObject(
			{
				code: 3,
			},
		);

		expect(mocks.printError).toHaveBeenCalledWith(
			"Could not connect to http://localhost:3001. Check that the deployment URL is correct and reachable.",
			3,
		);
		expect(mocks.saveApiKey).not.toHaveBeenCalled();
	});

	describe("with --project", () => {
		it("signs in through the browser for that project only, and says so", async () => {
			mocks.getBaseUrl.mockReturnValue("https://deployment.example");
			mocks.signInWithBrowser.mockResolvedValue({
				name: "Dev",
				email: "dev@example.com",
			});

			await runLogin(["--project", "project-example-one"]);

			expect(mocks.signInWithBrowser).toHaveBeenCalledWith(
				expect.objectContaining({
					origin: "https://deployment.example",
					project: "project-example-one",
				}),
			);
			expect(mocks.printSuccess).toHaveBeenCalledWith(
				"Authenticated as Dev (dev@example.com) for project project-example-one",
			);
			expect(mocks.saveApiKey).not.toHaveBeenCalled();
		});

		it("names the project in the line that tells the person where the browser went", async () => {
			mocks.getBaseUrl.mockReturnValue("https://deployment.example");
			mocks.signInWithBrowser.mockImplementation(
				async (input: { announce: (url: string) => void }) => {
					input.announce("https://deployment.example/authorize");
					return { name: "Dev", email: "dev@example.com" };
				},
			);
			const written: string[] = [];
			const write = vi
				.spyOn(process.stdout, "write")
				.mockImplementation((chunk: unknown) => {
					written.push(String(chunk));
					return true;
				});

			try {
				await runLogin(["--project", "project-example-one"]);
			} finally {
				write.mockRestore();
			}

			expect(written.join("")).toContain(
				"Opening your browser to sign in to https://deployment.example for project project-example-one.",
			);
		});

		it("does not touch the deployment's own browser sign-in or key", async () => {
			mocks.getBaseUrl.mockReturnValue("https://deployment.example");
			mocks.getOAuth.mockReturnValue({ accessToken: "fat_org_wide" });
			mocks.signInWithBrowser.mockResolvedValue({
				name: "Dev",
				email: "dev@example.com",
			});

			await runLogin(["--project", "project-example-one"]);

			expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
			expect(mocks.saveApiKey).not.toHaveBeenCalled();
		});

		it("refuses to be combined with an API key, which is not limited to one project", async () => {
			await expect(
				runLogin([
					"--project",
					"project-example-one",
					"--key",
					"fab_test_key",
				]),
			).rejects.toMatchObject({ code: 2 });

			expect(mocks.printError).toHaveBeenCalledWith(
				expect.stringContaining("cannot be combined with --key"),
				2,
			);
			expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
			expect(mocks.saveApiKey).not.toHaveBeenCalled();
		});

		it.each([
			["a space", "my project"],
			["a path", "../other"],
			["a query", "abc?x=1"],
			["more than 64 characters", "a".repeat(65)],
			["nothing", ""],
		])(
			"refuses an id with %s in it, before opening a browser",
			async (_label, id) => {
				await expect(runLogin(["--project", id])).rejects.toMatchObject(
					{
						code: 2,
					},
				);

				expect(mocks.printError).toHaveBeenCalledWith(
					expect.stringContaining("--project must be a project id"),
					2,
				);
				expect(mocks.signInWithBrowser).not.toHaveBeenCalled();
			},
		);
	});
});

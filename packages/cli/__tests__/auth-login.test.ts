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
		saveApiKey: vi.fn(),
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
	saveApiKey: mocks.saveApiKey,
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
	mocks.saveApiKey.mockReset();
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
});

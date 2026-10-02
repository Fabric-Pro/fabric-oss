import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalAppData = process.env.APPDATA;

/**
 * Point the config store at a throwaway directory on every platform. The store
 * resolves its folder from XDG_CONFIG_HOME on Linux and macOS and from APPDATA
 * on Windows, so setting only the first would let a Windows run read and write
 * the developer's real profile.
 */
async function isolatedConfigHome(): Promise<void> {
	const home = await mkdtemp(path.join(tmpdir(), "fabric-config-"));
	process.env.XDG_CONFIG_HOME = home;
	process.env.APPDATA = home;
}

afterEach(() => {
	if (originalConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalConfigHome;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	delete process.env.FABRIC_BASE_URL;
	delete process.env.FABRIC_API_KEY;
	vi.resetModules();
});

const OAUTH = {
	clientId: "client-example",
	redirectUri: "http://127.0.0.1:49152/callback",
	tokenEndpoint: "https://deployment.example/api/auth/oauth2/token",
	revocationEndpoint: "https://deployment.example/api/auth/oauth2/revoke",
	accessToken: "fat_access",
	refreshToken: "frt_refresh",
	expiresAt: 1_900_000_000_000,
};

describe("CLI profile configuration", () => {
	it("stores an explicitly selected deployment with the active profile and keeps env precedence", async () => {
		await isolatedConfigHome();
		const initialConfig = await import("../src/lib/config.js");
		await writeFile(
			initialConfig.getConfigPath(),
			JSON.stringify({
				activeProfile: "staging",
				profiles: {
					staging: {
						defaultContext: { type: "org", slug: "example-org" },
					},
				},
				defaultFormat: "table",
			}),
		);
		vi.resetModules();
		const config = await import("../src/lib/config.js");

		config.saveApiKey("fab_test_key", {
			baseUrl: "https://deployment.example",
		});

		const saved = JSON.parse(
			await readFile(config.getConfigPath(), "utf8"),
		);
		expect(saved.activeProfile).toBe("staging");
		expect(saved.profiles.staging).toEqual({
			apiKey: "fab_test_key",
			baseUrl: "https://deployment.example",
			defaultContext: { type: "org", slug: "example-org" },
		});
		expect(config.getBaseUrl()).toBe("https://deployment.example");

		process.env.FABRIC_BASE_URL = "https://environment.example";
		expect(config.getBaseUrl()).toBe("https://environment.example");
	});

	it("logs out the active non-default profile", async () => {
		await isolatedConfigHome();
		const initialConfig = await import("../src/lib/config.js");
		await writeFile(
			initialConfig.getConfigPath(),
			JSON.stringify({
				activeProfile: "staging",
				profiles: {
					staging: {
						apiKey: "fab_test_key",
						baseUrl: "https://deployment.example",
					},
				},
				defaultFormat: "table",
			}),
		);
		vi.resetModules();
		const config = await import("../src/lib/config.js");
		const { buildLogoutCommand } = await import(
			"../src/commands/auth/logout.js"
		);

		await buildLogoutCommand().parseAsync([], { from: "user" });

		expect(config.getApiKey()).toBeUndefined();
		expect(config.getBaseUrl()).toBe("https://deployment.example");
	});

	it("keeps a browser sign-in and an API key mutually exclusive in one profile", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");

		config.saveApiKey("fab_test_key");
		config.saveOAuth(OAUTH, { baseUrl: "https://deployment.example" });

		expect(config.hasStoredApiKey()).toBe(false);
		expect(config.getOAuth()).toEqual(OAUTH);
		expect(config.getApiKey()).toBe("fat_access");
		expect(config.getBaseUrl()).toBe("https://deployment.example");

		config.saveApiKey("fab_other_key");

		expect(config.getOAuth()).toBeUndefined();
		expect(config.hasStoredApiKey()).toBe(true);
		expect(config.getApiKey()).toBe("fab_other_key");
	});

	it("prefers an environment key over a stored sign-in", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");
		config.saveOAuth(OAUTH);

		process.env.FABRIC_API_KEY = "fab_env_key";

		expect(config.getApiKey()).toBe("fab_env_key");
		expect(config.hasStoredApiKey()).toBe(true);
	});

	it("clears a browser sign-in on logout and keeps the deployment", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");
		config.saveOAuth(OAUTH, { baseUrl: "https://deployment.example" });
		// A server that cannot be reached still ends in a local sign-out.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const { buildLogoutCommand } = await import(
			"../src/commands/auth/logout.js"
		);

		await buildLogoutCommand().parseAsync([], { from: "user" });
		vi.unstubAllGlobals();

		expect(config.getOAuth()).toBeUndefined();
		expect(config.getApiKey()).toBeUndefined();
		expect(config.getBaseUrl()).toBe("https://deployment.example");
	});
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
	if (originalConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalConfigHome;
	}
	delete process.env.FABRIC_BASE_URL;
	vi.resetModules();
});

describe("CLI profile configuration", () => {
	it("stores an explicitly selected deployment with the active profile and keeps env precedence", async () => {
		process.env.XDG_CONFIG_HOME = await mkdtemp(
			path.join(tmpdir(), "fabric-config-"),
		);
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
		process.env.XDG_CONFIG_HOME = await mkdtemp(
			path.join(tmpdir(), "fabric-config-"),
		);
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
});

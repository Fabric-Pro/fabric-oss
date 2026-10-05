import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageRoot = path.resolve(__dirname, "..");

async function npmBuildConfig(): Promise<Record<string, unknown>> {
	vi.resetModules();
	vi.stubEnv("FABRIC_CLI_BUNDLE", "");
	const config = (await import("../tsup.config")).default;
	return config as Record<string, unknown>;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the build npm publishes", () => {
	it("targets Node 22, so import.meta.url survives the build", async () => {
		const config = await npmBuildConfig();

		expect(config.platform).toBe("node");
		expect(config.target).toBe("node22");
	});

	it("inlines the SDK and does not install the npm one", async () => {
		const config = await npmBuildConfig();
		const manifest = JSON.parse(
			await readFile(path.join(packageRoot, "package.json"), "utf8"),
		);

		expect(config.noExternal).toEqual(["@fabricorg/sdk"]);
		expect(manifest.dependencies).not.toHaveProperty("@fabricorg/sdk");
		expect(manifest.engines).toEqual({ node: ">=22" });
	});
});

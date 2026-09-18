import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("fabric --version", () => {
	it("reports the installed CLI package version", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx/esm",
				fileURLToPath(new URL("../src/bin/fabric.ts", import.meta.url)),
				"--version",
			],
			{ encoding: "utf8" },
		);

		expect(output.trim()).toBe(packageJson.version);
	});
});

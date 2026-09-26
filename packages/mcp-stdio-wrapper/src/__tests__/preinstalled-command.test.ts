import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resolvePreinstalledCommand } from "../preinstalled-command";

describe("resolvePreinstalledCommand", () => {
	let globalRoot: string;

	before(async () => {
		globalRoot = await mkdtemp(join(tmpdir(), "example-global-"));
		const install = async (name: string, manifest: object) => {
			await mkdir(join(globalRoot, name), { recursive: true });
			await writeFile(
				join(globalRoot, name, "package.json"),
				JSON.stringify(manifest),
			);
		};
		await install("@azure-devops/mcp", {
			version: "2.8.0",
			bin: { "mcp-server-azuredevops": "dist/index.js" },
		});
		await install("example-server", {
			version: "1.4.2",
			bin: "cli.js",
		});
	});

	after(async () => {
		await rm(globalRoot, { recursive: true, force: true });
	});

	it("runs the installed binary for an exactly pinned npx command", async () => {
		const resolved = await resolvePreinstalledCommand(
			["npx", "-y", "@azure-devops/mcp@2.8.0", "example-org"],
			globalRoot,
		);
		assert.deepEqual(resolved, {
			executable: process.execPath,
			args: [
				join(globalRoot, "@azure-devops/mcp", "dist/index.js"),
				"example-org",
			],
			packageName: "@azure-devops/mcp",
			version: "2.8.0",
		});
	});

	it("runs the installed binary for an unversioned spec, as npx itself would", async () => {
		const resolved = await resolvePreinstalledCommand(
			["npx", "--yes", "example-server", "--flag"],
			globalRoot,
		);
		assert.deepEqual(resolved?.args, [
			join(globalRoot, "example-server", "cli.js"),
			"--flag",
		]);
	});

	it("keeps npx when the pinned version differs from the installed one", async () => {
		assert.equal(
			await resolvePreinstalledCommand(
				["npx", "-y", "@azure-devops/mcp@2.10.0"],
				globalRoot,
			),
			null,
		);
	});

	it("keeps npx for a tag or range, which may name another version", async () => {
		for (const spec of [
			"@azure-devops/mcp@latest",
			"@azure-devops/mcp@^2.8.0",
		]) {
			assert.equal(
				await resolvePreinstalledCommand(
					["npx", "-y", spec],
					globalRoot,
				),
				null,
			);
		}
	});

	it("keeps the command as given when the package is not installed or it is not npx", async () => {
		assert.equal(
			await resolvePreinstalledCommand(
				["npx", "-y", "example-missing@1.0.0"],
				globalRoot,
			),
			null,
		);
		assert.equal(
			await resolvePreinstalledCommand(["node", "server.js"], globalRoot),
			null,
		);
		assert.equal(
			await resolvePreinstalledCommand(
				["npx", "--package=example-server", "example-server"],
				globalRoot,
			),
			null,
		);
	});
});

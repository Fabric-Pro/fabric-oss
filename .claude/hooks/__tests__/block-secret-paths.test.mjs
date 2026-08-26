import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "block-secret-paths.mjs";

async function edit(filePath, toolName = "Edit") {
	return runHook(HOOK, {
		tool_name: toolName,
		tool_input: { file_path: filePath },
	});
}

describe("block-secret-paths — blocks edits", () => {
	const blocked = [
		".env",
		".env.local",
		".env.production",
		".env.staging",
		"apps/web/server.pem",
		"apps/web/server.key",
		"/Users/me/.npmrc",
		".npmrc",
		"credentials.json",
		"credentials",
		"packages/auth/credentials.yaml",
	];
	for (const filePath of blocked) {
		it(`blocks Edit of ${filePath}`, async () => {
			const result = await edit(filePath, "Edit");
			assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
		});
	}

	it("matches credentials.JSON case-insensitively", async () => {
		const result = await edit("Credentials.JSON", "Edit");
		assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
	});

	it("blocks for Write tool", async () => {
		const result = await edit(".env.local", "Write");
		assert.equal(result.exitCode, 2);
	});

	it("blocks for MultiEdit tool", async () => {
		const result = await edit("apps/web/server.pem", "MultiEdit");
		assert.equal(result.exitCode, 2);
	});

	it("blocks for NotebookEdit tool", async () => {
		const result = await edit(".env", "NotebookEdit");
		assert.equal(result.exitCode, 2);
	});
});

describe("block-secret-paths — allows edits", () => {
	const allowed = [
		".env.example",
		".env.sample",
		".env.template",
		"apps/web/.env.example",
		"credentials.example.json",
		"credentials.example",
		"docs/pem-overview.md",
		"notes-credentials.md", // markdown exemption
		"docs/credentials-howto.md",
		"node_modules/foo/.env",
		"packages/database/prisma/seed.ts",
		"some-other-file.json",
		"my-credentials-notes.txt", // basename does NOT start with `credentials`
	];
	for (const filePath of allowed) {
		it(`allows Edit of ${filePath}`, async () => {
			const result = await edit(filePath, "Edit");
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		});
	}
});

describe("block-secret-paths — Read is allowed", () => {
	it("allows Read of .env.local (different tool name)", async () => {
		// settings.json matcher excludes Read; this asserts the script
		// also short-circuits if it somehow receives a Read payload.
		const result = await edit(".env.local", "Read");
		assert.equal(result.exitCode, 0);
	});
});

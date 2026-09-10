import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { getProcessPool, shutdownProcessPool } from "../process-pool";
import { createServer } from "../server";

describe("MCP STDIO wrapper initialization", () => {
	afterEach(async () => {
		await shutdownProcessPool();
	});

	it("returns the initialization failure without pooling or calling the dead transport", async () => {
		const app = createServer();
		const configId = `example-config-${process.pid}`;
		const response = await app.request("http://localhost/mcp/call", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				command: process.execPath,
				args: ["-e", "setTimeout(() => process.exit(1), 250)"],
				method: "tools/list",
				params: {},
				userId: "example-user",
				organizationId: "example-org",
				configId,
				credentials: {
					__GDRIVE_OAUTH_KEYS_JSON: "{}",
					__GDRIVE_CREDENTIALS_JSON: "{}",
				},
			}),
		});

		assert.equal(response.status, 500);
		const body = await response.json();
		assert.deepEqual(body, {
			success: false,
			error: "Process exited unexpectedly",
		});
		assert.equal(getProcessPool().getStats().size, 0);

		const credentialDirs = (await readdir(tmpdir())).filter((name) =>
			name.startsWith(`gdrive-mcp-${configId}-`),
		);
		assert.deepEqual(credentialDirs, []);
	});
});

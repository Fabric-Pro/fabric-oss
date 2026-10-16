import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { getProcessPool, shutdownProcessPool } from "../process-pool";
import { createServer } from "../server";

// Built at runtime so secret scanners don't flag these fake test IDs.
const FAKE_ACCOUNT_SID = `AC${"0".repeat(32)}`;
const FAKE_API_KEY_SID = `SK${"0".repeat(32)}`;

// A minimal JSON-RPC server: answers every request with its pid, the
// credentials file it was started with and that file's content when it
// started.
const childScript = [
	'const { readFileSync } = require("node:fs");',
	"const path = process.env.GDRIVE_CREDENTIALS_PATH;",
	'const startedWith = path ? readFileSync(path, "utf8") : null;',
	'const rl = require("node:readline").createInterface({ input: process.stdin });',
	'rl.on("line", (line) => {',
	"  const msg = JSON.parse(line);",
	"  if (msg.id === undefined) return;",
	'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { pid: process.pid, credentialsPath: path, startedWith } }) + "\\n");',
	"});",
].join("\n");

async function writeEchoBin(dir: string, name: string): Promise<string> {
	const bin = join(dir, name);
	await writeFile(
		bin,
		[
			'"use strict";',
			'const rl = require("node:readline").createInterface({ input: process.stdin });',
			'rl.on("line", (line) => {',
			"  const msg = JSON.parse(line);",
			"  if (msg.id === undefined) return;",
			'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { argv: process.argv } }) + "\\n");',
			"});",
		].join("\n"),
	);
	return bin;
}

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

	it("respawns the pooled server when a call brings new credentials, and deletes the old credential files", async () => {
		const app = createServer();
		const configId = `example-respawn-${process.pid}`;
		const call = async (accessToken: string) => {
			const response = await app.request("http://localhost/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: process.execPath,
					args: ["-e", childScript],
					method: "tools/list",
					params: {},
					userId: "example-user",
					organizationId: "example-org",
					configId,
					credentials: {
						__GDRIVE_OAUTH_KEYS_JSON: "{}",
						__GDRIVE_CREDENTIALS_JSON: JSON.stringify({
							access_token: accessToken,
						}),
					},
				}),
			});
			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				result: { pid: number; credentialsPath: string };
			};
			return body.result;
		};
		const credentialDirs = async () =>
			(await readdir(tmpdir())).filter((name) =>
				name.startsWith(`gdrive-mcp-${configId}-`),
			);

		const first = await call("example-token-1");
		const reused = await call("example-token-1");
		assert.equal(reused.pid, first.pid);
		assert.equal((await credentialDirs()).length, 1);

		const second = await call("example-token-2");
		assert.notEqual(second.pid, first.pid);
		assert.equal(getProcessPool().getStats().size, 1);
		assert.deepEqual(
			JSON.parse(await readFile(second.credentialsPath, "utf8")),
			{ access_token: "example-token-2" },
		);
		// Only the new process's files remain, once the old process's
		// background close has finished.
		await getProcessPool().closesSettled();
		assert.equal((await credentialDirs()).length, 1);
		assert.ok(second.credentialsPath.includes((await credentialDirs())[0]));
	});

	it("keeps the pooled server for fresher credentials when a call with older ones arrives after it", async () => {
		const app = createServer();
		const configId = `example-freshness-${process.pid}`;
		const call = async (accessToken: string, version: number[]) => {
			const response = await app.request("http://localhost/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: process.execPath,
					args: ["-e", childScript],
					method: "tools/list",
					params: {},
					userId: "example-user",
					organizationId: "example-org",
					configId,
					credentials: {
						__GDRIVE_OAUTH_KEYS_JSON: "{}",
						__GDRIVE_CREDENTIALS_JSON: JSON.stringify({
							access_token: accessToken,
						}),
					},
					credentialsVersion: version,
				}),
			});
			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				result: { pid: number; startedWith: string };
			};
			return body.result;
		};

		const fresh = await call("example-token-2", [4, 2000]);
		const stale = await call("example-token-1", [4, 1000]);
		const again = await call("example-token-2", [4, 2000]);

		assert.notEqual(stale.pid, fresh.pid);
		assert.deepEqual(JSON.parse(stale.startedWith), {
			access_token: "example-token-1",
		});
		assert.equal(again.pid, fresh.pid);
		assert.equal(getProcessPool().getStats().size, 1);
	});

	it("rejects a malformed credentials version", async () => {
		const app = createServer();
		const response = await app.request("http://localhost/mcp/call", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				command: process.execPath,
				args: ["-e", childScript],
				method: "tools/list",
				userId: "example-user",
				configId: `example-bad-version-${process.pid}`,
				credentialsVersion: ["4", 1000],
			}),
		});
		assert.equal(response.status, 400);
		assert.equal(getProcessPool().getStats().size, 0);
	});

	it("gives two creations for one config started in the same millisecond their own credential files", async () => {
		const app = createServer();
		const configId = `example-overlap-${process.pid}`;
		const frozenNow = Date.now();
		mock.method(Date, "now", () => frozenNow);
		try {
			const call = async (accessToken: string) => {
				const response = await app.request(
					"http://localhost/mcp/call",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							command: process.execPath,
							args: ["-e", childScript],
							method: "tools/list",
							params: {},
							userId: "example-user",
							organizationId: "example-org",
							configId,
							credentials: {
								__GDRIVE_OAUTH_KEYS_JSON: "{}",
								__GDRIVE_CREDENTIALS_JSON: JSON.stringify({
									access_token: accessToken,
								}),
							},
						}),
					},
				);
				assert.equal(response.status, 200);
				const body = (await response.json()) as {
					result: { credentialsPath: string; startedWith: string };
				};
				return body.result;
			};

			const [a, b] = await Promise.all([
				call("example-token-a"),
				call("example-token-b"),
			]);

			assert.notEqual(a.credentialsPath, b.credentialsPath);
			assert.deepEqual(JSON.parse(a.startedWith), {
				access_token: "example-token-a",
			});
			assert.deepEqual(JSON.parse(b.startedWith), {
				access_token: "example-token-b",
			});
		} finally {
			mock.restoreAll();
		}
	});

	it("starts a preinstalled @twilio-alpha/mcp with the launcher first and no credentials in commandArgs", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "twilio-server-test-"));
		const fakeBin = await writeEchoBin(tempDir, "fake-twilio.cjs");

		try {
			const app = createServer({
				resolveCommand: async () => ({
					executable: process.execPath,
					args: [fakeBin, "package-arg"],
					packageName: "@twilio-alpha/mcp",
					version: "0.7.0",
				}),
			});

			const configId = `example-twilio-server-${process.pid}`;
			const response = await app.request("http://localhost/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "npx -y @twilio-alpha/mcp@0.7.0",
					args: ["request-arg"],
					method: "tools/list",
					params: {},
					userId: "example-user",
					organizationId: "example-org",
					configId,
					credentials: {
						TWILIO_ACCOUNT_SID: FAKE_ACCOUNT_SID,
						TWILIO_API_KEY: FAKE_API_KEY_SID,
						TWILIO_API_SECRET: "secret123",
					},
				}),
			});

			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				result: { argv: string[] };
			};

			assert.equal(body.result.argv[0], process.execPath);
			assert.equal(body.result.argv[1], fakeBin);
			assert.equal(body.result.argv[2], "package-arg");
			assert.equal(body.result.argv[3], "request-arg");
			assert.deepEqual(body.result.argv.slice(4), [
				`--accountSid=${FAKE_ACCOUNT_SID}`,
				`--apiKey=${FAKE_API_KEY_SID}`,
				"--apiSecret=secret123",
			]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves args unchanged for other preinstalled packages", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "other-server-test-"));
		const fakeBin = await writeEchoBin(tempDir, "fake-other.cjs");

		try {
			const app = createServer({
				resolveCommand: async () => ({
					executable: process.execPath,
					args: [fakeBin, "ado-pkg-arg"],
					packageName: "@azure-devops/mcp",
					version: "2.8.0",
				}),
			});

			const configId = `example-ado-server-${process.pid}`;
			const response = await app.request("http://localhost/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "npx -y @azure-devops/mcp@2.8.0",
					args: ["request-arg"],
					method: "tools/list",
					params: {},
					userId: "example-user",
					organizationId: "example-org",
					configId,
					credentials: {
						ADO_MCP_AUTH_TOKEN: "pat-token",
					},
				}),
			});

			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				result: { argv: string[] };
			};

			assert.equal(body.result.argv[0], process.execPath);
			assert.equal(body.result.argv[1], fakeBin);
			assert.equal(body.result.argv[2], "ado-pkg-arg");
			assert.equal(body.result.argv[3], "request-arg");
			assert.equal(body.result.argv.length, 4);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { getProcessPool, shutdownProcessPool } from "../process-pool";
import { createServer } from "../server";
import {
	allowOnlyNodeSpawns,
	stubNpmRoot,
	stubSpawn,
	writePackageBin,
} from "./launch-fixtures";

const GDRIVE_COMMAND = "npx -y @modelcontextprotocol/server-gdrive@2025.1.14";
const MEMORY_COMMAND = "npx -y @modelcontextprotocol/server-memory@1.0.0";
const ADO_COMMAND = "npx -y @azure-devops/mcp@2.8.0";
const TWILIO_COMMAND = "npx -y @twilio-alpha/mcp@0.7.0";

let testDirectory: string;
let globalRoot: string;
const previousTmpdir = process.env.TMPDIR;
before(async () => {
	testDirectory = await mkdtemp(join(tmpdir(), "wrapper-test-"));
	globalRoot = join(testDirectory, "packages");
	process.env.TMPDIR = testDirectory;
	stubNpmRoot(mock, globalRoot);
	allowOnlyNodeSpawns(mock);
});
after(async () => {
	mock.restoreAll();
	syncBuiltinESMExports();
	if (previousTmpdir === undefined) {
		delete process.env.TMPDIR;
	} else {
		process.env.TMPDIR = previousTmpdir;
	}
	await rm(testDirectory, { recursive: true, force: true });
});
afterEach(async () => {
	await shutdownProcessPool();
});

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

const echoArgv = [
	'const rl = require("node:readline").createInterface({ input: process.stdin });',
	'rl.on("line", (line) => {',
	"  const msg = JSON.parse(line);",
	"  if (msg.id === undefined) return;",
	'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { argv: process.argv } }) + "\\n");',
	"});",
].join("\n");

async function writeGdriveBin(script = childScript) {
	return writePackageBin(
		globalRoot,
		"@modelcontextprotocol/server-gdrive",
		"2025.1.14",
		script,
	);
}

async function writeMemoryBin(script: string) {
	return writePackageBin(
		globalRoot,
		"@modelcontextprotocol/server-memory",
		"1.0.0",
		script,
	);
}

async function credentialDirs() {
	return (await readdir(testDirectory))
		.filter((name) => name.startsWith("gdrive-mcp-"))
		.sort();
}

describe("MCP STDIO wrapper route authentication", () => {
	const addressHeaders = {
		"X-Forwarded-For": "10.0.0.1",
		"X-Real-IP": "127.0.0.1",
		Host: "localhost",
	};
	const routes = [
		// An empty call reaches body validation once authenticated.
		{ path: "/mcp/call", method: "POST", acceptedStatus: 400 },
		{ path: "/stats", method: "GET", acceptedStatus: 200 },
		{
			path: "/mcp/example/future-route",
			method: "GET",
			acceptedStatus: 404,
		},
	];
	const apiKey = "example-key";

	const originalEnv = process.env;
	afterEach(() => {
		process.env = originalEnv;
	});

	function setEnvironment(nodeEnv: string, allowExternalAccess: string) {
		process.env = {
			...process.env,
			NODE_ENV: nodeEnv,
			ALLOW_EXTERNAL_ACCESS: allowExternalAccess,
		};
		delete process.env.MCP_WRAPPER_API_KEY;
	}

	it("refuses protected routes without a production key and keeps health open", async () => {
		setEnvironment("production", "true");
		const app = createServer();
		for (const { path, method } of routes) {
			for (const headers of [
				addressHeaders,
				{ ...addressHeaders, "x-internal-api-key": apiKey },
			]) {
				const response = await app.request(path, { method, headers });
				assert.equal(response.status, 503, path);
				assert.equal(
					(await response.json()).message,
					"MCP STDIO wrapper is not configured",
				);
			}
		}
		assert.equal((await app.request("/health")).status, 200);
	});

	it("requires the production key on each protected route and keeps health open", async () => {
		setEnvironment("production", "true");
		const app = createServer({ internalApiKey: apiKey });
		for (const { path, method, acceptedStatus } of routes) {
			assert.equal(
				(await app.request(path, { method, headers: addressHeaders }))
					.status,
				401,
				path,
			);
			assert.equal(
				(
					await app.request(path, {
						method,
						headers: {
							...addressHeaders,
							"x-internal-api-key": "wrong",
						},
					})
				).status,
				401,
				path,
			);
			assert.equal(
				(
					await app.request(path, {
						method,
						headers: { "x-internal-api-key": apiKey },
					})
				).status,
				acceptedStatus,
				path,
			);
		}
		assert.equal((await app.request("/health")).status, 200);
	});

	it("allows local development without a key and requires an environment-configured key when present", async () => {
		setEnvironment("development", "false");
		const app = createServer();
		assert.equal((await app.request("/stats")).status, 200);
		assert.equal(
			(await app.request("/mcp/call", { method: "POST" })).status,
			400,
		);
		assert.equal((await app.request("/health")).status, 200);

		process.env.MCP_WRAPPER_API_KEY = apiKey;
		const appWithKey = createServer();
		assert.equal((await appWithKey.request("/stats")).status, 401);
		assert.equal(
			(
				await appWithKey.request("/stats", {
					headers: { "x-internal-api-key": apiKey },
				})
			).status,
			200,
		);
		assert.equal((await appWithKey.request("/health")).status, 200);
	});
});

describe("MCP STDIO wrapper initialization", () => {
	it("returns the initialization failure without pooling or calling the dead transport", async () => {
		const app = createServer();
		const configId = `example-config-${process.pid}`;
		await writeGdriveBin("setTimeout(() => process.exit(1), 250)");
		const before = await credentialDirs();
		const response = await app.request("http://localhost/mcp/call", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				command: GDRIVE_COMMAND,
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
			error: "Process exited unexpectedly (exit code 1)",
		});
		assert.equal(getProcessPool().getStats().size, 0);

		assert.deepEqual(await credentialDirs(), before);
	});

	it("keeps the child pooled after JSON-RPC errors from tools/call and tools/list", async () => {
		const app = createServer();
		const script = `
			const rl = require("node:readline").createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const msg = JSON.parse(line);
				if (msg.id === undefined) return;
				const reply = msg.method === "tools/call" || msg.method === "tools/list"
					? { error: { code: -32602, message: "Invalid example query" } }
					: { result: { pid: process.pid } };
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }) + "\\n");
			});
		`;
		await writeMemoryBin(script);
		const call = (method: string) =>
			app.request("https://example.com/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: MEMORY_COMMAND,
					method,
					userId: "example-user",
					organizationId: "example-org",
					configId: "example-rpc-error",
				}),
			});
		const first = await (await call("ping")).json();
		for (const method of ["tools/call", "tools/list"]) {
			const response = await call(method);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), {
				success: false,
				error: "MCP error -32602: Invalid example query",
			});
			assert.equal(getProcessPool().getStats().size, 1);
		}
		assert.deepEqual(await (await call("ping")).json(), first);
	});
	it("evicts a pooled child that exits during a tool call", async () => {
		const app = createServer();
		const script = `
			const rl = require("node:readline").createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const msg = JSON.parse(line);
				if (msg.id === undefined) return;
				if (msg.method === "tools/call") { process.exit(1); return; }
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
			});
		`;
		await writeMemoryBin(script);
		const response = await app.request("https://example.com/mcp/call", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				command: MEMORY_COMMAND,
				method: "tools/call",
				userId: "example-user",
				organizationId: "example-org",
				configId: "example-transport-error",
			}),
		});
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), {
			success: false,
			error: "Process exited unexpectedly (exit code 1)",
		});
		assert.equal(getProcessPool().getStats().size, 0);
	});

	it("respawns the pooled server when a call brings new credentials, and deletes the old credential files", async () => {
		const app = createServer();
		const configId = `example-respawn-${process.pid}`;
		await writeGdriveBin();
		const call = async (accessToken: string) => {
			const response = await app.request("http://localhost/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: GDRIVE_COMMAND,
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

		const initialCount = (await credentialDirs()).length;
		const first = await call("example-token-1");
		const firstCount = (await credentialDirs()).length;
		assert.equal(firstCount, initialCount + 1);
		const reused = await call("example-token-1");
		assert.equal(reused.pid, first.pid);
		assert.equal(reused.credentialsPath, first.credentialsPath);
		assert.equal((await credentialDirs()).length, firstCount);

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
		assert.equal((await credentialDirs()).length, firstCount);
		await assert.rejects(readFile(first.credentialsPath), {
			code: "ENOENT",
		});
		assert.notEqual(
			dirname(second.credentialsPath),
			dirname(first.credentialsPath),
		);
	});

	it("keeps the pooled server for fresher credentials when a call with older ones arrives after it", async () => {
		const app = createServer();
		const configId = `example-freshness-${process.pid}`;
		await writeGdriveBin();
		const call = async (accessToken: string, version: number[]) => {
			const response = await app.request("http://localhost/mcp/call", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: GDRIVE_COMMAND,
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
				command: GDRIVE_COMMAND,
				method: "tools/list",
				userId: "example-user",
				configId: `example-bad-version-${process.pid}`,
				credentialsVersion: ["4", 1000],
			}),
		});
		assert.equal(response.status, 400);
		assert.equal(getProcessPool().getStats().size, 0);
	});

	it("gives two creations for one config started in the same millisecond their own credential files", async (t) => {
		const app = createServer();
		const configId = `example-overlap-${process.pid}`;
		await writeGdriveBin();
		const frozenNow = Date.now();
		const now = t.mock.method(Date, "now", () => frozenNow);
		try {
			const call = async (accessToken: string) => {
				const response = await app.request(
					"http://localhost/mcp/call",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							command: GDRIVE_COMMAND,
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
			now.mock.restore();
		}
	});

	it("starts preinstalled Twilio through the launcher with its three credential flags", async () => {
		const fakeBin = await writePackageBin(
			globalRoot,
			"@twilio-alpha/mcp",
			"0.7.0",
			echoArgv,
		);
		const response = await call(createServer(), {
			command: TWILIO_COMMAND,
			credentials: {
				TWILIO_ACCOUNT_SID: FAKE_ACCOUNT_SID,
				TWILIO_API_KEY: FAKE_API_KEY_SID,
				TWILIO_API_SECRET: "secret123",
			},
		});

		assert.equal(response.status, 200);
		const body = (await response.json()) as { result: { argv: string[] } };
		assert.deepEqual(body.result.argv, [
			process.execPath,
			fakeBin,
			`--accountSid=${FAKE_ACCOUNT_SID}`,
			`--apiKey=${FAKE_API_KEY_SID}`,
			"--apiSecret=secret123",
		]);
	});

	it("appends the Azure DevOps organization and client authentication arguments to the installed binary", async () => {
		const fakeBin = await writePackageBin(
			globalRoot,
			"@azure-devops/mcp",
			"2.8.0",
			echoArgv,
		);
		const args = ["example-org", "--authentication", "envvar"];
		const response = await call(createServer(), {
			command: ADO_COMMAND,
			args,
			credentials: { ADO_MCP_AUTH_TOKEN: "example-token" },
		});

		assert.equal(response.status, 200);
		const body = (await response.json()) as { result: { argv: string[] } };
		assert.deepEqual(body.result.argv, [
			process.execPath,
			fakeBin,
			...args,
		]);
	});
});

function call(
	app: ReturnType<typeof createServer>,
	launch: {
		command: string;
		args?: readonly string[];
		credentials?: Readonly<Record<string, string>>;
	},
) {
	return app.request("http://localhost/mcp/call", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			method: "tools/list",
			userId: "example-user",
			organizationId: "example-org",
			configId: "example-catalog",
			...launch,
		}),
	});
}

describe("MCP STDIO catalog launch policy", () => {
	const figma = "npx -y figma-developer-mcp@0.13.2 --stdio";
	const unavailable = /MCP server.*is not available/;
	const invalidArgs = /Invalid Azure DevOps command arguments/;
	const invalidCredential = /Invalid credential name/;
	const cases = [
		[
			"an unlisted package",
			{ command: "npx -y example-server@1.0.0" },
			unavailable,
		],
		[
			"a different exact version",
			{ command: "npx -y @modelcontextprotocol/server-memory@1.0.1" },
			unavailable,
		],
		[
			"a missing version",
			{ command: "npx -y figma-developer-mcp --stdio" },
			unavailable,
		],
		[
			"a version range",
			{ command: "npx -y @modelcontextprotocol/server-memory@^1.0.0" },
			unavailable,
		],
		["extra fixed flags", { command: `${figma} --extra` }, unavailable],
		[
			"a missing fixed flag",
			{ command: "npx -y figma-developer-mcp@0.13.2" },
			unavailable,
		],
		[
			"a replaced fixed flag",
			{ command: "npx -y figma-developer-mcp@0.13.2 --extra" },
			unavailable,
		],
		[
			"a different executable",
			{ command: "node -y @modelcontextprotocol/server-memory@1.0.0" },
			unavailable,
		],
		[
			"a command separator and second command",
			{ command: `${MEMORY_COMMAND} ; example-command` },
			unavailable,
		],
		[
			"a repeated npx option",
			{
				command:
					"npx -y --yes @modelcontextprotocol/server-memory@1.0.0",
			},
			unavailable,
		],
		[
			"a quoted package spec",
			{ command: 'npx -y "@modelcontextprotocol/server-memory@1.0.0"' },
			unavailable,
		],
		[
			"noncanonical spacing",
			{ command: `${MEMORY_COMMAND} ` },
			unavailable,
		],
		[
			"request arguments for a server that takes none",
			{ command: MEMORY_COMMAND, args: ["example-org"] },
			/does not accept command arguments/,
		],
		[
			"an empty Azure DevOps organization",
			{ command: ADO_COMMAND, args: [""] },
			invalidArgs,
		],
		[
			"a missing Azure DevOps organization",
			{ command: ADO_COMMAND },
			invalidArgs,
		],
		[
			"an Azure DevOps organization longer than 50 characters",
			{ command: ADO_COMMAND, args: ["a".repeat(51)] },
			invalidArgs,
		],
		[
			"a character outside the Azure DevOps organization alphabet",
			{ command: ADO_COMMAND, args: ["example_org"] },
			invalidArgs,
		],
		[
			"a leading Azure DevOps organization hyphen",
			{ command: ADO_COMMAND, args: ["-example-org"] },
			invalidArgs,
		],
		[
			"a trailing Azure DevOps organization hyphen",
			{ command: ADO_COMMAND, args: ["example-org-"] },
			invalidArgs,
		],
		[
			"extra Azure DevOps arguments after authentication",
			{
				command: ADO_COMMAND,
				args: ["example-org", "--authentication", "envvar", "extra"],
			},
			invalidArgs,
		],
		[
			"an incomplete Azure DevOps authentication suffix",
			{ command: ADO_COMMAND, args: ["example-org", "--authentication"] },
			invalidArgs,
		],
		[
			"a different Azure DevOps authentication flag",
			{
				command: ADO_COMMAND,
				args: ["example-org", "--example", "envvar"],
			},
			invalidArgs,
		],
		[
			"a different Azure DevOps authentication mode",
			{
				command: ADO_COMMAND,
				args: ["example-org", "--authentication", "example-mode"],
			},
			invalidArgs,
		],
		...[
			"PATH",
			"NODE_OPTIONS",
			"LD_PRELOAD",
			"MCP_WRAPPER_API_KEY",
			"FIGMA_API_KEY",
		].map(
			(name) =>
				[
					`the ${name} credential on Azure DevOps`,
					{
						command: ADO_COMMAND,
						args: ["example-org"],
						credentials: { [name]: "example-value" },
					},
					invalidCredential,
				] as const,
		),
		[
			"an unknown credential named __proto__",
			{
				command: MEMORY_COMMAND,
				credentials: { ["__proto__"]: "example-value" },
			},
			invalidCredential,
		],
		[
			"a caller-supplied Google Drive credential path",
			{
				command: GDRIVE_COMMAND,
				credentials: { GDRIVE_CREDENTIALS_PATH: "example.json" },
			},
			invalidCredential,
		],
		[
			"an environment credential value containing a null byte",
			{
				command: ADO_COMMAND,
				args: ["example-org"],
				credentials: { ADO_MCP_AUTH_TOKEN: "example\0value" },
			},
			/Invalid credential value/,
		],
	] satisfies readonly (readonly [
		string,
		Parameters<typeof call>[1],
		RegExp,
	])[];

	for (const [label, launch, message] of cases) {
		it(`refuses ${label} before spawning or pooling`, async (t) => {
			const spawn = stubSpawn(t.mock, () => {
				throw new Error("Unexpected child process");
			});
			try {
				const response = await call(createServer(), launch);
				assert.equal(response.status, 400);
				assert.match((await response.json()).error, message);
				assert.equal(spawn.mock.callCount(), 0);
				assert.equal(getProcessPool().getStats().size, 0);
			} finally {
				spawn.restore();
			}
		});
	}

	it("refuses an invalid launch when its pool key already has a child", async (t) => {
		await writeMemoryBin(echoArgv);
		const app = createServer();
		assert.equal(
			(await call(app, { command: MEMORY_COMMAND })).status,
			200,
		);
		const lookup = t.mock.method(getProcessPool(), "getOrCreate");
		assert.equal(
			(await call(app, { command: `${MEMORY_COMMAND} --extra` })).status,
			400,
		);
		assert.equal(lookup.mock.callCount(), 0);
		assert.equal(getProcessPool().getStats().size, 1);
	});

	it("replaces a pooled child when its approved catalog command changes", async () => {
		await writeMemoryBin(echoArgv);
		const everythingBin = await writePackageBin(
			globalRoot,
			"@modelcontextprotocol/server-everything",
			"1.0.0",
			echoArgv,
		);
		const app = createServer();
		assert.equal(
			(await call(app, { command: MEMORY_COMMAND })).status,
			200,
		);
		const response = await call(app, {
			command: "npx -y @modelcontextprotocol/server-everything@1.0.0",
		});
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).result.argv, [
			process.execPath,
			everythingBin,
		]);
		assert.equal(getProcessPool().getStats().size, 1);
	});

	it("replaces a pooled Azure DevOps child when its organization changes", async () => {
		const bin = await writePackageBin(
			globalRoot,
			"@azure-devops/mcp",
			"2.8.0",
			echoArgv,
		);
		const app = createServer();
		assert.equal(
			(await call(app, { command: ADO_COMMAND, args: ["example-org"] }))
				.status,
			200,
		);
		const response = await call(app, {
			command: ADO_COMMAND,
			args: ["example-org-2"],
		});
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).result.argv, [
			process.execPath,
			bin,
			"example-org-2",
		]);
		assert.equal(getProcessPool().getStats().size, 1);
	});

	it("accepts each supported npx option for a pinned catalog server", async () => {
		const bin = await writeMemoryBin(echoArgv);
		const app = createServer();
		for (const command of [
			"npx @modelcontextprotocol/server-memory@1.0.0",
			MEMORY_COMMAND,
			"npx --yes @modelcontextprotocol/server-memory@1.0.0",
		]) {
			const response = await call(app, { command });
			assert.equal(response.status, 200);
			assert.deepEqual((await response.json()).result.argv, [
				process.execPath,
				bin,
			]);
			await getProcessPool().remove(
				"example-user",
				"example-org",
				"example-catalog",
			);
		}
	});

	it("passes the fixed flags in order to the npx fallback", async (t) => {
		const realSpawn = childProcess.spawn;
		const spawn = stubSpawn(t.mock, (_executable, _args, options) =>
			realSpawn(process.execPath, ["-e", echoArgv], options),
		);
		try {
			const response = await call(createServer(), {
				command: figma,
				credentials: { FIGMA_API_KEY: "example-key" },
			});
			assert.equal(response.status, 200);
			assert.equal(spawn.mock.callCount(), 1);
			assert.deepEqual(spawn.mock.calls[0]?.arguments.slice(0, 2), [
				"npx",
				["-y", "figma-developer-mcp@0.13.2", "--stdio"],
			]);
			assert.equal(
				spawn.mock.calls[0]?.arguments[2].env?.FIGMA_API_KEY,
				"example-key",
			);
		} finally {
			spawn.restore();
		}
	});

	it("reports Twilio unavailable when its pinned binary is missing", async () => {
		await rm(join(globalRoot, "@twilio-alpha/mcp"), {
			recursive: true,
			force: true,
		});
		const response = await call(createServer(), {
			command: TWILIO_COMMAND,
		});
		assert.equal(response.status, 400);
		assert.match(
			(await response.json()).error,
			/MCP server @twilio-alpha\/mcp is not available/,
		);
		assert.equal(getProcessPool().getStats().size, 0);
	});
});

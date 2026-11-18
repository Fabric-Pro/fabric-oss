import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import {
	createStdioTransport,
	redactUrlCredentials,
	StdioRpcError,
	StdioTransport,
	stderrLogLevel,
	summarizeNpmFailure,
} from "../stdio-transport";
import {
	allowOnlyNodeSpawns,
	stubNpmRoot,
	stubSpawn,
	writePackageBin,
} from "./launch-fixtures";

const MEMORY_COMMAND = "npx -y @modelcontextprotocol/server-memory@1.0.0";
const GDRIVE_COMMAND = "npx -y @modelcontextprotocol/server-gdrive@2025.1.14";
const ADO_COMMAND = "npx -y @azure-devops/mcp@2.8.0";
let globalRoot: string;
before(async () => {
	globalRoot = await mkdtemp(join(tmpdir(), "transport-test-packages-"));
	stubNpmRoot(mock, globalRoot);
	allowOnlyNodeSpawns(mock);
});
after(async () => {
	mock.restoreAll();
	syncBuiltinESMExports();
	await rm(globalRoot, { recursive: true, force: true });
});

async function startFixture(script: string, requestTimeoutMs?: number) {
	await writePackageBin(
		globalRoot,
		"@modelcontextprotocol/server-memory",
		"1.0.0",
		script,
	);
	return createStdioTransport({
		command: MEMORY_COMMAND,
		args: [],
		requestTimeoutMs,
	});
}

describe("StdioTransport request timeout", () => {
	it("applies a per-request deadline instead of the transport default", async () => {
		const transport = await startFixture(
			"setInterval(() => {}, 1000)",
			60_000,
		);
		try {
			const started = Date.now();
			await assert.rejects(
				transport.request("initialize", {}, 150),
				/Request timeout after 150ms/,
			);
			assert.ok(Date.now() - started < 5_000);
		} finally {
			await transport.close();
		}
	});
});

describe("StdioTransport JSON-RPC errors", () => {
	it("preserves the numeric code and error class of a child response", async () => {
		const transport = await startFixture(`
			const rl = require("node:readline").createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const msg = JSON.parse(line);
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid example query" } }) + "\\n");
			});
		`);
		try {
			await assert.rejects(
				transport.request("tools/call", {}),
				(error: unknown) => {
					assert.ok(error instanceof StdioRpcError);
					assert.equal(error.code, -32602);
					assert.equal(
						error.message,
						"MCP error -32602: Invalid example query",
					);
					return true;
				},
			);
		} finally {
			await transport.close();
		}
	});
});

describe("summarizeNpmFailure", () => {
	it("names the npm error code and message, not the debug-log pointer", () => {
		assert.equal(
			summarizeNpmFailure([
				"npm error code E404",
				"npm error 404 Not Found - GET https://registry.npmjs.org/@example%2fmissing-server - Not found",
				"npm error A complete log of this run can be found in: /var/lib/mcpwrapper/.npm/_logs/2026-01-01T00_00_00_000Z-debug-0.log",
			]),
			"E404: 404 Not Found - GET https://registry.npmjs.org/@example%2fmissing-server - Not found",
		);
	});

	it("reads the older npm ERR! prefix", () => {
		assert.equal(
			summarizeNpmFailure([
				"npm ERR! code ETARGET",
				"npm ERR! notarget No matching version",
			]),
			"ETARGET: notarget No matching version",
		);
	});

	it("returns null when only the debug-log pointer or no npm line is present", () => {
		assert.equal(
			summarizeNpmFailure([
				"npm error A complete log of this run can be found in: /tmp/x.log",
			]),
			null,
		);
		assert.equal(summarizeNpmFailure(["Server listening"]), null);
	});
});

describe("StdioTransport npm failures", () => {
	it("rejects pending requests with the npm error the child printed", async () => {
		const transport = await startFixture(`
			process.stdin.once("data", () => {
				process.stderr.write("npm error code E404\\n");
				process.stderr.write("npm error 404 Not Found - GET https://registry.npmjs.org/@example%2fmissing\\n");
				process.stderr.write("npm error A complete log of this run can be found in: /tmp/x.log\\n");
				setTimeout(() => process.exit(1), 20);
			});
			setInterval(() => {}, 1000);
		`);
		try {
			await assert.rejects(
				transport.request("initialize", {}, 5_000),
				/Process exited unexpectedly \(npm E404: 404 Not Found/,
			);
		} finally {
			await transport.close();
		}
	});
});

describe("StdioTransport unexpected exits (Fizzy #3457)", () => {
	async function exitReason(childScript: string): Promise<string> {
		const transport = await startFixture(
			`process.stdin.once("data", () => { ${childScript} }); setInterval(() => {}, 1000);`,
		);
		let message = "";
		try {
			await assert.rejects(
				transport.request("initialize", {}, 5_000),
				(error: Error) => {
					message = error.message;
					return true;
				},
			);
		} finally {
			await transport.close();
		}
		return message;
	}

	it("names the exit code and keeps the child's stderr out of the reason", async () => {
		const message = await exitReason(
			`process.stderr.write("Please provide a database URL: postgresql://dev:hunter2@db.example.com/app\\n");
			setTimeout(() => process.exit(1), 20);`,
		);
		assert.equal(message, "Process exited unexpectedly (exit code 1)");
	});

	it("names the signal that ended the process", async () => {
		const message = await exitReason(
			`process.kill(process.pid, "SIGTERM");`,
		);
		assert.equal(message, "Process exited unexpectedly (signal SIGTERM)");
	});
});

describe("redactUrlCredentials", () => {
	it("masks the user and password of a URL argument", () => {
		assert.equal(
			redactUrlCredentials("postgresql://dev:hunter2@db.example.com/app"),
			"postgresql://[REDACTED]@db.example.com/app",
		);
	});

	it("leaves arguments without URL credentials alone", () => {
		for (const arg of [
			"-y",
			"@modelcontextprotocol/server-postgres",
			"postgresql://db.example.com/app",
			"example-org",
			"dev@example.com",
		]) {
			assert.equal(redactUrlCredentials(arg), arg);
		}
	});
});

describe("StdioTransport stderr logging", () => {
	it("logs a JSON info startup line as info and keeps real failures as errors", async () => {
		const startup = JSON.stringify({
			authentication: "envvar",
			domains: ["all"],
			enabledDomains: ["core", "repositories", "work-items"],
			isCodespace: false,
			level: "info",
			message: "Starting Azure DevOps MCP Server",
			organization: "example-org",
			organizationUrl: "https://dev.azure.com/example-org",
			timestamp: "2026-01-01T00:00:00.000Z",
			version: "2.8.0",
		});
		const failures = [
			'{"level":"error","message":"Failed to connect"}',
			"TypeError: x is not a function",
			"{not json",
		];
		const info = mock.method(console, "info", () => {});
		const error = mock.method(console, "error", () => {});
		const transport = await startFixture(`
			for (const line of ${JSON.stringify([startup, ...failures])}) process.stderr.write(line + "\\n");
			setInterval(() => {}, 1000);
		`);
		try {
			const deadline = Date.now() + 5_000;
			while (
				error.mock.callCount() < failures.length &&
				Date.now() < deadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const logged = (calls: typeof info.mock.calls) =>
				calls.map((call) => call.arguments);
			assert.deepEqual(logged(info.mock.calls), [
				["[StdioTransport] stderr:", startup],
			]);
			assert.deepEqual(
				logged(error.mock.calls),
				failures.map((line) => ["[StdioTransport] stderr:", line]),
			);
		} finally {
			await transport.close();
			info.mock.restore();
			error.mock.restore();
		}
	});
});

describe("stderrLogLevel", () => {
	it("honours JSON info level for Azure DevOps startup payload", () => {
		const adoPayload = JSON.stringify({
			level: "info",
			message:
				"Starting server for organization: https://dev.azure.com/example-org",
		});
		assert.equal(stderrLogLevel(adoPayload), "info");
	});

	it("maps JSON error level to error", () => {
		assert.equal(
			stderrLogLevel('{"level":"error","message":"boom"}'),
			"error",
		);
	});

	it("maps JSON warning level to warn", () => {
		assert.equal(stderrLogLevel('{"level":"warning"}'), "warn");
	});

	it("supports numeric pino/bunyan levels", () => {
		assert.equal(stderrLogLevel('{"level":50,"msg":"db down"}'), "error");
		assert.equal(stderrLogLevel('{"level":40}'), "warn");
		assert.equal(stderrLogLevel('{"level":30}'), "info");
	});

	it("defaults JSON without a level to error", () => {
		assert.equal(stderrLogLevel('{"message":"x"}'), "error");
	});

	it("keeps crash text such as TypeError at error", () => {
		assert.equal(stderrLogLevel("TypeError: x is not a function"), "error");
	});

	it("falls back to error when line starts with { but is not valid JSON", () => {
		assert.equal(stderrLogLevel("{not json"), "error");
	});
});

describe("StdioTransport catalog launch", () => {
	it("enforces the command, args and credential policy when called directly", async (t) => {
		const spawn = stubSpawn(t.mock, () => {
			throw new Error("Unexpected child process");
		});
		try {
			for (const [launch, message] of [
				[
					{ command: "npx -y example-server@1.0.0", args: [] },
					/is not available/,
				],
				[
					{ command: MEMORY_COMMAND, args: ["example-org"] },
					/does not accept command arguments/,
				],
				[
					{
						command: MEMORY_COMMAND,
						args: [],
						credentials: { PATH: "example" },
					},
					/Invalid credential name/,
				],
			] as const) {
				await assert.rejects(
					new StdioTransport(launch).start(),
					message,
				);
				await assert.rejects(createStdioTransport(launch), message);
			}
			assert.equal(spawn.mock.callCount(), 0);
		} finally {
			spawn.restore();
		}
	});

	it("refuses a second start while the first launch is being prepared", async () => {
		await writePackageBin(
			globalRoot,
			"@modelcontextprotocol/server-memory",
			"1.0.0",
			"setTimeout(() => process.exit(0), 300)",
		);
		const transport = new StdioTransport({
			command: MEMORY_COMMAND,
			args: [],
		});
		const first = transport.start();
		try {
			await assert.rejects(
				transport.start(),
				/Transport already started or closed/,
			);
		} finally {
			await first;
			await transport.close();
		}
	});

	it("refuses to start a closed transport", async () => {
		const transport = new StdioTransport({
			command: MEMORY_COMMAND,
			args: [],
		});
		await transport.close();
		await assert.rejects(
			transport.start(),
			/Transport already started or closed/,
		);
	});

	it("does not spawn when the transport closes during launch preparation", async (t) => {
		await writePackageBin(
			globalRoot,
			"@modelcontextprotocol/server-memory",
			"1.0.0",
			"setInterval(() => {}, 1000)",
		);
		const spawn = stubSpawn(t.mock, () => {
			throw new Error("Unexpected child process");
		});
		try {
			const transport = new StdioTransport({
				command: MEMORY_COMMAND,
				args: [],
			});
			const launched = transport.start();
			await transport.close();
			await assert.rejects(launched, /Transport closed during startup/);
			assert.equal(spawn.mock.callCount(), 0);
		} finally {
			spawn.restore();
		}
	});

	it("passes only approved base variables and the selected server credential to spawn", async (t) => {
		const fakeBin = await writePackageBin(
			globalRoot,
			"@azure-devops/mcp",
			"2.8.0",
			"setInterval(() => {}, 1000)",
		);
		const base = {
			PATH: "example-path",
			HOME: "example-home",
			TMPDIR: "example-tempdir",
			TMP: "example-tmp",
			TEMP: "example-temp",
			LANG: "C.UTF-8",
			LANGUAGE: "en",
			LC_ALL: "C.UTF-8",
			LC_CTYPE: "C.UTF-8",
			NODE_ENV: "production",
			NPM_CONFIG_CACHE: "example-cache",
		};
		const inherited = {
			...base,
			MCP_WRAPPER_API_KEY: "example-wrapper-key",
			DATABASE_URL: "example-database-url",
			ADO_MCP_AUTH_TOKEN: "example-parent-value",
			TWILIO_API_KEY: "example-other-key",
			NODE_OPTIONS: "--no-warnings",
		};
		const previous = Object.fromEntries(
			Object.keys(inherited).map((name) => [name, process.env[name]]),
		);
		Object.assign(process.env, inherited);
		const realSpawn = childProcess.spawn;
		const spawn = stubSpawn(t.mock, (executable, args, options) =>
			realSpawn(executable, args, options),
		);
		let transport: StdioTransport | undefined;
		try {
			transport = await createStdioTransport({
				command: ADO_COMMAND,
				args: ["A".repeat(50)],
				credentials: { ADO_MCP_AUTH_TOKEN: "example-request-value" },
			});
			assert.equal(spawn.mock.callCount(), 1);
			const spawned = spawn.mock.calls[0];
			assert.ok(spawned);
			const [executable, args, { env }] = spawned.arguments;
			assert.equal(executable, process.execPath);
			assert.deepEqual(args, [fakeBin, "A".repeat(50)]);
			assert.ok(env);
			assert.equal(Object.hasOwn(env, "MCP_WRAPPER_API_KEY"), false);
			const expected = {
				...base,
				ADO_MCP_AUTH_TOKEN: "example-request-value",
			};
			assert.deepEqual(
				Object.keys(env).sort(),
				Object.keys(expected).sort(),
			);
			for (const [name, value] of Object.entries(expected)) {
				assert.equal(env[name], value);
			}
		} finally {
			spawn.restore();
			for (const [name, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
			await transport?.close();
		}
	});

	it("passes Google Drive file paths to spawn and cleans up the files on close", async (t) => {
		await writePackageBin(
			globalRoot,
			"@modelcontextprotocol/server-gdrive",
			"2025.1.14",
			"setInterval(() => {}, 1000)",
		);
		const realSpawn = childProcess.spawn;
		const spawn = stubSpawn(t.mock, (executable, args, options) =>
			realSpawn(executable, args, options),
		);
		let transport: StdioTransport | undefined;
		let paths: string[] = [];
		try {
			transport = await createStdioTransport({
				command: GDRIVE_COMMAND,
				args: [],
				credentials: {
					__GDRIVE_OAUTH_KEYS_JSON: '{"example":"oauth"}',
					__GDRIVE_CREDENTIALS_JSON: '{"example":"credentials"}',
				},
			});
			assert.equal(spawn.mock.callCount(), 1);
			const env = spawn.mock.calls[0]?.arguments[2].env;
			assert.equal(env?.__GDRIVE_OAUTH_KEYS_JSON, undefined);
			assert.equal(env?.__GDRIVE_CREDENTIALS_JSON, undefined);
			const oauthPath = env?.GDRIVE_OAUTH_PATH;
			const credentialsPath = env?.GDRIVE_CREDENTIALS_PATH;
			assert.ok(oauthPath && credentialsPath);
			paths = [oauthPath, credentialsPath];
			assert.equal(
				await readFile(oauthPath, "utf8"),
				'{"example":"oauth"}',
			);
			assert.equal(
				await readFile(credentialsPath, "utf8"),
				'{"example":"credentials"}',
			);
			for (const path of paths) {
				assert.equal((await stat(path)).mode & 0o777, 0o600);
			}
		} finally {
			spawn.restore();
			await transport?.close();
		}
		for (const path of paths) {
			await assert.rejects(readFile(path), { code: "ENOENT" });
		}
	});
});

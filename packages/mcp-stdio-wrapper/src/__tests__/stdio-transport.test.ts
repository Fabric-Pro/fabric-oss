import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
	createStdioTransport,
	StdioRpcError,
	stderrLogLevel,
	summarizeNpmFailure,
} from "../stdio-transport";

describe("StdioTransport request timeout", () => {
	it("applies a per-request deadline instead of the transport default", async () => {
		const transport = await createStdioTransport({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			requestTimeoutMs: 60_000,
		});
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
		const transport = await createStdioTransport({
			command: process.execPath,
			args: [
				"-e",
				`
			const rl = require("node:readline").createInterface({ input: process.stdin });
			rl.on("line", (line) => {
				const msg = JSON.parse(line);
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid example query" } }) + "\\n");
			});
		`,
			],
		});
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
		const transport = await createStdioTransport({
			command: process.execPath,
			args: [
				"-e",
				`
			process.stdin.once("data", () => {
				process.stderr.write("npm error code E404\\n");
				process.stderr.write("npm error 404 Not Found - GET https://registry.npmjs.org/@example%2fmissing\\n");
				process.stderr.write("npm error A complete log of this run can be found in: /tmp/x.log\\n");
				setTimeout(() => process.exit(1), 20);
			});
			setInterval(() => {}, 1000);
		`,
			],
		});
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
		const transport = await createStdioTransport({
			command: process.execPath,
			args: [
				"-e",
				`
			for (const line of ${JSON.stringify([startup, ...failures])}) process.stderr.write(line + "\\n");
			setInterval(() => {}, 1000);
		`,
			],
		});
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

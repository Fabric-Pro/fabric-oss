import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createStdioTransport,
	StdioRpcError,
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStdioTransport, StdioRpcError } from "../stdio-transport";

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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStdioTransport } from "../stdio-transport";

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

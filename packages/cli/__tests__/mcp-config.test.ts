/**
 * The reader for a checkout's `.mcp.json` (Fizzy #2878): it notes whether a
 * remote server carries an `Authorization` header, and never holds the value.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMcpConfig } from "../src/lib/instructions/mcp-config.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";

const SENTINEL = "sentinel-value-8d2e5a1c-never-held";

async function configWith(body: unknown) {
	const root = await resolveDestinationRoot(
		await mkdtemp(path.join(tmpdir(), "fabric-mcp-")),
	);
	await writeFile(path.join(root, ".mcp.json"), JSON.stringify(body));
	return readMcpConfig(root);
}

describe("readMcpConfig", () => {
	it("records the presence of an Authorization header, in any case, and never its value", async () => {
		const config = await configWith({
			mcpServers: {
				upper: {
					url: "https://example.com/mcp",
					headers: { Authorization: `Bearer ${SENTINEL}` },
				},
				lower: {
					url: "https://example.com/mcp",
					headers: { authorization: `Bearer ${SENTINEL}` },
				},
				other: {
					url: "https://example.com/mcp",
					headers: { "X-Api-Version": "2" },
				},
				none: { url: "https://example.com/mcp" },
				malformed: {
					url: "https://example.com/mcp",
					headers: ["Authorization"],
				},
			},
		});

		expect(config).toMatchObject({ state: "ok" });
		if (config.state !== "ok") {
			return;
		}
		expect(
			Object.fromEntries(
				config.servers.map((server) => [
					server.name,
					server.kind === "url" && server.hasAuthorizationHeader,
				]),
			),
		).toEqual({
			upper: true,
			lower: true,
			other: false,
			none: false,
			malformed: false,
		});
		expect(JSON.stringify(config)).not.toContain(SENTINEL);
	});

	it("has no such flag for a local process", async () => {
		const config = await configWith({
			mcpServers: {
				local: { command: "example-server", env: { TOKEN: SENTINEL } },
			},
		});

		expect(config).toEqual({
			state: "ok",
			servers: [
				{ name: "local", kind: "command", command: "example-server" },
			],
		});
	});
});

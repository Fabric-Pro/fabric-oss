/**
 * @fabricorg/sdk-mcp/stdio
 *
 * Convenience entry: runs a stdio MCP server using `FABRIC_API_KEY`
 * (and optional `FABRIC_BASE_URL` / `FABRIC_ORG`) from the environment.
 *
 * Designed to be exec'd by an MCP client (Claude Desktop, Cursor, etc.).
 * The `fabric mcp serve` CLI command is the recommended invocation; this
 * file is the underlying script.
 *
 * Stdout is reserved for the JSON-RPC framing — log only to stderr.
 */

import { createFabric } from "@fabricorg/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFabricMcpServer } from "./index.js";

export async function runStdio(): Promise<void> {
	const fabric = createFabric({});
	const server = createFabricMcpServer({ fabric });
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write("[fabric-mcp] stdio transport connected\n");
}

// When invoked directly (node dist/stdio.js), kick off the server.
const isDirectInvocation =
	typeof process !== "undefined" &&
	Array.isArray(process.argv) &&
	process.argv[1] !== undefined &&
	(process.argv[1].endsWith("stdio.js") ||
		process.argv[1].endsWith("stdio.cjs"));

if (isDirectInvocation) {
	runStdio().catch((err) => {
		process.stderr.write(
			`[fabric-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
}

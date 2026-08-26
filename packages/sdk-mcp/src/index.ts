/**
 * @fabricorg/sdk-mcp
 *
 * Builds an MCP (Model Context Protocol) server that exposes a Fabric
 * workspace's whole integration catalog as MCP tools — any MCP-compatible
 * agent (Claude Desktop, Cursor, Continue, OpenAI agents, …) can point at
 * one endpoint and get every connected vendor.
 *
 * Three generic tools (corsair-style):
 *   - `fabric_list_integrations` — what's connected for this tenant
 *   - `fabric_list_operations`   — endpoints for one integration
 *   - `fabric_call`              — execute an operation
 *
 * Usage (stdio transport, e.g. Claude Desktop):
 *   import { createFabricMcpServer } from "@fabricorg/sdk-mcp";
 *   import { createFabric } from "@fabricorg/sdk";
 *   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 *   const fabric = createFabric({ apiKey: process.env.FABRIC_API_KEY });
 *   const server = createFabricMcpServer({ fabric });
 *   await server.connect(new StdioServerTransport());
 *
 * Or use the prebuilt stdio entry: `import "@fabricorg/sdk-mcp/stdio";`
 * (The `fabric mcp serve` CLI command is the recommended user-facing path.)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Avoid importing @fabricorg/sdk concrete types at runtime; we only need its
// shape so the server is decoupled from a specific SDK version. Consumers
// pass an `FabricClient` instance.
type FabricLike = {
	integrations: {
		list(): Promise<
			Array<{
				slug: string;
				name: string;
				status: string;
				mode: string;
				source: string;
			}>
		>;
		[slug: string]: unknown;
	};
};

export interface CreateFabricMcpServerOptions {
	/** A configured FabricClient (createFabric) instance. Required. */
	fabric: FabricLike;
	/** Server name reported on the MCP handshake. Default `"fabric"`. */
	name?: string;
	/** Server version. Default `"0.1.0"`. */
	version?: string;
}

/**
 * Build a configured `McpServer` exposing the workspace catalog. Caller is
 * responsible for `.connect(transport)` so the same server works over stdio,
 * HTTP, or any other MCP transport.
 */
export function createFabricMcpServer(
	options: CreateFabricMcpServerOptions,
): McpServer {
	const fabric = options.fabric;
	const server = new McpServer({
		name: options.name ?? "fabric",
		version: options.version ?? "0.1.0",
	});

	server.registerTool(
		"fabric_list_integrations",
		{
			title: "List Fabric Integrations",
			description:
				"List integrations connected for the authenticated Fabric workspace. " +
				"Returns slug, display name, current connection status, permission mode " +
				"(open/cautious/strict/readonly), and source (plugin/mcp-server/connector).",
			inputSchema: {},
		},
		async () => {
			const integrations = await fabric.integrations.list();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(integrations, null, 2),
					},
				],
			};
		},
	);

	server.registerTool(
		"fabric_list_operations",
		{
			title: "List Operations for an Integration",
			description:
				"List the dot-notation operations available on a single Fabric integration. " +
				"Returns an array of `{ operation, riskLevel, description }`. Supply the " +
				"slug from `fabric_list_integrations`.",
			inputSchema: {
				slug: z
					.string()
					.describe(
						'Integration slug, e.g. "slack", "github", "linear".',
					),
			},
		},
		async ({ slug }) => {
			// Endpoint metadata isn't exposed via the SDK's HTTP surface yet, so we
			// hit a known introspection path the portal returns under
			// `/integrations/:slug/operations`. Until that route lands, we surface a
			// helpful TODO so agents don't silently get an empty list.
			const integration = (
				fabric.integrations as Record<string, unknown>
			)[slug] as
				| {
						call?: (op: string, args?: unknown) => Promise<unknown>;
				  }
				| undefined;
			if (!integration) {
				return {
					content: [
						{
							type: "text",
							text: `Integration "${slug}" is not registered for this workspace.`,
						},
					],
					isError: true,
				};
			}
			try {
				// Best-effort: the portal may expose `__operations` as a
				// magic operation that returns the catalog.
				const ops = await integration.call?.("__operations");
				return {
					content: [
						{ type: "text", text: JSON.stringify(ops, null, 2) },
					],
				};
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Operation listing for "${slug}" requires portal endpoint /api/v1/integrations/${slug}/operations (not yet exposed). Use fabric_call with a known operation path in the meantime.`,
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"fabric_call",
		{
			title: "Call a Fabric Integration Operation",
			description:
				"Execute an operation on a connected Fabric integration. Args is a JSON " +
				"object whose shape depends on the specific operation. Returns the " +
				"upstream response, or { status: 'pending_approval' | 'denied' } when " +
				"the workspace permission policy gates the call.",
			inputSchema: {
				slug: z.string().describe('Integration slug, e.g. "slack".'),
				operation: z
					.string()
					.describe(
						'Dot-notation operation, e.g. "messages.send" or "channels.list".',
					),
				args: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"Arguments object. Shape depends on the operation.",
					),
			},
		},
		async ({ slug, operation, args }) => {
			const integration = (
				fabric.integrations as Record<string, unknown>
			)[slug] as
				| {
						call?: (op: string, args?: unknown) => Promise<unknown>;
				  }
				| undefined;
			if (!integration?.call) {
				return {
					content: [
						{
							type: "text",
							text: `Integration "${slug}" is not registered for this workspace.`,
						},
					],
					isError: true,
				};
			}
			try {
				const result = await integration.call(operation, args ?? {});
				return {
					content: [
						{ type: "text", text: JSON.stringify(result, null, 2) },
					],
				};
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				};
			}
		},
	);

	return server;
}

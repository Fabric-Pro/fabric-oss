import { callMcpTool } from "@repo/mcp";
import { isReadOnlyBlockedOutput } from "@repo/utils";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

/**
 * MCP App Tool Call Proxy
 *
 * Proxies tool calls from MCP App iframes back to the MCP server.
 *
 * When an MCP App iframe wants to call a tool (e.g. refresh data, save a diagram),
 * it sends a postMessage to the host. The host forwards the call here, which
 * creates a fresh MCP connection and executes the tool, returning the result.
 *
 * POST /api/mcp-app/call-tool
 * Body: { configId, toolName, args, organizationId?, projectId? }
 * Returns: { content: Array<{ type: string, text?: string, ... }> }
 *
 * `projectId` enables the Read-only mode write-gate: a write tool
 * (e.g. a diagram save) is blocked before it reaches the MCP server while the
 * project is read-only. Without it this route is a leak class (it carries no
 * project context of its own).
 */
export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { configId, toolName, args, organizationId, projectId } =
			await request.json();

		if (!configId || !toolName) {
			return Response.json(
				{ error: "configId and toolName are required" },
				{ status: 400 },
			);
		}

		const userId = session.user.id;

		// Use @modelcontextprotocol/sdk Client directly for tool execution
		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { SSEClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/sse.js"
		);
		const { StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/streamableHttp.js"
		);
		const { getMcpConfigById, getValidAccessToken } = await import(
			"@repo/database"
		);
		const { decryptApiKey } = await import("@repo/utils");

		// Get MCP config from database
		const mcpConfig = await getMcpConfigById(configId, {
			userId,
			organizationId,
		});

		if (!mcpConfig) {
			return Response.json(
				{ error: "MCP configuration not found" },
				{ status: 404 },
			);
		}

		if (!mcpConfig.enabled) {
			return Response.json(
				{ error: "MCP server is disabled" },
				{ status: 403 },
			);
		}

		const mcpServer = mcpConfig.mcpServer as {
			defaultUrl?: string;
			name?: string;
			transport?: string;
		} | null;

		const serverUrl = mcpConfig.baseUrl || mcpServer?.defaultUrl;
		if (!serverUrl) {
			return Response.json(
				{ error: "No server URL configured" },
				{ status: 400 },
			);
		}

		// Build auth headers
		const headers: Record<string, string> = {};
		const authType = mcpConfig.authType?.toString() || "NONE";

		if (authType === "OAUTH2") {
			const accessToken = await getValidAccessToken({
				configId,
				userId,
				organizationId,
			});
			if (accessToken) {
				headers.Authorization = `Bearer ${accessToken}`;
			}
		} else if (authType === "API_KEY" && mcpConfig.encryptedApiKey) {
			const apiKey = await decryptApiKey(
				mcpConfig.encryptedApiKey as string,
			);
			const apiKeyMethod = mcpConfig.apiKeyMethod?.toString() || "BEARER";
			if (apiKeyMethod === "HEADER") {
				headers["X-API-Key"] = apiKey;
			} else if (apiKeyMethod === "PLAIN") {
				headers.Authorization = apiKey;
			} else {
				headers.Authorization = `Bearer ${apiKey}`;
			}
		}

		// Determine transport
		const configTransport =
			mcpConfig.transport?.toString().toUpperCase() ||
			mcpServer?.transport?.toUpperCase() ||
			"HTTP";

		// Create MCP SDK Client directly
		const url = new URL(serverUrl);
		const transport =
			configTransport === "SSE"
				? new SSEClientTransport(url, {
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					})
				: new StreamableHTTPClientTransport(url, {
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					});

		const client = new Client(
			{ name: "fabric-mcp-app-host", version: "1.0.0" },
			{ capabilities: {} },
		);

		try {
			await client.connect(transport);

			// Route the dispatch through the shared funnel so a write tool is
			// blocked while the project is read-only. The raw SDK
			// client is kept (its CallToolResult shape is what the iframe
			// renderer expects); only the block case short-circuits.
			const result = await callMcpTool({
				toolName,
				projectId,
				execute: () =>
					client.callTool({
						name: toolName,
						arguments: args || {},
					}),
			});

			if (isReadOnlyBlockedOutput(result)) {
				return Response.json(
					{
						error: result.error,
						errorCode: result.code,
					},
					{ status: 409 },
				);
			}

			return Response.json(result);
		} finally {
			await client.close().catch(() => {});
		}
	} catch (error) {
		console.error("[MCP App Call Tool] Error:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to call MCP tool",
			},
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";

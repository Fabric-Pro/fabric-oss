import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

interface McpAppResourceMeta {
	csp?: Record<string, unknown>;
	permissions?: Record<string, unknown>;
	domain?: string;
}

interface McpAppResourceContent {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
	_meta?: Record<string, unknown>;
}

/**
 * MCP App Resource Proxy
 *
 * Fetches an MCP App HTML resource (ui:// URI) from an MCP server and returns
 * the HTML content to the client for rendering in a sandboxed iframe.
 *
 * The MCP Apps spec says tools with _meta.ui.resourceUri point to HTML pages
 * that should be rendered inside the host. This endpoint fetches that HTML
 * on behalf of the frontend using the user's configured MCP credentials.
 *
 * POST /api/mcp-app/resource
 * Body: { configId: string, resourceUri: string, organizationId?: string }
 * Returns: { html?: string, assetBaseUrl: string, contents: McpAppResourceContent[] }
 */
export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { configId, resourceUri, organizationId } = await request.json();

		if (!configId || !resourceUri) {
			return Response.json(
				{ error: "configId and resourceUri are required" },
				{ status: 400 },
			);
		}

		// Validate resourceUri scheme
		if (!resourceUri.startsWith("ui://")) {
			return Response.json(
				{ error: "resourceUri must use the ui:// scheme" },
				{ status: 400 },
			);
		}

		const userId = session.user.id;

		// Dynamically import to avoid edge runtime issues
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

		// Create MCP SDK Client directly (needed for resources/read)
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

			const result = await client.readResource({ uri: resourceUri });
			const contents = (result.contents ?? []) as McpAppResourceContent[];
			const content = contents[0];

			if (!content || !("text" in content) || !content.text) {
				return Response.json(
					{ error: "Resource returned no HTML content" },
					{ status: 404 },
				);
			}

			const assetBaseUrl = new URL(serverUrl).origin;
			const resourceMeta = (content._meta ?? undefined) as
				| McpAppResourceMeta
				| undefined;

			return Response.json({
				html: content.text,
				assetBaseUrl,
				mimeType: content.mimeType,
				resourceMeta,
				contents,
			});
		} finally {
			await client.close().catch(() => {});
		}
	} catch (error) {
		console.error("[MCP App Resource] Error fetching resource:", error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch MCP App resource",
			},
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";

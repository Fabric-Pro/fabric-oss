import { getSession } from "@saas/auth/lib/server";
import { authorizeMcpConfigRequest } from "@saas/mcp/lib/authorize-mcp-config-request";
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

		// Reading a resource needs MCP_READ in the named organization, checked
		// before the config is read: the config's own token outlives membership.
		const authorization = await authorizeMcpConfigRequest({
			userId,
			organizationId,
			action: "read",
		});
		if (!authorization.ok) {
			return authorization.response;
		}

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
		const { getMcpConfigById } = await import("@repo/database");
		// Resolves GitLab personal servers through the person's GitLab
		// connection; every other config through its own MCPConfig token.
		const { getValidMcpTransportAuth } = await import("@repo/mcp");
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
			key?: string | null;
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
		// Set for a GitLab personal server: the token may only travel to its
		// own GitLab origin, through the GitLab outbound guard, so every
		// transport request uses this fetch.
		let transportFetch:
			| ((url: string | URL, init?: RequestInit) => Promise<Response>)
			| undefined;

		// A GitLab personal server always takes the person's GitLab
		// connection token, whatever auth type its config names: an API key
		// stored on such a row is never sent.
		const { isGitLabPersonalMcpServerKey } = await import(
			"@repo/database/prisma/queries/lib/gitlab-personal-keys"
		);
		if (
			authType === "OAUTH2" ||
			isGitLabPersonalMcpServerKey(mcpServer?.key)
		) {
			const auth = await getValidMcpTransportAuth({
				configId,
				userId,
				organizationId,
				endpoint: serverUrl,
			});
			if (auth.accessToken) {
				headers.Authorization = `Bearer ${auth.accessToken}`;
			}
			transportFetch = auth.fetch;
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
						...(transportFetch ? { fetch: transportFetch } : {}),
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					})
				: new StreamableHTTPClientTransport(url, {
						...(transportFetch ? { fetch: transportFetch } : {}),
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

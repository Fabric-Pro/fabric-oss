import { getMcpConfigById } from "@repo/database";
import {
	callMcpTool,
	getCachedMcpClientForConfig,
	invalidateMcpClientCache,
	McpClientError,
} from "@repo/mcp";
import { isReadOnlyBlockedOutput } from "@repo/utils";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
	injectAtlassianCloudId,
	toolDeclaresCloudId,
} from "./atlassian-cloud-id";

/**
 * Generic MCP Tool Execution API
 *
 * Executes any MCP tool with the given parameters.
 * This is a generic endpoint that can work with any project management tool
 * that implements MCP (Fizzy, Linear, etc.)
 *
 * Uses getCachedMcpClientForConfig for connection reuse across requests.
 * The cache manages connection lifecycle (10-min TTL, max 20 entries, LRU eviction).
 * See packages/mcp/lib/client.ts for cache implementation details.
 */
export async function POST(request: NextRequest) {
	// These are declared outside try so they're available in the outer catch for cache invalidation
	let mcpConfigId: string | undefined;
	let sessionUserId: string | undefined;
	let resolvedOrganizationId: string | undefined;

	try {
		const session = await getSession();
		if (!session) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const {
			mcpConfigId: configId,
			toolName,
			params = {},
			action,
			organizationId,
			resourceUri,
			// Owning project id — enables the Read-only mode write-gate.
			// Optional: today's callers invoke read tools, but
			// this generic route can dispatch ANY tool, so writes must consult
			// the gate like every other dispatch surface.
			projectId,
		} = await request.json();

		mcpConfigId = configId;
		sessionUserId = session.user.id;
		resolvedOrganizationId = organizationId ?? undefined;

		if (!mcpConfigId) {
			return NextResponse.json(
				{ error: "MCP config ID is required" },
				{ status: 400 },
			);
		}

		// Use cached MCP client for connection reuse across requests.
		// Include redirectUri for OAuth2 token refresh support.
		const siteUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
		const redirectUri = `${siteUrl}/api/mcp/oauth/callback`;

		const clientOptions = {
			configId: mcpConfigId,
			userId: session.user.id,
			organizationId: resolvedOrganizationId,
			redirectUri,
		};

		// Get cached client and discover tools, with one retry on stale connection.
		// The cache does health checks for connections idle > 30s, but a connection
		// used within 30s could still die. The retry handles that edge case.
		let client: Awaited<
			ReturnType<typeof getCachedMcpClientForConfig>
		>["client"];
		let serverName: string;
		let tools: Record<string, any>;

		try {
			const result = await getCachedMcpClientForConfig(clientOptions);
			client = result.client;
			serverName = result.serverName;
			tools = await client.tools();
		} catch (clientOrToolsError) {
			// If it's a McpClientError (auth, config disabled, rate limit), don't retry —
			// these are business-logic errors, not stale connections.
			if (clientOrToolsError instanceof McpClientError) {
				console.error(
					"[MCP Tool API] MCP client error:",
					clientOrToolsError.message,
				);
				const statusCode = clientOrToolsError.isAuthError
					? 401
					: clientOrToolsError.isRateLimitError
						? 429
						: 500;

				return NextResponse.json(
					{
						error: clientOrToolsError.message,
						code: clientOrToolsError.code,
						serverName: clientOrToolsError.serverName,
						retryAfter: clientOrToolsError.retryAfter,
					},
					{ status: statusCode },
				);
			}

			// Likely a stale cached connection. Invalidate and retry once with a fresh client.
			console.warn(
				"[MCP Tool API] Stale connection detected, retrying with fresh client:",
				clientOrToolsError instanceof Error
					? clientOrToolsError.message
					: clientOrToolsError,
			);

			await invalidateMcpClientCache(
				mcpConfigId,
				session.user.id,
				resolvedOrganizationId,
			).catch(() => {}); // Best-effort — don't let invalidation failure block the retry

			try {
				const retry = await getCachedMcpClientForConfig({
					...clientOptions,
					forceNew: true,
				});
				client = retry.client;
				serverName = retry.serverName;
				tools = await retry.client.tools();
			} catch (retryError) {
				console.error("[MCP Tool API] Retry also failed:", retryError);

				if (retryError instanceof McpClientError) {
					const statusCode = retryError.isAuthError
						? 401
						: retryError.isRateLimitError
							? 429
							: 500;
					return NextResponse.json(
						{
							error: retryError.message,
							code: retryError.code,
							serverName: retryError.serverName,
							retryAfter: retryError.retryAfter,
						},
						{ status: statusCode },
					);
				}

				const errorMessage =
					retryError instanceof Error
						? retryError.message
						: "Failed to connect to MCP server";
				return NextResponse.json(
					{ error: `MCP connection failed: ${errorMessage}` },
					{ status: 500 },
				);
			}
		}

		const availableTools = Object.keys(tools);

		// Handle list_tools action - returns available tools without executing
		if (action === "list_tools") {
			console.log(
				`[MCP Tool API] Listing tools for ${serverName}:`,
				availableTools,
			);
			return NextResponse.json({ tools: availableTools, serverName });
		}

		// Handle listResources action - list available MCP resources (e.g., Google Drive files)
		if (action === "listResources") {
			const clientAny = client as unknown as {
				listResources?: (cursor?: string) => Promise<unknown>;
			};
			if (!clientAny.listResources) {
				return NextResponse.json(
					{
						error: "This MCP server does not support resource listing",
					},
					{ status: 501 },
				);
			}

			const result = await clientAny.listResources(params?.cursor);
			return NextResponse.json({ result, serverName });
		}

		// Handle readResource action - read an MCP resource by URI
		if (action === "readResource") {
			if (!resourceUri) {
				return NextResponse.json(
					{ error: "resourceUri is required for readResource" },
					{ status: 400 },
				);
			}

			console.log(
				`[MCP Tool API] Reading resource: ${resourceUri} from ${serverName}`,
			);

			// Use the client's readResource method (available on STDIO wrapper clients)
			const clientAny = client as unknown as {
				readResource?: (uri: string) => Promise<unknown>;
			};
			if (!clientAny.readResource) {
				return NextResponse.json(
					{
						error: "This MCP server does not support resource reading",
					},
					{ status: 501 },
				);
			}

			const resourceResult = await clientAny.readResource(resourceUri);

			// Parse MCP resource format: { contents: [{ uri, mimeType, text }] }
			let parsed: unknown = resourceResult;
			if (
				resourceResult &&
				typeof resourceResult === "object" &&
				"contents" in (resourceResult as Record<string, unknown>)
			) {
				const contents = (
					resourceResult as { contents?: Array<{ text?: string }> }
				).contents;
				if (contents?.[0]?.text) {
					parsed = contents[0].text;
				}
			}

			return NextResponse.json({
				result: parsed,
				resourceUri,
				serverName,
			});
		}

		// For tool execution, toolName is required
		if (!toolName) {
			return NextResponse.json(
				{ error: "Tool name is required" },
				{ status: 400 },
			);
		}

		console.log(
			"[MCP Tool API] Executing %s with params:",
			toolName,
			params,
		);

		const tool = tools[toolName];

		if (!tool) {
			console.error(
				"[MCP Tool API] Tool %s not found. Available:",
				toolName,
				availableTools,
			);
			return NextResponse.json(
				{
					error: `Tool "${toolName}" not found on ${serverName}`,
					availableTools,
				},
				{ status: 404 },
			);
		}

		// Atlassian Rovo tools require a cloudId the OAuth flow already resolved
		// and persisted on the config. Inject it for tools that declare the param
		// (only when the caller didn't already supply one) so callers — the
		// Confluence page picker, content fetcher, etc. — don't each re-resolve it.
		let execParams: Record<string, unknown> = params;
		if (params?.cloudId == null && toolDeclaresCloudId(tool)) {
			const config = await getMcpConfigById(mcpConfigId, {
				userId: session.user.id,
				organizationId: resolvedOrganizationId,
			});
			execParams = injectAtlassianCloudId(
				params,
				tool,
				config?.atlassianCloudCloudId,
			);
		}

		// Execute the tool through the shared external-dispatch funnel — a
		// WRITE-classified tool is blocked here when the project is read-only,
		// before it reaches the MCP server.
		const result = await callMcpTool({
			toolName,
			projectId,
			execute: () =>
				tool.execute(execParams, {
					toolCallId: `${toolName}-${Date.now()}`,
					messages: [],
				}),
		});

		if (isReadOnlyBlockedOutput(result)) {
			return NextResponse.json(
				{ error: result.error, code: result.code, toolName },
				{ status: 409 },
			);
		}

		console.log(
			"[MCP Tool API] %s raw result:",
			toolName,
			JSON.stringify(result, null, 2),
		);

		// Parse MCP content format
		const parsed = parseMcpResult(result);
		console.log("[MCP Tool API] %s parsed result:", toolName, parsed);

		return NextResponse.json({ result: parsed, toolName, serverName });
	} catch (error) {
		console.error("[MCP Tool API] Error:", error);

		// Invalidate cache so the next request gets a fresh connection.
		// This handles the case where tool.execute() failed due to a dying connection.
		// Best-effort — don't let cache invalidation failure mask the real error.
		if (mcpConfigId && sessionUserId) {
			await invalidateMcpClientCache(
				mcpConfigId,
				sessionUserId,
				resolvedOrganizationId,
			).catch(() => {});
		}

		const errorMessage =
			error instanceof Error ? error.message : "Failed to execute tool";

		// Detect upstream auth errors (e.g., expired PAT, revoked token)
		// These surface as MCP tool errors containing "401" or "unauthorized"
		const isAuthError =
			/\b401\b/.test(errorMessage) ||
			/unauthorized/i.test(errorMessage) ||
			/authentication failed/i.test(errorMessage);

		if (isAuthError) {
			return NextResponse.json(
				{
					error: "Authentication failed. Your access token may be expired or revoked. Please update it in MCP Settings.",
					code: "AUTH_TOKEN_EXPIRED",
				},
				{ status: 401 },
			);
		}

		return NextResponse.json(
			{
				error: errorMessage,
			},
			{ status: 500 },
		);
	}
	// No finally { closeMcpClient } — the cache manages connection lifecycle.
	// See report-agent-loop.ts:1012-1016 for the same pattern and rationale.
}

/**
 * Try to parse a string as JSON; return the raw string if it's not valid JSON.
 * MCP tools like Notion's `notion-fetch` return markdown/plain text, not JSON.
 */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Not valid JSON — return as-is (e.g., markdown content from notion-fetch)
		return text;
	}
}

/**
 * Parse MCP tool result - handles the content array format
 * MCP SDK returns: { content: [{ type: "text", text: "..." }], isError: false }
 */
function parseMcpResult(result: unknown): unknown {
	try {
		// Handle MCP SDK format: { content: [{ type: "text", text: "..." }], isError: false }
		if (result && typeof result === "object" && !Array.isArray(result)) {
			const obj = result as Record<string, unknown>;

			// Check for error response
			if (obj.isError === true) {
				const errorContent = Array.isArray(obj.content)
					? obj.content.find((c: any) => c.type === "text")
					: null;
				const errorMessage =
					errorContent?.text || "MCP tool returned an error";
				throw new Error(errorMessage as string);
			}

			// Check for { content: [...] } wrapper format (MCP SDK response)
			if (Array.isArray(obj.content)) {
				const textContent = obj.content.find(
					(c: any) => c.type === "text",
				);
				if (textContent && "text" in textContent) {
					return tryParseJson(textContent.text as string);
				}
			}

			// Direct object (not a content wrapper)
			return result;
		}

		// MCP returns an array of content parts directly
		if (Array.isArray(result)) {
			const textContent = result.find((c: any) => c.type === "text");
			if (textContent && "text" in textContent) {
				return tryParseJson(textContent.text as string);
			}
		}

		// String value
		if (typeof result === "string") {
			return tryParseJson(result);
		}

		return result;
	} catch (e) {
		if (e instanceof Error && e.message !== "MCP tool returned an error") {
			console.error("[MCP Tool API] Parse error:", e);
		}
		throw e;
	}
}

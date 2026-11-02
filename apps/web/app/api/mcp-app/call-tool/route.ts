import {
	forbiddenOrganizationResponse,
	resolveRequestedOrganization,
} from "@repo/api/lib/requested-organization";
import { callMcpTool, guardToolWriteForReadOnly } from "@repo/mcp";
import {
	isReadOnlyBlockedOutput,
	type ReadOnlyBlockedOutput,
} from "@repo/utils";
import { getSession } from "@saas/auth/lib/server";
import { authorizeMcpConfigRequest } from "@saas/mcp/lib/authorize-mcp-config-request";
import {
	executeWithDurableEnvelope,
	isDurableMcpToolRequest,
} from "@saas/mcp/lib/gateway/mcp-apps";
import {
	authorizePlatformToolCall,
	executeAuthorizedPlatformToolCall,
	executePlatformTool,
	platformToolReplayAllowed,
} from "@saas/mcp/lib/gateway/platform-tools";
import { isPlatformToolName } from "@saas/mcp/lib/gateway/tool-eligibility";
import type { ToolCallResult } from "@saas/mcp/lib/gateway/types";
import type { NextRequest } from "next/server";

const READ_ONLY_BLOCK_META_KEY = "fabric/readOnlyBlocked";

function asToolCallResult(result: unknown): ToolCallResult {
	if (!isReadOnlyBlockedOutput(result)) {
		return result as ToolCallResult;
	}
	return {
		isError: true,
		content: [{ type: "text", text: result.error }],
		_meta: { [READ_ONLY_BLOCK_META_KEY]: result },
	};
}

function readOnlyBlockFromResult(
	result: unknown,
): ReadOnlyBlockedOutput | null {
	if (isReadOnlyBlockedOutput(result)) {
		return result;
	}
	const stored = (result as { _meta?: Record<string, unknown> } | null)
		?._meta?.[READ_ONLY_BLOCK_META_KEY];
	return isReadOnlyBlockedOutput(stored) ? stored : null;
}

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

		const {
			configId,
			toolName,
			args,
			organizationId,
			projectId,
			durable,
			idempotencyKey,
			_meta: requestMetadata,
		} = await request.json();
		const rpcParams =
			requestMetadata &&
			typeof requestMetadata === "object" &&
			!Array.isArray(requestMetadata)
				? { _meta: requestMetadata as Record<string, unknown> }
				: undefined;

		if (!configId || !toolName) {
			return Response.json(
				{ error: "configId and toolName are required" },
				{ status: 400 },
			);
		}

		const userId = session.user.id;
		const organizationResolution = await resolveRequestedOrganization({
			userId,
			requestedOrganizationId: organizationId,
			activeOrganizationId: session.session.activeOrganizationId,
		});
		if (!organizationResolution.ok) {
			return forbiddenOrganizationResponse(organizationResolution);
		}
		const resolvedOrganizationId = organizationResolution.organizationId;

		// Executing a tool needs MCP_CONNECT in the named organization, checked
		// before the config is read: the config's own token outlives membership.
		const authorization = await authorizeMcpConfigRequest({
			userId,
			organizationId: resolvedOrganizationId,
			action: "connect",
		});
		if (!authorization.ok) {
			return authorization.response;
		}

		// Built-in Fabric platform tool execution for MCP Apps (`configId === "platform"`)
		if (configId === "platform" && isPlatformToolName(toolName)) {
			const gatewaySession = {
				sessionId: `mcp-app-${userId}`,
				userId,
				organizationId: resolvedOrganizationId,
				projectId: projectId ?? null,
				userName: session.user.name || "",
				email: session.user.email || "",
				role: (session.user.role as "user" | "admin") || "user",
				credential: "session" as const,
				credentialId: userId,
				scopes: ["*"],
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			};
			const toolArgs = (args || {}) as Record<string, unknown>;
			const shouldRunDurable =
				durable === true ||
				isDurableMcpToolRequest(request, rpcParams, toolArgs);

			const runPlatform = async () =>
				asToolCallResult(
					await callMcpTool({
						toolName,
						projectId,
						execute: () =>
							executePlatformTool(
								toolName,
								toolArgs,
								gatewaySession,
							),
					}),
				);

			const rawResult = shouldRunDurable
				? await executeWithDurableEnvelope({
						toolName,
						toolArgs,
						organizationId: resolvedOrganizationId,
						userId,
						identity: {
							credentialKind: "session",
							credentialId: userId,
							projectBinding: projectId ?? null,
							serverBinding: "platform",
						},
						request,
						rpcParams,
						explicitIdempotencyKey:
							typeof idempotencyKey === "string"
								? idempotencyKey
								: undefined,
						authorize: async () => {
							const blocked = await guardToolWriteForReadOnly(
								projectId,
								toolName,
							);
							return blocked
								? {
										ok: false as const,
										result: asToolCallResult(blocked),
									}
								: authorizePlatformToolCall(
										toolName,
										toolArgs,
										gatewaySession,
									);
						},
						execute: (authorized) =>
							executeAuthorizedPlatformToolCall(authorized),
						replayAllowed: platformToolReplayAllowed(toolName),
					})
				: await runPlatform();
			const readOnlyBlock = readOnlyBlockFromResult(rawResult);
			if (readOnlyBlock) {
				return Response.json(
					{
						error: readOnlyBlock.error,
						errorCode: readOnlyBlock.code,
					},
					{ status: 409 },
				);
			}

			return Response.json(rawResult);
		}

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
		const { getMcpConfigById } = await import("@repo/database");
		const { assertMcpServerUrlResolved, fetchMcpServer } = await import(
			"@repo/mcp/lib/server-url-guard"
		);
		// Resolves GitLab personal servers through the person's GitLab
		// connection; every other config through its own MCPConfig token.
		const { getValidMcpTransportAuth } = await import("@repo/mcp");
		const { decryptApiKey } = await import("@repo/utils");

		// Get MCP config from database
		const mcpConfig = await getMcpConfigById(configId, {
			userId,
			organizationId: resolvedOrganizationId,
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
		await assertMcpServerUrlResolved(serverUrl);

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
				organizationId: resolvedOrganizationId,
				endpoint: serverUrl,
				expectedGrantGeneration: mcpConfig.oauthGrantGeneration,
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

		// Create MCP SDK Client directly
		const url = new URL(serverUrl);
		const transport =
			configTransport === "SSE"
				? new SSEClientTransport(url, {
						fetch: transportFetch ?? fetchMcpServer,
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					})
				: new StreamableHTTPClientTransport(url, {
						fetch: transportFetch ?? fetchMcpServer,
						requestInit:
							Object.keys(headers).length > 0
								? { headers }
								: undefined,
					});

		const client = new Client(
			{ name: "fabric-mcp-app-host", version: "1.0.0" },
			{ capabilities: {} },
		);
		const toolArgs = (args || {}) as Record<string, unknown>;
		const shouldRunDurable =
			durable === true ||
			isDurableMcpToolRequest(request, rpcParams, toolArgs);

		try {
			await client.connect(transport);

			// Route the dispatch through the shared funnel so a write tool is
			// blocked while the project is read-only. The raw SDK
			// client is kept (its CallToolResult shape is what the iframe
			// renderer expects); only the block case short-circuits.
			const runTool = async () =>
				asToolCallResult(
					await callMcpTool({
						toolName,
						projectId,
						execute: () =>
							client.callTool({
								name: toolName,
								arguments: toolArgs,
							}),
					}),
				);
			const result = shouldRunDurable
				? await executeWithDurableEnvelope({
						toolName,
						toolArgs,
						organizationId: resolvedOrganizationId,
						userId,
						identity: {
							credentialKind: "session",
							credentialId: userId,
							projectBinding: projectId ?? null,
							serverBinding: configId,
						},
						request,
						rpcParams,
						explicitIdempotencyKey:
							typeof idempotencyKey === "string"
								? idempotencyKey
								: undefined,
						authorize: async () => {
							const blocked = await guardToolWriteForReadOnly(
								projectId,
								toolName,
							);
							return blocked
								? {
										ok: false as const,
										result: asToolCallResult(blocked),
									}
								: { ok: true as const, context: undefined };
						},
						execute: async () =>
							asToolCallResult(
								await client.callTool({
									name: toolName,
									arguments: toolArgs,
								}),
							),
						// A configured server may authorize inside callTool. A live
						// connection alone cannot prove that the call is still allowed.
						replayAllowed: false,
					})
				: await runTool();

			const readOnlyBlock = readOnlyBlockFromResult(result);
			if (readOnlyBlock) {
				return Response.json(
					{
						error: readOnlyBlock.error,
						errorCode: readOnlyBlock.code,
					},
					{ status: 409 },
				);
			}

			return Response.json(result);
		} finally {
			await client.close().catch(() => {});
		}
	} catch (error) {
		console.error("[MCP App Call Tool] Error:", {
			error: error instanceof Error ? error.message : error,
			stack: error instanceof Error ? error.stack : undefined,
		});
		return Response.json(
			{ error: "Failed to call MCP tool" },
			{ status: 500 },
		);
	}
}

export const runtime = "nodejs";

/**
 * Fabric MCP Gateway - Streamable HTTP Transport
 *
 * Unified MCP endpoint that exposes ALL Fabric capabilities and connected
 * MCP server tools through a single URL. Works with any MCP client:
 * Claude Desktop, Cursor, VS Code, Windsurf, or custom implementations.
 *
 * Authentication:
 *   - API Key: `Authorization: Bearer fab_xxx` (recommended for external clients)
 *   - Session cookie: Better Auth session (for browser-based clients)
 *   - Organization context: `X-Organization-Id` header (optional)
 *
 * MCP Protocol:
 *   - POST: JSON-RPC requests (initialize, tools/list, tools/call, etc.)
 *   - DELETE: Terminate session
 *   - GET: Server info (non-standard, for health checks)
 *
 * Tool Namespacing:
 *   - Platform tools: `fabric_*` (e.g., fabric_list_projects, fabric_get_document)
 *   - Connected server tools: `{prefix}__{tool}` (e.g., linear__list_issues)
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 */

import { createHash } from "node:crypto";
import { verifyUserApiKey } from "@repo/api/modules/users/procedures/api-keys";
import { auth } from "@repo/auth";
import {
	createGatewaySession,
	deleteGatewaySession,
	executeConnectedServerTool,
	executePlatformTool,
	type GatewaySession,
	getAggregatedTools,
	getGatewaySession,
	type JsonRpcRequest,
	updateSessionOrganization,
} from "@saas/mcp/lib/gateway";
import {
	enforceAuthority,
	generateRequestFingerprint,
	resolveProviderKeyFromToolPrefix,
} from "@saas/mcp/lib/gateway/authority-service";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GATEWAY_NAME = "fabric-mcp-gateway";
const GATEWAY_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

// ─── Authentication ─────────────────────────────────────────────────────────

interface AuthResult {
	userId: string;
	organizationId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
}

/**
 * Authenticate the request via API key or session cookie.
 */
async function authenticateRequest(
	request: NextRequest,
): Promise<AuthResult | null> {
	const authHeader = request.headers.get("authorization");

	// 1a. Personal API key (Bearer fab_xxx) — organizationId always null
	if (authHeader?.startsWith("Bearer fab_")) {
		const apiKey = authHeader.substring(7);
		const result = await verifyUserApiKey(apiKey);

		if (!result.valid || !result.userId) {
			return null;
		}

		const { db } = await import("@repo/database");
		const user = await db.user.findUnique({
			where: { id: result.userId },
			select: { name: true, email: true, role: true },
		});

		if (!user) {
			return null;
		}

		return {
			userId: result.userId,
			organizationId: null,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
		};
	}

	// 1b. Organization API key (Bearer org_xxx) — organizationId comes from the key record itself
	if (authHeader?.startsWith("Bearer org_")) {
		const apiKey = authHeader.substring(7);
		const parts = apiKey.split("_");
		if (parts.length < 3 || parts[0] !== "org") {
			return null;
		}

		const keyPrefix = `org_${parts[1]}`;
		const {
			getOrganizationApiKeyByPrefix,
			updateOrganizationApiKeyUsage,
			db,
		} = await import("@repo/database");

		const storedKey = await getOrganizationApiKeyByPrefix(keyPrefix);
		if (!storedKey || !storedKey.isActive) {
			return null;
		}
		if (storedKey.expiresAt && storedKey.expiresAt < new Date()) {
			return null;
		}

		const keyHash = createHash("sha256").update(apiKey).digest("hex");
		if (keyHash !== storedKey.keyHash) {
			return null;
		}

		updateOrganizationApiKeyUsage(storedKey.id).catch(() => {});

		const user = await db.user.findUnique({
			where: { id: storedKey.createdByUserId },
			select: { name: true, email: true, role: true },
		});

		if (!user) {
			return null;
		}

		return {
			userId: storedKey.createdByUserId,
			organizationId: storedKey.organizationId,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
		};
	}

	// 2. Better Auth session
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return null;
	}

	return {
		userId: session.user.id,
		organizationId: session.session.activeOrganizationId ?? null,
		userName: session.user.name || "Unknown",
		email: session.user.email,
		role: (session.user.role as "user" | "admin") || "user",
	};
}

// ─── Origin Validation ──────────────────────────────────────────────────────

function validateOrigin(request: NextRequest): boolean {
	const origin = request.headers.get("origin");
	if (!origin) {
		return true; // No origin = same-origin or non-browser
	}

	if (process.env.NODE_ENV === "development") {
		if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
			return true;
		}
	}

	const host = request.headers.get("host");
	try {
		const originUrl = new URL(origin);
		return originUrl.hostname === host?.split(":")[0];
	} catch {
		return false;
	}
}

// ─── Session Management ─────────────────────────────────────────────────────

async function getOrCreateSession(
	mcpSessionId: string | null,
	authResult: AuthResult,
): Promise<{ session: GatewaySession; sessionId: string; isNew: boolean }> {
	// Try existing session from the centralized session store
	if (mcpSessionId) {
		const existing = getGatewaySession(mcpSessionId);
		if (existing && existing.userId === authResult.userId) {
			return { session: existing, sessionId: mcpSessionId, isNew: false };
		}
	}

	// Create new session
	const session = await createGatewaySession({
		userId: authResult.userId,
		organizationId: authResult.organizationId,
		userName: authResult.userName,
		email: authResult.email,
		role: authResult.role,
	});

	return { session, sessionId: session.sessionId, isNew: true };
}

// ─── JSON-RPC Helpers ───────────────────────────────────────────────────────

function jsonRpcSuccess(
	id: string | number | null,
	result: unknown,
	mcpSessionId: string,
): NextResponse {
	return NextResponse.json(
		{ jsonrpc: "2.0", id, result },
		{
			headers: {
				"Content-Type": "application/json",
				"Mcp-Session-Id": mcpSessionId,
			},
		},
	);
}

function jsonRpcError(
	id: string | number | null,
	code: number,
	message: string,
	mcpSessionId?: string,
): NextResponse {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (mcpSessionId) {
		headers["Mcp-Session-Id"] = mcpSessionId;
	}

	return NextResponse.json(
		{ jsonrpc: "2.0", id, error: { code, message } },
		{ headers },
	);
}

// ─── POST Handler ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
	// Validate Origin
	if (!validateOrigin(request)) {
		return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	}

	// Validate Accept header
	const accept = request.headers.get("accept") || "";
	if (
		!accept.includes("application/json") &&
		!accept.includes("text/event-stream") &&
		!accept.includes("*/*")
	) {
		return NextResponse.json(
			{
				error: "Accept header must include application/json or text/event-stream",
			},
			{ status: 406 },
		);
	}

	// Authenticate
	const authResult = await authenticateRequest(request);
	if (!authResult) {
		return NextResponse.json(
			{
				error: "Unauthorized. Provide a personal API key (Bearer fab_xxx), org API key (Bearer org_xxx), or session cookie.",
			},
			{ status: 401 },
		);
	}

	// Parse JSON-RPC request
	let rpcRequest: JsonRpcRequest;
	try {
		const body = await request.json();
		rpcRequest = body as JsonRpcRequest;
	} catch {
		return jsonRpcError(null, -32700, "Parse error");
	}

	if (rpcRequest.jsonrpc !== "2.0") {
		return jsonRpcError(
			rpcRequest.id ?? null,
			-32600,
			"Invalid JSON-RPC version",
		);
	}

	// Handle notifications (no id)
	if (rpcRequest.id === undefined || rpcRequest.id === null) {
		const mcpSessionId = request.headers.get("mcp-session-id") || "";
		return new NextResponse(null, {
			status: 202,
			headers: { "Mcp-Session-Id": mcpSessionId },
		});
	}

	// Get or create MCP session
	const incomingSessionId = request.headers.get("mcp-session-id");
	const { session, sessionId } = await getOrCreateSession(
		incomingSessionId,
		authResult,
	);

	// Route by method
	switch (rpcRequest.method) {
		case "initialize":
			return handleInitialize(rpcRequest.id, sessionId);

		case "notifications/initialized":
			return new NextResponse(null, {
				status: 202,
				headers: { "Mcp-Session-Id": sessionId },
			});

		case "tools/list":
			return handleToolsList(rpcRequest.id, session, sessionId);

		case "tools/call":
			return handleToolsCall(
				rpcRequest.id,
				rpcRequest.params,
				session,
				sessionId,
			);

		case "ping":
			return jsonRpcSuccess(rpcRequest.id, {}, sessionId);

		default:
			return jsonRpcError(
				rpcRequest.id,
				-32601,
				`Method not found: ${rpcRequest.method}`,
				sessionId,
			);
	}
}

// ─── DELETE Handler ─────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest): Promise<NextResponse> {
	const mcpSessionId = request.headers.get("mcp-session-id");
	if (mcpSessionId) {
		// Complete any active authority sessions tied to this gateway session
		// This ensures authority doesn't outlive the transport session
		try {
			const { db } = await import("@repo/database");
			const { completeAuthoritySession } = await import("@repo/database");
			const gatewaySession = getGatewaySession(mcpSessionId);
			if (gatewaySession) {
				const orgFilter = gatewaySession.organizationId
					? { organizationId: gatewaySession.organizationId }
					: { organizationId: null };
				const activeSessions = await db.authoritySession.findMany({
					where: {
						userId: gatewaySession.userId,
						...orgFilter,
						runType: "MCP_GATEWAY",
						status: "ACTIVE",
					},
					select: { id: true },
				});
				for (const s of activeSessions) {
					completeAuthoritySession(s.id).catch(() => {});
				}
			}
		} catch {
			// Best-effort cleanup
		}
		deleteGatewaySession(mcpSessionId);
	}
	return new NextResponse(null, { status: 204 });
}

// ─── GET Handler (Health Check / Server Info) ───────────────────────────────

export async function GET(_request: NextRequest): Promise<NextResponse> {
	return NextResponse.json({
		name: GATEWAY_NAME,
		version: GATEWAY_VERSION,
		protocol: PROTOCOL_VERSION,
		description:
			"Fabric MCP Gateway — unified MCP endpoint aggregating platform tools and connected MCP servers. " +
			"Authenticate with API key (Authorization: Bearer fab_xxx) and send MCP JSON-RPC via POST.",
		endpoints: {
			POST: "JSON-RPC requests (initialize, tools/list, tools/call)",
			DELETE: "Terminate MCP session",
			GET: "This server info page",
		},
		documentation: "https://docs.fabric.dev/mcp-gateway",
	});
}

// ─── Method Handlers ────────────────────────────────────────────────────────

function handleInitialize(
	id: string | number,
	sessionId: string,
): NextResponse {
	return jsonRpcSuccess(
		id,
		{
			protocolVersion: PROTOCOL_VERSION,
			serverInfo: {
				name: GATEWAY_NAME,
				version: GATEWAY_VERSION,
			},
			capabilities: {
				tools: { listChanged: true },
			},
			instructions:
				"Fabric MCP Gateway — your unified interface to Fabric platform tools and all connected MCP servers.\n\n" +
				"## Tool naming\n" +
				"- Platform tools: `fabric_*` (e.g., fabric_list_projects, fabric_get_document)\n" +
				"- Connected server tools: `{server}__{tool}` (e.g., linear__list_issues)\n\n" +
				"## Getting started\n" +
				"1. Call `fabric_get_identity` to see your current context\n" +
				"2. Call `fabric_list_connected_servers` to see available integrations\n\n" +
				"## Runtime authority (required for connected server tools)\n" +
				"Connected server tools require runtime authority before use. Platform tools (fabric_*) are always available.\n" +
				"1. Call `fabric_request_authority` with the providers and access levels you need\n" +
				"2. The user must approve in the Fabric UI (approval is human-only)\n" +
				"3. Call `fabric_check_authority` to see when approval is granted\n" +
				"4. Once approved, connected server tools become callable for the session duration\n" +
				"5. Authority expires automatically or can be revoked with `fabric_revoke_authority`\n\n" +
				"Tools in the tools/list response include `_meta.requiresAuthority` and `_meta.authorityStatus` " +
				"to indicate which tools need authority and whether it's currently granted.",
		},
		sessionId,
	);
}

async function handleToolsList(
	id: string | number,
	session: GatewaySession,
	sessionId: string,
): Promise<NextResponse> {
	try {
		const { tools, servers } = await getAggregatedTools(session);

		// Check which providers currently have active authority grants
		const authorizedProviders = new Set<string>();
		try {
			const { getActiveAuthoritySessionForRun } = await import(
				"@repo/database"
			);
			const activeAuth = await getActiveAuthoritySessionForRun(
				"MCP_GATEWAY",
				sessionId,
				session.userId,
				session.organizationId || undefined,
			);
			if (activeAuth) {
				for (const grant of activeAuth.grants) {
					if (grant.status === "APPROVED") {
						authorizedProviders.add(grant.providerKey);
					}
				}
			}
		} catch {
			// Best-effort — don't block tools/list if authority check fails
		}

		// Return in MCP format with authority metadata for connected tools
		const mcpTools = tools.map((t) => {
			const base = {
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
				...(t.annotations ? { annotations: t.annotations } : {}),
			};

			// Add authority metadata for connected server tools
			if (t._gateway_source && t._gateway_source !== "platform") {
				const prefix = t.name.split("__")[0];
				const serverInfo = servers.find((s) => s.toolPrefix === prefix);
				const providerKey = serverInfo
					? (resolveProviderKeyFromToolPrefix(prefix, servers)
							?.providerKey ?? `custom:${prefix}`)
					: `custom:${prefix}`;
				const isAuthorized = authorizedProviders.has(providerKey);

				return {
					...base,
					_meta: {
						requiresAuthority: true,
						authorityStatus: isAuthorized ? "granted" : "missing",
						providerKey,
					},
				};
			}

			return base;
		});

		return jsonRpcSuccess(id, { tools: mcpTools }, sessionId);
	} catch (error) {
		console.error("[MCP Gateway] tools/list error:", error);
		return jsonRpcError(id, -32603, "Failed to list tools", sessionId);
	}
}

async function handleToolsCall(
	id: string | number,
	params: Record<string, unknown> | undefined,
	session: GatewaySession,
	sessionId: string,
): Promise<NextResponse> {
	const toolName = params?.name as string;
	const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

	if (!toolName) {
		return jsonRpcError(id, -32602, "Missing tool name", sessionId);
	}

	try {
		let result: {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};

		if (toolName.startsWith("fabric_")) {
			// Platform tool
			result = await executePlatformTool(toolName, toolArgs, session);

			// Handle org switch — persist to session store
			if (toolName === "fabric_switch_organization" && !result.isError) {
				updateSessionOrganization(sessionId, session.organizationId);
			}
		} else if (toolName.includes("__")) {
			// Connected server tool (namespaced) — enforce authority gate
			const { tools, servers } = await getAggregatedTools(session);

			// Resolve provider key from tool prefix
			const separatorIndex = toolName.indexOf("__");
			const prefix = toolName.slice(0, separatorIndex);
			const providerInfo = resolveProviderKeyFromToolPrefix(
				prefix,
				servers,
			);
			const providerKey = providerInfo?.providerKey ?? `custom:${prefix}`;

			// Find tool annotations from aggregated tools
			const toolDef = tools.find((t) => t.name === toolName);
			const annotations = toolDef?.annotations as
				| {
						readOnlyHint?: boolean;
						destructiveHint?: boolean;
				  }
				| undefined;

			// Generate request fingerprint for one-shot grant matching
			const fingerprint = await generateRequestFingerprint(
				toolName,
				toolArgs,
			);

			// Look up the authority session bound to this specific gateway session.
			// If no session exists for this exact runId, the check will correctly deny —
			// we pass boundRunId to ensure strict per-session binding.
			const authorityResult = await enforceAuthority({
				toolName,
				providerKey,
				session,
				annotations,
				requestFingerprint: fingerprint,
				boundRunType: "MCP_GATEWAY",
				boundRunId: sessionId, // Strict: only grants from THIS gateway session
			});

			if (!authorityResult.authorized) {
				result = {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "Authority required",
								reason: authorityResult.reason,
								action: authorityResult.action,
								pendingSessionId:
									authorityResult.pendingSessionId,
								hint:
									authorityResult.action ===
									"request_authority"
										? `Use fabric_request_authority to request access for provider "${providerKey}".`
										: authorityResult.action ===
												"approve_pending"
											? `A pending authority request (session ${authorityResult.pendingSessionId}) needs approval in the Fabric UI.`
											: `Current authority level is insufficient. Request WRITE access for "${providerKey}".`,
								providerKey,
							}),
						},
					],
					isError: true,
				};
			} else {
				// Authority granted — execute the tool
				result = await executeConnectedServerTool(
					toolName,
					toolArgs,
					session,
					servers,
				);

				// If the grant was a one-shot REQUEST, consume it
				if (
					authorityResult.grant?.kind === "REQUEST" &&
					authorityResult.grant?.id
				) {
					const { consumeRequestGrant } = await import(
						"@repo/database"
					);
					consumeRequestGrant(authorityResult.grant.id).catch(
						() => {},
					);
				}
			}
		} else {
			result = {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							error: `Unknown tool: ${toolName}`,
							hint: "Platform tools start with 'fabric_'. Connected server tools use 'servername__toolname' format.",
						}),
					},
				],
				isError: true,
			};
		}

		return jsonRpcSuccess(id, result, sessionId);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Tool execution failed";
		console.error(`[MCP Gateway] tools/call ${toolName} error:`, error);

		return jsonRpcSuccess(
			id,
			{
				content: [
					{ type: "text", text: JSON.stringify({ error: message }) },
				],
				isError: true,
			},
			sessionId,
		);
	}
}

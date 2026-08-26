/**
 * Fabric Tool Router Integration
 *
 * Provides MCP tool access via Fabric's centralized tool router.
 * Replaces Composio with native Fabric MCP connections.
 */

import { env } from "./env";

interface FabricToolSession {
	mcp: {
		url: string;
		headers: Record<string, string>;
	};
	sessionId: string;
	expiresAt: string;
}

/**
 * Get an MCP session from Fabric's tool router.
 *
 * The tool router provides access to all MCP servers configured for the user/organization.
 * Sessions are valid for 24 hours and handle authentication automatically.
 *
 * @param userId - The authenticated user's ID
 * @param organizationId - Optional organization context (null for personal context)
 * @returns MCP session with URL and headers for making tool calls
 */
export async function getFabricToolSession(
	userId: string,
	organizationId: string | null,
): Promise<FabricToolSession> {
	const fabricApiUrl = env.FABRIC_API_URL;

	const response = await fetch(
		`${fabricApiUrl}/api/fabric/tool-router/session`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.AGENT_API_KEY}`,
				"x-fabric-user-id": userId,
			},
			body: JSON.stringify({
				organizationId: organizationId,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text().catch(() => "Unknown error");
		throw new Error(
			`Failed to create Fabric tool session: ${response.status} - ${error}`,
		);
	}

	const session = (await response.json()) as FabricToolSession;

	return session;
}

/**
 * List available tools from Fabric's tool router.
 *
 * @param sessionId - The session ID from getFabricToolSession
 * @param mcpUrl - The MCP URL from the session
 * @param mcpHeaders - The headers from the session
 * @returns List of available MCP tools
 */
async function listFabricTools(
	mcpUrl: string,
	mcpHeaders: Record<string, string>,
): Promise<unknown[]> {
	const response = await fetch(mcpUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...mcpHeaders,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "list-tools",
			method: "tools/list",
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to list tools: ${response.status}`);
	}

	const result = (await response.json()) as {
		result?: { tools?: unknown[] };
	};
	return result.result?.tools ?? [];
}

/**
 * Call a tool via Fabric's MCP endpoint.
 *
 * @param mcpUrl - The MCP URL from the session
 * @param mcpHeaders - The headers from the session
 * @param toolName - Name of the tool to call
 * @param args - Arguments for the tool
 * @returns Tool execution result
 */
async function callFabricTool(
	mcpUrl: string,
	mcpHeaders: Record<string, string>,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(mcpUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...mcpHeaders,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: `call-${toolName}-${Date.now()}`,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to call tool ${toolName}: ${response.status}`);
	}

	const result = (await response.json()) as {
		result?: unknown;
		error?: { message: string };
	};

	if (result.error) {
		throw new Error(`Tool error: ${result.error.message}`);
	}

	return result.result;
}

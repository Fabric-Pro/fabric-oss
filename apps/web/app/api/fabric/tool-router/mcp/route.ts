/**
 * Fabric Tool Router - MCP Endpoint
 *
 * Implements the Model Context Protocol (MCP) for Fabric.
 * This endpoint exposes all available integrations as MCP tools.
 *
 * For unconnected integrations, it returns "connect_[provider]" tools
 * that provide OAuth URLs when called.
 *
 * Supports:
 * - tools/list - List all available tools
 * - tools/call - Execute a tool
 */

import { fetchCredentialsByProvider } from "@repo/database";
import { NextResponse } from "next/server";
import { validateSession } from "../session/route";

export const runtime = "nodejs";

// OAuth providers and their configurations
const OAUTH_PROVIDERS = {
	GITHUB: {
		name: "GitHub",
		description:
			"Access GitHub repositories, issues, pull requests, and more",
		scopes: ["repo", "read:user"],
		capabilities: [
			"list_issues",
			"create_issue",
			"list_repos",
			"create_pr",
		],
	},
	SLACK: {
		name: "Slack",
		description:
			"Send messages, read channels, and interact with Slack workspaces",
		scopes: ["chat:write", "channels:read"],
		capabilities: ["send_message", "list_channels", "read_messages"],
	},
	GOOGLE_DRIVE: {
		name: "Google Drive",
		description: "Access files and folders in Google Drive",
		scopes: ["drive.readonly"],
		capabilities: [
			"list_files",
			"list_folders",
			"get_file",
			"search_files",
		],
	},
	MICROSOFT_GRAPH: {
		name: "Microsoft 365",
		description: "Access emails, calendar, files, and Teams",
		scopes: ["User.Read", "Files.Read.All"],
		capabilities: [
			"list_emails",
			"list_events",
			"list_files",
			"send_email",
		],
	},
	NOTION: {
		name: "Notion",
		description: "Access Notion pages, databases, and workspaces",
		scopes: [],
		capabilities: ["list_pages", "search", "get_page", "create_page"],
	},
} as const;

type OAuthProvider = keyof typeof OAUTH_PROVIDERS;

interface McpRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface McpTool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export async function POST(req: Request) {
	try {
		// Validate session
		const sessionId = req.headers.get("x-fabric-session");
		if (!sessionId) {
			return jsonRpcError(
				null,
				-32600,
				"Missing x-fabric-session header",
			);
		}

		const session = validateSession(sessionId);
		if (!session) {
			return jsonRpcError(null, -32600, "Invalid or expired session");
		}

		const { userId, organizationId } = session;

		// Parse JSON-RPC request
		const body: McpRequest = await req.json();

		if (body.jsonrpc !== "2.0") {
			return jsonRpcError(body.id, -32600, "Invalid JSON-RPC version");
		}

		// Handle MCP methods
		switch (body.method) {
			case "initialize":
				return jsonRpcSuccess(body.id, {
					protocolVersion: "2024-11-05",
					capabilities: {
						tools: { listChanged: true },
					},
					serverInfo: {
						name: "fabric-tool-router",
						version: "1.0.0",
					},
				});

			case "tools/list":
				return handleToolsList(body.id, userId, organizationId);

			case "tools/call":
				return handleToolsCall(
					body.id,
					body.params,
					userId,
					organizationId,
				);

			default:
				return jsonRpcError(
					body.id,
					-32601,
					`Method not found: ${body.method}`,
				);
		}
	} catch (error) {
		console.error("[ToolRouter/MCP] Error:", error);
		return jsonRpcError(null, -32603, "Internal error");
	}
}

async function handleToolsList(
	id: string | number,
	userId: string,
	organizationId: string | null,
): Promise<NextResponse> {
	const tools: McpTool[] = [];

	// Check which integrations are connected
	for (const [provider, config] of Object.entries(OAUTH_PROVIDERS)) {
		const isConnected = await checkIntegrationConnected(
			provider as OAuthProvider,
			userId,
			organizationId,
		);

		if (isConnected) {
			// Add actual integration tools
			for (const capability of config.capabilities) {
				tools.push({
					name: `${provider.toLowerCase()}_${capability}`,
					description: `${config.name}: ${capability.replace(/_/g, " ")}`,
					inputSchema: getToolSchema(
						provider as OAuthProvider,
						capability,
					),
				});
			}
		} else {
			// Add connect tool for unconnected integration
			tools.push({
				name: `connect_${provider.toLowerCase()}`,
				description: `Connect your ${config.name} account to enable: ${config.capabilities.join(", ")}`,
				inputSchema: {
					type: "object",
					properties: {},
					required: [],
				},
			});
		}
	}

	return jsonRpcSuccess(id, { tools });
}

async function handleToolsCall(
	id: string | number,
	params: Record<string, unknown> | undefined,
	userId: string,
	organizationId: string | null,
): Promise<NextResponse> {
	const toolName = params?.name as string;
	const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

	if (!toolName) {
		return jsonRpcError(id, -32602, "Missing tool name");
	}

	// Handle connect tools
	if (toolName.startsWith("connect_")) {
		const provider = toolName
			.replace("connect_", "")
			.toUpperCase() as OAuthProvider;
		return handleConnectTool(id, provider, userId, organizationId);
	}

	// Handle actual integration tools
	const [providerLower, ...capabilityParts] = toolName.split("_");
	const provider = providerLower.toUpperCase() as OAuthProvider;
	const capability = capabilityParts.join("_");

	// Check if connected
	const isConnected = await checkIntegrationConnected(
		provider,
		userId,
		organizationId,
	);
	if (!isConnected) {
		return jsonRpcSuccess(id, {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "not_connected",
						message: `${OAUTH_PROVIDERS[provider]?.name || provider} is not connected. Please connect it first.`,
						action: "connect",
						connectTool: `connect_${provider.toLowerCase()}`,
					}),
				},
			],
			isError: true,
		});
	}

	// Execute the tool
	try {
		const result = await executeIntegrationTool(
			provider,
			capability,
			toolArgs,
			userId,
			organizationId,
		);
		return jsonRpcSuccess(id, {
			content: [
				{
					type: "text",
					text: JSON.stringify(result),
				},
			],
		});
	} catch (error) {
		return jsonRpcSuccess(id, {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "execution_failed",
						message:
							error instanceof Error
								? error.message
								: "Tool execution failed",
					}),
				},
			],
			isError: true,
		});
	}
}

async function handleConnectTool(
	id: string | number,
	provider: OAuthProvider,
	userId: string,
	organizationId: string | null,
): Promise<NextResponse> {
	const config = OAUTH_PROVIDERS[provider];
	if (!config) {
		return jsonRpcError(id, -32602, `Unknown provider: ${provider}`);
	}

	// Generate OAuth URL
	const baseUrl =
		process.env.NEXT_PUBLIC_SITE_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		"http://localhost:3001";
	const redirectUri = `${baseUrl}/api/integrations/${provider.toLowerCase()}/oauth/callback`;

	// Create state with user context
	const state = Buffer.from(
		JSON.stringify({
			userId,
			organizationId,
			provider: provider.toLowerCase(),
			returnUrl: `${baseUrl}/app/settings/integrations`,
			timestamp: Date.now(),
		}),
	).toString("base64url");

	// Build OAuth URL based on provider
	let authUrl: string;

	switch (provider) {
		case "GITHUB": {
			const githubClientId = process.env.FABRIC_GITHUB_CLIENT_ID;
			if (!githubClientId) {
				return jsonRpcSuccess(id, {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "not_configured",
								message:
									"GitHub OAuth is not configured on this server. Please contact your administrator.",
							}),
						},
					],
					isError: true,
				});
			}
			authUrl = `https://github.com/login/oauth/authorize?client_id=${githubClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(config.scopes.join(" "))}&state=${state}`;
			break;
		}

		case "GOOGLE_DRIVE": {
			const googleClientId = process.env.GOOGLE_CLIENT_ID;
			if (!googleClientId) {
				return jsonRpcSuccess(id, {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "not_configured",
								message:
									"Google OAuth is not configured on this server. Please contact your administrator.",
							}),
						},
					],
					isError: true,
				});
			}
			authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(config.scopes.join(" "))}&state=${state}&response_type=code&access_type=offline&prompt=consent`;
			break;
		}

		case "SLACK": {
			const slackClientId = process.env.SLACK_CLIENT_ID;
			if (!slackClientId) {
				return jsonRpcSuccess(id, {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "not_configured",
								message:
									"Slack OAuth is not configured on this server. Please contact your administrator.",
							}),
						},
					],
					isError: true,
				});
			}
			authUrl = `https://slack.com/oauth/v2/authorize?client_id=${slackClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(config.scopes.join(","))}&state=${state}`;
			break;
		}

		case "MICROSOFT_GRAPH": {
			const msClientId = process.env.MICROSOFT_GRAPH_CLIENT_ID;
			if (!msClientId) {
				return jsonRpcSuccess(id, {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "not_configured",
								message:
									"Microsoft OAuth is not configured on this server. Please contact your administrator.",
							}),
						},
					],
					isError: true,
				});
			}
			authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${msClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(`${config.scopes.join(" ")} offline_access`)}&state=${state}&response_type=code&response_mode=query`;
			break;
		}

		case "NOTION": {
			const notionClientId = process.env.NOTION_CLIENT_ID;
			if (!notionClientId) {
				return jsonRpcSuccess(id, {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "not_configured",
								message:
									"Notion OAuth is not configured on this server. Please contact your administrator.",
							}),
						},
					],
					isError: true,
				});
			}
			authUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${notionClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code&owner=user`;
			break;
		}

		default:
			return jsonRpcError(
				id,
				-32602,
				`OAuth not implemented for: ${provider}`,
			);
	}

	return jsonRpcSuccess(id, {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					action: "oauth_required",
					provider: config.name,
					message: `Please connect your ${config.name} account to continue.`,
					authUrl,
					instructions:
						"Open the URL above in a browser to authenticate.",
				}),
			},
		],
	});
}

async function checkIntegrationConnected(
	provider: OAuthProvider,
	userId: string,
	organizationId: string | null,
): Promise<boolean> {
	const credentials = await fetchCredentialsByProvider(
		provider,
		userId,
		organizationId ?? undefined,
	);
	return credentials !== null && Object.keys(credentials).length > 0;
}

async function executeIntegrationTool(
	provider: OAuthProvider,
	capability: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId: string | null,
): Promise<unknown> {
	const credentials = await fetchCredentialsByProvider(
		provider,
		userId,
		organizationId ?? undefined,
	);

	if (!credentials) {
		throw new Error(`${provider} not connected`);
	}

	// Execute based on provider and capability
	switch (provider) {
		case "GITHUB":
			return executeGitHubTool(capability, args, credentials);
		case "GOOGLE_DRIVE":
			return executeGoogleDriveTool(capability, args, credentials);
		case "SLACK":
			return executeSlackTool(capability, args, credentials);
		// Add more providers as needed
		default:
			throw new Error(`Tool execution not implemented for ${provider}`);
	}
}

async function executeGitHubTool(
	capability: string,
	args: Record<string, unknown>,
	credentials: Record<string, string>,
): Promise<unknown> {
	const token = credentials.GITHUB_TOKEN;
	if (!token) {
		throw new Error("GitHub token not found");
	}

	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "Fabric-Tool-Router",
	};

	switch (capability) {
		case "list_issues": {
			const owner = args.owner as string;
			const repo = args.repo as string;

			// If no owner/repo, list user's issues across all repos
			const url =
				owner && repo
					? `https://api.github.com/repos/${owner}/${repo}/issues`
					: "https://api.github.com/user/issues?filter=all&state=open";

			const response = await fetch(url, { headers });
			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status}`);
			}
			return response.json();
		}

		case "list_repos": {
			const response = await fetch(
				"https://api.github.com/user/repos?per_page=100",
				{ headers },
			);
			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status}`);
			}
			return response.json();
		}

		default:
			throw new Error(`GitHub capability not implemented: ${capability}`);
	}
}

async function executeGoogleDriveTool(
	capability: string,
	args: Record<string, unknown>,
	credentials: Record<string, string>,
): Promise<unknown> {
	const token = credentials.GOOGLE_DRIVE_TOKEN;
	if (!token) {
		throw new Error("Google Drive token not found");
	}

	const headers = {
		Authorization: `Bearer ${token}`,
	};

	switch (capability) {
		case "list_folders": {
			const response = await fetch(
				"https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'&fields=files(id,name,createdTime,modifiedTime)",
				{ headers },
			);
			if (!response.ok) {
				throw new Error(`Google Drive API error: ${response.status}`);
			}
			return response.json();
		}

		case "list_files": {
			const folderId = args.folderId as string | undefined;
			const query = folderId ? `'${folderId}' in parents` : "";
			const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,createdTime,modifiedTime)`;

			const response = await fetch(url, { headers });
			if (!response.ok) {
				throw new Error(`Google Drive API error: ${response.status}`);
			}
			return response.json();
		}

		default:
			throw new Error(
				`Google Drive capability not implemented: ${capability}`,
			);
	}
}

async function executeSlackTool(
	capability: string,
	args: Record<string, unknown>,
	credentials: Record<string, string>,
): Promise<unknown> {
	const token = credentials.SLACK_TOKEN;
	if (!token) {
		throw new Error("Slack token not found");
	}

	switch (capability) {
		case "send_message": {
			const channel = args.channel as string;
			const text = args.text as string;

			if (!channel || !text) {
				throw new Error("channel and text are required");
			}

			const response = await fetch(
				"https://slack.com/api/chat.postMessage",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ channel, text }),
				},
			);

			return response.json();
		}

		case "list_channels": {
			const response = await fetch(
				"https://slack.com/api/conversations.list",
				{
					headers: { Authorization: `Bearer ${token}` },
				},
			);
			return response.json();
		}

		default:
			throw new Error(`Slack capability not implemented: ${capability}`);
	}
}

function getToolSchema(
	provider: OAuthProvider,
	capability: string,
): McpTool["inputSchema"] {
	// Return appropriate schema based on tool
	const schemas: Record<string, McpTool["inputSchema"]> = {
		// GitHub
		GITHUB_list_issues: {
			type: "object",
			properties: {
				owner: {
					type: "string",
					description:
						"Repository owner (optional - if omitted, lists your issues across all repos)",
				},
				repo: {
					type: "string",
					description: "Repository name (optional)",
				},
				state: {
					type: "string",
					enum: ["open", "closed", "all"],
					description: "Issue state filter",
				},
			},
		},
		GITHUB_list_repos: {
			type: "object",
			properties: {},
		},
		// Google Drive
		GOOGLE_DRIVE_list_folders: {
			type: "object",
			properties: {},
		},
		GOOGLE_DRIVE_list_files: {
			type: "object",
			properties: {
				folderId: {
					type: "string",
					description: "Folder ID to list files from (optional)",
				},
			},
		},
		// Slack
		SLACK_send_message: {
			type: "object",
			properties: {
				channel: { type: "string", description: "Channel ID or name" },
				text: { type: "string", description: "Message text" },
			},
			required: ["channel", "text"],
		},
		SLACK_list_channels: {
			type: "object",
			properties: {},
		},
	};

	return (
		schemas[`${provider}_${capability}`] || {
			type: "object",
			properties: {},
		}
	);
}

// JSON-RPC helpers
function jsonRpcSuccess(
	id: string | number | null,
	result: unknown,
): NextResponse {
	return NextResponse.json({
		jsonrpc: "2.0",
		id,
		result,
	});
}

function jsonRpcError(
	id: string | number | null,
	code: number,
	message: string,
): NextResponse {
	return NextResponse.json({
		jsonrpc: "2.0",
		id,
		error: { code, message },
	});
}

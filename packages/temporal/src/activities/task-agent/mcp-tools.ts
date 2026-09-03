/**
 * MCP Tool Execution
 *
 * Handles execution of MCP tools including:
 * - User-configured MCP servers
 * - Always-enabled tools (Sandbox)
 * - Conditionally-enabled tools (GitHub with OAuth)
 */

import { db, getAiProviderApiKeyByProvider } from "@repo/database";
import { executeGitHubTool } from "@repo/integrations/github";
import {
	getCachedMcpClientForConfig,
	type McpClientType,
	OAuthAuthorizationRequiredError,
} from "@repo/mcp";
import { getAlwaysEnabledMcps } from "@repo/mcp-registry";
import { decryptApiKey, getBaseUrl } from "@repo/utils";
import { executeMicrosoftTeamsTool } from "../shared/oauth-tool-executors";
import { guardToolWriteForReadOnly } from "../shared/read-only-gate";
import type {
	ExecuteMcpToolInput,
	LoadMcpConfigurationInput,
	MCPConfiguration,
} from "./types";

/**
 * Execute an MCP tool for task agent workflows
 * Handles both user-configured MCPs and always-enabled MCPs (Sandbox, GitHub)
 * Named uniquely to avoid conflict with orchestrator's executeMcpTool
 */
export async function executeTaskAgentTool(
	input: ExecuteMcpToolInput,
): Promise<unknown> {
	const { toolName, args, userId, organizationId, mcpConfig, projectId } =
		input;

	// Find the tool in config
	const mcpTool = mcpConfig.tools.find((t) => t.name === toolName);
	if (!mcpTool) {
		throw new Error(`Unknown tool: ${toolName}`);
	}

	// Check if this is an always-enabled tool (Sandbox)
	if (mcpTool.configId.startsWith("always-enabled:")) {
		// Sandbox tools operate on the agent's own VM (writeFile/exec/commit
		// are sandbox-internal, not writes to a connected source), so the
		// blanket gate below does not apply — except `push`, which writes to
		// the connected repository and is gated inside executeSandboxTool
		// (product decision 2026-07-23: code repos ARE in read-only scope).
		return executeAlwaysEnabledTool({
			toolName,
			args,
			userId,
			organizationId,
			configId: mcpTool.configId,
			projectId,
		});
	}

	// Everything past this point dispatches to an EXTERNAL source (GitHub,
	// Microsoft Teams, user-configured MCP servers) — Read-only mode gate.
	// This path previously had no gate at all (post-ship review
	// finding): the agent turn's own tools are gated inside executeAgentTurn,
	// but this workflow-driven tool loop is a separate dispatch.
	const readOnlyBlock = await guardToolWriteForReadOnly(projectId, toolName);
	if (readOnlyBlock) {
		return readOnlyBlock;
	}

	// Check if this is a GitHub tool (conditionally enabled when user has connected GitHub)
	if (mcpTool.configId.startsWith("github-connected:")) {
		const methodName = toolName.split("__")[1] || toolName;
		return executeGitHubTool(methodName, args, userId, organizationId);
	}

	// Check if this is a Microsoft Teams tool (conditionally enabled when user has connected Microsoft Graph)
	if (mcpTool.configId.startsWith("microsoft-teams-connected:")) {
		const methodName = toolName.split("__")[1] || toolName;
		return executeMicrosoftTeamsTool(
			methodName,
			args,
			userId,
			organizationId,
		);
	}

	// Regular MCP tool - use cached client with OAuth support
	const baseUrl = getBaseUrl();
	const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

	let client: McpClientType;
	try {
		const result = await getCachedMcpClientForConfig({
			configId: mcpTool.configId,
			userId,
			organizationId,
			redirectUri, // Enable OAuth2 token refresh
		});
		client = result.client;
	} catch (error) {
		// Handle OAuth authorization required errors
		if (error instanceof OAuthAuthorizationRequiredError) {
			throw new Error(
				`MCP server requires authentication. Please connect in Settings. (${error.message})`,
			);
		}
		throw error;
	}

	// Fetch the tool list from the client
	const tools = await client.tools();

	// Extract method name from tool name (format: ServerName__methodName)
	const methodName = toolName.split("__")[1] || toolName;

	// Find the tool definition
	const toolDef = tools[methodName];
	if (!toolDef) {
		throw new Error(
			`Tool "${methodName}" not found on server "${mcpTool.serverName}"`,
		);
	}

	// Execute the tool
	const executableTool = toolDef as unknown as {
		execute: (
			args: Record<string, unknown>,
			context: { toolCallId: string; messages: unknown[] },
		) => Promise<unknown>;
	};

	const result = await executableTool.execute(args, {
		toolCallId: `${toolName}-${Date.now()}`,
		messages: [],
	});

	return result;
}

/**
 * Execute an always-enabled tool (Sandbox)
 * These tools don't require MCP client connection - they use direct API calls
 * Note: GitHub is handled separately via `github-connected:*` configId since it requires OAuth
 */
async function executeAlwaysEnabledTool(input: {
	toolName: string;
	args: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	configId: string;
	projectId?: string;
}): Promise<unknown> {
	const { toolName, args, userId, organizationId, configId, projectId } =
		input;

	// Parse configId: "always-enabled:accountId:mcpId"
	const [, accountId] = configId.split(":");

	// Extract method name from tool name (format: ServerName__methodName)
	const methodName = toolName.split("__")[1] || toolName;

	switch (accountId) {
		case "sandbox":
			return executeSandboxTool(
				methodName,
				args,
				userId,
				organizationId,
				projectId,
			);

		default:
			throw new Error(`Unknown always-enabled account: ${accountId}`);
	}
}

/**
 * Whether a clone URL is genuinely GitHub's, and so may carry the
 * organization's stored GitHub token. `repoUrl` is an agent tool-call argument,
 * and the token is spliced into the URL before the clone, so a substring test
 * would hand it to `github.com.example-attacker.test`. Only `https:` matters:
 * the sandbox embeds the token solely into an https URL.
 *
 * Guards js/incomplete-url-substring-sanitization.
 */
function isGitHubCloneUrl(repoUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(repoUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	return host === "github.com" || host === "www.github.com";
}

/**
 * Execute a Sandbox tool using direct sandbox activities
 */
async function executeSandboxTool(
	methodName: string,
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<unknown> {
	// Import sandbox activities dynamically to avoid circular deps
	const sandbox = await import("../sandbox");

	const sessionId = args.sessionId as string | undefined;

	switch (methodName) {
		case "createSession": {
			// Auto-inject GitHub token if cloning a GitHub repo
			let githubToken = args.githubToken as string | undefined;
			const repoUrl = args.repoUrl as string | undefined;

			if (repoUrl && isGitHubCloneUrl(repoUrl) && !githubToken) {
				// Try to get GitHub token from user's integrations (XOR tenant isolation)
				const integration = organizationId
					? await db.workflowIntegration.findFirst({
							where: {
								organizationId,
								provider: "GITHUB",
								isActive: true,
							},
						})
					: await db.workflowIntegration.findFirst({
							where: {
								userId,
								organizationId: null,
								provider: "GITHUB",
								isActive: true,
							},
						});

				if (integration?.credentials) {
					const credentialsJson = decryptApiKey(
						integration.credentials,
					);
					try {
						const parsed = JSON.parse(credentialsJson);
						githubToken = parsed.access_token || credentialsJson;
					} catch {
						// Not JSON, use as-is (PAT format)
						githubToken = credentialsJson;
					}
				}
			}

			return sandbox.createSandboxSession({
				userId,
				organizationId,
				repoUrl,
				branch: args.branch as string | undefined,
				workDir: args.workDir as string | undefined,
				githubToken,
			});
		}

		case "runClaude": {
			if (!sessionId) {
				throw new Error("sessionId required for runClaude");
			}
			// Get Anthropic API key specifically - Claude Code requires Anthropic
			// Users must have ANTHROPIC_DIRECT configured in their AI provider settings
			const apiKeyConfig = await getAiProviderApiKeyByProvider({
				userId,
				organizationId,
				provider: "ANTHROPIC_DIRECT",
			});
			if (!apiKeyConfig.apiKey) {
				throw new Error(
					"Anthropic API key not configured. Claude Code in Sandbox requires an Anthropic API key. " +
						"Please configure ANTHROPIC_DIRECT provider in Settings > AI Providers.",
				);
			}
			const anthropicApiKey = decryptApiKey(apiKeyConfig.apiKey);
			return sandbox.runClaudeInSandbox({
				sessionId,
				userId,
				organizationId,
				task: args.task as string,
				context: args.context as string | undefined,
				systemPrompt: args.systemPrompt as string | undefined,
				timeout: args.timeout as number | undefined,
				anthropicApiKey,
			});
		}

		case "exec":
			if (!sessionId) {
				throw new Error("sessionId required for exec");
			}
			return sandbox.execInSandbox({
				sessionId,
				userId,
				organizationId,
				command: args.command as string,
				cwd: args.cwd as string | undefined,
				timeout: args.timeout as number | undefined,
			});

		case "getDiff": {
			if (!sessionId) {
				throw new Error("sessionId required for getDiff");
			}
			const diffResult = await sandbox.getSandboxDiff({
				sessionId,
				userId,
				organizationId,
				staged: args.staged as boolean | undefined,
			});
			// Return the diff - it will be cached by the workflow and auto-injected into PR approvals
			return {
				message: `${diffResult.stats.files} files changed, +${diffResult.stats.additions}/-${diffResult.stats.deletions}. The diff is cached and will be automatically injected into your PR approval request.`,
				diff: diffResult.diff,
				stats: diffResult.stats,
			};
		}

		case "commit":
			if (!sessionId) {
				throw new Error("sessionId required for commit");
			}
			return sandbox.commitInSandbox({
				sessionId,
				userId,
				organizationId,
				message: args.message as string,
			});

		case "push": {
			if (!sessionId) {
				throw new Error("sessionId required for push");
			}
			// Unlike the other sandbox tools (VM-internal), `push` writes to
			// the project's connected repository — Read-only mode blocks it
			// (product decision 2026-07-23: code repos ARE in scope).
			const readOnlyBlock = await guardToolWriteForReadOnly(
				projectId,
				"push",
			);
			if (readOnlyBlock) {
				return readOnlyBlock;
			}
			return sandbox.pushFromSandbox({
				sessionId,
				userId,
				organizationId,
				remote: args.remote as string | undefined,
				branch: args.branch as string | undefined,
				force: args.force as boolean | undefined,
			});
		}

		case "readFile":
			if (!sessionId) {
				throw new Error("sessionId required for readFile");
			}
			return sandbox.readSandboxFile({
				sessionId,
				userId,
				organizationId,
				path: args.path as string,
			});

		case "writeFile":
			if (!sessionId) {
				throw new Error("sessionId required for writeFile");
			}
			return sandbox.writeSandboxFile({
				sessionId,
				userId,
				organizationId,
				path: args.path as string,
				content: args.content as string,
			});

		case "destroySession":
			if (!sessionId) {
				throw new Error("sessionId required for destroySession");
			}
			return sandbox.destroySandboxSession({
				sessionId,
				userId,
				organizationId,
			});

		case "getSession":
			if (!sessionId) {
				throw new Error("sessionId required for getSession");
			}
			return sandbox.getSandboxSession({
				sessionId,
				userId,
				organizationId,
			});

		case "listFiles": {
			// listFiles is implemented via exec with ls command
			if (!sessionId) {
				throw new Error("sessionId required for listFiles");
			}
			const path = (args.path as string) || ".";
			const result = await sandbox.execInSandbox({
				sessionId,
				userId,
				organizationId,
				command: `ls -la "${path}"`,
			});
			// Parse ls output into structured format
			const lines =
				result.stdout?.split("\n").filter((l: string) => l.trim()) ||
				[];
			const files = lines
				.slice(1)
				.map((line: string) => {
					const parts = line.split(/\s+/);
					return {
						permissions: parts[0],
						type: parts[0]?.startsWith("d") ? "directory" : "file",
						size: parts[4],
						modified: `${parts[5]} ${parts[6]} ${parts[7]}`,
						name: parts.slice(8).join(" "),
					};
				})
				.filter(
					(f: { name?: string }) =>
						f.name && f.name !== "." && f.name !== "..",
				);
			return { path, files };
		}

		default:
			throw new Error(`Unknown Sandbox method: ${methodName}`);
	}
}

// GitHub tool execution is now handled by @repo/integrations/github (executeGitHubTool)

/**
 * Load MCP configuration for the user
 * Includes user-configured MCPs AND always-enabled MCPs (like Sandbox)
 */
export async function loadMcpConfiguration(
	input: LoadMcpConfigurationInput,
): Promise<MCPConfiguration> {
	const { userId, organizationId } = input;

	// Get enabled MCP configs for the user/org
	// Per-user-within-org pattern: configs have both userId AND organizationId set
	// SECURITY: Always filter by userId to prevent credential leakage between org members
	const mcpConfigs = await db.mCPConfig.findMany({
		where: {
			enabled: true,
			userId, // Always filter by current user (credentials are per-user)
			...(organizationId ? { organizationId } : { organizationId: null }),
		},
		include: {
			mcpServer: true,
		},
	});

	// Build tools list by fetching from MCP clients
	const tools: MCPConfiguration["tools"] = [];

	// Build redirect URI for OAuth2 support
	const baseUrl = getBaseUrl();
	const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

	for (const config of mcpConfigs) {
		try {
			// Get cached MCP client to fetch tools (with OAuth support)
			const { client } = await getCachedMcpClientForConfig({
				configId: config.id,
				userId,
				organizationId,
				redirectUri, // Enable OAuth2 token refresh
			});

			const serverTools = await client.tools();

			for (const [toolName, toolDef] of Object.entries(serverTools)) {
				const typedTool = toolDef as { description?: string };
				tools.push({
					name: `${config.mcpServer.name.replace(/\s+/g, "_")}__${toolName}`,
					description: typedTool.description || "",
					inputSchema: { type: "object" }, // MCP tools accept any object
					configId: config.id,
					serverName: config.mcpServer.name,
				});
			}
		} catch (error) {
			console.warn(
				`Failed to load tools from ${config.mcpServer.name}:`,
				error,
			);
			// Continue with other configs
		}
	}

	// Load always-enabled MCPs (like Sandbox) from registry
	// These are available to all users without configuration
	const alwaysEnabledMcps = getAlwaysEnabledMcps();
	for (const { account, mcp } of alwaysEnabledMcps) {
		const serverName = mcp.serverName || mcp.name;

		// Add tools from the MCP definition
		if (mcp.tools) {
			for (const tool of mcp.tools) {
				const schema = tool.inputSchema || { type: "object" };
				// DEBUG: Log schema being loaded for Sandbox tools
				if (tool.name === "createSession") {
					console.log(
						"[DEBUG loadMcpConfiguration] Sandbox createSession inputSchema from registry:",
						JSON.stringify(schema),
					);
				}
				tools.push({
					name: `${serverName}__${tool.name}`,
					description: tool.description || "",
					inputSchema: schema,
					configId: `always-enabled:${account.id}:${mcp.id}`,
					serverName,
					approvalRequiredFields: tool.approvalRequiredFields,
				});
			}
		}
	}

	// Conditionally include GitHub tools if user has connected GitHub
	// Uses XOR pattern: org context requires both userId AND organizationId for per-user isolation
	const githubIntegration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "GITHUB",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "GITHUB",
					isActive: true,
				},
			});

	if (githubIntegration) {
		// Import GitHub tools from mcp-registry (single source of truth)
		const { GITHUB_ACCOUNT } = await import("@repo/mcp-registry");

		for (const mcp of GITHUB_ACCOUNT.mcps) {
			if (mcp.available === false) {
				continue;
			}

			const serverName = mcp.serverName || mcp.name;
			if (mcp.tools) {
				for (const tool of mcp.tools) {
					tools.push({
						name: `${serverName}__${tool.name}`,
						description: tool.description || "",
						inputSchema: tool.inputSchema || { type: "object" },
						configId: `github-connected:${GITHUB_ACCOUNT.id}:${mcp.id}`,
						serverName,
						approvalRequiredFields: tool.approvalRequiredFields,
					});
				}
			}
		}
	}

	// Conditionally include Microsoft Teams tools if user has connected Microsoft Graph
	// Uses XOR pattern with per-user isolation: org context requires both userId AND organizationId
	const microsoftIntegration = organizationId
		? await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
			})
		: await db.workflowIntegration.findFirst({
				where: {
					userId,
					organizationId: null,
					provider: "MICROSOFT_GRAPH",
					isActive: true,
				},
			});

	if (microsoftIntegration) {
		// Import Microsoft Teams tools from mcp-registry (single source of truth)
		const { MICROSOFT_TEAMS_ACCOUNT } = await import("@repo/mcp-registry");

		for (const mcp of MICROSOFT_TEAMS_ACCOUNT.mcps) {
			if (mcp.available === false) {
				continue;
			}

			const serverName = mcp.serverName || mcp.name;
			if (mcp.tools) {
				for (const tool of mcp.tools) {
					tools.push({
						name: `${serverName}__${tool.name}`,
						description: tool.description || "",
						inputSchema: tool.inputSchema || { type: "object" },
						configId: `microsoft-teams-connected:${MICROSOFT_TEAMS_ACCOUNT.id}:${mcp.id}`,
						serverName,
						approvalRequiredFields: tool.approvalRequiredFields,
					});
				}
			}
		}
	}

	return { tools };
}

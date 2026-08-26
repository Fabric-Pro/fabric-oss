/**
 * Fetch Resources from MCP Servers
 *
 * Connects to MCP server using MCP Client (Vercel AI SDK) and fetches
 * available resources (boards, channels, repos, etc.) by calling MCP tools.
 *
 * Simple approach:
 * 1. Connect to MCP server with auth credentials
 * 2. Call identity tool to get account/workspace info
 * 3. Call list tool (e.g., get_boards) with account slug
 * 4. Return resources for UI dropdown selection
 */

import { getMcpConfigById } from "@repo/database";
import {
	callMcpTool,
	closeMcpClient,
	createMcpClientForConfig,
	type McpClientType,
} from "@repo/mcp";
import { isReadOnlyBlockedOutput } from "@repo/utils";
// Note: getMcpConfigById is used with tenant context in this file
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Parse MCP tool response - MCP returns { content: [...], isError: false }
 * The content array contains objects like { type: "text", text: "..." }
 */
function parseMcpResponse<T>(result: unknown): T | null {
	if (result === null || result === undefined) {
		return null;
	}

	// MCP responses come as { content: [...], isError: boolean }
	const mcpResult = result as { content?: unknown[]; isError?: boolean };

	if (mcpResult.content && Array.isArray(mcpResult.content)) {
		const textContent = mcpResult.content.find(
			(c): c is { type: string; text: string } =>
				c !== null &&
				typeof c === "object" &&
				"type" in c &&
				(c as { type?: string }).type === "text",
		);

		if (textContent && typeof textContent.text === "string") {
			try {
				return JSON.parse(textContent.text) as T;
			} catch {
				return textContent.text as T;
			}
		}
	}

	// Legacy array format
	if (Array.isArray(result)) {
		const textContent = result.find(
			(c): c is { type: string; text: string } =>
				c !== null &&
				typeof c === "object" &&
				"type" in c &&
				(c as { type?: string }).type === "text",
		);

		if (textContent && typeof textContent.text === "string") {
			try {
				return JSON.parse(textContent.text) as T;
			} catch {
				return textContent.text as T;
			}
		}
	}

	return result as T;
}

/**
 * Execute an MCP tool and parse the response
 */
async function executeMcpTool<T>(
	tools: Record<string, unknown>,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<T | null> {
	const toolDef = tools[toolName];
	if (!toolDef) {
		return null;
	}

	const tool = toolDef as unknown as {
		execute: (
			args: Record<string, unknown>,
			context: { toolCallId: string; messages: unknown[] },
		) => Promise<unknown>;
	};

	if (typeof tool.execute !== "function") {
		return null;
	}

	// Route through the shared funnel so the Read-only gate is consistently
	// applied. This procedure calls list/get READ tools, which
	// the gate passes through untouched; the funnel future-proofs the helper if
	// a write tool name is ever passed in.
	const result = await callMcpTool({
		toolName,
		execute: () =>
			tool.execute(args, {
				toolCallId: `${toolName}-${Date.now()}`,
				messages: [],
			}),
	});

	if (isReadOnlyBlockedOutput(result)) {
		return null;
	}

	return parseMcpResponse<T>(result);
}

// Resource item type
type ResourceItem = {
	id: string;
	name: string;
	description?: string;
	metadata?: Record<string, unknown>;
};

/**
 * Fetch resources from MCP server
 *
 * Strategy:
 * 1. Find identity tool (ends with _get_identity, _whoami, etc.)
 * 2. Call it to get accounts/workspaces with their slugs
 * 3. Find list tools (ends with _get_boards, _get_channels, etc.)
 * 4. Call them with account_slug from identity
 * 5. Return resources
 */
async function fetchMcpResources(
	tools: Record<string, unknown>,
): Promise<Array<{ resourceType: string; items: ResourceItem[] }>> {
	const resources: Array<{ resourceType: string; items: ResourceItem[] }> =
		[];
	const toolNames = Object.keys(tools);

	console.log("[MCP Resources] Fetching resources from MCP server...");

	// Step 1: Find and call identity tool to get account slugs
	const identityTool = toolNames.find((name) => {
		const lower = name.toLowerCase();
		return lower.endsWith("_get_identity") || lower.endsWith("_whoami");
	});

	type AccountInfo = {
		id?: string;
		slug?: string;
		name?: string;
		[key: string]: unknown;
	};
	let accounts: AccountInfo[] = [];

	if (identityTool) {
		console.log(`[MCP Resources] Calling identity tool: ${identityTool}`);
		try {
			const identity = await executeMcpTool<{ accounts?: AccountInfo[] }>(
				tools,
				identityTool,
				{},
			);

			if (identity?.accounts && Array.isArray(identity.accounts)) {
				accounts = identity.accounts;
				console.log(
					`[MCP Resources] Found ${accounts.length} account(s):`,
					accounts.map((a) => a.slug || a.name || a.id).join(", "),
				);
			}
		} catch (error) {
			console.log(
				"[MCP Resources] Identity call failed:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	// Step 2: Find list tools for common resource types
	// These patterns cover various MCP servers: Fizzy, Slack, GitHub, Jira, Linear, Notion, etc.
	const resourcePatterns = [
		// Project management
		{
			pattern: /_get_boards$|_list_boards$/,
			type: "board",
			slugParam: "account_slug",
		},
		{
			pattern: /_get_projects$|_list_projects$/,
			type: "project",
			slugParam: "team_id",
		},
		{
			pattern: /_get_sprints$|_list_sprints$/,
			type: "sprint",
			slugParam: "project_id",
		},
		{
			pattern: /_get_issues$|_list_issues$/,
			type: "issue",
			slugParam: "project_id",
		},
		{
			pattern: /_get_epics$|_list_epics$/,
			type: "epic",
			slugParam: "project_id",
		},

		// Communication
		{
			pattern: /_get_channels$|_list_channels$/,
			type: "channel",
			slugParam: "workspace_id",
		},
		{
			pattern: /_get_conversations$|_list_conversations$/,
			type: "conversation",
			slugParam: null,
		},

		// Code repositories
		{
			pattern:
				/_get_repos$|_list_repos$|_get_repositories$|_list_repositories$/,
			type: "repository",
			slugParam: "org",
		},
		{
			pattern: /_get_branches$|_list_branches$/,
			type: "branch",
			slugParam: "repo",
		},
		{
			pattern: /_get_milestones$|_list_milestones$/,
			type: "milestone",
			slugParam: "repo",
		},

		// Organization & teams
		{ pattern: /_get_teams$|_list_teams$/, type: "team", slugParam: null },
		{
			pattern: /_get_workspaces$|_list_workspaces$/,
			type: "workspace",
			slugParam: null,
		},
		{
			pattern: /_get_organizations$|_list_organizations$/,
			type: "organization",
			slugParam: null,
		},

		// Knowledge & content
		{
			pattern: /_get_databases$|_list_databases$/,
			type: "database",
			slugParam: null,
		},
		{
			pattern: /_get_spaces$|_list_spaces$/,
			type: "space",
			slugParam: null,
		},
		{
			pattern: /_get_pages$|_list_pages$/,
			type: "page",
			slugParam: "database_id",
		},
		{
			pattern: /_get_folders$|_list_folders$/,
			type: "folder",
			slugParam: null,
		},
		{
			pattern: /_get_collections$|_list_collections$/,
			type: "collection",
			slugParam: null,
		},
		{
			pattern: /_get_documents$|_list_documents$/,
			type: "document",
			slugParam: null,
		},

		// CRM & sales
		{
			pattern: /_get_pipelines$|_list_pipelines$/,
			type: "pipeline",
			slugParam: null,
		},
		{
			pattern: /_get_deals$|_list_deals$/,
			type: "deal",
			slugParam: "pipeline_id",
		},
		{
			pattern: /_get_contacts$|_list_contacts$/,
			type: "contact",
			slugParam: null,
		},
		{
			pattern: /_get_accounts$|_list_accounts$/,
			type: "account",
			slugParam: null,
		},
	];

	for (const { pattern, type, slugParam } of resourcePatterns) {
		const listTool = toolNames.find((name) =>
			pattern.test(name.toLowerCase()),
		);

		if (!listTool) {
			continue;
		}

		console.log(`[MCP Resources] Found ${type} tool: ${listTool}`);

		try {
			if (accounts.length > 0 && slugParam) {
				// Call for each account
				const allItems: ResourceItem[] = [];

				for (const account of accounts) {
					const args: Record<string, unknown> = {};

					// Set the slug parameter based on what's available
					if (slugParam === "account_slug" && account.slug) {
						args.account_slug = account.slug;
					} else if (account.id) {
						args[slugParam] = account.id;
					} else if (account.slug) {
						args[slugParam] = account.slug;
					}

					console.log(
						`[MCP Resources] Calling ${listTool} with:`,
						JSON.stringify(args),
					);

					const result = await executeMcpTool<
						Array<Record<string, unknown>>
					>(tools, listTool, args);

					if (result && Array.isArray(result)) {
						const items = result.map((item, index) => ({
							id: String(item.id ?? item.key ?? index),
							name: String(
								item.name ?? item.title ?? `Item ${index + 1}`,
							),
							description:
								typeof item.description === "string"
									? item.description
									: undefined,
							metadata: {
								...item,
								_accountSlug: account.slug,
								_accountName: account.name,
							},
						}));
						allItems.push(...items);
					}
				}

				if (allItems.length > 0) {
					resources.push({ resourceType: type, items: allItems });
					console.log(
						`[MCP Resources] Found ${allItems.length} ${type}(s)`,
					);
				}
			} else {
				// No accounts needed or available - call directly
				console.log(
					`[MCP Resources] Calling ${listTool} (no account needed)`,
				);

				const result = await executeMcpTool<
					Array<Record<string, unknown>>
				>(tools, listTool, {});

				if (result && Array.isArray(result)) {
					const items = result.map((item, index) => ({
						id: String(item.id ?? item.key ?? index),
						name: String(
							item.name ?? item.title ?? `Item ${index + 1}`,
						),
						description:
							typeof item.description === "string"
								? item.description
								: undefined,
						metadata: item,
					}));

					if (items.length > 0) {
						resources.push({ resourceType: type, items });
						console.log(
							`[MCP Resources] Found ${items.length} ${type}(s)`,
						);
					}
				}
			}
		} catch (error) {
			console.log(
				`[MCP Resources] ${listTool} failed:`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	return resources;
}

export const fetchResourcesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.MCP_READ))
	.route({
		method: "POST",
		path: "/mcp/resources/fetch",
		tags: ["MCP"],
		summary: "Fetch available resources from an MCP server",
		description:
			"Connects to an MCP server using MCP Client and fetches available resources (boards, channels, repos, etc.) by executing MCP tools",
	})
	.input(
		z.object({
			configId: z.string().describe("MCP config ID"),
			resourceType: z
				.string()
				.optional()
				.describe("Optional filter for specific resource type"),
			// IMPORTANT: For proper tenant isolation, pass organizationId explicitly:
			// - Pass org ID string when in organization context
			// - Pass null explicitly when in personal context
			// - Only omit (undefined) to fall back to session context
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			serverName: z.string().nullable(),
			serverKey: z.string().nullable(),
			resources: z.array(
				z.object({
					resourceType: z.string(),
					items: z.array(
						z.object({
							id: z.string(),
							name: z.string(),
							description: z.string().optional().nullable(),
							metadata: z
								.record(z.string(), z.unknown())
								.optional()
								.nullable(),
						}),
					),
				}),
			),
			error: z.string().optional().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const { configId, resourceType } = input;

		let mcpClient: McpClientType | undefined;
		let serverName: string | null = null;
		let serverKey: string | null = null;

		try {
			// Use resolveOrganizationId for proper tenant isolation
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			const mcpConfig = await getMcpConfigById(configId, {
				userId,
				organizationId,
			});

			if (!mcpConfig) {
				return {
					success: false,
					serverName: null,
					serverKey: null,
					resources: [],
					error: "MCP configuration not found",
				};
			}

			const mcpServer = mcpConfig.mcpServer as {
				key?: string;
				name?: string;
				defaultUrl?: string;
				transport?: string;
			} | null;

			serverName =
				mcpConfig.displayName || mcpServer?.name || "Unknown Server";
			serverKey = mcpServer?.key?.toLowerCase() || null;

			if (!mcpConfig.enabled) {
				return {
					success: false,
					serverName,
					serverKey,
					resources: [],
					error: "MCP server is disabled",
				};
			}

			// Determine transport
			const configTransport = mcpConfig.transport
				?.toString()
				.toUpperCase();
			const serverTransport = mcpServer?.transport?.toUpperCase();
			const transport = configTransport || serverTransport || "HTTP";

			console.log(
				`[MCP Resources] Connecting to ${serverName} (${transport})`,
			);

			// Create MCP client using createMcpClientForConfig which handles all transport types
			// including STDIO (via wrapper service), HTTP, and SSE
			try {
				const clientResult = await createMcpClientForConfig({
					configId,
					userId,
					organizationId,
				});
				mcpClient = clientResult.client;
			} catch (clientError) {
				console.error(
					`[MCP Resources] Failed to create client for ${serverName}:`,
					clientError,
				);
				return {
					success: false,
					serverName,
					serverKey,
					resources: [],
					error:
						clientError instanceof Error
							? clientError.message
							: "Failed to connect to MCP server",
				};
			}

			// Get available tools
			const availableTools = await mcpClient.tools();
			const toolNames = Object.keys(availableTools);
			console.log(
				`[MCP Resources] Available tools: ${toolNames.slice(0, 10).join(", ")}${toolNames.length > 10 ? "..." : ""}`,
			);

			// Fetch resources using MCP tools
			let resources = await fetchMcpResources(availableTools);

			// Filter by resource type if specified
			if (resourceType) {
				resources = resources.filter(
					(r) =>
						r.resourceType.toLowerCase() ===
						resourceType.toLowerCase(),
				);
			}

			console.log(
				`[MCP Resources] Found ${resources.reduce((acc, r) => acc + r.items.length, 0)} total resources`,
			);

			return {
				success: true,
				serverName,
				serverKey,
				resources,
				error: null,
			};
		} catch (err) {
			console.error("[MCP Resources] Error fetching resources:", err);

			let errorMessage = "Unknown error";
			if (err instanceof Error) {
				errorMessage = err.message;
			}

			return {
				success: false,
				serverName,
				serverKey,
				resources: [],
				error: errorMessage,
			};
		} finally {
			await closeMcpClient(mcpClient);
		}
	});

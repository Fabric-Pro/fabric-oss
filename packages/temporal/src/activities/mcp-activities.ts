/**
 * MCP Activities for Temporal Workflows
 *
 * Provides generic MCP client activities that work with any MCP server.
 * Uses the shared MCP client factory for consistent protocol handling.
 * Used for project management integrations (Fizzy, Linear, Jira, etc.)
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 */

import {
	getMcpConfigByIdInternal,
	getValidAccessToken,
	isProjectReadOnly,
	setMcpConfigHealth,
} from "@repo/database";
import { logger } from "@repo/logs";
import { closeMcpClient, createMcpClient, type McpClientType } from "@repo/mcp";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { getAmbientProjectId } from "@repo/utils/project-context";

/**
 * Health-check an MCP config using proper MCP protocol.
 * Instead of raw HTTP ping, we attempt to list tools which validates
 * the full MCP protocol stack including authentication.
 */
async function checkMcpServerHealth(configId: string): Promise<boolean> {
	let client: McpClientType | undefined;

	try {
		// Use internal version - health checks run system-wide without user context
		const config = await getMcpConfigByIdInternal(configId);
		if (!config) {
			return false;
		}

		const baseUrl =
			config.failoverUrl ||
			config.baseUrl ||
			config.mcpServer?.defaultUrl;
		if (!baseUrl) {
			return false;
		}

		// Get auth headers - use getValidAccessToken for OAuth2 to trigger refresh if expired
		const headers: Record<string, string> = {};
		if (config.authType === "OAUTH2" && config.userId) {
			// Use getValidAccessToken which handles token refresh automatically
			const token = await getValidAccessToken({
				configId,
				userId: config.userId,
				organizationId: config.organizationId,
			});
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}
		} else if (
			config.authType === "API_KEY" ||
			config.authType === "OAUTH2"
		) {
			// Fallback: decrypt directly (for configs without userId or API key auth)
			const { decryptApiKey } = await import("@repo/utils");
			if (config.encryptedAccessToken) {
				const token = decryptApiKey(config.encryptedAccessToken);
				headers.Authorization = `Bearer ${token}`;
			} else if (config.encryptedApiKey) {
				const apiKey = decryptApiKey(config.encryptedApiKey);
				headers.Authorization = `Bearer ${apiKey}`;
			}
		}

		// Determine transport from config
		const transport = (
			config.transport ||
			config.mcpServer?.transport ||
			"HTTP"
		)
			.toString()
			.toUpperCase();

		// Create MCP client using shared factory (uses official MCP SDK transports)
		client = await createMcpClient({
			serverUrl: baseUrl,
			transport,
			headers,
		});

		// Attempt to list tools - this validates the full MCP protocol
		const tools = await client.tools();
		return Object.keys(tools).length >= 0; // Success if we can list tools (even empty)
	} catch (error) {
		logger.warn("[MCP Health] Protocol check failed", { configId, error });
		return false;
	} finally {
		await closeMcpClient(client);
	}
}

/**
 * Health-check an MCP config and update status + failure counters.
 * Uses proper MCP protocol to validate connection instead of raw HTTP ping.
 *
 * Simple policy:
 * - success => HEALTHY, consecutiveFailures = 0
 * - failure => increment consecutiveFailures, DEGRADED for 1-2 failures, UNAVAILABLE for >=3
 */
export async function checkAndUpdateMcpHealth(configId: string) {
	// Use internal version - health checks run system-wide without user context
	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg) {
		return;
	}
	const baseUrl = cfg.failoverUrl || cfg.baseUrl || cfg.mcpServer?.defaultUrl;
	if (!baseUrl) {
		await setMcpConfigHealth({
			id: configId,
			status: "UNAVAILABLE",
			consecutiveFailures: (cfg.consecutiveFailures ?? 0) + 1,
		});
		return;
	}

	// Use MCP protocol check instead of raw HTTP ping
	const ok = await checkMcpServerHealth(configId);
	if (ok) {
		await setMcpConfigHealth({
			id: configId,
			status: "HEALTHY",
			consecutiveFailures: 0,
		});
		logger.info(`[MCP Health] ${configId} HEALTHY: ${baseUrl}`);
	} else {
		const failures = (cfg.consecutiveFailures ?? 0) + 1;
		const status = failures >= 3 ? "UNAVAILABLE" : "DEGRADED";
		await setMcpConfigHealth({
			id: configId,
			status,
			consecutiveFailures: failures,
		});
		logger.warn(
			`[MCP Health] ${configId} ${status}: ${baseUrl} (failures=${failures})`,
		);
	}
}

/**
 * Task item parsed from markdown
 */
interface ParsedTask {
	title: string;
	description?: string;
}

/**
 * Result of pushing tasks via MCP
 */
export interface McpPushTasksResult {
	success: boolean;
	itemsCreated: number;
	items: Array<{ id: string; title: string }>;
	errors: string[];
	serverName?: string;
}

/**
 * Create an MCP client using stored config
 * This resolves the config from database and creates a client with proper auth
 *
 * Uses the shared MCP client factory for proper protocol handling.
 * Supports both HTTP (Streamable HTTP) and SSE transports via official MCP SDK.
 *
 * @param configId - MCP config ID
 * @param userId - User ID for authorization (optional - if not provided, tries direct token access)
 */
async function createMcpClientFromConfigInternal(
	configId: string,
	userId?: string,
): Promise<{
	client: McpClientType;
	serverName: string;
	serverKey?: string;
}> {
	// Use internal version - authorization was already done at API layer before starting workflow
	const config = await getMcpConfigByIdInternal(configId);
	if (!config) {
		throw new Error(`MCP config ${configId} not found`);
	}

	// Get base URL from config or server defaults
	const baseUrl = config.baseUrl || config.mcpServer?.defaultUrl;
	if (!baseUrl) {
		throw new Error(
			`No base URL configured for MCP server ${config.mcpServer?.name || configId}`,
		);
	}

	// Build headers with authentication
	const headers: Record<string, string> = {};

	// Get valid access token (handles decryption, expiry, refresh)
	// Note: If userId is not provided, we can't verify authorization
	// In workflow context, authorization was already done at API layer
	if (userId) {
		const accessToken = await getValidAccessToken({
			configId,
			userId,
			organizationId: config.organizationId,
		});
		if (accessToken) {
			headers.Authorization = `Bearer ${accessToken}`;
		}
	} else if (config.userId) {
		// No userId param but config has a userId - use it for proper token refresh
		const accessToken = await getValidAccessToken({
			configId,
			userId: config.userId,
			organizationId: config.organizationId,
		});
		if (accessToken) {
			headers.Authorization = `Bearer ${accessToken}`;
		}
	} else {
		// For workflow activities without any user context, try to get token directly
		// This is safe because the workflow was already authorized at API layer
		const { decryptApiKey } = await import("@repo/utils");
		if (config.encryptedAccessToken) {
			const token = decryptApiKey(config.encryptedAccessToken);
			headers.Authorization = `Bearer ${token}`;
		} else if (config.encryptedApiKey) {
			const apiKey = decryptApiKey(config.encryptedApiKey);
			headers.Authorization = `Bearer ${apiKey}`;
		}
	}

	// Determine transport from config (supports both HTTP and SSE)
	const transport = (
		config.transport ||
		config.mcpServer?.transport ||
		"HTTP"
	)
		.toString()
		.toUpperCase();

	logger.info("[MCP Client] Creating client using shared factory", {
		configId,
		serverName: config.mcpServer?.name,
		baseUrl,
		transport,
		hasAuth: !!headers.Authorization,
	});

	// Use shared MCP client factory (uses official MCP SDK transports)
	const client = await createMcpClient({
		serverUrl: baseUrl,
		transport,
		headers,
	});

	return {
		client,
		serverName:
			config.mcpServer?.name || config.displayName || "MCP Server",
		serverKey: config.mcpServer?.key,
	};
}

/**
 * Metadata-only key list for logging. Returns the object's keys and never the
 * VALUES (which carry business content — card title/description/body). Also
 * never throws on a non-object, since a log line must not crash the operation.
 * SOC 2: keep logs metadata-only, mirroring the audit-log redactor.
 */
function keysOf(o: unknown): string[] {
	return o && typeof o === "object" ? Object.keys(o) : [];
}

/**
 * Execute an MCP tool with proper result parsing
 */
async function executeMcpToolInternal<T>(
	client: McpClientType,
	toolName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const tools = await client.tools();
	const tool = tools[toolName];

	if (!tool) {
		const availableTools = Object.keys(tools).join(", ");
		throw new Error(
			`Tool "${toolName}" not found. Available: ${availableTools}`,
		);
	}

	// Never log the arg VALUES — they carry business content (card
	// title/description/body). Keys only.
	logger.info("[MCP] Executing tool", { toolName, argKeys: keysOf(args) });

	const result = await tool.execute(args, {
		toolCallId: `${toolName}-${Date.now()}`,
		messages: [],
	});

	// Parse MCP SDK result format: { content: [{ type: "text", text: "..." }], isError: false }
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const obj = result as Record<string, unknown>;

		// Check for error
		if (obj.isError === true) {
			const errorContent = Array.isArray(obj.content)
				? (obj.content as Array<{ type: string; text?: string }>).find(
						(c) => c.type === "text",
					)
				: null;
			throw new Error(
				(errorContent?.text as string) || "MCP tool returned an error",
			);
		}

		// Parse content wrapper
		if (Array.isArray(obj.content)) {
			const textContent = (
				obj.content as Array<{ type: string; text?: string }>
			).find((c) => c.type === "text");
			if (textContent?.text) {
				try {
					return JSON.parse(textContent.text) as T;
				} catch {
					return textContent.text as T;
				}
			}
		}
	}

	// Handle array content directly
	if (Array.isArray(result)) {
		const textContent = (
			result as Array<{ type: string; text?: string }>
		).find((c) => c.type === "text");
		if (textContent?.text) {
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
 * Push tasks to any project management tool via MCP
 *
 * This is a generic activity that works with any PM MCP server.
 * Uses dynamic schema introspection to detect tool capabilities instead of
 * hardcoded provider-specific logic.
 *
 * @see packages/temporal/src/activities/pm-integration/tool-analyzer.ts
 */
export async function pushTasksViaMcp(params: {
	mcpConfigId: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	tasksMarkdown: string;
	/** Fabric project id — enables the Read-only mode write-gate. */
	projectId?: string;
}): Promise<McpPushTasksResult> {
	const { mcpConfigId, containerId, additionalContext, tasksMarkdown } =
		params;
	const items: Array<{ id: string; title: string }> = [];
	const errors: string[] = [];

	// Read-only mode: this activity only creates items in the PM tool, so a
	// read-only project skips the whole push before any external dispatch.
	// Ambient fallback covers a caller that omits the optional projectId (the
	// legacy fizzy branch leaked exactly that way — post-ship review finding).
	const readOnlyProjectId = params.projectId ?? getAmbientProjectId();
	if (readOnlyProjectId && (await isProjectReadOnly(readOnlyProjectId))) {
		logger.info("[MCP Push] Skipped — project is in Read-only mode", {
			projectId: readOnlyProjectId,
		});
		return {
			success: false,
			itemsCreated: 0,
			items: [],
			errors: [READ_ONLY_MODE_MESSAGE],
		};
	}

	let client: McpClientType | undefined;
	let serverName = "MCP Server";

	try {
		// Create MCP client from stored config using shared factory
		const clientInfo = await createMcpClientFromConfigInternal(mcpConfigId);
		client = clientInfo.client;
		serverName = clientInfo.serverName;

		logger.info("[MCP Push] Starting task push", {
			serverName,
			containerId,
			markdownLength: tasksMarkdown.length,
		});

		// Get available tools with their schemas
		const tools = await client.tools();
		const availableTools = Object.keys(tools);

		logger.info("[MCP Push] Available tools", { tools: availableTools });

		// Parse tasks from markdown
		const tasks = parseTasksFromMarkdown(tasksMarkdown);
		logger.info("[MCP Push] Parsed tasks", { count: tasks.length });

		if (tasks.length === 0) {
			return {
				success: true,
				itemsCreated: 0,
				items: [],
				errors: ["No tasks found in markdown"],
				serverName,
			};
		}

		// Dynamic capability detection using PM tool analyzer
		const pmAnalyzer = await import("./pm-integration/tool-analyzer");

		// Convert tools to the format expected by analyzer
		// Use inline type to avoid dynamic import type issues
		const toolDefinitions: Record<
			string,
			{
				name: string;
				description?: string;
				inputSchema?: {
					type?: string;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			}
		> = {};
		for (const [toolName, toolDef] of Object.entries(tools)) {
			const def = toolDef as {
				description?: string;
				inputSchema?: unknown;
			};
			toolDefinitions[toolName] = {
				name: toolName,
				description: def.description,
				inputSchema:
					def.inputSchema as (typeof toolDefinitions)[string]["inputSchema"],
			};
		}

		const capabilities = pmAnalyzer.analyzePMToolCapabilities(
			toolDefinitions,
			{ serverHint: serverName },
		);

		if (!capabilities.taskCreation) {
			throw new Error(
				`No task creation capability detected for ${serverName}. Available tools: ${availableTools.join(", ")}`,
			);
		}

		const { taskCreation, detectedType } = capabilities;
		const createToolName = taskCreation.toolName;

		logger.info("[MCP Push] Using create tool", {
			createToolName,
			detectedType,
			containerParam: taskCreation.containerParam,
			titleParam: taskCreation.titleParam,
		});

		// Create items for each task using dynamic args builder
		for (const task of tasks) {
			try {
				const args = pmAnalyzer.buildTaskCreationArgs(
					capabilities,
					{
						title: task.title.slice(0, 200),
						description: task.description?.slice(0, 10000),
					},
					containerId,
					additionalContext,
				);

				const result = await executeMcpToolInternal<{
					id: string;
					title?: string;
				}>(client, createToolName, args);

				items.push({
					id: result.id || `item-${items.length + 1}`,
					title: task.title,
				});

				// Small delay to avoid rate limiting
				await new Promise((resolve) => setTimeout(resolve, 100));
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				errors.push(`Failed to create "${task.title}": ${errorMsg}`);
				logger.error("[MCP Push] Failed to create item", {
					titleLength: task.title?.length ?? 0,
					error: errorMsg,
				});
			}
		}

		logger.info("[MCP Push] Completed", {
			itemsCreated: items.length,
			errors: errors.length,
		});

		return {
			success: errors.length === 0,
			itemsCreated: items.length,
			items,
			errors,
			serverName,
		};
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error("[MCP Push] Failed", { error: errorMsg });

		return {
			success: false,
			itemsCreated: items.length,
			items,
			errors: [errorMsg, ...errors],
			serverName,
		};
	} finally {
		// Use shared close helper for proper cleanup
		await closeMcpClient(client);
	}
}

/**
 * Result of extracting content via MCP
 */
export interface McpExtractContentResult {
	success: boolean;
	content: string;
	title?: string;
	url?: string;
	metadata: {
		serverName: string;
		serverKey?: string;
		toolName: string;
		extractedAt: string;
		contentLength: number;
	};
	error?: string;
}

/**
 * Extract content from external sources via MCP
 *
 * This activity fetches content from Notion pages, Confluence pages, Jira issues,
 * or any other source accessible via an MCP tool. Useful for:
 * - Extracting PRDs from Notion for the PRD-to-Tasks pipeline
 * - Pulling requirements from Confluence
 * - Getting issue details from Jira
 *
 * The content is normalized to markdown/text for LLM processing.
 */
export async function extractContentViaMcp(params: {
	mcpConfigId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	userId?: string;
}): Promise<McpExtractContentResult> {
	const { mcpConfigId, toolName, toolArgs, userId } = params;
	let client: McpClientType | undefined;

	try {
		// Create MCP client from stored config
		const clientInfo = await createMcpClientFromConfigInternal(
			mcpConfigId,
			userId,
		);
		client = clientInfo.client;
		const serverName = clientInfo.serverName;
		const serverKey = clientInfo.serverKey;

		logger.info("[MCP Extract] Starting content extraction", {
			serverName,
			serverKey,
			toolName,
			// Metadata only — arg keys, not values (locators/content).
			argKeys: keysOf(toolArgs),
		});

		// Execute the tool
		const result = await executeMcpToolInternal<unknown>(
			client,
			toolName,
			toolArgs,
		);

		// Parse the result based on the server type and tool
		const parsed = parseExtractedContent(result, serverKey, toolName);

		logger.info("[MCP Extract] Extraction complete", {
			serverName,
			toolName,
			contentLength: parsed.content.length,
			hasTitle: !!parsed.title,
		});

		return {
			success: true,
			content: parsed.content,
			title: parsed.title,
			url: parsed.url,
			metadata: {
				serverName,
				serverKey,
				toolName,
				extractedAt: new Date().toISOString(),
				contentLength: parsed.content.length,
			},
		};
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error("[MCP Extract] Extraction failed", {
			error: errorMsg,
			toolName,
			argKeys: keysOf(toolArgs),
		});

		return {
			success: false,
			content: "",
			metadata: {
				serverName: "Unknown",
				toolName,
				extractedAt: new Date().toISOString(),
				contentLength: 0,
			},
			error: errorMsg,
		};
	} finally {
		await closeMcpClient(client);
	}
}

/**
 * Parse extracted content from MCP tool result
 * Normalizes different source formats to consistent text/markdown
 */
function parseExtractedContent(
	result: unknown,
	serverKey?: string,
	toolName?: string,
): { content: string; title?: string; url?: string } {
	// Handle null/undefined
	if (result === null || result === undefined) {
		return { content: "" };
	}

	// Handle string directly
	if (typeof result === "string") {
		return { content: result };
	}

	// Handle object results
	if (typeof result === "object" && !Array.isArray(result)) {
		const obj = result as Record<string, unknown>;

		// Notion-specific parsing
		if (serverKey?.includes("notion") || toolName?.includes("notion")) {
			return parseNotionContent(obj);
		}

		// Confluence-specific parsing
		if (
			serverKey?.includes("atlassian") ||
			serverKey?.includes("confluence") ||
			toolName?.includes("confluence")
		) {
			return parseConfluenceContent(obj);
		}

		// Jira-specific parsing
		if (toolName?.includes("jira")) {
			return parseJiraContent(obj);
		}

		// Linear-specific parsing
		if (serverKey?.includes("linear") || toolName?.includes("linear")) {
			return parseLinearContent(obj);
		}

		// Generic parsing - try common field names
		return parseGenericContent(obj);
	}

	// Handle arrays (list of blocks, etc.)
	if (Array.isArray(result)) {
		const contents = result.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			if (typeof item === "object" && item !== null) {
				const parsed = parseExtractedContent(item, serverKey, toolName);
				return parsed.content;
			}
			return String(item);
		});
		return { content: contents.join("\n\n") };
	}

	// Fallback: stringify
	return { content: JSON.stringify(result, null, 2) };
}

/**
 * Parse Notion page content
 */
function parseNotionContent(obj: Record<string, unknown>): {
	content: string;
	title?: string;
	url?: string;
} {
	let content = "";
	let title: string | undefined;
	let url: string | undefined;

	// Extract title from properties or title field
	if (obj.properties && typeof obj.properties === "object") {
		const props = obj.properties as Record<string, unknown>;
		// Try common title property names
		for (const key of ["title", "Name", "name", "Title"]) {
			if (props[key]) {
				const titleProp = props[key] as Record<string, unknown>;
				if (titleProp.title && Array.isArray(titleProp.title)) {
					title = (titleProp.title as Array<{ plain_text?: string }>)
						.map((t) => t.plain_text || "")
						.join("");
				}
			}
		}
	}

	// Extract URL
	if (typeof obj.url === "string") {
		url = obj.url;
	}

	// Extract content from blocks or content field
	if (obj.content && typeof obj.content === "string") {
		content = obj.content;
	} else if (obj.markdown && typeof obj.markdown === "string") {
		content = obj.markdown;
	} else if (obj.blocks && Array.isArray(obj.blocks)) {
		content = parseNotionBlocks(
			obj.blocks as Array<Record<string, unknown>>,
		);
	} else if (obj.results && Array.isArray(obj.results)) {
		content = parseNotionBlocks(
			obj.results as Array<Record<string, unknown>>,
		);
	}

	// If we have a title but no content, include title in content
	if (title && !content) {
		content = `# ${title}\n\n(Content could not be extracted)`;
	} else if (title && content) {
		content = `# ${title}\n\n${content}`;
	}

	return { content, title, url };
}

/**
 * Parse Notion blocks to markdown
 */
function parseNotionBlocks(blocks: Array<Record<string, unknown>>): string {
	const parts: string[] = [];

	for (const block of blocks) {
		const blockType = block.type as string;

		// Get the content object for this block type
		const blockContent = block[blockType] as
			| Record<string, unknown>
			| undefined;
		if (!blockContent) {
			continue;
		}

		// Extract rich text
		const richText = blockContent.rich_text as
			| Array<{ plain_text?: string }>
			| undefined;
		const text = richText?.map((t) => t.plain_text || "").join("") || "";

		switch (blockType) {
			case "paragraph":
				if (text) {
					parts.push(text);
				}
				break;
			case "heading_1":
				if (text) {
					parts.push(`# ${text}`);
				}
				break;
			case "heading_2":
				if (text) {
					parts.push(`## ${text}`);
				}
				break;
			case "heading_3":
				if (text) {
					parts.push(`### ${text}`);
				}
				break;
			case "bulleted_list_item":
				if (text) {
					parts.push(`- ${text}`);
				}
				break;
			case "numbered_list_item":
				if (text) {
					parts.push(`1. ${text}`);
				}
				break;
			case "to_do": {
				const checked = blockContent.checked ? "x" : " ";
				if (text) {
					parts.push(`- [${checked}] ${text}`);
				}
				break;
			}
			case "code": {
				const language = (blockContent.language as string) || "";
				if (text) {
					parts.push(`\`\`\`${language}\n${text}\n\`\`\``);
				}
				break;
			}
			case "quote":
				if (text) {
					parts.push(`> ${text}`);
				}
				break;
			case "divider":
				parts.push("---");
				break;
			default:
				if (text) {
					parts.push(text);
				}
		}
	}

	return parts.join("\n\n");
}

/**
 * Parse Confluence page content
 */
function parseConfluenceContent(obj: Record<string, unknown>): {
	content: string;
	title?: string;
	url?: string;
} {
	let content = "";
	let title: string | undefined;
	let url: string | undefined;

	// Extract title
	if (typeof obj.title === "string") {
		title = obj.title;
	}

	// Extract URL
	if (obj._links && typeof obj._links === "object") {
		const links = obj._links as Record<string, string>;
		url = links.webui || links.self;
	}

	// Extract content from body storage format (Confluence uses XHTML)
	if (obj.body && typeof obj.body === "object") {
		const body = obj.body as Record<string, unknown>;
		if (body.storage && typeof body.storage === "object") {
			const storage = body.storage as Record<string, unknown>;
			if (typeof storage.value === "string") {
				// Convert Confluence XHTML to plain text/markdown
				content = convertConfluenceXhtmlToMarkdown(storage.value);
			}
		} else if (body.view && typeof body.view === "object") {
			const view = body.view as Record<string, unknown>;
			if (typeof view.value === "string") {
				content = convertConfluenceXhtmlToMarkdown(view.value);
			}
		}
	}

	// Try content field directly
	if (!content && typeof obj.content === "string") {
		content = obj.content;
	}

	// Add title if we have content
	if (title && content) {
		content = `# ${title}\n\n${content}`;
	} else if (title && !content) {
		content = `# ${title}\n\n(Content could not be extracted)`;
	}

	return { content, title, url };
}

/**
 * Convert Confluence XHTML to markdown (simplified)
 */
function convertConfluenceXhtmlToMarkdown(xhtml: string): string {
	let md = xhtml;

	// Remove XML declarations and namespaces
	md = md.replace(/<\?xml[^>]*\?>/g, "");
	md = md.replace(/xmlns[^=]*="[^"]*"/g, "");

	// Convert common Confluence elements
	md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n");
	md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n");
	md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n");
	md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n");
	md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
	md = md.replace(/<br\s*\/?>/gi, "\n");
	md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
	md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
	md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
	md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
	md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
	md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
	md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

	// Remove remaining tags
	md = md.replace(/<[^>]+>/g, "");

	// Clean up entities
	md = md.replace(/&nbsp;/g, " ");
	md = md.replace(/&amp;/g, "&");
	md = md.replace(/&lt;/g, "<");
	md = md.replace(/&gt;/g, ">");
	md = md.replace(/&quot;/g, '"');

	// Clean up whitespace
	md = md.replace(/\n{3,}/g, "\n\n");
	md = md.trim();

	return md;
}

/**
 * Parse Jira issue content
 */
function parseJiraContent(obj: Record<string, unknown>): {
	content: string;
	title?: string;
	url?: string;
} {
	let content = "";
	let title: string | undefined;
	let url: string | undefined;

	// Extract from fields
	if (obj.fields && typeof obj.fields === "object") {
		const fields = obj.fields as Record<string, unknown>;

		// Title = summary
		if (typeof fields.summary === "string") {
			title = fields.summary;
		}

		// Description
		if (typeof fields.description === "string") {
			content = fields.description;
		} else if (
			fields.description &&
			typeof fields.description === "object"
		) {
			// ADF (Atlassian Document Format) - simplified extraction
			content = extractTextFromAdf(
				fields.description as Record<string, unknown>,
			);
		}

		// Add issue key to content
		const key = obj.key as string;
		if (key && title) {
			content = `# ${key}: ${title}\n\n${content}`;
		}
	}

	// Try direct fields
	if (!title && typeof obj.summary === "string") {
		title = obj.summary;
	}
	if (!content && typeof obj.description === "string") {
		content = obj.description;
	}

	// URL from self link
	if (typeof obj.self === "string") {
		url = obj.self;
	}

	return { content, title, url };
}

/**
 * Extract text from Atlassian Document Format (ADF)
 */
function extractTextFromAdf(adf: Record<string, unknown>): string {
	const parts: string[] = [];

	function traverse(node: unknown) {
		if (!node || typeof node !== "object") {
			return;
		}

		const n = node as Record<string, unknown>;

		// Text nodes
		if (n.type === "text" && typeof n.text === "string") {
			parts.push(n.text);
		}

		// Recurse into content
		if (Array.isArray(n.content)) {
			for (const child of n.content) {
				traverse(child);
			}
		}
	}

	traverse(adf);
	return parts.join(" ");
}

/**
 * Parse Linear issue content
 */
function parseLinearContent(obj: Record<string, unknown>): {
	content: string;
	title?: string;
	url?: string;
} {
	let content = "";
	let title: string | undefined;
	let url: string | undefined;

	// Extract title
	if (typeof obj.title === "string") {
		title = obj.title;
	}

	// Extract description
	if (typeof obj.description === "string") {
		content = obj.description;
	}

	// URL
	if (typeof obj.url === "string") {
		url = obj.url;
	}

	// Issue identifier
	const identifier = obj.identifier as string;
	if (identifier && title) {
		content = `# ${identifier}: ${title}\n\n${content}`;
	} else if (title) {
		content = `# ${title}\n\n${content}`;
	}

	return { content, title, url };
}

/**
 * Generic content parsing for unknown sources
 */
function parseGenericContent(obj: Record<string, unknown>): {
	content: string;
	title?: string;
	url?: string;
} {
	let content = "";
	let title: string | undefined;
	let url: string | undefined;

	// Try common field names for title
	for (const key of ["title", "name", "summary", "subject", "heading"]) {
		if (typeof obj[key] === "string") {
			title = obj[key] as string;
			break;
		}
	}

	// Try common field names for content
	for (const key of [
		"content",
		"body",
		"description",
		"text",
		"markdown",
		"html",
	]) {
		if (typeof obj[key] === "string") {
			content = obj[key] as string;
			break;
		}
		if (obj[key] && typeof obj[key] === "object") {
			// Nested content object
			const nested = obj[key] as Record<string, unknown>;
			for (const nestedKey of ["value", "text", "raw", "rendered"]) {
				if (typeof nested[nestedKey] === "string") {
					content = nested[nestedKey] as string;
					break;
				}
			}
			if (content) {
				break;
			}
		}
	}

	// Try common field names for URL
	for (const key of ["url", "link", "href", "webUrl", "self"]) {
		if (typeof obj[key] === "string") {
			url = obj[key] as string;
			break;
		}
	}

	// If still no content, stringify the whole object
	if (!content) {
		content = JSON.stringify(obj, null, 2);
	}

	return { content, title, url };
}

/**
 * Parse tasks from markdown content
 */
function parseTasksFromMarkdown(markdown: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
	const lines = markdown.split("\n");
	let currentTask: { title: string; description: string } | null = null;

	for (const line of lines) {
		// Pattern 1: ### TASK-N: Title
		const taskMatch = line.match(/^###\s*TASK-?\d*:?\s*(.+)/);
		if (taskMatch) {
			if (currentTask) {
				tasks.push(currentTask);
			}
			currentTask = {
				title: taskMatch[1].trim(),
				description: "",
			};
			continue;
		}

		// Pattern 2: - [ ] Task description (checkbox)
		const checkboxMatch = line.match(/^-\s*\[\s*\]\s*(.+)/);
		if (checkboxMatch) {
			if (currentTask) {
				tasks.push(currentTask);
			}
			tasks.push({
				title: checkboxMatch[1].trim(),
			});
			currentTask = null;
			continue;
		}

		// Add to current task description
		if (currentTask && line.trim()) {
			currentTask.description += `${line}\n`;
		}
	}

	// Don't forget the last task
	if (currentTask) {
		tasks.push(currentTask);
	}

	// Fallback: if no tasks found, try bullet points
	if (tasks.length === 0) {
		const bulletPattern = /^[-*]\s+(.+)$/gm;
		let bulletMatch: RegExpExecArray | null = bulletPattern.exec(markdown);
		while (bulletMatch !== null) {
			const title = bulletMatch[1].trim();
			if (
				!title.startsWith("**") &&
				title.length > 5 &&
				title.length < 200
			) {
				tasks.push({ title });
			}
			bulletMatch = bulletPattern.exec(markdown);
		}
	}

	return tasks;
}

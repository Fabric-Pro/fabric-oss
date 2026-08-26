/**
 * Shared Notion content fetching utility.
 *
 * Fetches page content via MCP tools with comprehensive response format handling.
 * Used by both ProjectCreationWizard and NotionResourceBrowser.
 */

export type NotionContentFetchResult = {
	content: string;
	title: string;
	contentFetchFailed: boolean;
};

/**
 * Parse MCP tool result content from various response formats.
 */
function parseNotionMcpContent(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (!result || typeof result !== "object") {
		return "";
	}

	const obj = result as Record<string, unknown>;

	// Standard MCP format: array of content blocks
	if (Array.isArray(obj.content)) {
		return obj.content
			.filter(
				(block: unknown) =>
					block &&
					typeof block === "object" &&
					"text" in (block as Record<string, unknown>),
			)
			.map((block: unknown) => (block as { text: string }).text)
			.join("\n\n");
	}

	if (typeof obj.content === "string") {
		return obj.content;
	}

	if (typeof obj.content === "object" && obj.content !== null) {
		return JSON.stringify(obj.content);
	}

	if (obj.text) {
		return typeof obj.text === "string"
			? obj.text
			: JSON.stringify(obj.text);
	}

	if (obj.markdown) {
		return typeof obj.markdown === "string"
			? obj.markdown
			: JSON.stringify(obj.markdown);
	}

	// Last resort: stringify the entire result
	return JSON.stringify(result);
}

/**
 * Find the best tool for fetching a single Notion page's content.
 */
function findGetPageTool(tools: string[]): string | undefined {
	return tools.find((t) => {
		const lower = t.toLowerCase();
		return (
			(lower.includes("get") && lower.includes("page")) ||
			(lower.includes("fetch") &&
				!lower.includes("search") &&
				!lower.includes("teams")) ||
			lower.includes("notion_get_page") ||
			lower.includes("read_page") ||
			lower === "get_page"
		);
	});
}

/**
 * Fetch a Notion page's content via MCP.
 *
 * Discovers available tools, finds a suitable fetch/get_page tool,
 * and handles all known MCP response formats.
 */
export async function fetchNotionPageContent(params: {
	pageId: string;
	mcpConfigId: string;
	organizationId?: string | null;
	fallbackTitle?: string;
}): Promise<NotionContentFetchResult> {
	const { pageId, mcpConfigId, organizationId, fallbackTitle } = params;
	let title = fallbackTitle || "Notion Page";

	// Step 1: List available tools
	const toolsResponse = await fetch("/api/pipeline/mcp-tool", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mcpConfigId,
			action: "list_tools",
			organizationId: organizationId ?? undefined,
		}),
	});
	const toolsData = await toolsResponse.json();
	const tools = (toolsData.tools || []) as string[];

	// Step 2: Find the get page tool
	const getPageTool = findGetPageTool(tools);
	if (!getPageTool) {
		console.warn(
			"[NotionContentFetcher] No get_page tool found. Available tools:",
			tools,
		);
		return { content: "", title, contentFetchFailed: true };
	}

	// Step 3: Fetch page content
	const contentResponse = await fetch("/api/pipeline/mcp-tool", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mcpConfigId,
			toolName: getPageTool,
			params: { id: pageId, page_id: pageId },
			organizationId: organizationId ?? undefined,
		}),
	});
	const contentData = await contentResponse.json();

	if (contentData.error || !contentData.result) {
		return { content: "", title, contentFetchFailed: true };
	}

	// Step 4: Parse the content
	const content = parseNotionMcpContent(contentData.result);

	// Try to extract title from markdown heading
	if (content) {
		const titleMatch = content.match(/^#\s+(.+)/m);
		if (titleMatch) {
			title = titleMatch[1];
		}
	}

	return {
		content,
		title,
		contentFetchFailed: content.length === 0,
	};
}

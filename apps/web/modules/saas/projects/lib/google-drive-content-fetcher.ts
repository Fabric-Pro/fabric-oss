/**
 * Shared Google Drive content fetching utility.
 *
 * Fetches file content via MCP tools with comprehensive response format handling.
 * Used by project-side Google Drive selection and sync helpers.
 */

export type GoogleDriveContentFetchResult = {
	content: string;
	title: string;
	mimeType: string;
	contentFetchFailed: boolean;
	/** If the fileId was resolved from a filename, this contains the real ID */
	resolvedFileId?: string;
};

/**
 * Detect if an ID is actually a filename (from the text-parse fallback bug).
 * Real Google Drive file IDs are alphanumeric strings without spaces or common file extensions.
 */
function looksLikeFilename(id: string): boolean {
	if (!id) {
		return false;
	}
	// Real GDrive IDs are alphanumeric (with hyphens/underscores), no spaces, no file extensions
	return /\s/.test(id) || /\.\w{2,5}$/.test(id);
}

/**
 * Resolve a filename to a real Google Drive file ID via MCP listResources.
 * Returns the real file ID if found, or undefined if resolution fails.
 */
async function resolveFileIdFromResources(
	filename: string,
	mcpConfigId: string,
	organizationId?: string | null,
): Promise<string | undefined> {
	try {
		const response = await fetch("/api/pipeline/mcp-tool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mcpConfigId,
				action: "listResources",
				organizationId: organizationId || undefined,
			}),
		});
		const data = await response.json();
		const resources = data.result?.resources || [];

		for (const r of resources as Array<{
			uri?: string;
			name?: string;
		}>) {
			if (r.name === filename) {
				const uriMatch = r.uri?.match(/gdrive:\/\/\/(.+)/);
				if (uriMatch?.[1]) {
					return uriMatch[1];
				}
			}
		}
	} catch {
		// Resolution failed — caller should handle gracefully
	}
	return undefined;
}

/**
 * Resolve real file IDs for a batch of files that have filename-based IDs.
 * Calls listResources once and matches by name.
 */
export async function resolveFileIdsViaResources(
	_files: Array<{ id: string; title: string }>,
	mcpConfigId: string,
	organizationId?: string | null,
): Promise<Map<string, string>> {
	const nameToId = new Map<string, string>();
	try {
		const response = await fetch("/api/pipeline/mcp-tool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mcpConfigId,
				action: "listResources",
				organizationId: organizationId || undefined,
			}),
		});
		const data = await response.json();
		const resources = data.result?.resources || [];

		for (const r of resources as Array<{
			uri?: string;
			name?: string;
		}>) {
			const uriMatch = r.uri?.match(/gdrive:\/\/\/(.+)/);
			if (uriMatch?.[1] && r.name) {
				nameToId.set(r.name, uriMatch[1]);
			}
		}
	} catch {
		// Resolution failed
	}
	return nameToId;
}

/**
 * Parse MCP tool result content from various response formats.
 */
export function parseGoogleDriveMcpContent(result: unknown): string {
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

	// MCP text content array at top level: [{ type: "text", text: "..." }]
	if (Array.isArray(result)) {
		const textBlocks = (result as Array<Record<string, unknown>>).filter(
			(block) =>
				block?.type === "text" && typeof block?.text === "string",
		);
		if (textBlocks.length > 0) {
			return textBlocks.map((block) => block.text as string).join("\n\n");
		}
	}

	// Last resort: stringify the entire result
	return JSON.stringify(result);
}

/** Tool name patterns for reading file content */
const READ_TOOL_PATTERNS = [
	"get_document",
	"get-document",
	"read_file",
	"get_file",
	"get_file_content",
	"read_document",
	"google_drive_read",
	"drive_get_file",
	"readgoogledoc", // @piotr-agier/google-drive-mcp
	"downloadfile",
];

/**
 * Find the best tool for fetching a single file's content.
 */
function findReadFileTool(tools: string[]): string | undefined {
	for (const pattern of READ_TOOL_PATTERNS) {
		const match = tools.find((t) => t.toLowerCase().includes(pattern));
		if (match) {
			return match;
		}
	}
	return undefined;
}

/**
 * Fetch a Google Drive file's content via MCP.
 *
 * Discovers available tools, finds a suitable read/get tool,
 * and handles all known MCP response formats.
 */
export async function fetchGoogleDriveFileContent(params: {
	fileId: string;
	mcpConfigId: string;
	organizationId?: string | null;
	fallbackTitle?: string;
	fallbackMimeType?: string;
}): Promise<GoogleDriveContentFetchResult> {
	const {
		fileId,
		mcpConfigId,
		organizationId,
		fallbackTitle,
		fallbackMimeType,
	} = params;
	let title = fallbackTitle || "Google Drive File";
	const mimeType = fallbackMimeType || "";

	// Step 1: List available tools
	const toolsResponse = await fetch("/api/pipeline/mcp-tool", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mcpConfigId,
			action: "list_tools",
			organizationId: organizationId || undefined,
		}),
	});
	const toolsData = await toolsResponse.json();
	const tools = (toolsData.tools || []) as string[];

	// Step 2: Find the read file tool, or fall back to MCP resource reading
	const readTool = findReadFileTool(tools);

	let contentData: { result?: unknown; error?: string };

	if (readTool) {
		// Use read tool (e.g., readGoogleDoc, get_document)
		const contentResponse = await fetch("/api/pipeline/mcp-tool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mcpConfigId,
				toolName: readTool,
				params: { fileId, file_id: fileId, documentId: fileId },
				organizationId: organizationId || undefined,
			}),
		});
		contentData = await contentResponse.json();
	} else {
		// Fallback: read via MCP resources (e.g., gdrive:///fileId)
		console.log(
			"[GoogleDriveContentFetcher] No read tool found, trying MCP resource:",
			`gdrive:///${fileId}`,
		);
		const resourceResponse = await fetch("/api/pipeline/mcp-tool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mcpConfigId,
				action: "readResource",
				resourceUri: `gdrive:///${fileId}`,
				organizationId: organizationId || undefined,
			}),
		});
		contentData = await resourceResponse.json();
	}

	// If the initial fetch failed and fileId looks like a filename,
	// try resolving the real file ID via listResources and retry
	let resolvedFileId: string | undefined;
	if (
		(contentData.error || !contentData.result) &&
		looksLikeFilename(fileId)
	) {
		console.log(
			"[GoogleDriveContentFetcher] fileId looks like a filename, resolving via listResources:",
			fileId,
		);
		const realId = await resolveFileIdFromResources(
			fileId,
			mcpConfigId,
			organizationId,
		);
		if (realId) {
			resolvedFileId = realId;
			console.log(
				"[GoogleDriveContentFetcher] Resolved filename to real ID:",
				realId,
			);
			// Retry with real ID
			if (readTool) {
				const retryResponse = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						toolName: readTool,
						params: {
							fileId: realId,
							file_id: realId,
							documentId: realId,
						},
						organizationId: organizationId || undefined,
					}),
				});
				contentData = await retryResponse.json();
			} else {
				const retryResponse = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId,
						action: "readResource",
						resourceUri: `gdrive:///${realId}`,
						organizationId: organizationId || undefined,
					}),
				});
				contentData = await retryResponse.json();
			}
		}
	}

	if (contentData.error || !contentData.result) {
		return { content: "", title, mimeType, contentFetchFailed: true };
	}

	// Step 4: Parse the content
	const content = parseGoogleDriveMcpContent(contentData.result);

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
		mimeType,
		contentFetchFailed: content.length === 0,
		resolvedFileId,
	};
}

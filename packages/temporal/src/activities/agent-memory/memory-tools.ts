/**
 * Agent Memory Tools
 *
 * Tool definitions for agents to interact with their memory.
 * These tools allow agents to read, write, and search their memory files.
 */

import {
	type AgentMemoryFileType,
	createMemoryEdit,
	listMemoryFiles,
	readMemoryFile,
	searchMemoryFiles,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface AgentMemoryToolResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

interface MemoryToolContext {
	agentInstanceId: string;
	userId: string;
	organizationId?: string;
	autoApproveMemory?: boolean;
}

// ============================================================================
// Tool Schemas
// ============================================================================

export const memoryListSchema = z.object({
	path: z
		.string()
		.optional()
		.describe("Optional path prefix to filter (e.g., 'skills/')"),
});

export const memoryReadSchema = z.object({
	path: z
		.string()
		.describe(
			"Path to the memory file (e.g., 'AGENTS.md', 'skills/research/SKILL.md')",
		),
});

export const memoryWriteSchema = z.object({
	path: z.string().describe("Path to write the file"),
	content: z.string().describe("Content to write"),
	reason: z
		.string()
		.optional()
		.describe("Why you want to update this memory"),
});

export const memorySearchSchema = z.object({
	query: z.string().describe("Search query to find in memory files"),
	fileTypes: z
		.array(
			z.enum([
				"AGENTS_MD",
				"MCP_JSON",
				"SKILL",
				"KNOWLEDGE",
				"CONVERSATION",
				"CUSTOM",
			]),
		)
		.optional()
		.describe("Optional file types to search"),
});

export const memoryCompactSchema = z.object({
	path: z
		.string()
		.describe("Path to the memory file to compact (e.g., 'AGENTS.md')"),
	content: z
		.string()
		.describe(
			"The compacted content to write back — duplicates removed, long entries summarized",
		),
	reason: z.string().optional().describe("Why you are compacting this file"),
});

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * List memory files
 */
export async function memoryListTool(
	ctx: MemoryToolContext,
	args: z.infer<typeof memoryListSchema>,
): Promise<AgentMemoryToolResult> {
	try {
		const { files } = await listMemoryFiles({
			agentInstanceId: ctx.agentInstanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			path: args.path,
			limit: 100,
		});

		const fileList = files.map((f) => ({
			path: f.path,
			type: f.fileType,
			version: f.version,
			updatedAt: f.updatedAt,
		}));

		return {
			success: true,
			data: {
				files: fileList,
				total: fileList.length,
			},
		};
	} catch (error) {
		logger.error("[MemoryTool:list] Failed", {
			error: error instanceof Error ? error.message : "Unknown",
		});
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to list memory files",
		};
	}
}

/**
 * Read a memory file
 */
export async function memoryReadTool(
	ctx: MemoryToolContext,
	args: z.infer<typeof memoryReadSchema>,
): Promise<AgentMemoryToolResult> {
	try {
		const file = await readMemoryFile(
			{
				agentInstanceId: ctx.agentInstanceId,
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			},
			args.path,
		);

		if (!file) {
			return {
				success: false,
				error: `File not found: ${args.path}`,
			};
		}

		return {
			success: true,
			data: {
				path: file.path,
				content: file.content,
				type: file.fileType,
				version: file.version,
				updatedAt: file.updatedAt,
			},
		};
	} catch (error) {
		logger.error("[MemoryTool:read] Failed", {
			path: args.path,
			error: error instanceof Error ? error.message : "Unknown",
		});
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to read memory file",
		};
	}
}

/**
 * Write/update a memory file
 * Creates a pending edit that requires approval (unless autoApproveMemory is true)
 */
export async function memoryWriteTool(
	ctx: MemoryToolContext,
	args: z.infer<typeof memoryWriteSchema>,
): Promise<AgentMemoryToolResult> {
	try {
		// Check if file exists to determine operation
		const existingFile = await readMemoryFile(
			{
				agentInstanceId: ctx.agentInstanceId,
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			},
			args.path,
		);

		const operation = existingFile ? "UPDATE" : "CREATE";

		const edit = await createMemoryEdit({
			ctx: {
				agentInstanceId: ctx.agentInstanceId,
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			},
			path: args.path,
			operation,
			newContent: args.content,
			reason: args.reason,
			autoApprove: ctx.autoApproveMemory ?? false,
		});

		if (ctx.autoApproveMemory) {
			return {
				success: true,
				data: {
					message: `Memory file ${operation.toLowerCase()}d successfully`,
					path: args.path,
					editId: edit.id,
					applied: true,
				},
			};
		}

		return {
			success: true,
			data: {
				message: "Memory update proposed. Awaiting user approval.",
				path: args.path,
				editId: edit.id,
				applied: false,
				operation,
			},
		};
	} catch (error) {
		logger.error("[MemoryTool:write] Failed", {
			path: args.path,
			error: error instanceof Error ? error.message : "Unknown",
		});
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to write memory file",
		};
	}
}

/**
 * Compact a memory file by removing duplicates and summarizing long entries.
 *
 * Identical to memoryWriteTool underneath — the LLM provides the compacted
 * content and this tool writes it back. Mirrors Dust's compact_memory tool
 * which uses the same editEntries implementation as edit_entries.
 */
export async function memoryCompactTool(
	ctx: MemoryToolContext,
	args: z.infer<typeof memoryCompactSchema>,
): Promise<AgentMemoryToolResult> {
	return memoryWriteTool(ctx, {
		path: args.path,
		content: args.content,
		reason:
			args.reason ??
			"Compacting memory to remove duplicates and summarize long entries",
	});
}

/**
 * Search memory files by content
 */
export async function memorySearchTool(
	ctx: MemoryToolContext,
	args: z.infer<typeof memorySearchSchema>,
): Promise<AgentMemoryToolResult> {
	try {
		const files = await searchMemoryFiles(
			{
				agentInstanceId: ctx.agentInstanceId,
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			},
			args.query,
			{
				fileTypes: args.fileTypes as AgentMemoryFileType[] | undefined,
				limit: 20,
			},
		);

		const results = files.map((f) => ({
			path: f.path,
			type: f.fileType,
			// Include a snippet of the content around the match
			snippet: extractSnippet(f.content, args.query, 200),
		}));

		return {
			success: true,
			data: {
				query: args.query,
				results,
				total: results.length,
			},
		};
	} catch (error) {
		logger.error("[MemoryTool:search] Failed", {
			query: args.query,
			error: error instanceof Error ? error.message : "Unknown",
		});
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search memory files",
		};
	}
}

/**
 * Extract a snippet of content around a search term
 */
function extractSnippet(
	content: string,
	query: string,
	maxLength: number,
): string {
	const lowerContent = content.toLowerCase();
	const lowerQuery = query.toLowerCase();
	const index = lowerContent.indexOf(lowerQuery);

	if (index === -1) {
		// Return beginning of content if query not found (shouldn't happen)
		return (
			content.slice(0, maxLength) +
			(content.length > maxLength ? "..." : "")
		);
	}

	const start = Math.max(0, index - maxLength / 2);
	const end = Math.min(content.length, index + query.length + maxLength / 2);

	let snippet = content.slice(start, end);
	if (start > 0) {
		snippet = `...${snippet}`;
	}
	if (end < content.length) {
		snippet = `${snippet}...`;
	}

	return snippet;
}

// ============================================================================
// Tool Registry
// ============================================================================

export interface MemoryToolDefinition {
	name: string;
	description: string;
	schema: z.ZodType;
	execute: (
		ctx: MemoryToolContext,
		args: any,
	) => Promise<AgentMemoryToolResult>;
}

/**
 * Get all agent memory tools
 */
export function getAgentMemoryTools(): MemoryToolDefinition[] {
	return [
		{
			name: "memory_list",
			description:
				"List files in your memory. Use to see what's stored in your persistent memory (AGENTS.md, skills, knowledge, etc.)",
			schema: memoryListSchema,
			execute: memoryListTool,
		},
		{
			name: "memory_read",
			description:
				"Read a specific memory file. Use to retrieve your stored instructions, skills, or knowledge.",
			schema: memoryReadSchema,
			execute: memoryReadTool,
		},
		{
			name: "memory_write",
			description:
				"Write or update a memory file. Use to store new learnings, update instructions, or save knowledge. Requires user approval unless auto-approve is enabled.",
			schema: memoryWriteSchema,
			execute: memoryWriteTool,
		},
		{
			name: "memory_search",
			description:
				"Search across all memory files. Use to find specific information in your stored knowledge.",
			schema: memorySearchSchema,
			execute: memorySearchTool,
		},
		{
			name: "memory_compact",
			description:
				"Compact a memory file by removing duplicate entries and summarizing long entries. Use this when a memory file has grown large, contains redundant information, or needs to be reorganized. Read the file first, then write back a leaner version.",
			schema: memoryCompactSchema,
			execute: memoryCompactTool,
		},
	];
}

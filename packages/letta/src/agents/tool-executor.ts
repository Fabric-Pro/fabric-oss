/**
 * Tool Executor Agent
 * Letta agent specialized for executing MCP tools with result caching
 */

import type { LettaClient } from "../client";
import type { LettaAgent, LettaTool, ToolResultCache } from "../types";

const TOOL_EXECUTOR_PERSONA = `You are a Tool Executor agent. Your job is to:
1. CHECK the cached_results memory block FIRST before calling any tool
2. If data exists in cache and is not stale (cached within last 5 minutes), extract and return it
3. Only call tools for NEW data not in cache
4. Store all successful tool results in cached_results for future use
5. Be efficient - never make redundant API calls

When checking cache, look for exact matches on tool name and similar arguments.
When storing results, use the format: toolName -> { result, cachedAt, args }`;

export interface CreateToolExecutorOptions {
	userId: string;
	organizationId?: string;
	mcpTools?: LettaTool[];
	model?: string;
}

/**
 * Create a tool executor agent for a user
 */
export async function createToolExecutorAgent(
	client: LettaClient,
	options: CreateToolExecutorOptions,
): Promise<LettaAgent> {
	const { userId, organizationId, mcpTools = [], model } = options;

	return client.createAgent({
		name: `tool-executor-${userId}`,
		description: "Executes MCP tools efficiently with result caching",
		model,
		memoryBlocks: [
			{
				label: "persona",
				value: TOOL_EXECUTOR_PERSONA,
			},
			{
				label: "human",
				value: JSON.stringify({
					userId,
					organizationId,
					preferences: {},
				}),
			},
			{
				label: "cached_results",
				value: "{}",
				limit: 50000, // 50KB limit for cache
			},
			{
				label: "tool_patterns",
				value: "[]",
				limit: 10000,
			},
		],
		tools: mcpTools,
		metadata: {
			userId,
			organizationId,
			type: "tool_executor",
			version: "1.0",
		},
	});
}

/**
 * Get or create tool executor agent for a user
 */
export async function getOrCreateToolExecutorAgent(
	client: LettaClient,
	options: CreateToolExecutorOptions,
): Promise<LettaAgent> {
	// Try to find existing agent
	const existing = await client.findAgentByMetadata({
		userId: options.userId,
		type: "tool_executor",
	});

	if (existing) {
		return existing;
	}

	// Create new agent
	return createToolExecutorAgent(client, options);
}

/**
 * Get cached tool result from agent memory
 */
export async function getCachedToolResult(
	client: LettaClient,
	agentId: string,
	toolName: string,
	maxAgeMs: number = 5 * 60 * 1000, // 5 minutes default
): Promise<unknown | null> {
	try {
		const block = await client.getMemoryBlock(agentId, "cached_results");
		const cache = JSON.parse(block.value || "{}") as Record<
			string,
			ToolResultCache
		>;

		const entry = cache[toolName];
		if (!entry) {
			return null;
		}

		// Check if cache is stale
		const cachedAt = new Date(entry.cachedAt).getTime();
		const now = Date.now();

		if (now - cachedAt > maxAgeMs) {
			return null; // Cache expired
		}

		return entry.result;
	} catch {
		return null;
	}
}

/**
 * Cache a tool result in agent memory
 */
export async function cacheToolResult(
	client: LettaClient,
	agentId: string,
	toolName: string,
	result: unknown,
	metadata?: Record<string, unknown>,
): Promise<void> {
	const block = await client.getMemoryBlock(agentId, "cached_results");
	const cache = JSON.parse(block.value || "{}") as Record<
		string,
		ToolResultCache
	>;

	cache[toolName] = {
		toolName,
		result,
		cachedAt: new Date().toISOString(),
		metadata,
	};

	// Prune old entries if cache is getting large
	const entries = Object.entries(cache);
	if (entries.length > 100) {
		// Keep only the 50 most recent entries
		const sorted = entries.sort(
			(a, b) =>
				new Date(b[1].cachedAt).getTime() -
				new Date(a[1].cachedAt).getTime(),
		);
		const pruned = Object.fromEntries(sorted.slice(0, 50));
		await client.updateMemoryBlock(
			agentId,
			"cached_results",
			JSON.stringify(pruned),
		);
	} else {
		await client.updateMemoryBlock(
			agentId,
			"cached_results",
			JSON.stringify(cache),
		);
	}
}

/**
 * Record a successful tool execution pattern
 */
export async function recordToolPattern(
	client: LettaClient,
	agentId: string,
	pattern: {
		task: string;
		toolSequence: string[];
		success: boolean;
	},
): Promise<void> {
	const block = await client.getMemoryBlock(agentId, "tool_patterns");
	const patterns = JSON.parse(block.value || "[]") as Array<
		typeof pattern & { recordedAt: string }
	>;

	patterns.push({
		...pattern,
		recordedAt: new Date().toISOString(),
	});

	// Keep only last 50 patterns
	const trimmed = patterns.slice(-50);
	await client.updateMemoryBlock(
		agentId,
		"tool_patterns",
		JSON.stringify(trimmed),
	);
}

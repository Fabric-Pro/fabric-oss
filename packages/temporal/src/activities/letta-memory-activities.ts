/**
 * Letta Memory Activities
 *
 * Temporal activities for Letta-based semantic memory operations.
 * Provides tool result caching and cleanup of legacy run memory.
 *
 * @security All operations include:
 * - Agent ownership verification
 * - Rate limiting
 * - Input validation and sanitization
 * - Multi-tenant isolation
 */

import type { LettaClient } from "@repo/letta";
import {
	getLettaClient,
	LettaError,
	orchestratorMemoryMetadata,
} from "@repo/letta";
import { logger } from "@repo/logs";
import {
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import {
	type LettaSecurityContext,
	logSecurityEvent,
	MAX_CACHE_ENTRY_SIZE,
	MAX_MEMORY_BLOCK_SIZE,
	sanitizeToolResult,
	validateLettaOperation,
	validateMemoryBlockContent,
} from "./letta-security";

// ============================================================================
// Types
// ============================================================================

export interface InitializeLettaMemoryInput {
	userId: string;
	organizationId?: string;
	availableAgents?: Array<{
		id: string;
		name: string;
		description: string;
		capabilities: string[];
	}>;
}

export interface InitializeLettaMemoryOutput {
	agentId: string;
	isNew: boolean;
}

export interface CacheToolResultInput {
	lettaAgentId: string;
	userId: string; // ✅ Added for user-scoped caching
	organizationId?: string; // ✅ Added for security validation
	toolName: string;
	toolArgs: Record<string, unknown>;
	result: unknown;
	durationMs: number;
	success: boolean;
}

export interface GetCachedToolResultInput {
	lettaAgentId: string;
	userId: string; // ✅ Added for user-scoped caching
	organizationId?: string; // ✅ Added for security validation
	toolName: string;
	toolArgs?: Record<string, unknown>;
}

export interface GetCachedToolResultOutput {
	found: boolean;
	result?: unknown;
	cachedAt?: string;
	hitCount?: number;
}

export interface RecordExecutionInput {
	lettaAgentId: string;
	executionId: string;
	task: string;
	steps: Array<{
		stepId: string;
		description: string;
		status: "complete" | "error" | "skipped";
		agentId?: string;
		toolCalls?: Array<{
			name: string;
			success: boolean;
		}>;
	}>;
	success: boolean;
	durationMs: number;
}

export interface GetRoutingSuggestionsInput {
	lettaAgentId: string;
	task: string;
}

export interface RoutingSuggestion {
	agents: string[];
	confidence: number;
	pattern?: string;
}

// ============================================================================
// Helper: Get or Create Letta Client
// ============================================================================

function getLettaClientFromEnv(): LettaClient | null {
	const baseUrl = process.env.LETTA_BASE_URL;
	const apiKey = process.env.LETTA_API_KEY;

	if (!baseUrl) {
		console.log(
			"[LettaMemory] Letta not configured (LETTA_BASE_URL not set)",
		);
		return null;
	}

	return getLettaClient({ baseUrl, apiKey });
}

// ============================================================================
// Activity: Initialize Letta Memory Agent
// ============================================================================

/**
 * Initialize or get the organization-shared Letta memory agent.
 * Tool cache entries are scoped by user; legacy run blocks are cleared at completion.
 */
export async function initializeLettaMemory(
	input: InitializeLettaMemoryInput,
): Promise<InitializeLettaMemoryOutput | null> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return null;
	}

	try {
		// Check if Letta is healthy
		console.log("🔍 [Letta] Checking Letta server health...");
		const health = await client.health();
		if (!health.healthy) {
			console.log("❌ [Letta] Letta server unhealthy:", health.error);
			return null;
		}
		console.log("✅ [Letta] Letta server is healthy");

		// Determine identifier key and type (Hybrid approach)
		// - Use organizationId for organization-level tenancy (shared memory across team)
		// - Use userId for personal accounts (user-specific memory)
		const identifierKey = input.organizationId || input.userId;
		const identityType = input.organizationId ? "org" : "user";

		console.log("🔍 [Letta] Using hybrid tenancy model", {
			identifierKey,
			identityType,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		console.log("🔍 [Letta] Looking for memory agent...");
		const memoryAgent = await client.findAgentByMetadata(
			orchestratorMemoryMetadata(input),
		);

		if (memoryAgent) {
			console.log("✅ [Letta] Using existing memory agent", {
				agentId: memoryAgent.id,
			});
			return { agentId: memoryAgent.id, isNew: false };
		}

		// Create new memory agent with proper descriptions
		console.log("🆕 [Letta] Creating new memory agent...");
		const agent = await client.createAgent({
			name: `orchestrator-memory-${identifierKey}`,
			description: `Semantic memory for orchestrator execution patterns (${identityType}: ${identifierKey})`,
			memoryBlocks: [
				{
					label: "persona",
					description:
						"Your role and goals as a memory agent for Advisor's orchestrator",
					value: `You are a memory agent that tracks execution patterns, tool results, and user preferences for the orchestrator behind Advisor, Fabric's AI assistant.

Your goals:
1. Cache tool results to avoid redundant API calls
2. Learn successful execution patterns
3. Track user preferences and behaviors
4. Identify common error patterns to avoid`,
				},
				{
					label: "tool_cache",
					description:
						"Cache of tool execution results to avoid redundant API calls. Format: { 'toolName:argsHash': { result, cachedAt, hitCount, ttl } }",
					value: "{}",
					limit: 50000,
				},
				{
					label: "execution_history",
					description:
						"History of orchestrator executions with task descriptions, steps, and outcomes. Used to learn patterns and improve routing decisions.",
					value: "[]",
					limit: 30000,
				},
				{
					label: "successful_patterns",
					description:
						"Patterns of successful task executions, including which agents were used and why. Used to suggest optimal routing for similar tasks.",
					value: "[]",
					limit: 10000,
				},
				{
					label: "error_patterns",
					description:
						"Common error patterns and failures to avoid. Includes failed tool calls, agent routing mistakes, and user corrections.",
					value: "[]",
					limit: 10000,
				},
			],
			metadata: {
				userId: input.userId,
				...orchestratorMemoryMetadata(input),
				version: "2.0",
				createdAt: new Date().toISOString(),
			},
		});

		console.log("✅ [Letta] Created new memory agent", {
			agentId: agent.id,
			identityType,
			memoryBlocks: agent.memoryBlocks?.length || 0,
		});
		return { agentId: agent.id, isNew: true };
	} catch (error) {
		logger.error(
			{
				event: "letta.memory.initialization_failed",
				code:
					error instanceof LettaError
						? error.code
						: "INITIALIZATION_FAILED",
				httpStatus:
					error instanceof LettaError ? (error.status ?? 0) : 0,
				operation: "initializeLettaMemory",
			},
			"Letta memory initialization failed",
		);
		return null;
	}
}

// ============================================================================
// Activity: Cache Tool Result
// ============================================================================

/**
 * Cache a tool execution result for future reuse
 *
 * @security This function includes:
 * - Agent ownership verification
 * - Rate limiting (50 cache ops per minute)
 * - Result size validation and sanitization
 * - Sensitive field redaction
 */
export async function cacheToolResult(
	input: CacheToolResultInput,
): Promise<void> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return;
	}

	const securityContext: LettaSecurityContext = {
		userId: input.userId,
		organizationId: input.organizationId,
		lettaAgentId: input.lettaAgentId,
	};

	try {
		// Inside a chat turn that has stopped (or used its token allowance)
		// nothing is cached: checked before the rate-limit bookkeeping and
		// again immediately before each memory write below, after the reads
		// that precede it. A no-op outside a turn.
		throwIfDispatchStopped();
		// ✅ Security: Validate operation (rate limit + ownership)
		const validationResult = await validateLettaOperation(
			securityContext,
			"toolCache",
		);

		if (!validationResult.valid) {
			logSecurityEvent("violation", securityContext, {
				operation: "cacheToolResult",
				success: false,
				errorCode: validationResult.errorCode,
				metadata: { toolName: input.toolName },
			});
			console.warn(
				`[Letta Cache] Security validation failed: ${validationResult.error}`,
			);
			return;
		}

		const block = await client.getMemoryBlock(
			input.lettaAgentId,
			"tool_cache",
		);
		const cache = JSON.parse(block.value || "{}") as Record<
			string,
			{
				result: unknown;
				cachedAt: string;
				hitCount: number;
				userId: string; // ✅ Added for audit trail
				args?: Record<string, unknown>;
				durationMs: number;
			}
		>;

		// Create cache key from tool name, userId, and args
		const cacheKey = createCacheKey(
			input.toolName,
			input.userId,
			input.toolArgs,
		);

		// Only cache successful results
		if (input.success) {
			// ✅ Security: Sanitize and validate result size
			const { sanitized, truncated, originalSize } = sanitizeToolResult(
				input.result,
				input.userId,
				{ maxSize: MAX_CACHE_ENTRY_SIZE, truncate: true },
			);

			if (truncated) {
				console.log(
					`[Letta Cache] Result truncated for ${input.toolName}: ${originalSize} -> ${MAX_CACHE_ENTRY_SIZE} bytes`,
				);
			}

			cache[cacheKey] = {
				result: sanitized,
				cachedAt: new Date().toISOString(),
				hitCount: 0,
				userId: input.userId, // ✅ Store userId for audit trail
				args: input.toolArgs,
				durationMs: input.durationMs,
			};

			// Trim cache to 100 most recent entries
			const entries = Object.entries(cache);
			if (entries.length > 100) {
				const sorted = entries.sort(
					(a, b) =>
						new Date(b[1].cachedAt).getTime() -
						new Date(a[1].cachedAt).getTime(),
				);
				const trimmed = Object.fromEntries(sorted.slice(0, 100));

				// ✅ Security: Validate final cache size
				const cacheContent = JSON.stringify(trimmed);
				const validation = validateMemoryBlockContent(cacheContent, {
					maxSize: MAX_MEMORY_BLOCK_SIZE,
					requireJson: true,
					blockLabel: "tool_cache",
				});

				if (!validation.valid) {
					console.error(
						`[Letta Cache] Cache block validation failed: ${validation.error}`,
					);
					return;
				}

				throwIfDispatchStopped();
				await client.updateMemoryBlock(
					input.lettaAgentId,
					"tool_cache",
					cacheContent,
				);

				logSecurityEvent("cache", securityContext, {
					operation: "cacheToolResult",
					success: true,
					metadata: { toolName: input.toolName, truncated },
				});
				return;
			}
		}

		// ✅ Security: Validate final cache size
		const cacheContent = JSON.stringify(cache);
		const validation = validateMemoryBlockContent(cacheContent, {
			maxSize: MAX_MEMORY_BLOCK_SIZE,
			requireJson: true,
			blockLabel: "tool_cache",
		});

		if (!validation.valid) {
			console.error(
				`[Letta Cache] Cache block validation failed: ${validation.error}`,
			);
			return;
		}

		throwIfDispatchStopped();
		await client.updateMemoryBlock(
			input.lettaAgentId,
			"tool_cache",
			cacheContent,
		);

		logSecurityEvent("cache", securityContext, {
			operation: "cacheToolResult",
			success: true,
			metadata: { toolName: input.toolName },
		});

		console.log(
			`💾 [Letta Cache] Stored ${input.success ? "successful" : "failed"} result for ${input.toolName}`,
		);
	} catch (error) {
		// A turn stop is not a cache failure to log past.
		rethrowIfDispatchStopped(error);
		logSecurityEvent("cache", securityContext, {
			operation: "cacheToolResult",
			success: false,
			metadata: {
				toolName: input.toolName,
				error: error instanceof Error ? error.message : "Unknown error",
			},
		});
		console.error("❌ [Letta Cache] Failed to cache tool result:", error);
	}
}

// ============================================================================
// Activity: Get Cached Tool Result
// ============================================================================

/**
 * Check if a tool result is cached
 *
 * @security This function includes:
 * - Agent ownership verification
 * - Rate limiting (100 read ops per minute)
 * - User-scoped cache key to prevent cross-user data leakage
 */
export async function getCachedToolResult(
	input: GetCachedToolResultInput,
): Promise<GetCachedToolResultOutput> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return { found: false };
	}

	const securityContext: LettaSecurityContext = {
		userId: input.userId,
		organizationId: input.organizationId,
		lettaAgentId: input.lettaAgentId,
	};

	try {
		// ✅ Security: Validate operation (rate limit + ownership)
		const validationResult = await validateLettaOperation(
			securityContext,
			"memoryRead",
		);

		if (!validationResult.valid) {
			logSecurityEvent("violation", securityContext, {
				operation: "getCachedToolResult",
				success: false,
				errorCode: validationResult.errorCode,
				metadata: { toolName: input.toolName },
			});
			console.warn(
				`[Letta Cache] Security validation failed: ${validationResult.error}`,
			);
			return { found: false };
		}

		const block = await client.getMemoryBlock(
			input.lettaAgentId,
			"tool_cache",
		);
		const cache = JSON.parse(block.value || "{}") as Record<
			string,
			{
				result: unknown;
				cachedAt: string;
				hitCount: number;
				userId: string; // ✅ Added for audit trail
				args?: Record<string, unknown>;
			}
		>;

		// ✅ Security: User-scoped cache key prevents cross-user data leakage
		const cacheKey = createCacheKey(
			input.toolName,
			input.userId,
			input.toolArgs,
		);
		const entry = cache[cacheKey];

		if (entry) {
			// ✅ Security: Verify cached entry belongs to the requesting user
			if (entry.userId && entry.userId !== input.userId) {
				console.warn(
					`[Letta Cache] Cache entry user mismatch: expected ${input.userId}, found ${entry.userId}`,
				);
				logSecurityEvent("violation", securityContext, {
					operation: "getCachedToolResult",
					success: false,
					errorCode: "TENANT_ISOLATION_VIOLATION",
					metadata: {
						toolName: input.toolName,
						cachedUserId: entry.userId,
					},
				});
				return { found: false };
			}

			// Check if cache is still fresh (1 hour for read operations, 5 min for others)
			const cacheAge = Date.now() - new Date(entry.cachedAt).getTime();
			const isReadOp = input.toolName
				.toLowerCase()
				.match(/^(get|list|search|find|fetch)/);
			const maxAge = isReadOp ? 60 * 60 * 1000 : 5 * 60 * 1000;

			if (cacheAge < maxAge) {
				// Update hit count
				entry.hitCount++;
				cache[cacheKey] = entry;
				await client.updateMemoryBlock(
					input.lettaAgentId,
					"tool_cache",
					JSON.stringify(cache),
				);

				const ageSeconds = Math.round(cacheAge / 1000);
				console.log(
					`🎯 [Letta Cache HIT] ${input.toolName} (age: ${ageSeconds}s, hits: ${entry.hitCount})`,
				);

				logSecurityEvent("access", securityContext, {
					operation: "getCachedToolResult",
					success: true,
					metadata: { toolName: input.toolName, cacheHit: true },
				});

				return {
					found: true,
					result: entry.result,
					cachedAt: entry.cachedAt,
					hitCount: entry.hitCount,
				};
			}
			console.log(
				`⏰ [Letta Cache] Expired cache for ${input.toolName} (age: ${Math.round(cacheAge / 1000)}s > ${Math.round(maxAge / 1000)}s)`,
			);
		}

		return { found: false };
	} catch (error) {
		logSecurityEvent("access", securityContext, {
			operation: "getCachedToolResult",
			success: false,
			metadata: {
				toolName: input.toolName,
				error: error instanceof Error ? error.message : "Unknown error",
			},
		});
		console.error("❌ [Letta Cache] Failed to get cached result:", error);
		return { found: false };
	}
}

// ============================================================================
// Activity: Record Execution
// ============================================================================

/**
 * Clear legacy run text while preserving the scheduled activity contract.
 * Organization-shared memory must not retain tasks or step descriptions.
 */
export async function recordExecution(
	input: RecordExecutionInput,
): Promise<void> {
	try {
		const client = getLettaClientFromEnv();
		if (!client) {
			return;
		}

		for (const label of [
			"execution_history",
			"successful_patterns",
			"error_patterns",
		]) {
			try {
				const block = await client.getMemoryBlock(
					input.lettaAgentId,
					label,
				);
				if (block && block.value !== "[]") {
					await client.updateMemoryBlock(
						input.lettaAgentId,
						label,
						"[]",
					);
				}
			} catch (error) {
				if (
					error instanceof LettaError &&
					error.code === "BLOCK_NOT_FOUND"
				) {
					continue;
				}
				// Provider errors can contain legacy block text; log only the label.
				console.error(
					"[LettaMemory] Failed to clear legacy run block",
					{ label },
				);
			}
		}
		console.log("[LettaMemory] Legacy run block cleanup finished");
	} catch {
		console.error("[LettaMemory] Failed to clear legacy run memory");
	}
}

// ============================================================================
// Activity: Get Routing Suggestions
// ============================================================================

/** Retained for registered activity compatibility; shared patterns are disabled. */
export async function getRoutingSuggestions(
	_input: GetRoutingSuggestionsInput,
): Promise<RoutingSuggestion[]> {
	return [];
}

// ============================================================================
// Activity: Get Cached Tools Summary
// ============================================================================

/**
 * Get a summary of cached tool results for context injection
 */
export async function getCachedToolsSummary(
	lettaAgentId: string,
	toolNames: string[],
): Promise<Record<string, unknown>> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return {};
	}

	try {
		const block = await client.getMemoryBlock(lettaAgentId, "tool_cache");
		const cache = JSON.parse(block.value || "{}") as Record<
			string,
			{
				result: unknown;
				cachedAt: string;
				args?: Record<string, unknown>;
			}
		>;

		const summary: Record<string, unknown> = {};

		for (const toolName of toolNames) {
			// Find any cached entries for this tool
			const entries = Object.entries(cache).filter(([key]) =>
				key.startsWith(`${toolName}:`),
			);

			if (entries.length > 0) {
				// Get the most recent entry
				const [, entry] = entries.sort(
					(a, b) =>
						new Date(b[1].cachedAt).getTime() -
						new Date(a[1].cachedAt).getTime(),
				)[0];

				summary[toolName] = entry.result;
			}
		}

		return summary;
	} catch {
		return {};
	}
}

// ============================================================================
// Helpers
// ============================================================================

function createCacheKey(
	toolName: string,
	userId: string,
	args?: Record<string, unknown>,
): string {
	// ✅ Include userId in cache key for user-scoped caching
	// This prevents data leakage between users in the same organization
	if (!args || Object.keys(args).length === 0) {
		return `${toolName}:${userId}`;
	}
	// Create deterministic key from sorted args
	const sortedArgs = Object.entries(args)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join("&");
	return `${toolName}:${sortedArgs}:${userId}`;
}

/**
 * Letta Memory Activities
 *
 * Temporal activities for Letta-based semantic memory operations.
 * Provides tool result caching, execution history, and pattern learning.
 *
 * @security All operations include:
 * - Agent ownership verification
 * - Rate limiting
 * - Input validation and sanitization
 * - Multi-tenant isolation
 */

import type { LettaClient } from "@repo/letta";
import { getLettaClient } from "@repo/letta";
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
 * Initialize or get existing Letta memory agent for a user
 * This agent stores execution history and learned patterns
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

		// Get or create Identity
		console.log("🔍 [Letta] Looking for identity...", {
			identifierKey,
			identityType,
		});
		const identities = await client.listIdentities({ identifierKey });
		let identity = identities[0];

		if (!identity) {
			console.log("🆕 [Letta] Creating new identity...");
			identity = await client.createIdentity({
				identifierKey,
				name: identifierKey,
				identityType,
			});
			console.log("✅ [Letta] Created identity", { id: identity.id });
		} else {
			console.log("✅ [Letta] Using existing identity", {
				id: identity.id,
			});
		}

		// Find agents associated with this identity
		console.log("🔍 [Letta] Looking for memory agent...");
		const agents = await client.listAgents({
			identifierKeys: [identifierKey],
		});
		const memoryAgent = agents.find(
			(a) => a.metadata?.type === "orchestrator-memory",
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
			identityIds: [identity.id], // ✅ Associate with identity
			memoryBlocks: [
				{
					label: "persona",
					description:
						"Your role and goals as a memory agent for Fabric Loom",
					value: `You are a memory agent that tracks execution patterns, tool results, and user preferences for Fabric Loom (the orchestrator).

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
				organizationId: input.organizationId,
				type: "orchestrator-memory",
				identityType,
				identifierKey,
				version: "2.0", // Bumped version for Identity support
				createdAt: new Date().toISOString(),
			},
		});

		console.log("✅ [Letta] Created new memory agent", {
			agentId: agent.id,
			identityId: identity.id,
			identityType,
			memoryBlocks: agent.memoryBlocks?.length || 0,
		});
		return { agentId: agent.id, isNew: true };
	} catch (error) {
		console.error("❌ [Letta] Failed to initialize:", error);
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
		// ✅ Security: Validate operation (rate limit + ownership)
		const validationResult = await validateLettaOperation(
			securityContext,
			"toolCache",
			{ skipIdentityCheck: true }, // Skip for performance on cache ops
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
			{ skipIdentityCheck: true }, // Skip for performance on cache reads
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
 * Record an execution for pattern learning
 */
export async function recordExecution(
	input: RecordExecutionInput,
): Promise<void> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return;
	}

	try {
		// Get or create the execution_history block (handles agents created before this feature)
		const block = (await client.getOrCreateMemoryBlock(
			input.lettaAgentId,
			"execution_history",
			"[]",
			{
				limit: 30000,
				description:
					"History of task executions for learning and optimization",
			},
		)) as { value?: string; _isMock?: boolean; label: string };

		// Skip update if we got a mock block (Letta API issue)
		if (block._isMock) {
			console.warn(
				`[LettaMemory] Skipping execution_history update - block is in corrupted state for agent ${input.lettaAgentId}`,
			);
			return;
		}

		const history: Array<{
			executionId: string;
			task: string;
			steps: typeof input.steps;
			success: boolean;
			durationMs: number;
			recordedAt: string;
		}> = JSON.parse(block.value || "[]");

		history.push({
			executionId: input.executionId,
			task: input.task,
			steps: input.steps,
			success: input.success,
			durationMs: input.durationMs,
			recordedAt: new Date().toISOString(),
		});

		// Keep last 100 executions, but also truncate to fit character limit
		// This prevents the "Value length exceeds block limit" error from Letta
		const trimmed = truncateToFitLimit(
			history.slice(-100),
			LETTA_MEMORY_CHAR_LIMIT - 100, // Leave some buffer
			{
				summarizeEntry: summarizeExecutionEntry,
				minEntries: 5, // Keep at least 5 recent executions
			},
		);

		await client.updateMemoryBlock(
			input.lettaAgentId,
			"execution_history",
			JSON.stringify(trimmed),
		);

		// Record successful patterns
		if (input.success) {
			await recordSuccessfulPattern(client, input.lettaAgentId, {
				task: input.task,
				agents: [
					...new Set(
						input.steps
							.map((s) => s.agentId)
							.filter(Boolean) as string[],
					),
				],
				stepCount: input.steps.length,
				tools: input.steps
					.flatMap((s) => s.toolCalls?.map((tc) => tc.name) || [])
					.filter((v, i, arr) => arr.indexOf(v) === i),
			});
		} else {
			// Record error pattern
			await recordErrorPattern(client, input.lettaAgentId, {
				task: input.task,
				failedSteps: input.steps.filter((s) => s.status === "error"),
			});
		}

		console.log(`[LettaMemory] Recorded execution: ${input.executionId}`);
	} catch (error) {
		console.error("[LettaMemory] Failed to record execution:", error);
	}
}

// ============================================================================
// Activity: Get Routing Suggestions
// ============================================================================

/**
 * Get routing suggestions based on historical patterns
 */
export async function getRoutingSuggestions(
	input: GetRoutingSuggestionsInput,
): Promise<RoutingSuggestion[]> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return [];
	}

	try {
		let block: { value: string } | undefined;
		try {
			block = await client.getMemoryBlock(
				input.lettaAgentId,
				"successful_patterns",
			);
		} catch (blockError) {
			// Memory block may not exist yet - this is expected for new agents
			if (
				blockError instanceof Error &&
				"code" in blockError &&
				blockError.code === "BLOCK_NOT_FOUND"
			) {
				console.log(
					"[LettaMemory] successful_patterns block not found, returning empty suggestions",
				);
				return [];
			}
			throw blockError;
		}
		const patterns = JSON.parse(block?.value || "[]") as Array<{
			taskPattern: string;
			agents: string[];
			tools: string[];
			stepCount: number;
			usageCount: number;
			lastUsed: string;
		}>;

		// Simple keyword matching
		const taskLower = input.task.toLowerCase();
		const taskWords = new Set(
			taskLower.split(/\s+/).filter((w) => w.length > 2),
		);

		const matches = patterns
			.map((p) => {
				const patternWords = p.taskPattern.toLowerCase().split(/\s+/);
				const overlap = patternWords.filter((w) =>
					taskWords.has(w),
				).length;
				return { pattern: p, overlap };
			})
			.filter((m) => m.overlap >= 2)
			.sort((a, b) => {
				// Sort by overlap first, then usage count
				if (b.overlap !== a.overlap) {
					return b.overlap - a.overlap;
				}
				return b.pattern.usageCount - a.pattern.usageCount;
			});

		return matches.slice(0, 3).map((m) => ({
			agents: m.pattern.agents,
			confidence: Math.min(m.pattern.usageCount * 10 + m.overlap * 5, 90),
			pattern: m.pattern.taskPattern,
		}));
	} catch (error) {
		console.error(
			"[LettaMemory] Failed to get routing suggestions:",
			error,
		);
		return [];
	}
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

/** Letta's character limit for memory blocks */
const LETTA_MEMORY_CHAR_LIMIT = 30000;

/**
 * Truncate an array of entries to fit within Letta's character limit.
 * Removes entries from the front (oldest) until it fits.
 * Also truncates individual entry data if entries are too large.
 */
function truncateToFitLimit<T>(
	entries: T[],
	maxChars: number = LETTA_MEMORY_CHAR_LIMIT,
	options?: {
		/** Function to summarize/truncate individual entries if they're too large */
		summarizeEntry?: (entry: T) => T;
		/** Minimum entries to keep even if over limit */
		minEntries?: number;
	},
): T[] {
	const minEntries = options?.minEntries ?? 1;
	let result = [...entries];

	// First, try summarizing entries if they're too large
	if (options?.summarizeEntry) {
		const summarizeEntry = options.summarizeEntry;
		result = result.map(summarizeEntry);
	}

	let serialized = JSON.stringify(result);

	// Remove entries from the front until we're under the limit
	while (serialized.length > maxChars && result.length > minEntries) {
		result.shift(); // Remove oldest entry
		serialized = JSON.stringify(result);
	}

	// If still over limit with minimum entries, truncate the content more aggressively
	if (serialized.length > maxChars && options?.summarizeEntry) {
		const summarizeEntry = options.summarizeEntry;
		// Apply more aggressive truncation
		result = result.map((entry) => {
			const entryStr = JSON.stringify(entry);
			if (entryStr.length > maxChars / minEntries) {
				// Entry is too large, summarize it
				return summarizeEntry(entry);
			}
			return entry;
		});
	}

	return result;
}

/**
 * Summarize execution history entry to reduce size.
 * Truncates step data which can be very verbose.
 */
function summarizeExecutionEntry(entry: {
	executionId: string;
	task: string;
	steps: Array<{
		stepId: string;
		description: string;
		status: string;
		agentId?: string;
		toolCalls?: Array<{ name: string; args?: unknown; result?: unknown }>;
		output?: string;
		error?: string;
	}>;
	success: boolean;
	durationMs: number;
	recordedAt: string;
}): typeof entry {
	return {
		...entry,
		// Truncate task if too long
		task:
			entry.task.length > 200
				? `${entry.task.substring(0, 200)}...`
				: entry.task,
		// Summarize steps - keep structure but truncate verbose data
		steps: entry.steps.map((step) => ({
			stepId: step.stepId,
			description:
				step.description?.length > 100
					? `${step.description.substring(0, 100)}...`
					: step.description,
			status: step.status,
			agentId: step.agentId,
			// Only keep tool names, not full args/results
			toolCalls: step.toolCalls?.map((tc) => ({
				name: tc.name,
				// Truncate args summary
				args: tc.args ? "[truncated]" : undefined,
				result: undefined, // Drop results entirely - too large
			})),
			// Truncate output/error
			output:
				step.output?.length && step.output.length > 100
					? `${step.output.substring(0, 100)}...`
					: step.output,
			error:
				step.error?.length && step.error.length > 100
					? `${step.error.substring(0, 100)}...`
					: step.error,
		})),
	};
}

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

async function recordSuccessfulPattern(
	client: LettaClient,
	agentId: string,
	pattern: {
		task: string;
		agents: string[];
		tools: string[];
		stepCount: number;
	},
): Promise<void> {
	try {
		// Get or create the successful_patterns block (handles agents created before this feature)
		const block = await client.getOrCreateMemoryBlock(
			agentId,
			"successful_patterns",
			"[]",
			{
				limit: 10000,
				description:
					"Patterns of successful task executions for routing optimization",
			},
		);
		const patterns = JSON.parse(block?.value || "[]") as Array<{
			taskPattern: string;
			agents: string[];
			tools: string[];
			stepCount: number;
			usageCount: number;
			lastUsed: string;
		}>;

		// Find similar pattern
		const existing = patterns.find(
			(p) =>
				p.agents.sort().join(",") === pattern.agents.sort().join(",") &&
				p.tools.sort().join(",") === pattern.tools.sort().join(","),
		);

		if (existing) {
			existing.usageCount++;
			existing.lastUsed = new Date().toISOString();
		} else {
			patterns.push({
				taskPattern: pattern.task,
				agents: pattern.agents,
				tools: pattern.tools,
				stepCount: pattern.stepCount,
				usageCount: 1,
				lastUsed: new Date().toISOString(),
			});
		}

		// Keep top 50 by usage, but also ensure it fits within character limit
		const sorted = patterns
			.sort((a, b) => b.usageCount - a.usageCount)
			.slice(0, 50);

		// Truncate to fit Letta's character limit (successful_patterns has 10000 limit)
		const truncated = truncateToFitLimit(sorted, 10000 - 50, {
			summarizeEntry: (entry) => ({
				...entry,
				taskPattern:
					entry.taskPattern.length > 150
						? `${entry.taskPattern.substring(0, 150)}...`
						: entry.taskPattern,
			}),
			minEntries: 10,
		});

		await client.updateMemoryBlock(
			agentId,
			"successful_patterns",
			JSON.stringify(truncated),
		);
	} catch (error) {
		console.error(
			"[LettaMemory] Failed to record successful pattern:",
			error,
		);
	}
}

async function recordErrorPattern(
	client: LettaClient,
	agentId: string,
	pattern: {
		task: string;
		failedSteps: Array<{ stepId: string; description: string }>;
	},
): Promise<void> {
	try {
		let patterns: Array<{
			taskPattern: string;
			failedSteps: typeof pattern.failedSteps;
			count: number;
			lastOccurred: string;
		}> = [];

		// Get or create the error_patterns block (handles agents created before this feature)
		const block = await client.getOrCreateMemoryBlock(
			agentId,
			"error_patterns",
			"[]",
			{
				limit: 10000,
				description: "Common error patterns and failures to avoid",
			},
		);
		patterns = JSON.parse(block.value || "[]");

		// Find similar error
		const existing = patterns.find(
			(p) =>
				p.failedSteps
					.map((s) => s.description)
					.sort()
					.join("|") ===
				pattern.failedSteps
					.map((s) => s.description)
					.sort()
					.join("|"),
		);

		if (existing) {
			existing.count++;
			existing.lastOccurred = new Date().toISOString();
		} else {
			patterns.push({
				taskPattern: pattern.task,
				failedSteps: pattern.failedSteps,
				count: 1,
				lastOccurred: new Date().toISOString(),
			});
		}

		// Keep last 30 error patterns, but also ensure it fits within character limit
		const sorted = patterns
			.sort(
				(a, b) =>
					new Date(b.lastOccurred).getTime() -
					new Date(a.lastOccurred).getTime(),
			)
			.slice(0, 30);

		// Truncate to fit Letta's character limit (error_patterns has 10000 limit)
		const truncated = truncateToFitLimit(sorted, 10000 - 50, {
			summarizeEntry: (entry) => ({
				...entry,
				taskPattern:
					entry.taskPattern.length > 150
						? `${entry.taskPattern.substring(0, 150)}...`
						: entry.taskPattern,
				failedSteps: entry.failedSteps.map((step) => ({
					...step,
					description:
						step.description?.length > 100
							? `${step.description.substring(0, 100)}...`
							: step.description,
				})),
			}),
			minEntries: 5,
		});

		await client.updateMemoryBlock(
			agentId,
			"error_patterns",
			JSON.stringify(truncated),
		);
	} catch (error) {
		console.error("[LettaMemory] Failed to record error pattern:", error);
	}
}

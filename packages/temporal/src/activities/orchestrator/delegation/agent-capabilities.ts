/**
 * Agent Capabilities Module
 *
 * Provides functions for fetching and analyzing agent capabilities.
 * Used to determine if an agent is a generalist that can handle complete tasks.
 *
 * CACHING STRATEGY (two-level):
 *
 * L1 — In-memory Map (30s TTL):
 *   Avoids redundant DB reads within the same workflow execution / worker process.
 *   Lost on worker restart, so it is purely a performance micro-cache.
 *
 * L2 — Database (5-minute TTL, stored in RegisteredAgent.metadata.agentCard):
 *   Persists across worker restarts and deployments. The health monitor
 *   proactively refreshes this cache after every successful health check.
 *   On an L1 miss we read from here; only fetch from the live agent when
 *   the DB entry is missing or older than DB_CACHE_TTL_MS.
 */

import { A2AClient } from "@repo/agent-core";
import {
	getRegisteredAgentByAgentId,
	updateAgentCardCache,
} from "@repo/database";
import { CacheKeys, CacheTTL, RedisCache } from "../../../lib/redis-cache";
import type { AgentCardCapabilities, AgentCategory } from "../types";
import { resolveAgentEndpoint } from "./resolve-endpoint";

// A2A client instance for inter-agent communication
const a2aClient = new A2AClient({ timeout: 120000 });

// =============================================================================
// Cache constants
// =============================================================================

/** L1: in-memory micro-cache TTL — survives within a single worker process */
const MEMORY_CACHE_TTL_MS = 30_000; // 30 seconds

/** L2: DB-backed persistent cache TTL */
const DB_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// =============================================================================
// L1 in-memory cache
// =============================================================================

interface MemoryCacheEntry {
	data: AgentCardCapabilities;
	expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();

function getFromMemoryCache(agentId: string): AgentCardCapabilities | null {
	const entry = memoryCache.get(agentId);
	if (!entry) {
		return null;
	}
	if (Date.now() > entry.expiresAt) {
		memoryCache.delete(agentId);
		return null;
	}
	return entry.data;
}

function setInMemoryCache(agentId: string, data: AgentCardCapabilities): void {
	memoryCache.set(agentId, {
		data,
		expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
	});
}

// =============================================================================
// Capability building helpers
// =============================================================================

/**
 * Build an AgentCardCapabilities object from a raw agent card JSON value.
 * This is the single place that does the field mapping so both the live-fetch
 * path and the DB-cache path stay consistent.
 */
function buildCapabilitiesFromCard(
	agentId: string,
	agentCard: Record<string, any>,
): AgentCardCapabilities {
	const capabilities = (agentCard.capabilities || {}) as Record<
		string,
		unknown
	>;

	return {
		// Core autonomy capabilities
		autonomousExecution: capabilities.autonomousExecution as
			| boolean
			| undefined,
		taskDecomposition: capabilities.taskDecomposition as
			| boolean
			| undefined,
		contextPreservation: capabilities.contextPreservation as
			| boolean
			| undefined,
		maxAutonomyLevel: capabilities.maxAutonomyLevel as
			| "step"
			| "task"
			| "session"
			| undefined,

		// Execution capabilities
		codeExecution: capabilities.codeExecution as boolean | undefined,
		browserAutomation: capabilities.browserAutomation as
			| boolean
			| undefined,
		apiOrchestration: capabilities.apiOrchestration as boolean | undefined,
		fileOperations: capabilities.fileOperations as boolean | undefined,

		// Memory and learning
		memoryEnabled: capabilities.memoryEnabled as boolean | undefined,
		learningEnabled: capabilities.learningEnabled as boolean | undefined,

		// Security and isolation
		multiTenancyAware: capabilities.multiTenancyAware as
			| boolean
			| undefined,
		sandboxed: capabilities.sandboxed as boolean | undefined,

		// MCP and resource access
		hasMcpAccess: (capabilities.hasMcpAccess as boolean) ?? false,
		mcpToolAccess: capabilities.mcpToolAccess as string[] | undefined,
		hasWorkspaceAccess:
			(capabilities.hasWorkspaceAccess as boolean) ?? false,
		canDelegateToAgents:
			(capabilities.canDelegateToAgents as boolean) ?? false,
		hasFabricResourceAccess:
			(capabilities.hasFabricResourceAccess as boolean) ?? false,

		// Agent skills and tags from agent card
		skills: agentCard.skills?.map(
			(skill: {
				id: string;
				name: string;
				description?: string;
				tags?: string[];
			}) => ({
				id: skill.id,
				name: skill.name,
				description: skill.description,
				tags: skill.tags,
			}),
		),
		tags: agentCard.tags,

		// Limitations from agent card (or inferred)
		limitations: inferLimitations(
			agentId,
			capabilities,
			agentCard as { limitations?: string[] },
		),

		// Categories from agent card (or inferred)
		categories: inferCategories(
			agentId,
			capabilities,
			agentCard as { categories?: AgentCategory[] },
		),
	};
}

// =============================================================================
// Main export
// =============================================================================

/**
 * Fetches the agent card from the agent's A2A endpoint and extracts capabilities.
 *
 * Uses a two-level cache strategy:
 * - L1 (in-memory, 30 s): avoids redundant DB reads within the same process
 * - L2 (database, 5 min): persists across worker restarts
 *
 * The live agent card is only fetched when both caches are cold or stale.
 *
 * NOTE: If the agent card cannot be fetched and there is no DB cache entry,
 * returns null. Agents MUST expose proper agent cards for orchestrator routing.
 */
export async function getAgentCapabilities(
	agentId: string,
	userId: string,
	organizationId?: string,
): Promise<AgentCardCapabilities | null> {
	console.log(`[Orchestrator] Fetching agent capabilities for: ${agentId}`);

	// -----------------------------------------------------------------------
	// L1: check in-memory micro-cache
	// -----------------------------------------------------------------------
	const l1Hit = getFromMemoryCache(agentId);
	if (l1Hit) {
		console.log(
			`[Orchestrator] L1 cache hit for agent capabilities: ${agentId}`,
		);
		return l1Hit;
	}

	// -----------------------------------------------------------------------
	// L1.5: check Redis cache (faster than DB, persists across worker restarts)
	// -----------------------------------------------------------------------
	const redisCard = await RedisCache.get<Record<string, unknown>>(
		CacheKeys.agentCard(agentId),
	);
	if (redisCard) {
		console.log(
			`[Orchestrator] Redis cache hit for agent capabilities: ${agentId}`,
		);
		const result = buildCapabilitiesFromCard(agentId, redisCard);
		// Populate L1 so subsequent calls within this execution skip Redis
		setInMemoryCache(agentId, result);
		// Refresh Redis TTL opportunistically
		RedisCache.set(
			CacheKeys.agentCard(agentId),
			redisCard,
			CacheTTL.agentCard,
		).catch(() => {});
		return result;
	}

	// -----------------------------------------------------------------------
	// L2: check DB cache
	// -----------------------------------------------------------------------
	const registeredAgent = await getRegisteredAgentByAgentId(agentId);

	if (registeredAgent) {
		const metadata =
			(registeredAgent.metadata as Record<string, unknown> | null) ?? {};

		const cachedCard = metadata.agentCard as
			| Record<string, unknown>
			| undefined;
		const cachedAtStr = metadata.agentCardCachedAt as string | undefined;

		if (cachedCard && cachedAtStr) {
			const cachedAt = new Date(cachedAtStr).getTime();
			const ageMs = Date.now() - cachedAt;

			if (ageMs < DB_CACHE_TTL_MS) {
				console.log(
					`[Orchestrator] L2 DB cache hit for agent capabilities: ${agentId} ` +
						`(age: ${Math.round(ageMs / 1000)}s)`,
				);
				const result = buildCapabilitiesFromCard(agentId, cachedCard);
				// Populate L1 so subsequent calls within this execution skip the DB
				setInMemoryCache(agentId, result);
				// Backfill Redis so subsequent calls skip the DB read entirely
				RedisCache.set(
					CacheKeys.agentCard(agentId),
					cachedCard,
					CacheTTL.agentCard,
				).catch(() => {});
				return result;
			}

			console.log(
				`[Orchestrator] L2 DB cache stale for agent: ${agentId} ` +
					`(age: ${Math.round(ageMs / 1000)}s > ${DB_CACHE_TTL_MS / 1000}s TTL), refreshing`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// Cache miss — fetch from live agent
	// -----------------------------------------------------------------------
	const agent = await resolveAgentEndpoint(agentId, userId, organizationId);
	if (!agent) {
		console.warn(
			`[Orchestrator] Cannot fetch capabilities - agent not found: ${agentId}`,
		);
		return null;
	}

	try {
		// Fetch agent card from A2A endpoint
		const agentCard = await a2aClient.getAgentCard(agent.deploymentUrl);

		if (!agentCard) {
			console.warn(
				`[Orchestrator] No agent card returned for: ${agentId}. ` +
					"Agent should expose /.well-known/agent.json",
			);
			return null;
		}

		// Build capabilities from the fresh agent card
		// Cast to Record for flexible property access since A2A AgentCapabilities
		// type may not include all our extended properties
		const agentCardRecord = agentCard as unknown as Record<string, unknown>;
		const result = buildCapabilitiesFromCard(agentId, agentCardRecord);

		// Persist to L2 DB cache (fire-and-forget — don't let a DB failure
		// block capability resolution)
		const now = new Date();
		updateAgentCardCache(agentId, agentCardRecord, now).catch((err) => {
			console.warn(
				`[Orchestrator] Failed to persist agent card cache for ${agentId}:`,
				err,
			);
		});

		// Populate L1
		setInMemoryCache(agentId, result);

		const isGeneralist =
			result.autonomousExecution && result.taskDecomposition;

		console.log(`[Orchestrator] Agent ${agentId} capabilities:`, {
			isGeneralist,
			maxAutonomyLevel: result.maxAutonomyLevel,
			codeExecution: result.codeExecution,
			browserAutomation: result.browserAutomation,
			apiOrchestration: result.apiOrchestration,
			hasMcpAccess: result.hasMcpAccess,
			hasWorkspaceAccess: result.hasWorkspaceAccess,
			skillCount: result.skills?.length || 0,
			tags: result.tags?.slice(0, 5),
			limitations: result.limitations,
		});

		return result;
	} catch (error) {
		console.error(
			`[Orchestrator] Failed to fetch agent card for ${agentId}:`,
			error,
		);
		return null;
	}
}

/**
 * Infer limitations from capabilities if not explicitly provided.
 */
function inferLimitations(
	agentId: string,
	capabilities: Record<string, unknown>,
	agentCard: { limitations?: string[] },
): string[] {
	// If agent card provides limitations, use them
	if (agentCard.limitations && agentCard.limitations.length > 0) {
		return agentCard.limitations;
	}

	// Otherwise, infer limitations from capabilities
	const limitations: string[] = [];

	if (!capabilities.hasMcpAccess) {
		limitations.push("Cannot access MCP tools");
	}

	if (!capabilities.hasWorkspaceAccess) {
		limitations.push("Cannot access Fabric workspaces or documents");
	}

	if (!capabilities.canDelegateToAgents) {
		limitations.push("Cannot delegate to other agents");
	}

	if (!capabilities.hasFabricResourceAccess) {
		limitations.push("Cannot access Fabric resources (RAG, embeddings)");
	}

	// Special case for known agent patterns
	if (agentId.includes("cuga") || agentId.includes("generalist")) {
		// CUGA-like agents typically can't access MCP or workspaces
		if (!limitations.includes("Cannot access MCP tools")) {
			limitations.push("Cannot access MCP tools");
		}
		if (
			!limitations.includes(
				"Cannot access Fabric workspaces or documents",
			)
		) {
			limitations.push("Cannot access Fabric workspaces or documents");
		}
	}

	return limitations;
}

/**
 * Infer categories from capabilities and agent ID.
 */
function inferCategories(
	agentId: string,
	capabilities: Record<string, unknown>,
	agentCard: { categories?: AgentCategory[] },
): AgentCategory[] {
	// If agent card provides categories, use them
	if (agentCard.categories && agentCard.categories.length > 0) {
		return agentCard.categories;
	}

	// Otherwise, infer categories
	const categories: AgentCategory[] = [];
	const agentIdLower = agentId.toLowerCase();

	if (
		agentIdLower.includes("document") ||
		agentIdLower.includes("generator") ||
		agentIdLower.includes("prd")
	) {
		categories.push("document_generation");
	}

	if (
		agentIdLower.includes("task") ||
		agentIdLower.includes("planner") ||
		agentIdLower.includes("planning")
	) {
		categories.push("task_planning");
	}

	if (capabilities.codeExecution) {
		categories.push("code_execution");
	}

	if (capabilities.browserAutomation) {
		categories.push("browser_automation");
	}

	if (agentIdLower.includes("api") || capabilities.apiOrchestration) {
		categories.push("api_integration");
	}

	if (agentIdLower.includes("research")) {
		categories.push("research");
	}

	// If no specific category, mark as general
	if (categories.length === 0) {
		categories.push("general");
	}

	return categories;
}

/**
 * Check if an agent can handle a task that requires specific access.
 */
export function canAgentHandleTask(
	capabilities: AgentCardCapabilities | undefined,
	requirements: {
		needsMcpAccess?: boolean;
		needsWorkspaceAccess?: boolean;
		needsBrowserAutomation?: boolean;
		needsCodeExecution?: boolean;
		needsDelegation?: boolean;
	},
): { canHandle: boolean; missingCapabilities: string[] } {
	if (!capabilities) {
		return {
			canHandle: false,
			missingCapabilities: ["Unknown capabilities"],
		};
	}

	const missing: string[] = [];

	if (requirements.needsMcpAccess && !capabilities.hasMcpAccess) {
		missing.push("MCP tool access");
	}

	if (requirements.needsWorkspaceAccess && !capabilities.hasWorkspaceAccess) {
		missing.push("Workspace access");
	}

	if (
		requirements.needsBrowserAutomation &&
		!capabilities.browserAutomation
	) {
		missing.push("Browser automation");
	}

	if (requirements.needsCodeExecution && !capabilities.codeExecution) {
		missing.push("Code execution");
	}

	if (requirements.needsDelegation && !capabilities.canDelegateToAgents) {
		missing.push("Agent delegation");
	}

	return {
		canHandle: missing.length === 0,
		missingCapabilities: missing,
	};
}

/**
 * Checks if an agent has a specific skill or capability based on tags and skills.
 */
export function agentHasCapability(
	capabilities: AgentCardCapabilities | undefined,
	capability: string,
): boolean {
	if (!capabilities) {
		return false;
	}

	const capabilityLower = capability.toLowerCase();

	// Check direct capability flags
	const capabilityMap: Record<string, boolean | undefined> = {
		code: capabilities.codeExecution,
		"code-execution": capabilities.codeExecution,
		browser: capabilities.browserAutomation,
		"browser-automation": capabilities.browserAutomation,
		api: capabilities.apiOrchestration,
		"api-orchestration": capabilities.apiOrchestration,
		file: capabilities.fileOperations,
		"file-operations": capabilities.fileOperations,
		memory: capabilities.memoryEnabled,
		learning: capabilities.learningEnabled,
		autonomous: capabilities.autonomousExecution,
		"task-decomposition": capabilities.taskDecomposition,
		planning: capabilities.taskDecomposition,
		mcp: capabilities.hasMcpAccess,
		"mcp-access": capabilities.hasMcpAccess,
		workspace: capabilities.hasWorkspaceAccess,
		"workspace-access": capabilities.hasWorkspaceAccess,
		delegation: capabilities.canDelegateToAgents,
		"can-delegate": capabilities.canDelegateToAgents,
	};

	if (capabilityMap[capabilityLower] !== undefined) {
		return !!capabilityMap[capabilityLower];
	}

	// Check tags
	if (
		capabilities.tags?.some((tag) =>
			tag.toLowerCase().includes(capabilityLower),
		)
	) {
		return true;
	}

	// Check skills
	if (
		capabilities.skills?.some(
			(skill) =>
				skill.id.toLowerCase().includes(capabilityLower) ||
				skill.name.toLowerCase().includes(capabilityLower) ||
				skill.tags?.some((tag) =>
					tag.toLowerCase().includes(capabilityLower),
				),
		)
	) {
		return true;
	}

	return false;
}

/**
 * Determines if an agent is suitable for a given task based on capabilities.
 */
export function isAgentSuitableForTask(
	capabilities: AgentCardCapabilities | undefined,
	taskDescription: string,
): { suitable: boolean; confidence: number; reasoning: string } {
	if (!capabilities) {
		return {
			suitable: false,
			confidence: 0,
			reasoning: "No capability information available for agent",
		};
	}

	const taskLower = taskDescription.toLowerCase();
	let matchScore = 0;
	const matchReasons: string[] = [];

	// Check for browser-related tasks
	if (
		taskLower.includes("browser") ||
		taskLower.includes("web") ||
		taskLower.includes("scrape") ||
		taskLower.includes("navigate")
	) {
		if (capabilities.browserAutomation) {
			matchScore += 30;
			matchReasons.push("Has browser automation capability");
		} else {
			matchScore -= 20;
			matchReasons.push("Missing browser automation capability");
		}
	}

	// Check for code-related tasks
	if (
		taskLower.includes("code") ||
		taskLower.includes("script") ||
		taskLower.includes("execute") ||
		taskLower.includes("run")
	) {
		if (capabilities.codeExecution) {
			matchScore += 30;
			matchReasons.push("Has code execution capability");
		} else {
			matchScore -= 20;
			matchReasons.push("Missing code execution capability");
		}
	}

	// Check for API-related tasks
	if (
		taskLower.includes("api") ||
		taskLower.includes("fetch") ||
		taskLower.includes("request") ||
		taskLower.includes("endpoint")
	) {
		if (capabilities.apiOrchestration) {
			matchScore += 25;
			matchReasons.push("Has API orchestration capability");
		}
	}

	// Check for MCP tool-related tasks
	if (
		taskLower.includes("fizzy") ||
		taskLower.includes("slack") ||
		taskLower.includes("github") ||
		taskLower.includes("mcp")
	) {
		if (capabilities.hasMcpAccess) {
			matchScore += 30;
			matchReasons.push("Has MCP tool access");
		} else {
			matchScore -= 30;
			matchReasons.push("Cannot access MCP tools");
		}
	}

	// Check for workspace-related tasks
	if (
		taskLower.includes("workspace") ||
		taskLower.includes("document") ||
		taskLower.includes("project")
	) {
		if (capabilities.hasWorkspaceAccess) {
			matchScore += 25;
			matchReasons.push("Has workspace access");
		} else {
			matchScore -= 15;
			matchReasons.push("Limited workspace access");
		}
	}

	// Check for complex multi-step tasks
	if (
		taskLower.includes("plan") ||
		taskLower.includes("analyze") ||
		taskLower.includes("research") ||
		taskDescription.length > 200
	) {
		if (capabilities.taskDecomposition) {
			matchScore += 25;
			matchReasons.push("Has task decomposition for complex tasks");
		}
	}

	// Bonus for autonomous execution on complex tasks
	if (
		capabilities.autonomousExecution &&
		capabilities.maxAutonomyLevel === "task"
	) {
		matchScore += 15;
		matchReasons.push("Can handle complete tasks autonomously");
	}

	// Normalize score to 0-100
	const confidence = Math.max(0, Math.min(100, 50 + matchScore));

	return {
		suitable: confidence >= 50,
		confidence,
		reasoning: matchReasons.join("; ") || "General capability match",
	};
}

/**
 * Determines the optimal delegation strategy based on agent capabilities and task characteristics.
 */
export function determineDelegationStrategy(
	capabilities: AgentCardCapabilities | undefined,
	_taskDescription: string,
): {
	delegationMode: "complete-task" | "single-step";
	shouldDecompose: boolean;
	reasoning: string;
} {
	// Default to single-step for unknown agents
	if (!capabilities) {
		return {
			delegationMode: "single-step",
			shouldDecompose: true,
			reasoning:
				"Unknown agent capabilities - using conservative single-step delegation",
		};
	}

	const isGeneralist =
		capabilities.autonomousExecution && capabilities.taskDecomposition;
	const hasTaskAutonomy =
		capabilities.maxAutonomyLevel === "task" ||
		capabilities.maxAutonomyLevel === "session";

	// Generalist agents with task-level autonomy get complete-task delegation
	if (isGeneralist && hasTaskAutonomy) {
		return {
			delegationMode: "complete-task",
			shouldDecompose: false,
			reasoning: `Generalist agent with ${capabilities.maxAutonomyLevel}-level autonomy - delegating complete task`,
		};
	}

	// Agents with autonomous execution but limited autonomy level
	if (capabilities.autonomousExecution && !hasTaskAutonomy) {
		return {
			delegationMode: "single-step",
			shouldDecompose: true,
			reasoning: `Agent has autonomous execution but limited autonomy (${capabilities.maxAutonomyLevel || "step"}) - orchestrator will decompose`,
		};
	}

	// Simple agents without autonomous execution
	return {
		delegationMode: "single-step",
		shouldDecompose: true,
		reasoning:
			"Simple agent without autonomous execution - orchestrator will decompose and provide step-by-step instructions",
	};
}

/**
 * Invalidate cached capabilities for an agent.
 * Clears both the L1 in-memory cache and signals that the L2 DB cache
 * should be considered stale on next read (by removing the L1 entry so
 * callers will re-evaluate freshness against the DB).
 */
export function invalidateAgentCapabilities(agentId: string): boolean {
	return memoryCache.delete(agentId);
}

/**
 * Clear all cached capabilities from the L1 in-memory cache.
 * Call this for a full refresh within the current process.
 */
export function clearCapabilityCache(): void {
	memoryCache.clear();
}

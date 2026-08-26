/**
 * Capability Registry
 *
 * Discovers and manages all available capabilities (agents, tools, workflows)
 * that the orchestrator can use. Provides unified capability matching with
 * support for both keyword-based (BM25) and semantic (embedding) matching.
 */

import { closeMcpClientSafe, getMcpClient } from "@repo/agent-core/backend";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { getAgentCapabilities } from "../delegation/agent-capabilities";
import {
	cosineSimilarity,
	getOrGenerateEmbedding,
	getOrGenerateEmbeddings,
	hybridScore,
} from "../tools/capability-embeddings";
import type {
	AgentCardCapabilities,
	Capability,
	CapabilityMatch,
	DiscoverCapabilitiesInput,
	InformationNeed,
} from "../types";

/**
 * Discovers all available capabilities for the orchestrator.
 *
 * This includes:
 * - Registered agents from database
 * - MCP tools from configured servers
 * - (Future) Workflows and integrations
 */
export async function discoverCapabilities(
	input: DiscoverCapabilitiesInput,
): Promise<Capability[]> {
	console.log("[Orchestrator] Discovering capabilities");
	const capabilities: Capability[] = [];

	// Discover agents
	const agentCapabilities = await discoverAgentCapabilities(input);
	capabilities.push(...agentCapabilities);

	// Discover MCP tools
	const toolCapabilities = await discoverMcpToolCapabilities(input);
	capabilities.push(...toolCapabilities);

	console.log("[Orchestrator] Discovered capabilities", {
		agents: agentCapabilities.length,
		tools: toolCapabilities.length,
		total: capabilities.length,
	});

	return capabilities;
}

/**
 * Discover agent capabilities from database.
 */
async function discoverAgentCapabilities(
	input: DiscoverCapabilitiesInput,
): Promise<Capability[]> {
	const capabilities: Capability[] = [];

	try {
		const agents = await db.registeredAgent.findMany({
			where: {
				status: "ACTIVE",
				OR: [
					{ scope: "SYSTEM" },
					{ scope: "USER", userId: input.userId },
					...(input.organizationId
						? [
								{
									scope: "ORGANIZATION",
									organizationId: input.organizationId,
								},
							]
						: []),
				],
			},
		});

		// Filter by enabled agent IDs if provided
		const filteredAgents = input.enabledAgentIds
			? agents.filter((a) => input.enabledAgentIds?.includes(a.agentId))
			: agents;

		for (const agent of filteredAgents) {
			const metadata = agent.metadata as Record<string, unknown> | null;
			const skills =
				(metadata?.skills as Array<{
					name: string;
					description?: string;
				}>) || [];
			const tags = (metadata?.tags as string[]) || [];

			// Get detailed capabilities
			let agentCardCaps: AgentCardCapabilities | undefined;
			try {
				const caps = await getAgentCapabilities(
					agent.agentId,
					input.userId,
					input.organizationId,
				);
				agentCardCaps = caps ?? undefined;
			} catch (_e) {
				// Non-critical - continue without detailed capabilities
			}

			capabilities.push({
				id: agent.agentId,
				type: "agent",
				name: agent.displayName,
				description: agent.description || "",
				skills: [
					...skills.map((s) => s.name),
					...tags,
					...(agent.description
						?.split(" ")
						.filter((w) => w.length > 4) || []),
				],
				inputTypes: ["text", "context"],
				outputTypes: ["text", "artifacts"],
				riskLevel: determineAgentRisk(agent, agentCardCaps),
				requiresApproval: shouldAgentRequireApproval(
					agent,
					agentCardCaps,
				),
				isAvailable: true,
				healthStatus: "healthy",
				agentCapabilities: agentCardCaps,
			});
		}
	} catch (error) {
		console.error("[Orchestrator] Failed to discover agents:", error);
	}

	return capabilities;
}

/**
 * Discover MCP tool capabilities.
 */
async function discoverMcpToolCapabilities(
	input: DiscoverCapabilitiesInput,
): Promise<Capability[]> {
	const capabilities: Capability[] = [];

	try {
		// XOR PATTERN: Strict tenant isolation
		// Personal MCP configs are NEVER visible in org context and vice versa
		const tenantFilter = input.organizationId
			? { organizationId: input.organizationId } // Org context: only org configs
			: { userId: input.userId, organizationId: null }; // Personal: explicit null check

		const mcpConfigs = await db.mCPConfig.findMany({
			where: {
				...tenantFilter,
				enabled: true,
				...(input.enabledMcpConfigIds
					? { id: { in: input.enabledMcpConfigIds } }
					: {}),
			},
			include: { mcpServer: true },
		});

		for (const config of mcpConfigs) {
			try {
				const result = await getMcpClient(
					config.id,
					input.userId,
					input.organizationId,
				);
				if (!result) {
					continue;
				}

				const { client, serverName } = result;
				const tools = await client.tools();

				for (const [toolName, toolDef] of Object.entries(tools)) {
					const def = toolDef as {
						description?: string;
						inputSchema?: Record<string, unknown>;
					};

					capabilities.push({
						id: `${serverName}:${toolName}`,
						type: "mcp_tool",
						name: toolName,
						description: def.description || "",
						skills: extractToolSkills(toolName, def.description),
						inputTypes: extractInputTypes(def.inputSchema),
						outputTypes: ["json"],
						riskLevel: determineToolRisk(toolName),
						requiresApproval: isWriteTool(toolName),
						isAvailable: true,
						healthStatus: "healthy",
						parameters: def.inputSchema,
					});
				}

				await closeMcpClientSafe(client);
			} catch (e) {
				console.warn(
					`Failed to discover tools from ${config.displayName}:`,
					e,
				);
			}
		}
	} catch (error) {
		console.error("[Orchestrator] Failed to discover MCP tools:", error);
	}

	return capabilities;
}

/**
 * Match capabilities to task needs.
 */
export function matchCapabilities(
	task: string,
	informationNeeds: InformationNeed[],
	capabilities: Capability[],
): CapabilityMatch[] {
	const matches: CapabilityMatch[] = [];
	const taskLower = task.toLowerCase();
	const taskWords = taskLower.split(/\s+/).filter((w) => w.length > 3);

	for (const capability of capabilities) {
		let score = 0;
		const matchedNeeds: string[] = [];

		// Skill matching
		for (const skill of capability.skills) {
			const skillLower = skill.toLowerCase();

			// Direct task match
			if (taskLower.includes(skillLower)) {
				score += 0.3;
			}

			// Word overlap
			for (const word of taskWords) {
				if (skillLower.includes(word)) {
					score += 0.1;
				}
			}
		}

		// Description matching
		if (capability.description) {
			const descLower = capability.description.toLowerCase();
			for (const word of taskWords) {
				if (descLower.includes(word)) {
					score += 0.05;
				}
			}
		}

		// Information need matching
		for (const need of informationNeeds) {
			if (canCapabilityFulfillNeed(capability, need)) {
				matchedNeeds.push(need.description);
				score += need.priority === "required" ? 0.2 : 0.1;
			}
		}

		// Only include meaningful matches
		if (score > 0.2) {
			matches.push({
				capability,
				score: Math.min(score, 1),
				matchedNeeds,
				suggestedUse: suggestUsage(capability, task),
			});
		}
	}

	// Sort by score descending
	return matches.sort((a, b) => b.score - a.score);
}

// =============================================================================
// Semantic Capability Matching
// =============================================================================

export interface SemanticMatchOptions {
	/** Minimum hybrid score to include (0-1) */
	minConfidence?: number;
	/** Maximum number of matches to return */
	limit?: number;
	/** Weight for BM25 keyword matching (default: 0.4) */
	bm25Weight?: number;
	/** Weight for embedding similarity (default: 0.6) */
	embeddingWeight?: number;
	/** User ID for multi-tenant embedding requests */
	userId?: string;
	/** Organization ID for multi-tenant embedding requests */
	organizationId?: string;
	/** API key for AI Gateway */
	apiKey: string;
}

/**
 * Match capabilities to task using semantic (embedding-based) matching.
 * Combines BM25 keyword scores with embedding cosine similarity.
 *
 * This is more accurate than pure keyword matching as it understands
 * semantic similarity (e.g., "create ticket" matches "add issue").
 */
export async function matchCapabilitiesSemantic(
	task: string,
	informationNeeds: InformationNeed[],
	capabilities: Capability[],
	options: SemanticMatchOptions,
): Promise<CapabilityMatch[]> {
	const {
		minConfidence = 0.3,
		limit = 20,
		bm25Weight = 0.4,
		embeddingWeight = 0.6,
		userId,
		organizationId,
		apiKey,
	} = options;

	if (capabilities.length === 0) {
		return [];
	}

	logger.info(
		`[CapabilityRegistry] Semantic matching for "${task.slice(0, 50)}..." against ${capabilities.length} capabilities`,
	);

	try {
		// 1. Get keyword-based scores (BM25-style)
		const keywordMatches = matchCapabilities(
			task,
			informationNeeds,
			capabilities,
		);
		const keywordScoreMap = new Map(
			keywordMatches.map((m) => [m.capability.id, m.score]),
		);

		// 2. Generate task embedding
		const taskEmbedding = await getOrGenerateEmbedding(
			task,
			`task:${task.slice(0, 100)}`,
			apiKey,
			userId,
			organizationId,
		);

		// 3. Generate capability embeddings in batch
		const capabilityTexts = capabilities.map((cap) => ({
			text: `${cap.name}: ${cap.description}`,
			cacheKey: `capability:${cap.id}`,
		}));

		const capabilityEmbeddings = await getOrGenerateEmbeddings(
			capabilityTexts,
			apiKey,
			userId,
			organizationId,
		);

		// 4. Calculate hybrid scores
		const matches: CapabilityMatch[] = [];

		for (const capability of capabilities) {
			const embedding = capabilityEmbeddings.get(
				`capability:${capability.id}`,
			);
			if (!embedding) {
				continue;
			}

			// Calculate cosine similarity
			const similarity = cosineSimilarity(taskEmbedding, embedding);

			// Get keyword score (from BM25-style matching)
			const keywordScore = keywordScoreMap.get(capability.id) ?? 0;

			// Calculate hybrid score
			const score = hybridScore(keywordScore * 10, similarity, {
				bm25Weight,
				embeddingWeight,
			});

			if (score >= minConfidence) {
				// Get matched needs from keyword matching
				const keywordMatch = keywordMatches.find(
					(m) => m.capability.id === capability.id,
				);

				matches.push({
					capability,
					score,
					matchedNeeds: keywordMatch?.matchedNeeds ?? [],
					suggestedUse: suggestUsage(capability, task),
				});
			}
		}

		// Sort by score and limit
		const sorted = matches
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		logger.info(
			`[CapabilityRegistry] Semantic matching found ${sorted.length} matches (top score: ${sorted[0]?.score?.toFixed(3) ?? "N/A"})`,
		);

		return sorted;
	} catch (error) {
		logger.error(
			"[CapabilityRegistry] Semantic matching failed, falling back to keyword matching:",
			error,
		);
		// Fallback to keyword matching
		return matchCapabilities(task, informationNeeds, capabilities);
	}
}

/**
 * Match capabilities using semantic (embedding-based) matching.
 * This is the default and recommended approach for capability matching.
 *
 * Combines BM25 keyword scores (40%) with embedding similarity (60%)
 * for accurate semantic understanding of task requirements.
 */
export async function matchCapabilitiesHybrid(
	task: string,
	informationNeeds: InformationNeed[],
	capabilities: Capability[],
	options: SemanticMatchOptions,
): Promise<CapabilityMatch[]> {
	// Always use semantic matching - no feature flag needed
	return matchCapabilitiesSemantic(
		task,
		informationNeeds,
		capabilities,
		options,
	);
}

/**
 * Check if a capability can fulfill an information need.
 */
function canCapabilityFulfillNeed(
	capability: Capability,
	need: InformationNeed,
): boolean {
	// Check if any of the need's sources match the capability type
	for (const source of need.sources) {
		if (source === "web" && capability.type === "mcp_tool") {
			const nameLower = capability.name.toLowerCase();
			if (
				nameLower.includes("search") ||
				nameLower.includes("scrape") ||
				nameLower.includes("firecrawl")
			) {
				return true;
			}
		}

		if (source === "agent" && capability.type === "agent") {
			return true;
		}

		if (source === "mcp_tool" && capability.type === "mcp_tool") {
			return true;
		}
	}

	return false;
}

/**
 * Suggest how to use a capability for a task.
 */
function suggestUsage(capability: Capability, _task: string): string {
	if (capability.type === "agent") {
		return `Delegate to ${capability.name} for ${capability.description.slice(0, 50)}...`;
	}

	if (capability.type === "mcp_tool") {
		const nameLower = capability.name.toLowerCase();
		if (nameLower.includes("search")) {
			return "Use for web search and information gathering";
		}
		if (nameLower.includes("scrape")) {
			return "Use to extract content from specific URLs";
		}
		if (nameLower.includes("get") || nameLower.includes("list")) {
			return "Use to retrieve data from external service";
		}
		if (nameLower.includes("create") || nameLower.includes("add")) {
			return "Use to create new resources";
		}
	}

	return `Use for ${capability.description.slice(0, 50)}...`;
}

/**
 * Extract skills from tool name and description.
 */
function extractToolSkills(name: string, description?: string): string[] {
	const skills: string[] = [];
	const nameLower = name.toLowerCase();

	// Extract from name patterns
	if (nameLower.includes("search")) {
		skills.push("search", "find", "query");
	}
	if (nameLower.includes("scrape")) {
		skills.push("scrape", "extract", "crawl");
	}
	if (nameLower.includes("get")) {
		skills.push("read", "fetch", "retrieve");
	}
	if (nameLower.includes("list")) {
		skills.push("list", "enumerate");
	}
	if (nameLower.includes("create")) {
		skills.push("create", "add", "new");
	}
	if (nameLower.includes("update")) {
		skills.push("update", "modify", "change");
	}
	if (nameLower.includes("delete")) {
		skills.push("delete", "remove");
	}

	// Extract keywords from description
	if (description) {
		const words = description.toLowerCase().split(/\s+/);
		for (const word of words) {
			if (word.length > 4 && !skills.includes(word)) {
				skills.push(word);
			}
		}
	}

	return skills.slice(0, 10);
}

/**
 * Extract input types from schema.
 */
function extractInputTypes(schema?: Record<string, unknown>): string[] {
	if (!schema?.properties) {
		return ["unknown"];
	}

	const types: string[] = [];
	const props = schema.properties as Record<string, { type?: string }>;

	for (const [name, prop] of Object.entries(props)) {
		if (prop.type) {
			types.push(`${name}:${prop.type}`);
		}
	}

	return types.length > 0 ? types : ["unknown"];
}

/**
 * Determine agent risk level.
 */
function determineAgentRisk(
	agent: { agentId: string },
	capabilities?: AgentCardCapabilities,
): "low" | "medium" | "high" | "critical" {
	// Generalist agents with code execution are high risk
	if (capabilities?.codeExecution || capabilities?.browserAutomation) {
		return "high";
	}

	// Agents with task-level autonomy are medium-high risk
	if (
		capabilities?.maxAutonomyLevel === "task" ||
		capabilities?.maxAutonomyLevel === "session"
	) {
		return "medium";
	}

	// Document generators are low risk
	if (
		agent.agentId.includes("document") ||
		agent.agentId.includes("generator")
	) {
		return "low";
	}

	return "medium";
}

/**
 * Determine if agent should require approval.
 */
function shouldAgentRequireApproval(
	_agent: { agentId: string },
	capabilities?: AgentCardCapabilities,
): boolean {
	// Code execution always needs approval
	if (capabilities?.codeExecution) {
		return true;
	}

	// Browser automation needs approval
	if (capabilities?.browserAutomation) {
		return true;
	}

	// Task-level autonomy needs approval
	if (
		capabilities?.maxAutonomyLevel === "task" ||
		capabilities?.maxAutonomyLevel === "session"
	) {
		return true;
	}

	return false;
}

/**
 * Determine tool risk level based on name patterns.
 */
function determineToolRisk(
	toolName: string,
): "low" | "medium" | "high" | "critical" {
	const nameLower = toolName.toLowerCase();

	if (nameLower.includes("delete") || nameLower.includes("remove")) {
		return "critical";
	}

	if (
		nameLower.includes("create") ||
		nameLower.includes("add") ||
		nameLower.includes("post")
	) {
		return "high";
	}

	if (
		nameLower.includes("update") ||
		nameLower.includes("modify") ||
		nameLower.includes("patch")
	) {
		return "medium";
	}

	return "low";
}

/**
 * Check if tool is a write operation.
 */
function isWriteTool(toolName: string): boolean {
	const nameLower = toolName.toLowerCase();
	return (
		nameLower.includes("create") ||
		nameLower.includes("add") ||
		nameLower.includes("post") ||
		nameLower.includes("update") ||
		nameLower.includes("modify") ||
		nameLower.includes("patch") ||
		nameLower.includes("delete") ||
		nameLower.includes("remove")
	);
}

/**
 * Get available agents as a simple list.
 */
export async function getAvailableAgentsList(
	userId: string,
	organizationId?: string,
	enabledAgentIds?: string[] | null,
): Promise<Array<{ id: string; name: string; description: string }>> {
	try {
		// XOR PATTERN: Strict tenant isolation
		// Personal agents are NEVER visible in org context and vice versa
		const scopeConditions = organizationId
			? [{ scope: "SYSTEM" }, { scope: "ORGANIZATION", organizationId }] // Org: SYSTEM + ORG only
			: [{ scope: "SYSTEM" }, { scope: "USER", userId }]; // Personal: SYSTEM + USER only

		const agents = await db.registeredAgent.findMany({
			where: {
				status: "ACTIVE",
				OR: scopeConditions,
			},
		});

		const filtered = enabledAgentIds
			? agents.filter((a) => enabledAgentIds.includes(a.agentId))
			: agents;

		return filtered.map((a) => ({
			id: a.agentId,
			name: a.displayName,
			description: a.description || "",
		}));
	} catch (error) {
		console.error("[Orchestrator] Failed to get agents list:", error);
		return [];
	}
}

/**
 * Get available MCP tools as a simple list.
 */
export async function getAvailableMcpToolsList(
	userId: string,
	organizationId?: string,
	enabledMcpConfigIds?: string[] | null,
): Promise<string[]> {
	const tools: string[] = [];

	try {
		// XOR PATTERN: Strict tenant isolation
		// Personal MCP configs are NEVER visible in org context and vice versa
		const tenantFilter = organizationId
			? { organizationId } // Org context: only org configs
			: { userId, organizationId: null }; // Personal: explicit null check

		const mcpConfigs = await db.mCPConfig.findMany({
			where: {
				...tenantFilter,
				enabled: true,
				...(enabledMcpConfigIds
					? { id: { in: enabledMcpConfigIds } }
					: {}),
			},
		});

		for (const config of mcpConfigs) {
			try {
				const result = await getMcpClient(
					config.id,
					userId,
					organizationId,
				);
				if (!result) {
					continue;
				}

				const serverTools = await result.client.tools();
				tools.push(...Object.keys(serverTools));
				await closeMcpClientSafe(result.client);
			} catch (_e) {
				// Skip failed servers
			}
		}
	} catch (error) {
		console.error("[Orchestrator] Failed to get MCP tools list:", error);
	}

	return tools;
}

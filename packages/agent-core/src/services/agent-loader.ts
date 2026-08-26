/**
 * Agent Loader Service
 * Loads agents from database and makes them available to the orchestrator
 * Supports both system agents and dynamically registered external agents
 */

import type { A2AValidationResult } from "../a2a";
import { A2AClient, extractAgentMetadata, validateA2AEndpoint } from "../a2a";
import { globalAgentRegistry } from "../registry";

/**
 * Loaded agent representation - unified view of all agent types
 */
export interface LoadedAgent {
	agentId: string;
	name: string;
	displayName: string;
	description: string;
	framework: string;
	deploymentUrl: string;
	scope: "system" | "organization" | "user";
	capabilities: string[];
	skills: Array<{
		id: string;
		name: string;
		description: string;
	}>;
	tools: string[];
	isExternal: boolean;
	supportsStreaming: boolean;
	status: "active" | "inactive" | "error";
	lastHealthCheck?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Agent context for scoped loading
 */
export interface AgentLoadContext {
	userId: string;
	organizationId?: string;
}

/**
 * Database agent record (matches Prisma schema)
 */
interface DbAgent {
	id: string;
	agentId: string;
	name: string;
	displayName: string;
	description: string | null;
	framework: string;
	deploymentUrl: string | null;
	status: string;
	scope: string;
	config: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	lastHealthCheck: Date | null;
}

/**
 * Cache entry for loaded agents
 */
interface CacheEntry {
	agents: LoadedAgent[];
	expiresAt: number;
}

/**
 * Agent Loader Service
 * Combines system agents from registry with dynamic agents from database
 */
export class AgentLoaderService {
	private cache: Map<string, CacheEntry> = new Map();
	private cacheTtlMs: number;
	private a2aClient: A2AClient;

	constructor(options?: {
		cacheTtlMs?: number;
		a2aClientOptions?: ConstructorParameters<typeof A2AClient>[0];
	}) {
		this.cacheTtlMs = options?.cacheTtlMs ?? 5 * 60 * 1000; // 5 minutes default
		this.a2aClient = new A2AClient(options?.a2aClientOptions);
	}

	/**
	 * Load all agents available to a user (system + org + personal)
	 */
	async loadAgentsForContext(
		context: AgentLoadContext,
		dbLoader: (context: AgentLoadContext) => Promise<DbAgent[]>,
	): Promise<LoadedAgent[]> {
		const cacheKey = `${context.userId}:${context.organizationId || "none"}`;

		// Check cache
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.agents;
		}

		// Load system agents from registry
		const systemAgents = this.loadSystemAgents();

		// Load dynamic agents from database
		const dbAgents = await dbLoader(context);
		const dynamicAgents = dbAgents.map((a) => this.transformDbAgent(a));

		// Merge agents (dynamic can enhance system)
		const merged = this.mergeAgents(systemAgents, dynamicAgents);

		// Update cache
		this.cache.set(cacheKey, {
			agents: merged,
			expiresAt: Date.now() + this.cacheTtlMs,
		});

		return merged;
	}

	/**
	 * Load system agents from the global registry
	 */
	private loadSystemAgents(): LoadedAgent[] {
		const adapters = globalAgentRegistry.getAll();

		return adapters.map((adapter) => ({
			agentId: adapter.name,
			name: adapter.name,
			displayName: adapter.config.displayName || adapter.name,
			description: adapter.config.description || "",
			framework: adapter.framework,
			deploymentUrl: adapter.getDeploymentUrl?.() || "",
			scope: "system" as const,
			capabilities: adapter.config.tags || [],
			skills: [],
			tools: adapter.tools.map((t) => t.function.name),
			isExternal: false,
			supportsStreaming: true,
			status: "active" as const,
			metadata: {
				language: adapter.language,
				version: adapter.config.version,
			},
		}));
	}

	/**
	 * Transform database agent to LoadedAgent format
	 */
	private transformDbAgent(agent: DbAgent): LoadedAgent {
		const config = agent.config || {};
		const metadata = agent.metadata || {};

		return {
			agentId: agent.agentId,
			name: agent.name,
			displayName: agent.displayName,
			description: agent.description || "",
			framework: agent.framework,
			deploymentUrl: agent.deploymentUrl || "",
			scope: agent.scope.toLowerCase() as
				| "system"
				| "organization"
				| "user",
			capabilities: (config.capabilities as string[]) || [],
			skills:
				(config.skills as Array<{
					id: string;
					name: string;
					description: string;
				}>) || [],
			tools: (config.tools as string[]) || [],
			isExternal: !!agent.deploymentUrl,
			supportsStreaming: (config.supportsStreaming as boolean) ?? false,
			status: agent.status.toLowerCase() as
				| "active"
				| "inactive"
				| "error",
			lastHealthCheck: agent.lastHealthCheck?.toISOString(),
			metadata,
		};
	}

	/**
	 * Merge system and dynamic agents
	 * Dynamic agents can enhance system agents with the same ID
	 */
	private mergeAgents(
		systemAgents: LoadedAgent[],
		dynamicAgents: LoadedAgent[],
	): LoadedAgent[] {
		const agentMap = new Map<string, LoadedAgent>();

		// Add system agents first
		for (const agent of systemAgents) {
			agentMap.set(agent.agentId, agent);
		}

		// Add/override with dynamic agents
		for (const agent of dynamicAgents) {
			const existing = agentMap.get(agent.agentId);
			if (existing) {
				// Merge - dynamic enhances system
				agentMap.set(agent.agentId, {
					...existing,
					...agent,
					capabilities: [
						...new Set([
							...existing.capabilities,
							...agent.capabilities,
						]),
					],
					tools: [...new Set([...existing.tools, ...agent.tools])],
				});
			} else {
				agentMap.set(agent.agentId, agent);
			}
		}

		return Array.from(agentMap.values());
	}

	/**
	 * Register a new external agent
	 * Validates the A2A protocol and extracts metadata
	 */
	async registerExternalAgent(
		deploymentUrl: string,
		context: AgentLoadContext,
		options?: {
			scope?: "user" | "organization";
			overrides?: Partial<
				Pick<LoadedAgent, "displayName" | "description">
			>;
		},
	): Promise<{
		valid: boolean;
		agent?: Omit<DbAgent, "id">;
		validationResult: A2AValidationResult;
	}> {
		// Validate A2A protocol
		const validation = await validateA2AEndpoint(deploymentUrl, {
			testSendMessage: false,
			timeout: 10000,
		});

		if (!validation.valid || !validation.agentCard) {
			return { valid: false, validationResult: validation };
		}

		// Extract metadata from agent card
		const extracted = extractAgentMetadata(validation.agentCard);

		// Build agent record
		const agent: Omit<DbAgent, "id"> = {
			agentId: `external-${validation.agentCard.name}-${Date.now()}`,
			name: validation.agentCard.name,
			displayName:
				options?.overrides?.displayName || extracted.displayName,
			description:
				options?.overrides?.description || extracted.description,
			framework: "A2A",
			deploymentUrl,
			status: "ACTIVE",
			scope: options?.scope?.toUpperCase() || "USER",
			config: {
				capabilities: extracted.capabilities,
				skills: extracted.skills,
				supportsStreaming: extracted.supportsStreaming,
				protocolVersion: validation.protocolVersion,
			},
			metadata: {
				registeredBy: context.userId,
				registeredAt: new Date().toISOString(),
				agentCard: validation.agentCard,
			},
			lastHealthCheck: new Date(),
		};

		return { valid: true, agent, validationResult: validation };
	}

	/**
	 * Health check for an agent
	 */
	async healthCheck(agent: LoadedAgent): Promise<boolean> {
		if (!agent.deploymentUrl) {
			return true; // System agents without URL are always healthy
		}

		if (agent.framework === "A2A") {
			return this.a2aClient.healthCheck(agent.deploymentUrl);
		}

		// For other frameworks, try a simple fetch
		try {
			const response = await fetch(`${agent.deploymentUrl}/health`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Filter to only healthy agents
	 */
	async filterHealthyAgents(agents: LoadedAgent[]): Promise<LoadedAgent[]> {
		const results = await Promise.all(
			agents.map(async (agent) => ({
				agent,
				healthy: await this.healthCheck(agent),
			})),
		);

		return results.filter((r) => r.healthy).map((r) => r.agent);
	}

	/**
	 * Invalidate cache
	 */
	invalidateCache(cacheKey?: string): void {
		if (cacheKey) {
			this.cache.delete(cacheKey);
		} else {
			this.cache.clear();
		}
	}

	/**
	 * Get cache stats
	 */
	getCacheStats(): { size: number; keys: string[] } {
		return {
			size: this.cache.size,
			keys: Array.from(this.cache.keys()),
		};
	}
}

// Singleton instance
let defaultLoader: AgentLoaderService | null = null;

export function getAgentLoader(
	options?: ConstructorParameters<typeof AgentLoaderService>[0],
): AgentLoaderService {
	if (!defaultLoader || options) {
		defaultLoader = new AgentLoaderService(options);
	}
	return defaultLoader;
}

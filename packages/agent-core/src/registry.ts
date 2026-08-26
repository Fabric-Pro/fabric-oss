/**
 * Agent Registry
 *
 * Central registry for managing agents across different frameworks and languages.
 * Provides:
 * - Agent discovery and listing
 * - Health monitoring
 * - Framework filtering
 * - Multi-tenant agent management
 */

import type { AgentAdapter, AgentHealthStatus } from "./adapter";

// Verbose registry lifecycle logs flood CopilotKit's per-request init path
// (11 agents × N polls per session). Off by default; opt in with
// AGENT_CORE_VERBOSE=1 to debug registration issues.
const VERBOSE = process.env.AGENT_CORE_VERBOSE === "1";

/**
 * Agent registry for managing multiple agent implementations
 */
export class AgentRegistry {
	private agents = new Map<string, AgentAdapter>();

	/**
	 * Register an agent
	 * @throws Error if agent with same name already exists
	 */
	register(agent: AgentAdapter): void {
		if (this.agents.has(agent.name)) {
			throw new Error(
				`Agent "${agent.name}" already registered. Use a unique name.`,
			);
		}

		if (VERBOSE) {
			console.log("[AgentRegistry] Registering agent:", {
				name: agent.name,
				framework: agent.framework,
				language: agent.language,
				deploymentUrl: agent.getDeploymentUrl(),
			});
		}

		this.agents.set(agent.name, agent);
	}

	/**
	 * Unregister an agent
	 */
	unregister(name: string): boolean {
		const deleted = this.agents.delete(name);
		if (deleted && VERBOSE) {
			console.log("[AgentRegistry] Unregistered agent:", name);
		}
		return deleted;
	}

	/**
	 * Get agent by name
	 */
	get(name: string): AgentAdapter | undefined {
		return this.agents.get(name);
	}

	/**
	 * Check if agent exists
	 */
	has(name: string): boolean {
		return this.agents.has(name);
	}

	/**
	 * Get all agents
	 */
	getAll(): AgentAdapter[] {
		return Array.from(this.agents.values());
	}

	/**
	 * Get agents by framework
	 * @param framework Framework identifier (e.g., "langgraph", "microsoft-agent-framework")
	 */
	getByFramework(framework: string): AgentAdapter[] {
		return this.getAll().filter((a) => a.framework === framework);
	}

	/**
	 * Get agents by language
	 * @param language Language identifier (e.g., "typescript", "python", "csharp")
	 */
	getByLanguage(language: string): AgentAdapter[] {
		return this.getAll().filter((a) => a.language === language);
	}

	/**
	 * Get agents by tag
	 * @param tag Tag to filter by
	 */
	getByTag(tag: string): AgentAdapter[] {
		return this.getAll().filter((a) => a.config.tags?.includes(tag));
	}

	/**
	 * Health check all agents
	 * @returns Map of agent name to health status
	 */
	async healthCheckAll(): Promise<Record<string, AgentHealthStatus>> {
		const results: Record<string, AgentHealthStatus> = {};

		await Promise.all(
			this.getAll().map(async (agent) => {
				try {
					results[agent.name] = await agent.healthCheck();
				} catch (error) {
					results[agent.name] = {
						healthy: false,
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
						lastCheck: new Date(),
					};
				}
			}),
		);

		return results;
	}

	/**
	 * Health check specific agent
	 */
	async healthCheck(name: string): Promise<AgentHealthStatus | null> {
		const agent = this.get(name);
		if (!agent) {
			return null;
		}

		try {
			return await agent.healthCheck();
		} catch (error) {
			return {
				healthy: false,
				error: error instanceof Error ? error.message : "Unknown error",
				lastCheck: new Date(),
			};
		}
	}

	/**
	 * Get registry metadata for UI display
	 * Similar to MCP server registry
	 */
	getRegistryMetadata(): Array<{
		name: string;
		displayName: string;
		description: string;
		framework: string;
		language: string;
		version: string;
		tags: string[];
		deploymentUrl: string;
		tools: string[];
		healthy?: boolean;
	}> {
		return this.getAll().map((agent) => {
			const metadata = agent.getMetadata();
			return {
				name: metadata.name,
				displayName: agent.config.displayName,
				description: agent.config.description,
				framework: metadata.framework,
				language: metadata.language,
				version: metadata.version,
				tags: metadata.tags,
				deploymentUrl: metadata.deploymentUrl,
				tools: metadata.tools,
			};
		});
	}

	/**
	 * Get count of agents by framework
	 */
	getFrameworkCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const agent of this.agents.values()) {
			counts[agent.framework] = (counts[agent.framework] || 0) + 1;
		}
		return counts;
	}

	/**
	 * Get count of agents by language
	 */
	getLanguageCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const agent of this.agents.values()) {
			counts[agent.language] = (counts[agent.language] || 0) + 1;
		}
		return counts;
	}

	/**
	 * Clear all agents (useful for testing)
	 */
	clear(): void {
		if (VERBOSE) {
			console.log("[AgentRegistry] Clearing all agents");
		}
		this.agents.clear();
	}

	/**
	 * Get total number of registered agents
	 */
	get size(): number {
		return this.agents.size;
	}
}

/**
 * Global singleton registry instance
 * Can be imported and used across the application
 */
export const globalAgentRegistry = new AgentRegistry();

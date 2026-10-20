/**
 * Agent Loader Activities
 *
 * Temporal activities for loading and discovering agents.
 * Combines system agents with dynamically registered external agents.
 */

import {
	type AgentLoadContext,
	getAgentLoader,
	type LoadedAgent,
} from "@repo/agent-core";
import { db } from "@repo/database";

// ============================================================================
// Types
// ============================================================================

export interface LoadAvailableAgentsInput {
	userId: string;
	organizationId?: string;
}

export interface LoadAvailableAgentsOutput {
	agents: LoadedAgent[];
	systemCount: number;
	externalCount: number;
}

export interface GetAgentRoutingContextInput {
	userId: string;
	organizationId?: string;
}

export interface AgentRoutingContext {
	agentDescriptions: string;
	agentList: Array<{
		id: string;
		name: string;
		description: string;
		capabilities: string[];
		isExternal: boolean;
	}>;
}

// ============================================================================
// Activity: Load Available Agents
// ============================================================================

/**
 * Load all agents available to a user (system + org + personal)
 */
export async function loadAvailableAgents(
	input: LoadAvailableAgentsInput,
): Promise<LoadAvailableAgentsOutput> {
	const loader = getAgentLoader();
	const context: AgentLoadContext = {
		userId: input.userId,
		organizationId: input.organizationId,
	};

	console.log("[AgentLoader] Loading agents for context:", context);

	// Load agents from database
	const dbLoader = async (ctx: AgentLoadContext) => {
		const agents = await db.registeredAgent.findMany({
			where: {
				status: "ACTIVE",
				OR: [
					// User's personal agents
					{ scope: "USER", userId: ctx.userId },
					// Organization agents
					...(ctx.organizationId
						? [
								{
									scope: "ORGANIZATION",
									organizationId: ctx.organizationId,
								},
							]
						: []),
					// System agents (always included)
					{ scope: "SYSTEM" },
				],
			},
		});

		return agents.map((a) => ({
			id: a.id,
			agentId: a.agentId,
			name: a.name,
			displayName: a.displayName,
			description: a.description,
			framework: a.framework,
			deploymentUrl: a.deploymentUrl,
			status: a.status,
			scope: a.scope,
			config: a.config as Record<string, unknown> | null,
			metadata: a.metadata as Record<string, unknown> | null,
			lastHealthCheck: a.lastHealthCheck,
		}));
	};

	try {
		const agents = await loader.loadAgentsForContext(context, dbLoader);

		const systemCount = agents.filter((a) => !a.isExternal).length;
		const externalCount = agents.filter((a) => a.isExternal).length;

		console.log(
			`[AgentLoader] Loaded ${agents.length} agents (${systemCount} system, ${externalCount} external)`,
		);

		return {
			agents,
			systemCount,
			externalCount,
		};
	} catch (error) {
		console.error("[AgentLoader] Failed to load agents:", error);
		// Return empty list on error - don't fail the workflow
		return {
			agents: [],
			systemCount: 0,
			externalCount: 0,
		};
	}
}

// ============================================================================
// Activity: Get Agent Routing Context
// ============================================================================

/**
 * Get agent descriptions formatted for AI routing decisions
 */
export async function getAgentRoutingContext(
	input: GetAgentRoutingContextInput,
): Promise<AgentRoutingContext> {
	const { agents } = await loadAvailableAgents({
		userId: input.userId,
		organizationId: input.organizationId,
	});

	// Format agent descriptions for AI
	const agentDescriptions = agents
		.map((agent) => {
			const externalTag = agent.isExternal ? " [External]" : " [System]";
			const capsList =
				agent.capabilities.length > 0
					? `\n  Capabilities: ${agent.capabilities.join(", ")}`
					: "";
			const skillsList =
				agent.skills.length > 0
					? `\n  Skills: ${agent.skills.map((s) => s.name).join(", ")}`
					: "";

			return `- **${agent.displayName}** (${agent.agentId})${externalTag}: ${agent.description}${capsList}${skillsList}`;
		})
		.join("\n\n");

	const agentList = agents.map((a) => ({
		id: a.agentId,
		name: a.displayName,
		description: a.description,
		capabilities: a.capabilities,
		isExternal: a.isExternal,
	}));

	return {
		agentDescriptions,
		agentList,
	};
}

// ============================================================================
// Activity: Update Agent Health Status
// ============================================================================

export interface UpdateAgentHealthInput {
	agentId: string;
	healthy: boolean;
}

/**
 * Update agent health status in database
 */
export async function updateAgentHealth(
	input: UpdateAgentHealthInput,
): Promise<void> {
	try {
		await db.registeredAgent.update({
			where: { agentId: input.agentId },
			data: {
				status: input.healthy ? "ACTIVE" : "ERROR",
				lastHealthCheck: new Date(),
			},
		});
	} catch (error) {
		console.error("[AgentLoader] Failed to update health status:", error);
	}
}

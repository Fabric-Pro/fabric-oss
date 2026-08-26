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
	includeHealthCheck?: boolean;
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

		// Optionally filter to healthy agents
		const finalAgents = input.includeHealthCheck
			? await loader.filterHealthyAgents(agents)
			: agents;

		const systemCount = finalAgents.filter((a) => !a.isExternal).length;
		const externalCount = finalAgents.filter((a) => a.isExternal).length;

		console.log(
			`[AgentLoader] Loaded ${finalAgents.length} agents (${systemCount} system, ${externalCount} external)`,
		);

		return {
			agents: finalAgents,
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
		includeHealthCheck: false, // Faster without health checks for routing
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
// Activity: Execute External Agent Task
// ============================================================================

export interface ExecuteExternalAgentInput {
	deploymentUrl: string;
	message: string;
	contextId?: string;
	timeout?: number;
}

export interface ExecuteExternalAgentOutput {
	taskId: string;
	status: string;
	response?: string;
	artifacts?: unknown[];
}

/**
 * Execute a task on an external A2A agent
 */
export async function executeExternalAgent(
	input: ExecuteExternalAgentInput,
): Promise<ExecuteExternalAgentOutput> {
	const { A2AClient } = await import("@repo/agent-core");
	const client = new A2AClient({ timeout: input.timeout || 60000 });

	console.log(
		`[AgentLoader] Executing external agent: ${input.deploymentUrl}`,
	);

	try {
		const task = await client.sendMessage(
			input.deploymentUrl,
			{
				role: "user",
				parts: [{ type: "text", text: input.message }],
			},
			{ contextId: input.contextId },
		);

		// Wait for task completion
		const result = await client.waitForCompletion(
			input.deploymentUrl,
			task.id,
			{ timeout: input.timeout || 60000, pollInterval: 1000 },
		);

		// Extract text response from artifacts
		let response = "";
		if (result.artifacts) {
			for (const artifact of result.artifacts) {
				if (artifact.parts) {
					for (const part of artifact.parts) {
						if (part.type === "text") {
							response += `${part.text}\n`;
						}
					}
				}
			}
		}

		return {
			taskId: result.id,
			status: result.status,
			response: response.trim() || undefined,
			artifacts: result.artifacts,
		};
	} catch (error) {
		console.error("[AgentLoader] External agent execution failed:", error);
		throw error;
	}
}

// ============================================================================
// Activity: Health Check Agent
// ============================================================================

export interface HealthCheckAgentInput {
	agentId: string;
	deploymentUrl: string;
	framework: string;
}

export interface HealthCheckAgentOutput {
	healthy: boolean;
	responseTime?: number;
	error?: string;
}

/**
 * Health check an agent
 */
export async function healthCheckAgent(
	input: HealthCheckAgentInput,
): Promise<HealthCheckAgentOutput> {
	const startTime = Date.now();

	try {
		const loader = getAgentLoader();
		const healthy = await loader.healthCheck({
			agentId: input.agentId,
			name: input.agentId,
			displayName: input.agentId,
			description: "",
			framework: input.framework,
			deploymentUrl: input.deploymentUrl,
			scope: "system",
			capabilities: [],
			skills: [],
			tools: [],
			isExternal: !!input.deploymentUrl,
			supportsStreaming: false,
			status: "active",
		});

		return {
			healthy,
			responseTime: Date.now() - startTime,
		};
	} catch (error) {
		return {
			healthy: false,
			responseTime: Date.now() - startTime,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
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

/**
 * Orchestrator Agent
 * Letta agent for routing tasks and managing multi-agent execution
 */

import type { LettaClient } from "../client";
import type { LettaAgent, LettaTool } from "../types";

const ORCHESTRATOR_PERSONA = `You are the Fabric Loom Agent (the orchestrator). Your responsibilities are:

1. ROUTING: Analyze incoming tasks and route them to the most appropriate specialist agent(s)
2. PLANNING: Break down complex tasks into executable steps
3. COORDINATION: Manage execution flow and collect results from specialist agents
4. APPROVAL: Request human approval for high-risk operations
5. LEARNING: Remember successful patterns and user preferences

When routing, consider:
- Task complexity and requirements
- Available specialist agents and their capabilities
- Historical success patterns for similar tasks
- User preferences stored in memory

Always check your execution_history memory block to avoid repeating mistakes.`;

const ORCHESTRATOR_TOOLS: LettaTool[] = [
	{
		name: "send_message_to_agent_and_wait_for_reply",
		description: "Send a message to another agent and wait for their reply",
		parameters: {
			type: "object",
			properties: {
				target_agent_id: {
					type: "string",
					description: "The ID of the agent to send the message to",
				},
				message: {
					type: "string",
					description: "The message to send",
				},
			},
			required: ["target_agent_id", "message"],
		},
	},
	{
		name: "send_message_to_agent_async",
		description:
			"Send a message to another agent without waiting for reply",
		parameters: {
			type: "object",
			properties: {
				target_agent_id: {
					type: "string",
					description: "The ID of the agent to send the message to",
				},
				message: {
					type: "string",
					description: "The message to send",
				},
			},
			required: ["target_agent_id", "message"],
		},
	},
	{
		name: "request_human_approval",
		description: "Request human approval for a high-risk operation",
		parameters: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					description:
						"Description of the operation requiring approval",
				},
				risk_level: {
					type: "string",
					enum: ["medium", "high", "critical"],
					description: "Risk level of the operation",
				},
				details: {
					type: "string",
					description: "Additional details about the operation",
				},
			},
			required: ["operation", "risk_level"],
		},
	},
];

export interface CreateOrchestratorOptions {
	userId: string;
	organizationId?: string;
	model?: string;
	availableAgents?: Array<{
		id: string;
		name: string;
		description: string;
		capabilities: string[];
	}>;
}

/**
 * Create an orchestrator agent for a user
 */
export async function createOrchestratorAgent(
	client: LettaClient,
	options: CreateOrchestratorOptions,
): Promise<LettaAgent> {
	const { userId, organizationId, model, availableAgents = [] } = options;

	return client.createAgent({
		name: `orchestrator-${userId}`,
		description: "Routes tasks and coordinates multi-agent execution",
		model,
		memoryBlocks: [
			{
				label: "persona",
				value: ORCHESTRATOR_PERSONA,
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
				label: "available_agents",
				value: JSON.stringify(availableAgents),
				limit: 20000,
			},
			{
				label: "execution_history",
				value: "[]",
				limit: 30000,
			},
			{
				label: "successful_patterns",
				value: "[]",
				limit: 10000,
			},
			{
				label: "error_patterns",
				value: "[]",
				limit: 10000,
			},
		],
		tools: ORCHESTRATOR_TOOLS,
		metadata: {
			userId,
			organizationId,
			type: "orchestrator",
			version: "1.0",
		},
	});
}

/**
 * Get or create orchestrator agent for a user
 */
export async function getOrCreateOrchestratorAgent(
	client: LettaClient,
	options: CreateOrchestratorOptions,
): Promise<LettaAgent> {
	// Try to find existing agent
	const existing = await client.findAgentByMetadata({
		userId: options.userId,
		type: "orchestrator",
	});

	if (existing) {
		// Update available agents if provided
		if (options.availableAgents) {
			await client.updateMemoryBlock(
				existing.id,
				"available_agents",
				JSON.stringify(options.availableAgents),
			);
		}
		return existing;
	}

	// Create new agent
	return createOrchestratorAgent(client, options);
}

/**
 * Record an execution in orchestrator history
 */
export async function recordExecution(
	client: LettaClient,
	agentId: string,
	execution: {
		taskId: string;
		task: string;
		agents: string[];
		steps: Array<{
			stepId: string;
			description: string;
			status: "complete" | "error" | "skipped";
			agentId?: string;
		}>;
		success: boolean;
		durationMs: number;
	},
): Promise<void> {
	const block = await client.getMemoryBlock(agentId, "execution_history");
	const history = JSON.parse(block.value || "[]") as Array<
		typeof execution & { recordedAt: string }
	>;

	history.push({
		...execution,
		recordedAt: new Date().toISOString(),
	});

	// Keep only last 100 executions
	const trimmed = history.slice(-100);
	await client.updateMemoryBlock(
		agentId,
		"execution_history",
		JSON.stringify(trimmed),
	);

	// If successful, record as a pattern
	if (execution.success) {
		await recordSuccessfulPattern(client, agentId, {
			taskPattern: execution.task,
			agents: execution.agents,
			stepCount: execution.steps.length,
		});
	}
}

/**
 * Record a successful execution pattern
 */
async function recordSuccessfulPattern(
	client: LettaClient,
	agentId: string,
	pattern: {
		taskPattern: string;
		agents: string[];
		stepCount: number;
	},
): Promise<void> {
	const block = await client.getMemoryBlock(agentId, "successful_patterns");
	const patterns = JSON.parse(block.value || "[]") as Array<
		typeof pattern & { usageCount: number; lastUsed: string }
	>;

	// Check if similar pattern exists
	const existing = patterns.find(
		(p) =>
			p.agents.join(",") === pattern.agents.join(",") &&
			p.stepCount === pattern.stepCount,
	);

	if (existing) {
		existing.usageCount++;
		existing.lastUsed = new Date().toISOString();
	} else {
		patterns.push({
			...pattern,
			usageCount: 1,
			lastUsed: new Date().toISOString(),
		});
	}

	// Keep only top 50 patterns by usage
	const sorted = patterns
		.sort((a, b) => b.usageCount - a.usageCount)
		.slice(0, 50);
	await client.updateMemoryBlock(
		agentId,
		"successful_patterns",
		JSON.stringify(sorted),
	);
}

/**
 * Get routing suggestions based on historical patterns
 */
export async function getRoutingSuggestions(
	client: LettaClient,
	agentId: string,
	task: string,
): Promise<Array<{ agents: string[]; confidence: number }>> {
	const block = await client.getMemoryBlock(agentId, "successful_patterns");
	const patterns = JSON.parse(block.value || "[]") as Array<{
		taskPattern: string;
		agents: string[];
		stepCount: number;
		usageCount: number;
	}>;

	// Simple keyword matching for now
	// In production, would use embedding similarity
	const taskLower = task.toLowerCase();
	const matches = patterns.filter((p) => {
		const patternLower = p.taskPattern.toLowerCase();
		// Check for keyword overlap
		const taskWords = new Set(taskLower.split(/\s+/));
		const patternWords = patternLower.split(/\s+/);
		const overlap = patternWords.filter((w) => taskWords.has(w)).length;
		return overlap >= 2; // At least 2 word overlap
	});

	return matches
		.map((m) => ({
			agents: m.agents,
			confidence: Math.min(m.usageCount * 10, 90), // Cap at 90%
		}))
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 3);
}

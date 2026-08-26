/**
 * Run Agent Activity
 *
 * Enables sub-agent delegation within agentic loops.
 * Supports two execution modes:
 *
 * 1. **Delegate Mode**: Fresh context window (prevents token exhaustion)
 *    - Sub-agent gets: goal, description, minimal context
 *    - Returns: result to calling agent
 *    - Use for: Complex sub-tasks that need full context budget
 *
 * 2. **Inline Mode**: Shared context (faster but limited)
 *    - Sub-agent sees: full conversation history
 *    - Returns: streams into parent conversation
 *    - Use for: Quick lookups, clarifications
 *
 * Safety:
 * - Max recursion depth: 4
 * - Same tools cannot call themselves (prevent infinite loops)
 * - Timeout per sub-agent call
 */

import { type AgentCapability, globalAgentRegistry } from "@repo/agent-core";
import { getAIModelWithMetadata } from "@repo/ai";
import { db } from "@repo/database";
import { generateText, type ModelMessage, stepCountIs, tool } from "ai";
import { z } from "zod";
import { loadMcpToolsForAgent } from "../agent-execution-core";
import { makeInFlightToolCompactor } from "./in-flight-tool-compaction";

// =============================================================================
// Types
// =============================================================================

export type RunAgentMode = "delegate" | "inline";

export interface RunAgentInput {
	/** ID of the agent to run */
	agentId: string;
	/** Goal/task for the sub-agent */
	goal: string;
	/** Additional context to provide */
	context?: string;
	/** Execution mode */
	mode: RunAgentMode;
	/** Current recursion depth */
	currentDepth: number;
	/** Calling agent ID (for loop prevention) */
	callingAgentId: string;
	/** Parent conversation messages (for inline mode) */
	parentMessages?: ModelMessage[];
	/** User ID for authorization */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** MCP config IDs available to sub-agent */
	mcpConfigIds?: string[];
	/** Timeout in milliseconds */
	timeoutMs?: number;
}

export interface RunAgentOutput {
	/** Whether the sub-agent succeeded */
	success: boolean;
	/** Result from sub-agent */
	result: string;
	/** Agent that was executed */
	agentId: string;
	/** Agent name for display */
	agentName: string;
	/** Mode used */
	mode: RunAgentMode;
	/** Steps taken by sub-agent */
	steps?: Array<{
		action: string;
		result: string;
	}>;
	/** Token usage */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
	/** Duration in milliseconds */
	durationMs: number;
	/** Error if failed */
	error?: string;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_RECURSION_DEPTH = 4;
const DEFAULT_TIMEOUT_MS = 60000; // 1 minute per sub-agent

const DELEGATE_SYSTEM_PROMPT = `You are an AI assistant executing a specific task delegated to you by another agent.

Your task is to complete the following goal and return a clear, structured result.

## Guidelines
- Focus only on the specific goal given to you
- Use available tools to gather information or take actions
- Provide a comprehensive but concise result
- If you cannot complete the task, explain why clearly

## Goal
{goal}

## Additional Context
{context}
`;

// =============================================================================
// Activity Implementation
// =============================================================================

/**
 * Execute a sub-agent with the specified mode
 *
 * This activity is designed to be called from within an agent's tool execution
 * to delegate work to specialized sub-agents.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentOutput> {
	const startTime = Date.now();
	const {
		agentId,
		goal,
		context = "",
		mode,
		currentDepth,
		callingAgentId,
		parentMessages = [],
		userId,
		organizationId,
		mcpConfigIds = [],
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = input;

	// ==========================================================================
	// Safety Checks
	// ==========================================================================

	// Check recursion depth
	if (currentDepth >= MAX_RECURSION_DEPTH) {
		return {
			success: false,
			result: "",
			agentId,
			agentName: "Unknown",
			mode,
			durationMs: Date.now() - startTime,
			error: `Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Cannot delegate further.`,
		};
	}

	// Prevent self-calls
	if (agentId === callingAgentId) {
		return {
			success: false,
			result: "",
			agentId,
			agentName: "Unknown",
			mode,
			durationMs: Date.now() - startTime,
			error: "Agent cannot call itself to prevent infinite loops.",
		};
	}

	// ==========================================================================
	// Load Agent Configuration
	// ==========================================================================

	let agentConfig: {
		id: string;
		name: string;
		displayName: string;
		instructions?: string | null;
		config?: Record<string, unknown> | null;
	} | null = null;

	try {
		// Try registered agent first
		const registry = globalAgentRegistry;
		const registeredAgent = registry.get(agentId);

		if (registeredAgent) {
			agentConfig = {
				id: registeredAgent.name,
				name: registeredAgent.config.name,
				displayName:
					registeredAgent.config.displayName || registeredAgent.name,
				instructions: registeredAgent.config.description, // Use description as instructions
				config: registeredAgent.config as unknown as Record<
					string,
					unknown
				>,
			};
		} else {
			// Fall back to database
			const dbAgent = await db.registeredAgent.findFirst({
				where: {
					id: agentId,
					OR: [
						{ userId, organizationId: null },
						{ organizationId: organizationId ?? undefined },
						{ scope: "SYSTEM" },
					],
				},
			});

			if (dbAgent) {
				agentConfig = {
					id: dbAgent.id,
					name: dbAgent.name,
					displayName: dbAgent.displayName,
					instructions: (dbAgent.config as Record<string, unknown>)
						?.instructions as string,
					config: dbAgent.config as Record<string, unknown>,
				};
			}
		}

		if (!agentConfig) {
			return {
				success: false,
				result: "",
				agentId,
				agentName: "Unknown",
				mode,
				durationMs: Date.now() - startTime,
				error: `Agent "${agentId}" not found or not accessible.`,
			};
		}
	} catch (error) {
		return {
			success: false,
			result: "",
			agentId,
			agentName: "Unknown",
			mode,
			durationMs: Date.now() - startTime,
			error: `Failed to load agent: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}

	// ==========================================================================
	// Execute Based on Mode
	// ==========================================================================

	try {
		if (mode === "delegate") {
			return await executeDelegateMode(
				agentConfig,
				goal,
				context,
				currentDepth,
				userId,
				organizationId,
				mcpConfigIds,
				timeoutMs,
				startTime,
			);
		}
		return await executeInlineMode(
			agentConfig,
			goal,
			context,
			parentMessages,
			currentDepth,
			userId,
			organizationId,
			mcpConfigIds,
			timeoutMs,
			startTime,
		);
	} catch (error) {
		return {
			success: false,
			result: "",
			agentId: agentConfig.id,
			agentName: agentConfig.displayName,
			mode,
			durationMs: Date.now() - startTime,
			error: `Execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}

// =============================================================================
// Execution Modes
// =============================================================================

/**
 * Delegate Mode: Fresh context window
 *
 * Sub-agent gets a clean context with just the goal and minimal context.
 * Prevents token exhaustion in deeply nested agent calls.
 */
async function executeDelegateMode(
	agentConfig: {
		id: string;
		name: string;
		displayName: string;
		instructions?: string | null;
		config?: Record<string, unknown> | null;
	},
	goal: string,
	context: string,
	currentDepth: number,
	userId: string,
	organizationId: string | undefined,
	mcpConfigIds: string[],
	timeoutMs: number,
	startTime: number,
): Promise<RunAgentOutput> {
	// Build system prompt
	const systemPrompt = DELEGATE_SYSTEM_PROMPT.replace("{goal}", goal).replace(
		"{context}",
		context || "No additional context provided.",
	);

	// Get AI model
	const { model } = await getAIModelWithMetadata(
		{ taskType: "TOOL_CALLING" },
		{ userId, organizationId },
	);

	// Build tools for sub-agent (excluding run_agent to current agent)
	const tools = await buildSubAgentTools(
		agentConfig.id,
		currentDepth + 1,
		userId,
		organizationId,
		mcpConfigIds,
	);

	// Execute with timeout
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const result = await generateText({
			model,
			system: `${agentConfig.instructions || ""}\n\n${systemPrompt}`,
			messages: [
				{
					role: "user",
					content: `Please complete this task: ${goal}`,
				},
			],
			tools,
			stopWhen: stepCountIs(10),
			prepareStep: makeInFlightToolCompactor(),
			abortSignal: controller.signal,
		});

		clearTimeout(timeoutId);

		// Extract steps from result
		const steps = result.steps?.map((step) => ({
			action: step.toolCalls?.[0]?.toolName || "thinking",
			result:
				String(step.toolResults?.[0]?.output ?? "") || step.text || "",
		}));

		return {
			success: true,
			result: result.text,
			agentId: agentConfig.id,
			agentName: agentConfig.displayName,
			mode: "delegate",
			steps,
			tokenUsage: {
				inputTokens: result.usage?.inputTokens || 0,
				outputTokens: result.usage?.outputTokens || 0,
			},
			durationMs: Date.now() - startTime,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Inline Mode: Shared context
 *
 * Sub-agent sees the full conversation history.
 * Faster for simple lookups but consumes parent's context budget.
 */
async function executeInlineMode(
	agentConfig: {
		id: string;
		name: string;
		displayName: string;
		instructions?: string | null;
		config?: Record<string, unknown> | null;
	},
	goal: string,
	context: string,
	parentMessages: ModelMessage[],
	currentDepth: number,
	userId: string,
	organizationId: string | undefined,
	mcpConfigIds: string[],
	timeoutMs: number,
	startTime: number,
): Promise<RunAgentOutput> {
	// Get AI model
	const { model } = await getAIModelWithMetadata(
		{ taskType: "TOOL_CALLING" },
		{ userId, organizationId },
	);

	// Build tools
	const tools = await buildSubAgentTools(
		agentConfig.id,
		currentDepth + 1,
		userId,
		organizationId,
		mcpConfigIds,
	);

	// Append the delegation request to parent messages
	const messages: ModelMessage[] = [
		...parentMessages,
		{
			role: "user",
			content: `[Sub-task from parent agent]\n\nGoal: ${goal}\n\n${context ? `Context: ${context}` : ""}`,
		},
	];

	// Execute with timeout
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const result = await generateText({
			model,
			system: agentConfig.instructions || "",
			messages,
			tools,
			stopWhen: stepCountIs(5), // Fewer steps for inline mode
			prepareStep: makeInFlightToolCompactor(),
			abortSignal: controller.signal,
		});

		clearTimeout(timeoutId);

		const steps = result.steps?.map((step) => ({
			action: step.toolCalls?.[0]?.toolName || "thinking",
			result:
				String(step.toolResults?.[0]?.output ?? "") || step.text || "",
		}));

		return {
			success: true,
			result: result.text,
			agentId: agentConfig.id,
			agentName: agentConfig.displayName,
			mode: "inline",
			steps,
			tokenUsage: {
				inputTokens: result.usage?.inputTokens || 0,
				outputTokens: result.usage?.outputTokens || 0,
			},
			durationMs: Date.now() - startTime,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

// =============================================================================
// Tool Builder
// =============================================================================

/**
 * Build tools available to sub-agent
 *
 * Includes run_agent tool for further delegation (if depth allows)
 */
async function buildSubAgentTools(
	currentAgentId: string,
	newDepth: number,
	userId: string,
	organizationId: string | undefined,
	mcpConfigIds: string[],
) {
	const tools: Record<string, any> = {};

	// Add run_agent tool if depth allows
	if (newDepth < MAX_RECURSION_DEPTH) {
		tools.run_agent = createRunAgentTool(
			currentAgentId,
			newDepth,
			userId,
			organizationId,
			mcpConfigIds,
		);
	}

	// Load MCP tools for the sub-agent using the same tenant-isolated loader
	// as the parent agent. This mirrors Dust's toolsetsToAdd pattern where
	// the parent passes MCP server IDs to the child conversation.
	if (mcpConfigIds.length > 0) {
		const { tools: mcpTools } = await loadMcpToolsForAgent(
			mcpConfigIds,
			userId,
			organizationId,
		);
		Object.assign(tools, mcpTools);
	}

	return tools;
}

/**
 * Create the run_agent tool definition
 */
export function createRunAgentTool(
	callingAgentId: string,
	currentDepth: number,
	userId: string,
	organizationId: string | undefined,
	mcpConfigIds: string[],
) {
	const inputSchema = z.object({
		agentId: z.string().describe("ID of the agent to run"),
		goal: z
			.string()
			.describe("Clear description of what the agent should accomplish"),
		context: z
			.string()
			.optional()
			.describe("Additional context to help the agent"),
		mode: z
			.enum(["delegate", "inline"])
			.default("delegate")
			.describe(
				"delegate: fresh context (recommended for complex tasks), inline: shared context (faster for simple queries)",
			),
	});

	return tool({
		description: `Delegate a task to another specialized agent. Use "delegate" mode for complex tasks that need full context, or "inline" mode for quick lookups.

Available agents can be discovered by asking the user or checking your instructions.

Max delegation depth: ${MAX_RECURSION_DEPTH - currentDepth} more levels allowed.`,
		inputSchema,
		execute: async (params: z.infer<typeof inputSchema>) => {
			const { agentId, goal, context, mode } = params;
			const result = await runAgent({
				agentId,
				goal,
				context,
				mode,
				currentDepth,
				callingAgentId,
				userId,
				organizationId,
				mcpConfigIds,
			});

			if (result.success) {
				return {
					success: true,
					agentName: result.agentName,
					result: result.result,
					steps: result.steps?.length || 0,
				};
			}
			return {
				success: false,
				error: result.error,
			};
		},
	});
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get list of available agents for delegation
 */
export async function getAvailableAgents(
	userId: string,
	organizationId?: string,
): Promise<
	Array<{
		id: string;
		name: string;
		displayName: string;
		description: string;
		capabilities: AgentCapability[];
	}>
> {
	// Get from registry - use getAll() and map to expected structure
	const registry = globalAgentRegistry;
	const registeredAdapters = registry.getAll();

	// Get from database
	const dbAgents = await db.registeredAgent.findMany({
		where: {
			status: "ACTIVE",
			OR: [
				{ userId, organizationId: null },
				{ organizationId: organizationId ?? undefined },
				{ scope: "SYSTEM" },
			],
		},
		select: {
			id: true,
			name: true,
			displayName: true,
			description: true,
			config: true,
		},
	});

	// Combine and deduplicate
	const agentMap = new Map<
		string,
		{
			id: string;
			name: string;
			displayName: string;
			description: string;
			capabilities: AgentCapability[];
		}
	>();

	// Map registry adapters to agent format
	for (const adapter of registeredAdapters) {
		agentMap.set(adapter.name, {
			id: adapter.name,
			name: adapter.config.name,
			displayName: adapter.config.displayName || adapter.name,
			description: adapter.config.description || "",
			// Registry adapters don't have capabilities in config - use tags as fallback
			capabilities:
				(adapter.config.tags as unknown as AgentCapability[]) || [],
		});
	}

	for (const agent of dbAgents) {
		if (!agentMap.has(agent.id)) {
			agentMap.set(agent.id, {
				id: agent.id,
				name: agent.name,
				displayName: agent.displayName,
				description: agent.description || "",
				capabilities:
					((agent.config as Record<string, unknown>)
						?.capabilities as AgentCapability[]) || [],
			});
		}
	}

	return Array.from(agentMap.values());
}

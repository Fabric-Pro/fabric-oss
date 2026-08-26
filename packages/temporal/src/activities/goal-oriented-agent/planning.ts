/**
 * Goal-Oriented Planning Activity
 *
 * Creates a task plan focused on achieving the specified goal.
 * Unlike general orchestrator planning, this:
 * - Always keeps the goal in focus
 * - Incorporates feedback from previous verification failures
 * - Plans with success criteria in mind
 */

import { generateObject } from "@repo/ai";
import { z } from "zod";
import type {
	AgentVariable,
	GoalVerificationResult,
	RoutingDecision,
	TaskPlan,
} from "../../workflows/goal-oriented-agent/types";
import type {
	TaskStep,
	TaskType,
} from "../../workflows/orchestrator/types/task.types";
import { getAiModel } from "../orchestrator/utils/model-selector";

export interface CreateGoalOrientedPlanInput {
	goal: string;
	userMessage: string;
	systemPrompt: string;
	knowledgeContext?: string;
	previousAttempts: GoalVerificationResult[];
	variables: Record<string, AgentVariable>;
	userId: string;
	organizationId?: string;
	mcpConfigIds: string[];
}

export interface CreateGoalOrientedPlanOutput {
	plan: TaskPlan;
	routingDecision: RoutingDecision;
}

// Map goal-oriented step types to orchestrator TaskType
const STEP_TYPE_MAP: Record<string, TaskType> = {
	tool: "api",
	llm: "generate",
	agent: "agent",
	verification: "verify",
};

const TaskStepSchema = z.object({
	id: z.string(),
	description: z.string(),
	type: z.enum(["tool", "llm", "agent", "verification"]),
	executor: z.string().optional(),
	inputs: z.record(z.string(), z.unknown()).optional(),
	outputs: z.array(z.string()).optional(),
	requiresApproval: z.boolean().default(false),
	riskLevel: z.enum(["low", "medium", "high", "critical"]).default("low"),
});

// Map strategy to TaskType
const STRATEGY_TYPE_MAP: Record<string, TaskType> = {
	direct: "api",
	iterative: "hybrid",
	research_first: "research",
	parallel: "hybrid",
};

const PlanSchema = z.object({
	reasoning: z
		.string()
		.describe("Explain your approach to achieving the goal"),
	steps: z.array(TaskStepSchema).min(1).max(10),
	strategy: z.enum(["direct", "iterative", "research_first", "parallel"]),
	estimatedComplexity: z.enum(["simple", "moderate", "complex"]),
});

export async function createGoalOrientedPlan(
	input: CreateGoalOrientedPlanInput,
): Promise<CreateGoalOrientedPlanOutput> {
	const {
		goal,
		userMessage,
		systemPrompt,
		knowledgeContext,
		previousAttempts,
		variables,
		userId,
		organizationId,
		mcpConfigIds,
	} = input;

	console.log("[GoalOrientedPlanning] Creating plan", {
		goal: goal.slice(0, 100),
		hasPreviousAttempts: previousAttempts.length > 0,
		mcpConfigCount: mcpConfigIds.length,
	});

	// Load available tools for planning
	const availableTools = await loadMcpToolsForPlanning(
		mcpConfigIds,
		userId,
		organizationId,
	);

	const toolDescriptions = availableTools
		.map((t) => `- ${t.name}: ${t.description}`)
		.join("\n");

	// Build context from previous attempts
	let previousAttemptsContext = "";
	if (previousAttempts.length > 0) {
		const lastAttempt = previousAttempts[previousAttempts.length - 1];
		previousAttemptsContext = `
## Previous Attempt Feedback
The goal was NOT achieved in the previous attempt.
- Confidence: ${Math.round(lastAttempt.confidence * 100)}%
- Reasoning: ${lastAttempt.reasoning}
${lastAttempt.suggestions?.length ? `- Suggestions: ${lastAttempt.suggestions.join(", ")}` : ""}
${lastAttempt.missingCriteria?.length ? `- Missing criteria: ${lastAttempt.missingCriteria.join(", ")}` : ""}

Please address these issues in your new plan.
`;
	}

	// Build available variables context
	const variablesContext = Object.entries(variables)
		.filter(([key]) => !key.startsWith("sys."))
		.map(([key, v]) => `- ${key}: ${JSON.stringify(v.value)}`)
		.join("\n");

	const planningPrompt = `You are a goal-oriented planning agent. Your task is to create a plan to achieve the specified goal.

## Goal
${goal}

## User Request
${userMessage}

## Agent Context
${systemPrompt}

${knowledgeContext ? `## Relevant Knowledge\n${knowledgeContext}` : ""}

## Available Tools
${toolDescriptions || "No specific tools available. Use LLM reasoning."}

${variablesContext ? `## Available Variables\n${variablesContext}` : ""}

${previousAttemptsContext}

## Instructions
1. Analyze the goal and determine what needs to be done
2. Break down the task into concrete, actionable steps
3. Each step should be verifiable (you can check if it was done correctly)
4. Consider what tools are available and how to use them effectively
5. If this is a retry, address the feedback from the previous attempt

Create a focused plan that will achieve the goal. Keep it concise but complete.`;

	const model = await getAiModel(userId, organizationId);

	const result = await generateObject({
		model,
		schema: PlanSchema,
		prompt: planningPrompt,
	});

	const planData = result.object;

	// Convert to TaskPlan format with proper type mapping
	const steps: TaskStep[] = planData.steps.map((step, index) => ({
		id: step.id,
		description: step.description,
		type: STEP_TYPE_MAP[step.type] || "api",
		status: "pending" as const,
		order: index + 1,
		executor: step.executor,
		inputs: step.inputs,
		riskLevel: step.riskLevel,
		requiresApproval: step.requiresApproval,
	}));

	const plan: TaskPlan = {
		id: `plan-${Date.now()}`,
		description: goal,
		steps,
		riskLevel: determineOverallRisk(planData.steps),
		strategy: STRATEGY_TYPE_MAP[planData.strategy] || "api",
		createdAt: new Date().toISOString(),
	};

	// Build routing decision
	const routingDecision: RoutingDecision = {
		primaryAgent: "goal-oriented-executor",
		secondaryAgents: [],
		reasoning: planData.reasoning,
		suggestedStrategy: STRATEGY_TYPE_MAP[planData.strategy] || "api",
		riskLevel: plan.riskLevel,
		riskFactors: [],
		confidence: previousAttempts.length === 0 ? 0.8 : 0.6, // Lower confidence on retries
		matchedMcpTools: availableTools.map((t) => ({
			toolName: t.name,
			configId: t.configId || "",
			confidence: 1,
			reason: "Tool available for goal execution",
		})),
	};

	console.log("[GoalOrientedPlanning] Plan created", {
		stepCount: plan.steps.length,
		strategy: plan.strategy,
		complexity: planData.estimatedComplexity,
	});

	return { plan, routingDecision };
}

function determineOverallRisk(
	steps: Array<{ riskLevel?: string }>,
): "low" | "medium" | "high" | "critical" {
	const riskOrder = ["low", "medium", "high", "critical"];
	let maxRiskIndex = 0;

	for (const step of steps) {
		const stepRiskIndex = riskOrder.indexOf(step.riskLevel || "low");
		if (stepRiskIndex > maxRiskIndex) {
			maxRiskIndex = stepRiskIndex;
		}
	}

	return riskOrder[maxRiskIndex] as "low" | "medium" | "high" | "critical";
}

async function loadMcpToolsForPlanning(
	mcpConfigIds: string[],
	userId: string,
	organizationId?: string,
): Promise<
	Array<{
		name: string;
		description: string;
		configId?: string;
		serverName?: string;
	}>
> {
	if (mcpConfigIds.length === 0) {
		return [];
	}

	try {
		// Load MCP configs directly from database
		const { db } = await import("@repo/database");

		// Build tenant filter
		const tenantFilter = organizationId
			? { organizationId, userId }
			: { organizationId: null, userId };

		const configs = await db.mCPConfig.findMany({
			where: {
				id: { in: mcpConfigIds },
				...tenantFilter,
				enabled: true,
			},
			include: { mcpServer: true },
		});

		const tools: Array<{
			name: string;
			description: string;
			configId?: string;
			serverName?: string;
		}> = [];

		for (const config of configs) {
			const displayName = config.displayName || config.id;
			const serverName = config.mcpServer?.name || displayName;
			tools.push({
				name: displayName,
				description: `Tools from ${displayName}`,
				configId: config.id,
				serverName,
			});
		}

		return tools;
	} catch (error) {
		console.warn("[GoalOrientedPlanning] Failed to load MCP tools", error);
		return [];
	}
}

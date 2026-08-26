/**
 * Multi-Model Planning Pipeline
 *
 * Implements a draft → review → refine planning approach:
 * 1. Draft: Fast model creates initial plan
 * 2. Review: Stronger model validates and critiques
 * 3. Refine: Incorporates feedback to produce final plan
 *
 * Benefits:
 * - Catches plan issues before execution
 * - Balances speed (fast draft) with quality (thorough review)
 * - Provides audit trail of planning decisions
 */

import { generateText } from "@repo/ai";
import { logger } from "@repo/logs";
import type { CreateTaskPlanInput, TaskPlan, TaskStep } from "../types";
import { getAiModel, safeParseJson } from "../utils";
import { type PlanValidationResult, validatePlan } from "./plan-validator";

// =============================================================================
// Types
// =============================================================================

export interface MultiModelPlannerConfig {
	/** Enable the multi-model pipeline (default: true) */
	enabled: boolean;
	/** Model to use for drafting (faster, cheaper) */
	draftModel?: string;
	/** Model to use for review (stronger, more thorough) */
	reviewModel?: string;
	/** Maximum refinement iterations */
	maxRefinements: number;
	/** Minimum confidence score to skip review (0-1) */
	skipReviewThreshold: number;
	/** Enable parallel review checks */
	parallelReview: boolean;
}

export interface PlanDraft {
	plan: TaskPlan;
	confidence: number;
	reasoning: string;
	draftModel: string;
	durationMs: number;
}

export interface PlanReview {
	approved: boolean;
	score: number;
	issues: PlanReviewIssue[];
	suggestions: PlanReviewSuggestion[];
	reviewModel: string;
	durationMs: number;
}

export interface PlanReviewIssue {
	severity: "critical" | "major" | "minor";
	stepId?: string;
	issue: string;
	impact: string;
}

export interface PlanReviewSuggestion {
	type: "optimization" | "safety" | "clarity" | "completeness";
	stepId?: string;
	suggestion: string;
	rationale: string;
}

export interface RefinedPlan {
	plan: TaskPlan;
	changesApplied: string[];
	refinementCount: number;
	finalScore: number;
}

export interface MultiModelPlanResult {
	plan: TaskPlan;
	draft: PlanDraft;
	review: PlanReview;
	refinement?: RefinedPlan;
	validation: PlanValidationResult;
	totalDurationMs: number;
	pipelineStages: Array<{
		stage: "draft" | "review" | "refine" | "validate";
		durationMs: number;
		success: boolean;
	}>;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_MULTI_MODEL_CONFIG: MultiModelPlannerConfig = {
	enabled: true,
	maxRefinements: 2,
	skipReviewThreshold: 0.9,
	parallelReview: false,
};

// =============================================================================
// Multi-Model Planner
// =============================================================================

/**
 * Creates a task plan using the multi-model pipeline.
 */
export async function createMultiModelPlan(
	input: CreateTaskPlanInput,
	config: Partial<MultiModelPlannerConfig> = {},
): Promise<MultiModelPlanResult> {
	const startTime = Date.now();
	const mergedConfig = { ...DEFAULT_MULTI_MODEL_CONFIG, ...config };
	const pipelineStages: MultiModelPlanResult["pipelineStages"] = [];

	logger.info("[MultiModelPlanner] Starting multi-model planning pipeline", {
		task: input.message.substring(0, 100),
		config: mergedConfig,
	});

	// Stage 1: Draft
	const draftStartTime = Date.now();
	const draft = await createDraftPlan(input);
	pipelineStages.push({
		stage: "draft",
		durationMs: Date.now() - draftStartTime,
		success: true,
	});

	logger.info("[MultiModelPlanner] Draft created", {
		stepCount: draft.plan.steps.length,
		confidence: draft.confidence,
		durationMs: draft.durationMs,
	});

	// Check if we can skip review (high confidence draft)
	if (draft.confidence >= mergedConfig.skipReviewThreshold) {
		logger.info(
			"[MultiModelPlanner] Skipping review due to high confidence",
			{
				confidence: draft.confidence,
				threshold: mergedConfig.skipReviewThreshold,
			},
		);

		// Still validate the plan
		const validationStartTime = Date.now();
		const validation = await validatePlan({
			plan: draft.plan,
			routingDecision: input.routingDecision,
			userId: input.userId,
			organizationId: input.organizationId,
			enabledMcpConfigIds: input.enabledMcpConfigIds,
			enabledAgentIds: input.enabledAgentIds,
		});
		pipelineStages.push({
			stage: "validate",
			durationMs: Date.now() - validationStartTime,
			success: validation.isValid,
		});

		return {
			plan: draft.plan,
			draft,
			review: {
				approved: true,
				score: draft.confidence,
				issues: [],
				suggestions: [],
				reviewModel: "skipped",
				durationMs: 0,
			},
			validation,
			totalDurationMs: Date.now() - startTime,
			pipelineStages,
		};
	}

	// Stage 2: Review
	const reviewStartTime = Date.now();
	const review = await reviewPlan(draft.plan, input);
	pipelineStages.push({
		stage: "review",
		durationMs: Date.now() - reviewStartTime,
		success:
			review.approved ||
			review.issues.filter((i) => i.severity === "critical").length === 0,
	});

	logger.info("[MultiModelPlanner] Review completed", {
		approved: review.approved,
		score: review.score,
		issueCount: review.issues.length,
		suggestionCount: review.suggestions.length,
	});

	// Stage 3: Refine (if needed)
	let finalPlan = draft.plan;
	let refinement: RefinedPlan | undefined;

	const hasCriticalIssues = review.issues.some(
		(i) => i.severity === "critical",
	);
	const hasMajorIssues = review.issues.some((i) => i.severity === "major");

	if (!review.approved || hasCriticalIssues || hasMajorIssues) {
		const refineStartTime = Date.now();
		refinement = await refinePlan(
			draft.plan,
			review,
			input,
			mergedConfig.maxRefinements,
		);
		finalPlan = refinement.plan;
		pipelineStages.push({
			stage: "refine",
			durationMs: Date.now() - refineStartTime,
			success: refinement.finalScore > review.score,
		});

		logger.info("[MultiModelPlanner] Refinement completed", {
			changesApplied: refinement.changesApplied.length,
			refinementCount: refinement.refinementCount,
			finalScore: refinement.finalScore,
		});
	}

	// Stage 4: Validate final plan
	const validationStartTime = Date.now();
	const validation = await validatePlan({
		plan: finalPlan,
		routingDecision: input.routingDecision,
		userId: input.userId,
		organizationId: input.organizationId,
		enabledMcpConfigIds: input.enabledMcpConfigIds,
		enabledAgentIds: input.enabledAgentIds,
	});
	pipelineStages.push({
		stage: "validate",
		durationMs: Date.now() - validationStartTime,
		success: validation.isValid,
	});

	return {
		plan: finalPlan,
		draft,
		review,
		refinement,
		validation,
		totalDurationMs: Date.now() - startTime,
		pipelineStages,
	};
}

// =============================================================================
// Stage 1: Draft Plan
// =============================================================================

async function createDraftPlan(input: CreateTaskPlanInput): Promise<PlanDraft> {
	const startTime = Date.now();
	const model = await getAiModel(input.userId, input.organizationId);

	const systemPrompt = `You are an expert task planner. Create a concise execution plan for the given task.

OUTPUT FORMAT (JSON):
{
  "plan": {
    "steps": [
      {
        "id": "step-1",
        "description": "Clear description of what to do",
        "type": "research|generate|api|browser|verify",
        "order": 1,
        "executor": "agent_id or mcp_tool_name",
        "capability": "agent|mcp_tool|llm|workflow|web",
        "riskLevel": "low|medium|high|critical",
        "requiresApproval": true/false,
        "inputs": {},
        "expectedOutput": "What this step produces"
      }
    ]
  },
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of plan approach"
}

GUIDELINES:
- Prefer MCP tools for direct API operations (faster, deterministic)
- Use agents for complex reasoning or multi-step tasks
- Mark destructive operations as high/critical risk with approval required
- Keep plans minimal - only include necessary steps
- READ operations are always low risk
- CREATE/UPDATE operations are medium-high risk
- DELETE operations are critical risk`;

	const prompt = `Task: ${input.message}
Primary Agent: ${input.routingDecision.primaryAgent}
Risk Level: ${input.routingDecision.riskLevel}
Strategy: ${input.routingDecision.suggestedStrategy}
${input.routingDecision.matchedMcpTools?.length ? `Available MCP Tools: ${input.routingDecision.matchedMcpTools.map((t) => t.toolName).join(", ")}` : ""}
${input.routingDecision.matchedAgents?.length ? `Available Agents: ${input.routingDecision.matchedAgents.map((a) => a.agentId).join(", ")}` : ""}`;

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt,
		temperature: 0.3, // Lower temperature for more consistent planning
	});

	const parsed = safeParseJson<{
		plan: { steps: TaskStep[] };
		confidence: number;
		reasoning: string;
	}>(response.text || "{}", "object");

	const steps = parsed?.plan?.steps || [];
	const normalizedSteps = steps.map((step, idx) => normalizeStep(step, idx));

	const plan: TaskPlan = {
		id: `plan-${Date.now()}`,
		description: input.message.substring(0, 200),
		steps:
			normalizedSteps.length > 0
				? normalizedSteps
				: [createFallbackStep(input)],
		riskLevel: input.routingDecision.riskLevel,
		strategy: input.routingDecision.suggestedStrategy,
		createdAt: new Date().toISOString(),
	};

	return {
		plan,
		confidence: parsed?.confidence || 0.7,
		reasoning: parsed?.reasoning || "Plan created from task analysis",
		draftModel: "default",
		durationMs: Date.now() - startTime,
	};
}

// =============================================================================
// Stage 2: Review Plan
// =============================================================================

async function reviewPlan(
	plan: TaskPlan,
	input: CreateTaskPlanInput,
): Promise<PlanReview> {
	const startTime = Date.now();
	const model = await getAiModel(input.userId, input.organizationId);

	const systemPrompt = `You are a senior technical reviewer. Analyze the execution plan and identify issues.

OUTPUT FORMAT (JSON):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "issues": [
    {
      "severity": "critical|major|minor",
      "stepId": "step-id or null",
      "issue": "What's wrong",
      "impact": "Why it matters"
    }
  ],
  "suggestions": [
    {
      "type": "optimization|safety|clarity|completeness",
      "stepId": "step-id or null",
      "suggestion": "What to improve",
      "rationale": "Why this helps"
    }
  ]
}

REVIEW CRITERIA:
1. SAFETY: Are destructive operations properly marked? Is approval required where needed?
2. COMPLETENESS: Does the plan cover all aspects of the task?
3. EFFICIENCY: Are there redundant steps? Can steps be parallelized?
4. EXECUTABILITY: Are executors available? Are dependencies clear?
5. RISK ASSESSMENT: Are risk levels accurate? Are critical operations protected?

Mark as NOT APPROVED if:
- Critical safety issues exist
- Plan is fundamentally incomplete
- Risk levels are severely underestimated`;

	const prompt = `ORIGINAL TASK: ${input.message}

PLAN TO REVIEW:
${JSON.stringify(plan, null, 2)}

Analyze this plan thoroughly and provide your review.`;

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt,
		temperature: 0.2, // Very low temperature for consistent review
	});

	const parsed = safeParseJson<{
		approved: boolean;
		score: number;
		issues: PlanReviewIssue[];
		suggestions: PlanReviewSuggestion[];
	}>(response.text || "{}", "object");

	return {
		approved: parsed?.approved ?? true,
		score: parsed?.score ?? 0.8,
		issues: parsed?.issues ?? [],
		suggestions: parsed?.suggestions ?? [],
		reviewModel: "default",
		durationMs: Date.now() - startTime,
	};
}

// =============================================================================
// Stage 3: Refine Plan
// =============================================================================

async function refinePlan(
	originalPlan: TaskPlan,
	review: PlanReview,
	input: CreateTaskPlanInput,
	maxIterations: number,
): Promise<RefinedPlan> {
	const model = await getAiModel(input.userId, input.organizationId);
	let currentPlan = originalPlan;
	let refinementCount = 0;
	const changesApplied: string[] = [];

	const systemPrompt = `You are an expert plan optimizer. Refine the plan based on review feedback.

OUTPUT FORMAT (JSON):
{
  "refinedSteps": [...], // Updated steps array
  "changesApplied": ["Change 1", "Change 2"],
  "newScore": 0.0-1.0
}

RULES:
- Address all critical issues first
- Apply safety suggestions
- Don't add unnecessary complexity
- Preserve the original intent
- Update risk levels if needed`;

	for (let i = 0; i < maxIterations && refinementCount < maxIterations; i++) {
		const criticalIssues = review.issues.filter(
			(issue) => issue.severity === "critical",
		);
		const majorIssues = review.issues.filter(
			(issue) => issue.severity === "major",
		);

		if (criticalIssues.length === 0 && majorIssues.length === 0) {
			break;
		}

		const prompt = `ORIGINAL TASK: ${input.message}

CURRENT PLAN:
${JSON.stringify(currentPlan, null, 2)}

ISSUES TO ADDRESS:
${JSON.stringify([...criticalIssues, ...majorIssues], null, 2)}

SUGGESTIONS TO CONSIDER:
${JSON.stringify(review.suggestions, null, 2)}

Refine the plan to address these issues.`;

		const response = await generateText({
			model,
			system: systemPrompt,
			prompt,
			temperature: 0.3,
		});

		const parsed = safeParseJson<{
			refinedSteps: TaskStep[];
			changesApplied: string[];
			newScore: number;
		}>(response.text || "{}", "object");

		if (parsed?.refinedSteps && parsed.refinedSteps.length > 0) {
			currentPlan = {
				...currentPlan,
				steps: parsed.refinedSteps.map((step, idx) =>
					normalizeStep(step, idx),
				),
			};
			changesApplied.push(...(parsed.changesApplied || []));
			refinementCount++;
		} else {
			break;
		}
	}

	return {
		plan: currentPlan,
		changesApplied,
		refinementCount,
		finalScore: Math.min(review.score + refinementCount * 0.1, 1.0),
	};
}

// =============================================================================
// Helper Functions
// =============================================================================

function normalizeStep(
	step: TaskStep | Record<string, unknown>,
	idx: number,
): TaskStep {
	const s = step as Record<string, unknown>;
	const description = (
		(s.description as string) || `Step ${idx + 1}`
	).toLowerCase();
	const executor = s.executor ? String(s.executor).toLowerCase() : "";

	// Auto-detect risk level and approval requirement based on operation type
	let riskLevel = (s.riskLevel as TaskStep["riskLevel"]) || "low";
	let requiresApproval = (s.requiresApproval as boolean) || false;

	// READ operations are LOW risk
	const isReadOperation =
		description.includes("get") ||
		executor.includes("get") ||
		description.includes("list") ||
		executor.includes("list") ||
		description.includes("fetch") ||
		description.includes("retrieve") ||
		description.includes("search") ||
		description.includes("find") ||
		description.includes("read") ||
		description.includes("display") ||
		description.includes("show") ||
		description.includes("present");

	if (!isReadOperation) {
		// CREATE operations are HIGH risk and require approval
		if (
			description.includes("create") ||
			executor.includes("create") ||
			description.includes("new") ||
			description.includes("add") ||
			description.includes("insert") ||
			description.includes("post")
		) {
			riskLevel = "high";
			requiresApproval = true;
		}

		// DELETE operations are CRITICAL risk and require approval
		if (
			description.includes("delete") ||
			executor.includes("delete") ||
			description.includes("remove") ||
			description.includes("destroy")
		) {
			riskLevel = "critical";
			requiresApproval = true;
		}

		// UPDATE operations are MEDIUM risk and require approval
		if (
			description.includes("update") ||
			executor.includes("update") ||
			description.includes("modify") ||
			description.includes("edit") ||
			description.includes("change") ||
			description.includes("patch") ||
			description.includes("put")
		) {
			if (riskLevel === "low") {
				riskLevel = "medium";
			}
			requiresApproval = true;
		}

		// BULK operations are CRITICAL
		if (
			description.includes("bulk") ||
			description.includes("batch") ||
			(description.includes("all") &&
				(description.includes("delete") ||
					description.includes("update") ||
					description.includes("create")))
		) {
			riskLevel = "critical";
			requiresApproval = true;
		}
	}

	return {
		id: (s.id as string) || `step-${idx + 1}`,
		description: (s.description as string) || `Step ${idx + 1}`,
		type: (s.type as TaskStep["type"]) || "generate",
		status: "pending",
		order: (s.order as number) || idx + 1,
		executor: s.executor as string | undefined,
		capability: s.capability as TaskStep["capability"],
		riskLevel,
		requiresApproval,
		inputs: s.inputs as Record<string, unknown> | undefined,
		expectedOutput: s.expectedOutput as string | undefined,
		toolsToUse: s.toolsToUse as string[] | undefined,
	};
}

function createFallbackStep(input: CreateTaskPlanInput): TaskStep {
	return {
		id: "step-1",
		description: input.message.substring(0, 150),
		type: input.routingDecision.suggestedStrategy as TaskStep["type"],
		status: "pending",
		order: 1,
		executor: input.routingDecision.primaryAgent,
		riskLevel: input.routingDecision.riskLevel,
		requiresApproval: input.routingDecision.riskLevel !== "low",
	};
}

// =============================================================================
// Activity Function
// =============================================================================

/**
 * Create a task plan using the multi-model pipeline.
 * This is the main entry point for Temporal activities.
 */
export async function createMultiModelPlanActivity(
	input: CreateTaskPlanInput,
	config?: Partial<MultiModelPlannerConfig>,
): Promise<MultiModelPlanResult> {
	return createMultiModelPlan(input, config);
}

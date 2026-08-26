/**
 * Deep Researcher Analysis Activities
 *
 * Activities for analyzing request complexity and decomposing
 * complex research questions into sub-tasks.
 *
 * Uses generateText + manual JSON parsing instead of generateObject to avoid
 * the OpenAI Responses API strict JSON schema validation issue in the
 * Vercel AI Gateway (which strips 'type' keys from enum properties when
 * routing to azure/openai /v1/responses endpoint).
 */

import { generateText } from "@repo/ai";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import type {
	ResearchComplexity,
	SubTask,
} from "../../workflows/deep-researcher";
import { getAiModel } from "../orchestrator/utils/model-selector";

// =============================================================================
// Heartbeat Helper
// =============================================================================

/**
 * Execute a long-running async operation while sending periodic heartbeats.
 * This prevents Temporal from timing out activities during AI API calls.
 */
async function withHeartbeat<T>(
	operation: Promise<T>,
	intervalMs = 10000,
): Promise<T> {
	const heartbeatInterval = setInterval(() => {
		heartbeat();
	}, intervalMs);

	try {
		return await operation;
	} finally {
		clearInterval(heartbeatInterval);
	}
}

// =============================================================================
// JSON Parsing Helper
// =============================================================================

/**
 * Extract and parse JSON from an LLM text response.
 * Handles markdown code blocks (```json ... ```) and bare JSON objects.
 */
function extractJson(text: string): unknown {
	// Strip markdown code fences
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = fenced ? fenced[1].trim() : text.trim();

	// Find the first { or [ to handle any preamble
	const start = raw.search(/[{[]/);
	if (start === -1) {
		throw new Error(
			`No JSON object found in response: ${raw.slice(0, 200)}`,
		);
	}
	return JSON.parse(raw.slice(start));
}

// =============================================================================
// Types
// =============================================================================

export interface AnalyzeComplexityInput {
	query: string;
	context?: string;
	userId: string;
	organizationId?: string;
}

export interface AnalyzeComplexityOutput {
	complexity: ResearchComplexity;
	reasoning: string;
	suggestedSubTaskCount: number;
}

export interface DecomposeTaskInput {
	query: string;
	context?: string;
	complexity: ResearchComplexity;
	maxSubTasks: number;
	userId: string;
	organizationId?: string;
}

export interface DecomposeTaskOutput {
	subTasks: SubTask[];
	decompositionReasoning: string;
}

export interface RefineSubTasksInput {
	originalQuery: string;
	currentSubTasks: SubTask[];
	previousResults: Array<{
		subTaskId: string;
		title: string;
		status: "completed" | "failed" | "timeout";
		findings: string;
		confidence: number;
		error?: string;
	}>;
	feedback: string;
	userId: string;
	organizationId?: string;
}

export interface RefineSubTasksOutput {
	subTasks: SubTask[];
	refinementReasoning: string;
}

// =============================================================================
// Schemas (used for validation only — NOT passed to generateObject)
// =============================================================================

const ComplexitySchema = z.object({
	complexity: z
		.enum(["simple", "medium", "complex"])
		.describe(
			"simple: can be answered directly, medium: needs 2-3 focused investigations, complex: needs 4-6 parallel investigations",
		),
	reasoning: z.string().describe("Why this complexity level was chosen"),
	suggestedSubTaskCount: z
		.number()
		.int()
		.min(1)
		.max(6)
		.describe("Recommended number of sub-tasks for this query"),
});

const SubTaskSchema = z.object({
	id: z.string().describe("Unique identifier for this sub-task"),
	title: z.string().describe("Short, descriptive title"),
	description: z
		.string()
		.describe("Detailed description of what to investigate"),
	focusArea: z.string().describe("The specific aspect or angle to focus on"),
	expectedOutput: z
		.string()
		.describe("What kind of output/findings are expected"),
});

const DecompositionSchema = z.object({
	subTasks: z.array(SubTaskSchema).describe("List of sub-tasks"),
	decompositionReasoning: z
		.string()
		.describe("Explanation of how the query was decomposed"),
});

// =============================================================================
// Activities
// =============================================================================

/**
 * Analyze the complexity of a research query.
 *
 * Classifies requests as:
 * - simple: Can be answered directly without decomposition
 * - medium: Needs 2-3 focused sub-investigations
 * - complex: Needs 4-6 parallel sub-investigations
 */
export async function analyzeComplexity(
	input: AnalyzeComplexityInput,
): Promise<AnalyzeComplexityOutput> {
	console.log("[DeepResearcher] Analyzing complexity", {
		queryPreview: input.query.slice(0, 100),
	});

	const model = await getAiModel(input.userId, input.organizationId, false);

	const prompt = `You are analyzing the complexity of a research question to determine how to investigate it.

## Research Question
${input.query}

${input.context ? `## Additional Context\n${input.context}` : ""}

## Classification Guidelines

**SIMPLE** requests:
- Can be answered with a single focused investigation
- Have a clear, specific answer
- Don't require multiple perspectives or sources
- Examples: "What is React?", "When was Python released?"

**MEDIUM** complexity requests:
- Need 2-3 different angles of investigation
- Require comparing a few sources or perspectives
- Have some nuance but aren't highly complex
- Examples: "Compare React and Vue for a new project", "What are best practices for API design?"

**COMPLEX** requests:
- Require 4-6 parallel investigations
- Need comprehensive, multi-faceted research
- Involve synthesizing many sources and perspectives
- Require deep analysis across multiple domains
- Examples: "How should we architect a microservices system for our enterprise?", "What is the current state of AI safety research and its implications?"

Analyze the query and classify its complexity.

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "complexity": "simple" | "medium" | "complex",
  "reasoning": "string explaining why",
  "suggestedSubTaskCount": number between 1 and 6
}`;

	// Wrap the AI call with heartbeats to prevent Temporal timeout
	const result = await withHeartbeat(
		generateText({
			model,
			prompt,
		}),
	);

	const parsed = ComplexitySchema.parse(extractJson(result.text));

	console.log("[DeepResearcher] Complexity analysis complete", {
		complexity: parsed.complexity,
		suggestedSubTasks: parsed.suggestedSubTaskCount,
	});

	return parsed;
}

/**
 * Decompose a complex research question into sub-tasks.
 *
 * Creates 2-6 focused sub-tasks that can be investigated in parallel.
 * Each sub-task has a specific focus area and expected output.
 */
export async function decomposeTask(
	input: DecomposeTaskInput,
): Promise<DecomposeTaskOutput> {
	console.log("[DeepResearcher] Decomposing task", {
		queryPreview: input.query.slice(0, 100),
		complexity: input.complexity,
		maxSubTasks: input.maxSubTasks,
	});

	const model = await getAiModel(input.userId, input.organizationId, false);

	// Determine number of sub-tasks based on complexity
	const targetSubTasks =
		input.complexity === "medium"
			? Math.min(3, input.maxSubTasks)
			: Math.min(6, input.maxSubTasks);

	const prompt = `You are decomposing a research question into parallel sub-investigations.

## Research Question
${input.query}

${input.context ? `## Additional Context\n${input.context}` : ""}

## Decomposition Guidelines

Create ${targetSubTasks} sub-tasks that:
1. **Cover different angles** - Each sub-task should investigate a distinct aspect
2. **Are independently executable** - Each can be researched in isolation
3. **Avoid overlap** - Minimize duplication between sub-tasks
4. **Are specific** - Clear scope and expected deliverable
5. **Together provide comprehensive coverage** - All sub-tasks combined should fully address the query

## Sub-Task Requirements

For each sub-task, provide:
- **id**: A unique identifier (e.g., "st-1", "st-2")
- **title**: A short, descriptive title (2-5 words)
- **description**: What specific investigation to perform (2-3 sentences)
- **focusArea**: The specific aspect or domain to focus on
- **expectedOutput**: What kind of findings or conclusions are expected

Create exactly ${targetSubTasks} sub-tasks.

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "subTasks": [
    {
      "id": "st-1",
      "title": "string",
      "description": "string",
      "focusArea": "string",
      "expectedOutput": "string"
    }
  ],
  "decompositionReasoning": "string explaining the decomposition approach"
}`;

	// Wrap the AI call with heartbeats to prevent Temporal timeout
	const result = await withHeartbeat(
		generateText({
			model,
			prompt,
		}),
	);

	const parsed = DecompositionSchema.parse(extractJson(result.text));

	console.log("[DeepResearcher] Task decomposition complete", {
		subTaskCount: parsed.subTasks.length,
		subTasks: parsed.subTasks.map((t) => t.title),
	});

	return parsed;
}

/**
 * Refine sub-tasks based on feedback from previous iteration.
 *
 * When the success criteria isn't met, this activity creates
 * refined sub-tasks that address the gaps identified.
 */
export async function refineSubTasks(
	input: RefineSubTasksInput,
): Promise<RefineSubTasksOutput> {
	console.log("[DeepResearcher] Refining sub-tasks", {
		currentSubTaskCount: input.currentSubTasks.length,
		previousResultsCount: input.previousResults.length,
	});

	const model = await getAiModel(input.userId, input.organizationId, false);

	// Build summary of previous results
	const previousSummary = input.previousResults
		.map(
			(r) =>
				`- **${r.title}** (${r.status}): ${r.status === "completed" ? `Findings: ${r.findings.slice(0, 200)}...` : `Error: ${r.error}`}`,
		)
		.join("\n");

	const prompt = `You are refining research sub-tasks based on feedback from a previous iteration.

## Original Research Question
${input.originalQuery}

## Previous Sub-Tasks and Results
${previousSummary}

## Feedback on Previous Results
${input.feedback}

## Current Sub-Tasks
${input.currentSubTasks.map((t) => `- ${t.title}: ${t.description}`).join("\n")}

## Refinement Guidelines

Create refined sub-tasks that:
1. **Address the feedback** - Focus on what was missing or insufficient
2. **Build on successful findings** - Don't repeat work that succeeded
3. **Target gaps** - Investigate areas not covered or poorly covered
4. **Maintain focus** - Each sub-task should be specific and actionable

Keep approximately the same number of sub-tasks (${input.currentSubTasks.length}), but adjust focus based on the feedback.

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "subTasks": [
    {
      "id": "st-1",
      "title": "string",
      "description": "string",
      "focusArea": "string",
      "expectedOutput": "string"
    }
  ],
  "decompositionReasoning": "string explaining the refinement approach"
}`;

	// Wrap the AI call with heartbeats to prevent Temporal timeout
	const result = await withHeartbeat(
		generateText({
			model,
			prompt,
		}),
	);

	const parsed = DecompositionSchema.parse(extractJson(result.text));

	console.log("[DeepResearcher] Sub-tasks refined", {
		refinedCount: parsed.subTasks.length,
	});

	return {
		subTasks: parsed.subTasks,
		refinementReasoning: parsed.decompositionReasoning,
	};
}

// =============================================================================
// Clarification Check
// =============================================================================

export interface CheckClarificationInput {
	query: string;
	context?: string;
	userId: string;
	organizationId?: string;
}

export interface CheckClarificationOutput {
	needsClarification: boolean;
	clarificationPrompt?: string;
	reasoning: string;
}

const ClarificationSchema = z.object({
	needsClarification: z
		.boolean()
		.describe("Whether the query is too ambiguous to research effectively"),
	clarificationPrompt: z
		.string()
		.nullable()
		.describe(
			"A concise question to ask the user for clarification (1-2 sentences), or null if no clarification is needed",
		),
	reasoning: z.string().describe("Brief explanation of the assessment"),
});

/**
 * Check if a research query needs clarification before proceeding.
 *
 * Only called for "complex" queries. Evaluates whether the query is
 * ambiguous, underspecified, or could be interpreted in multiple ways
 * that would lead to wasted research effort.
 */
export async function checkClarificationNeeded(
	input: CheckClarificationInput,
): Promise<CheckClarificationOutput> {
	console.log("[DeepResearcher] Checking if clarification needed", {
		queryLength: input.query.length,
	});

	const model = await getAiModel(input.userId, input.organizationId);

	const prompt = `You are evaluating whether a research query needs clarification before a deep research workflow proceeds.

## Query
${input.query}

${input.context ? `## Additional Context\n${input.context}` : ""}

## Guidelines

Only request clarification if the query is genuinely ambiguous in a way that would cause the research to go in a significantly wrong direction. Most queries can be researched as-is.

Request clarification ONLY if:
- The query could reasonably be interpreted in 2+ very different ways
- A key term is ambiguous and choosing wrong would waste all research effort
- The scope is so broad that narrowing would save significant time

Do NOT request clarification for:
- Queries that are clear enough to start researching
- Minor ambiguities that can be addressed in the final report
- Queries where a reasonable default interpretation exists

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "needsClarification": true | false,
  "clarificationPrompt": "string question for user, or null",
  "reasoning": "string brief explanation"
}`;

	const result = await withHeartbeat(
		generateText({
			model,
			prompt,
		}),
	);

	const parsed = ClarificationSchema.parse(extractJson(result.text));

	console.log("[DeepResearcher] Clarification check result", {
		needsClarification: parsed.needsClarification,
		reasoning: parsed.reasoning,
	});

	return {
		needsClarification: parsed.needsClarification,
		clarificationPrompt: parsed.clarificationPrompt ?? undefined,
		reasoning: parsed.reasoning,
	};
}

/**
 * Orchestrator Memory Activities
 *
 * Temporal activities for Qdrant-based semantic memory operations.
 * Complements Letta's structured memory with vector-based similarity search.
 *
 * Features:
 * - Store execution summaries as vector embeddings
 * - Semantic search for similar past tasks
 * - Hybrid routing suggestions (Letta + Qdrant)
 * - Negative memory (learning from failures)
 * - LLM-powered execution summaries
 * - Multi-tenant isolation
 */

import { createHash } from "node:crypto";
import { generateText } from "@repo/ai";
import {
	type ExecutionSummary,
	executionExists,
	generateEmbedding,
	searchSimilarExecutions,
	storeExecutionSummary,
} from "@repo/rag";
import type {
	FailureWarning,
	HybridRoutingResult,
	HybridRoutingSuggestion,
	SemanticMemoryResult,
	TaskStep,
} from "../workflows/orchestrator/types";
import {
	getRoutingSuggestions,
	type RoutingSuggestion,
} from "./letta-memory-activities";
import { getAiModel } from "./orchestrator/utils/model-selector";

// ============================================================================
// Types
// ============================================================================

export interface EmbedAndStoreTrajectoryInput {
	executionId: string;
	taskDescription: string;
	steps: TaskStep[];
	outcome: "success" | "partial" | "failure";
	durationMs: number;
	userId: string;
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	/** Error message if execution failed */
	errorMessage?: string;
	/** Use LLM to generate richer summary (default: true for failures, false otherwise) */
	useLLMSummary?: boolean;
}

export interface SearchSemanticMemoryInput {
	query: string;
	userId: string;
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	topK?: number;
	minSimilarity?: number;
	outcomeFilter?: "success" | "partial" | "failure";
}

export interface GetHybridRoutingSuggestionsInput {
	task: string;
	lettaAgentId: string | null;
	userId: string;
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	/** Include failure warnings from negative memory */
	includeFailureWarnings?: boolean;
}

export interface GenerateLLMSummaryInput {
	taskDescription: string;
	steps: TaskStep[];
	outcome: "success" | "partial" | "failure";
	errorMessage?: string;
	userId: string;
	organizationId?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a hash for task deduplication
 */
function generateTaskHash(task: string): string {
	const normalized = task.toLowerCase().trim().replace(/\s+/g, " ");
	return createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Generate a summary for embedding from execution data
 */
function generateExecutionSummary(
	taskDescription: string,
	steps: TaskStep[],
	outcome: string,
): string {
	const agentsUsed = [
		...new Set(steps.map((s) => s.executor).filter(Boolean)),
	];
	const toolsUsed = [
		...new Set(steps.flatMap((s) => s.toolsToUse || []).filter(Boolean)),
	];

	const summaryParts = [
		`Task: ${taskDescription}`,
		`Outcome: ${outcome}`,
		`Steps: ${steps.length}`,
	];

	if (agentsUsed.length > 0) {
		summaryParts.push(`Agents: ${agentsUsed.join(", ")}`);
	}
	if (toolsUsed.length > 0) {
		summaryParts.push(`Tools: ${toolsUsed.join(", ")}`);
	}

	// Add step descriptions for richer context
	const stepDescriptions = steps
		.slice(0, 5)
		.map((s, i) => `${i + 1}. ${s.description}`)
		.join("; ");
	if (stepDescriptions) {
		summaryParts.push(`Steps: ${stepDescriptions}`);
	}

	return summaryParts.join(". ");
}

/**
 * Calculate weighted hybrid score combining Letta and Qdrant confidence
 * Uses weighted average: (lettaScore * 0.6) + (qdrantScore * 0.4) + recencyBoost
 */
function calculateWeightedHybridScore(
	lettaConfidence: number,
	qdrantSimilarity: number,
	recencyBoost: number,
): number {
	// Convert Qdrant similarity (0-1) to confidence scale (0-100)
	const qdrantConfidence = qdrantSimilarity * 100;

	// Weighted average with Letta having slightly more weight (keyword matches are precise)
	const weightedScore = lettaConfidence * 0.6 + qdrantConfidence * 0.4;

	// Add recency boost and cap at 95
	return Math.min(Math.round(weightedScore + recencyBoost), 95);
}

// ============================================================================
// Activity: Generate LLM-Powered Summary
// ============================================================================

const LLM_SUMMARY_PROMPT = `You are a technical summarizer. Generate a concise, semantic-rich summary of this task execution that captures:
1. The core intent and goal of the task
2. Key actions taken and tools/agents used
3. The outcome and any notable results or errors

Keep the summary under 200 words. Focus on information useful for finding similar tasks in the future.

Task: {taskDescription}
Outcome: {outcome}
Steps taken:
{stepsSummary}
{errorSection}

Generate a narrative summary:`;

/**
 * Generate an LLM-powered summary for better semantic embeddings
 * Falls back to basic summary if LLM fails
 *
 * Uses dynamically configured AI model from user/org settings (FAST task type)
 */
export async function generateLLMSummary(
	input: GenerateLLMSummaryInput,
): Promise<string> {
	const {
		taskDescription,
		steps,
		outcome,
		errorMessage,
		userId,
		organizationId,
	} = input;

	// Generate basic summary as fallback
	const basicSummary = generateExecutionSummary(
		taskDescription,
		steps,
		outcome,
	);

	try {
		// Build step summary
		const stepsSummary = steps
			.slice(0, 8) // Limit to first 8 steps
			.map((s, i) => {
				const executor = s.executor ? ` [${s.executor}]` : "";
				const tools = s.toolsToUse?.length
					? ` using ${s.toolsToUse.join(", ")}`
					: "";
				return `${i + 1}. ${s.description}${executor}${tools} - ${s.status}`;
			})
			.join("\n");

		const errorSection = errorMessage
			? `\nError encountered: ${errorMessage}`
			: "";

		const prompt = LLM_SUMMARY_PROMPT.replace(
			"{taskDescription}",
			taskDescription,
		)
			.replace("{outcome}", outcome)
			.replace("{stepsSummary}", stepsSummary)
			.replace("{errorSection}", errorSection);

		// Use dynamically configured model from user/org AI provider settings
		// This is a simple summarization task, so we don't need tool calling
		const model = await getAiModel(userId, organizationId, false);
		const result = await generateText({
			model,
			prompt: `${prompt}\n\n[Keep response under 200 words]`,
		});

		const llmSummary = result.text?.trim();

		if (llmSummary && llmSummary.length > 50) {
			console.log(
				`[OrchestratorMemory] Generated LLM summary (${llmSummary.length} chars)`,
			);
			return llmSummary;
		}

		// Fall back to basic if LLM response is too short
		console.log("[OrchestratorMemory] LLM summary too short, using basic");
		return basicSummary;
	} catch (error) {
		console.warn(
			`[OrchestratorMemory] LLM summary failed, using basic: ${error}`,
		);
		return basicSummary;
	}
}

// ============================================================================
// Activity: Embed and Store Trajectory
// ============================================================================

/**
 * Generate embedding and store execution in Qdrant for semantic search
 * Uses LLM-powered summaries for failures by default for better semantic recall
 */
export async function embedAndStoreTrajectory(
	input: EmbedAndStoreTrajectoryInput,
): Promise<boolean> {
	const {
		executionId,
		taskDescription,
		steps,
		outcome,
		durationMs,
		userId,
		organizationId,
		errorMessage,
		useLLMSummary,
	} = input;

	console.log(`[OrchestratorMemory] Embedding execution ${executionId}...`);

	try {
		// Skip if already stored (idempotency for Temporal replays)
		// This avoids expensive LLM summary generation on replays
		const alreadyStored = await executionExists(executionId);
		if (alreadyStored) {
			console.log(
				`[OrchestratorMemory] Execution ${executionId} already stored, skipping`,
			);
			return true;
		}

		// Decide whether to use LLM summary
		// Default: use LLM for failures (captures error context better)
		const shouldUseLLM = useLLMSummary ?? outcome === "failure";

		let summary: string;
		if (shouldUseLLM) {
			summary = await generateLLMSummary({
				taskDescription,
				steps,
				outcome,
				errorMessage,
				userId,
				organizationId,
			});
		} else {
			summary = generateExecutionSummary(taskDescription, steps, outcome);
		}

		// Extract agents and tools used
		const agentsUsed = [
			...new Set(
				steps.map((s) => s.executor).filter(Boolean) as string[],
			),
		];
		const toolsUsed = [
			...new Set(
				steps.flatMap((s) => s.toolsToUse || []).filter(Boolean),
			),
		];

		// Generate embedding - credentials are fetched internally by generateEmbedding()
		const embeddingResult = await generateEmbedding(
			summary,
			{
				userId,
				organizationId,
				tags: [
					"orchestrator-memory",
					"execution-summary",
					outcome === "failure" ? "failure" : "success",
				],
			},
			undefined, // providerConfig is no longer needed
		);

		// Store in Qdrant
		const execution: ExecutionSummary = {
			id: executionId,
			taskDescription,
			taskHash: generateTaskHash(taskDescription),
			summary,
			agentsUsed,
			toolsUsed,
			outcome,
			durationMs,
			stepCount: steps.length,
			userId,
			organizationId,
			timestamp: new Date().toISOString(),
		};

		const stored = await storeExecutionSummary({
			execution,
			embedding: embeddingResult.embedding,
		});

		if (stored) {
			console.log(
				`✅ [OrchestratorMemory] Stored execution ${executionId} (${outcome}, ${steps.length} steps, LLM: ${shouldUseLLM})`,
			);
		}

		return stored;
	} catch (error) {
		console.error(
			`❌ [OrchestratorMemory] Failed to store execution: ${error}`,
		);
		return false;
	}
}

// ============================================================================
// Activity: Search Semantic Memory
// ============================================================================

/**
 * Search for similar past executions using semantic similarity
 */
export async function searchSemanticMemory(
	input: SearchSemanticMemoryInput,
): Promise<SemanticMemoryResult[]> {
	const {
		query,
		userId,
		organizationId,
		topK = 5,
		minSimilarity = 0.5,
		outcomeFilter,
	} = input;

	console.log(
		`[OrchestratorMemory] Searching for similar tasks: "${query.slice(0, 50)}..."`,
	);

	try {
		// Generate embedding - credentials are fetched internally by generateEmbedding()
		const embeddingResult = await generateEmbedding(
			query,
			{
				userId,
				organizationId,
				tags: ["orchestrator-memory", "semantic-search"],
			},
			undefined, // providerConfig is no longer needed
		);

		// Search Qdrant
		const results = await searchSimilarExecutions({
			queryEmbedding: embeddingResult.embedding,
			userId,
			organizationId,
			topK,
			minSimilarity,
			outcomeFilter,
		});

		// Convert to orchestrator types
		const memoryResults: SemanticMemoryResult[] = results.map((r) => ({
			execution: {
				id: r.execution.id,
				taskDescription: r.execution.taskDescription,
				taskHash: r.execution.taskHash,
				summary: r.execution.summary,
				agentsUsed: r.execution.agentsUsed,
				toolsUsed: r.execution.toolsUsed,
				outcome: r.execution.outcome,
				durationMs: r.execution.durationMs,
				stepCount: r.execution.stepCount,
				userId: r.execution.userId,
				organizationId: r.execution.organizationId,
				timestamp: r.execution.timestamp,
			},
			similarity: r.similarity,
		}));

		console.log(
			`[OrchestratorMemory] Found ${memoryResults.length} similar executions`,
		);

		return memoryResults;
	} catch (error) {
		console.error(
			`❌ [OrchestratorMemory] Semantic search failed: ${error}`,
		);
		return [];
	}
}

// ============================================================================
// Activity: Get Hybrid Routing Suggestions
// ============================================================================

/**
 * Calculate recency boost factor (0-15 points)
 * More recent executions get higher boost
 */
function calculateRecencyBoost(timestamp: string): number {
	const executionTime = new Date(timestamp).getTime();
	const now = Date.now();
	const ageMs = now - executionTime;

	// Age thresholds in milliseconds
	const ONE_HOUR = 60 * 60 * 1000;
	const ONE_DAY = 24 * ONE_HOUR;
	const ONE_WEEK = 7 * ONE_DAY;
	const ONE_MONTH = 30 * ONE_DAY;

	if (ageMs < ONE_HOUR) {
		return 15; // Very recent - max boost
	}
	if (ageMs < ONE_DAY) {
		return 12; // Within a day
	}
	if (ageMs < ONE_WEEK) {
		return 8; // Within a week
	}
	if (ageMs < ONE_MONTH) {
		return 4; // Within a month
	}
	return 0; // Older than a month - no boost
}

/**
 * Generate a failure warning message from a failed execution
 */
function generateFailureWarning(
	failedExecution: SemanticMemoryResult,
): FailureWarning {
	const { execution, similarity } = failedExecution;

	// Extract error info from summary (LLM summaries include error details)
	const errorMatch = execution.summary.match(
		/(?:error|failed|failure)[:\s]+([^.]+)/i,
	);
	const errorSummary = errorMatch?.[1]?.trim() || undefined;

	return {
		message: `A similar task "${execution.taskDescription.slice(0, 80)}..." failed previously.`,
		failedTask: execution.taskDescription,
		errorSummary,
		similarity,
		timestamp: execution.timestamp,
		executionId: execution.id,
	};
}

/**
 * Get routing suggestions combining Letta (keyword) and Qdrant (semantic) sources
 * with recency weighting, refined hybrid scoring, and negative memory warnings
 */
export async function getHybridRoutingSuggestions(
	input: GetHybridRoutingSuggestionsInput,
): Promise<HybridRoutingResult> {
	const {
		task,
		lettaAgentId,
		userId,
		organizationId,
		includeFailureWarnings = true,
	} = input;

	console.log("[OrchestratorMemory] Getting hybrid routing suggestions...");

	try {
		// Run all searches in parallel (success + failures)
		// Credentials are fetched internally by searchSemanticMemory()
		const searchPromises: [
			Promise<RoutingSuggestion[]>,
			Promise<SemanticMemoryResult[]>,
			Promise<SemanticMemoryResult[]>,
		] = [
			lettaAgentId
				? getRoutingSuggestions({ lettaAgentId, task })
				: Promise.resolve([] as RoutingSuggestion[]),
			searchSemanticMemory({
				query: task,
				userId,
				organizationId,
				topK: 5,
				minSimilarity: 0.6, // Higher threshold for routing
				outcomeFilter: "success", // Only successful executions for suggestions
			}),
			// Search for similar failures (negative memory)
			includeFailureWarnings
				? searchSemanticMemory({
						query: task,
						userId,
						organizationId,
						topK: 3,
						minSimilarity: 0.7, // Higher threshold for warnings
						outcomeFilter: "failure",
					})
				: Promise.resolve([]),
		];

		const [lettaSuggestions, semanticResults, failureResults] =
			await Promise.all(searchPromises);

		const suggestions: HybridRoutingSuggestion[] = [];
		const warnings: FailureWarning[] = [];

		// Add Letta suggestions (already have recency built into pattern matching)
		for (const letta of lettaSuggestions) {
			suggestions.push({
				agents: letta.agents,
				tools: [],
				confidence: letta.confidence,
				source: "letta",
				pattern: letta.pattern,
			});
		}

		// Add semantic suggestions with refined hybrid scoring
		for (const semantic of semanticResults) {
			const recencyBoost = calculateRecencyBoost(
				semantic.execution.timestamp,
			);

			// Check if this agent combination already exists from Letta
			const existingIdx = suggestions.findIndex(
				(s) =>
					s.agents.sort().join(",") ===
					semantic.execution.agentsUsed.sort().join(","),
			);

			if (existingIdx >= 0) {
				// Use weighted hybrid scoring for merged suggestions
				const lettaConfidence = suggestions[existingIdx].confidence;
				const hybridScore = calculateWeightedHybridScore(
					lettaConfidence,
					semantic.similarity,
					recencyBoost,
				);

				suggestions[existingIdx].confidence = hybridScore;
				suggestions[existingIdx].source = "hybrid";
				suggestions[existingIdx].tools = [
					...new Set([
						...suggestions[existingIdx].tools,
						...semantic.execution.toolsUsed,
					]),
				];
			} else {
				// Add new suggestion from semantic search
				const baseConfidence = Math.round(semantic.similarity * 80);
				suggestions.push({
					agents: semantic.execution.agentsUsed,
					tools: semantic.execution.toolsUsed,
					confidence: Math.min(baseConfidence + recencyBoost, 95),
					source: "qdrant",
					pattern: semantic.execution.taskDescription,
					executionId: semantic.execution.id,
				});
			}
		}

		// Generate warnings from failure matches (negative memory)
		for (const failure of failureResults) {
			warnings.push(generateFailureWarning(failure));
		}

		// Sort suggestions by confidence
		suggestions.sort((a, b) => b.confidence - a.confidence);

		// Sort warnings by similarity (most similar failures first)
		warnings.sort((a, b) => b.similarity - a.similarity);

		console.log(
			`[OrchestratorMemory] Generated ${suggestions.length} suggestions, ${warnings.length} warnings ` +
				`(letta: ${lettaSuggestions.length}, semantic: ${semanticResults.length}, failures: ${failureResults.length})`,
		);

		return {
			suggestions: suggestions.slice(0, 5),
			warnings: warnings.slice(0, 3),
			stats: {
				lettaMatches: lettaSuggestions.length,
				semanticMatches: semanticResults.length,
				failureMatches: failureResults.length,
			},
		};
	} catch (error) {
		console.error(
			`❌ [OrchestratorMemory] Hybrid routing failed: ${error}`,
		);
		return {
			suggestions: [],
			warnings: [],
			stats: { lettaMatches: 0, semanticMatches: 0, failureMatches: 0 },
		};
	}
}

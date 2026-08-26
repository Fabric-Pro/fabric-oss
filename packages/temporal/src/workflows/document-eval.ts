/**
 * Document Evaluation Workflow
 *
 * Runs Mastra-powered evaluation (NLP + LLM-as-judge) on a document.
 * Designed to be called as a fire-and-forget child workflow from document
 * generation workflows.
 *
 * Architecture:
 * - Parent workflow starts this with `startChild` + `parentClosePolicy: ABANDON`
 * - This workflow runs independently - parent doesn't wait for completion
 * - Eval results are persisted to database regardless of parent state
 *
 * Steps:
 * 1. Check cache (skip if recent eval exists for same content)
 * 2. Find best golden reference for document type
 * 3. Run NLP metrics (completeness, similarity, keywords, structure)
 * 4. Run LLM metrics (quality, coherence, alignment) - optional
 * 5. Calculate composite score with document-type-specific weights
 * 6. Save evaluation result to database
 */

import type { ProjectDocumentType } from "@repo/database";
import {
	ApplicationFailure,
	log,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as evalActivities from "../activities/document-eval/eval-storage";
import type { runLLMMetricsActivity as RunLLMMetricsActivityFn } from "../activities/document-eval/mastra-llm-metrics";
import type { runNLPMetrics as RunNLPMetricsFn } from "../activities/document-eval/mastra-nlp-metrics";

// =============================================================================
// Activity Proxies
// =============================================================================

// Storage activities - shorter timeout since they're just DB operations
const { checkEvalCache, getGoldenReference, saveEvalResult } = proxyActivities<
	typeof evalActivities
>({
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// NLP metrics - synchronous, fast
const { runNLPMetrics } = proxyActivities<{
	runNLPMetrics: typeof RunNLPMetricsFn;
}>({
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// LLM metrics - longer timeout, requires heartbeat
// Uses runLLMMetricsActivity which handles model resolution internally
const { runLLMMetricsActivity } = proxyActivities<{
	runLLMMetricsActivity: typeof RunLLMMetricsActivityFn;
}>({
	startToCloseTimeout: "5m",
	heartbeatTimeout: "30s",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// =============================================================================
// Types
// =============================================================================

export interface DocumentEvalInput {
	projectDocumentId: string;
	documentContent: string;
	documentVersion: number;
	documentType: ProjectDocumentType;
	userId: string;
	organizationId?: string;
	userPrompt?: string;
	threshold?: number; // Default: 70
	forceRefresh?: boolean; // Bypass cache
}

export interface DocumentEvalOutput {
	success: boolean;
	evalId?: string;
	passed?: boolean;
	overallScore?: number;
	evalMode: "hybrid" | "nlp_only";
	nlpScores?: {
		completeness: number;
		similarity: number;
		keywords: number;
		structure: number;
		overall: number;
	};
	llmScores?: {
		quality: number | null;
		coherence: number | null;
		alignment: number | null;
		overall: number | null;
	} | null;
	feedback?: string;
	suggestions?: string[];
	goldenReference?: {
		id: string;
		name: string;
		documentType: string;
	} | null;
	error?: string;
	executionTimeMs: number;
	costUsd: number;
}

// =============================================================================
// Scoring Weights (Document-Type Specific)
// =============================================================================

interface ScoringWeights {
	nlp: {
		completeness: number;
		similarity: number;
		keywords: number;
		structure: number;
	};
	overall: {
		nlp: number;
		llm: number;
	};
}

const SCORING_WEIGHTS: Record<string, ScoringWeights> = {
	prd: {
		nlp: {
			completeness: 0.35,
			similarity: 0.2,
			keywords: 0.3,
			structure: 0.15,
		},
		overall: { nlp: 0.35, llm: 0.65 },
	},
	architecture: {
		nlp: {
			completeness: 0.3,
			similarity: 0.25,
			keywords: 0.25,
			structure: 0.2,
		},
		overall: { nlp: 0.4, llm: 0.6 },
	},
	technical_spec: {
		nlp: {
			completeness: 0.35,
			similarity: 0.2,
			keywords: 0.3,
			structure: 0.15,
		},
		overall: { nlp: 0.35, llm: 0.65 },
	},
	api_spec: {
		nlp: {
			completeness: 0.4,
			similarity: 0.15,
			keywords: 0.35,
			structure: 0.1,
		},
		overall: { nlp: 0.45, llm: 0.55 },
	},
	user_story: {
		nlp: {
			completeness: 0.4,
			similarity: 0.15,
			keywords: 0.35,
			structure: 0.1,
		},
		overall: { nlp: 0.3, llm: 0.7 },
	},
	proposal: {
		nlp: {
			completeness: 0.3,
			similarity: 0.2,
			keywords: 0.25,
			structure: 0.25,
		},
		overall: { nlp: 0.35, llm: 0.65 },
	},
	general: {
		nlp: {
			completeness: 0.3,
			similarity: 0.25,
			keywords: 0.25,
			structure: 0.2,
		},
		overall: { nlp: 0.4, llm: 0.6 },
	},
};

function getWeightsForDocType(docType: string): ScoringWeights {
	return SCORING_WEIGHTS[docType.toLowerCase()] ?? SCORING_WEIGHTS.general;
}

function calculateOverallScore(params: {
	docType: string;
	nlpScores: {
		completeness: number;
		similarity: number;
		keywords: number;
		structure: number;
	};
	llmScores: {
		quality: number | null;
		coherence: number | null;
		alignment: number | null;
	} | null;
}): number {
	const weights = getWeightsForDocType(params.docType);

	// Calculate NLP composite with doc-specific weights
	const nlpComposite =
		params.nlpScores.completeness * weights.nlp.completeness +
		params.nlpScores.similarity * weights.nlp.similarity +
		params.nlpScores.keywords * weights.nlp.keywords +
		params.nlpScores.structure * weights.nlp.structure;

	if (!params.llmScores) {
		// NLP only mode: apply penalty for not having LLM validation
		return Math.round(nlpComposite * 0.9); // 10% penalty
	}

	// Calculate LLM composite (average of available scores)
	const llmMetrics = [
		params.llmScores.quality,
		params.llmScores.coherence,
		params.llmScores.alignment,
	].filter((s): s is number => s !== null);

	const llmComposite =
		llmMetrics.length > 0
			? llmMetrics.reduce((a, b) => a + b, 0) / llmMetrics.length
			: 0;

	// Weighted overall with doc-specific weights
	const overall =
		nlpComposite * weights.overall.nlp + llmComposite * weights.overall.llm;

	return Math.round(overall);
}

function buildFeedback(params: {
	passed: boolean;
	overallScore: number;
	nlpScore: number;
	llmScore?: number | null;
}): string {
	const parts: string[] = [];

	if (params.passed) {
		parts.push(
			`Document passed with a score of ${params.overallScore}/100.`,
		);
	} else {
		parts.push(`Document scored ${params.overallScore}/100.`);
	}

	if (params.llmScore !== null && params.llmScore !== undefined) {
		parts.push(`LLM score: ${params.llmScore}/100.`);
	} else {
		parts.push(`NLP score: ${params.nlpScore}/100.`);
	}

	return parts.join(" ");
}

function buildSuggestions(params: {
	missingSections: string[];
	missingPhrases: string[];
	structureIssues: string[];
	llmWeaknesses: string[];
}): string[] {
	const suggestions: string[] = [];

	if (params.missingSections.length > 0) {
		suggestions.push(
			`Add missing sections: ${params.missingSections.slice(0, 3).join(", ")}`,
		);
	}

	if (params.missingPhrases.length > 0) {
		suggestions.push(
			`Address missing topics: ${params.missingPhrases.slice(0, 3).join(", ")}`,
		);
	}

	if (params.structureIssues.length > 0) {
		suggestions.push(...params.structureIssues.slice(0, 2));
	}

	if (params.llmWeaknesses.length > 0) {
		suggestions.push(...params.llmWeaknesses.slice(0, 2));
	}

	return [...new Set(suggestions)].slice(0, 5);
}

// =============================================================================
// Workflow
// =============================================================================

/**
 * Document Evaluation Workflow
 *
 * Evaluates a document using Mastra-powered NLP and LLM-as-judge metrics.
 * Designed to run as a fire-and-forget child workflow.
 *
 * @param input - Evaluation input parameters
 * @returns Evaluation results
 */
export async function documentEvalWorkflow(
	input: DocumentEvalInput,
): Promise<DocumentEvalOutput> {
	const { workflowId } = workflowInfo();
	const startTime = Date.now();

	const {
		projectDocumentId,
		documentContent,
		documentVersion,
		documentType,
		userId,
		organizationId,
		userPrompt,
		threshold = 70,
		forceRefresh = false,
	} = input;

	log.info("🔍 Document Evaluation Workflow Started", {
		projectDocumentId,
		documentType,
		userId,
		organizationId,
		contentLength: documentContent?.length,
		threshold,
		forceRefresh,
	});

	try {
		// Step 1: Check cache
		if (!forceRefresh) {
			log.info("Step 1: Checking evaluation cache");
			const cacheResult = await checkEvalCache({
				projectDocumentId,
				documentContent,
				userId,
				organizationId,
			});

			if (cacheResult.cached && cacheResult.result) {
				log.info("✅ Cache hit - returning cached evaluation", {
					evalId: cacheResult.result.evalId,
					passed: cacheResult.result.passed,
					overallScore: cacheResult.result.overallScore,
				});

				return {
					success: true,
					evalId: cacheResult.result.evalId,
					passed: cacheResult.result.passed,
					overallScore: cacheResult.result.overallScore,
					evalMode: cacheResult.result.evalMode,
					nlpScores: cacheResult.result.nlpScores,
					llmScores: cacheResult.result.llmScores,
					feedback: cacheResult.result.feedback,
					suggestions: cacheResult.result.suggestions,
					goldenReference: cacheResult.result.goldenReference,
					executionTimeMs: Date.now() - startTime,
					costUsd: 0, // Cached - no cost
				};
			}
			log.info("Cache miss - proceeding with evaluation");
		}

		// Step 2: Get golden reference
		log.info("Step 2: Finding best golden reference", { documentType });
		const goldenRefResult = await getGoldenReference({
			documentType,
			userId,
			organizationId,
		});

		log.info("Golden reference result", {
			found: goldenRefResult.found,
			name: goldenRefResult.goldenReference?.name,
			requiredSectionsCount: goldenRefResult.requiredSections.length,
		});

		// Step 3: Run NLP metrics
		log.info("Step 3: Running NLP metrics");
		const nlpResult = await runNLPMetrics({
			documentContent,
			documentType,
			requiredSections: goldenRefResult.requiredSections,
			keyPhrases: goldenRefResult.goldenReference?.keyPhrases ?? [],
			goldenContent: goldenRefResult.goldenReference?.content,
		});

		log.info("NLP metrics complete", {
			overallScore: nlpResult.overallScore,
			completeness: nlpResult.completeness.score,
			similarity: nlpResult.similarity.score,
			keywords: nlpResult.keywords.score,
			structure: nlpResult.structure.score,
			executionTimeMs: nlpResult.executionTimeMs,
		});

		// Step 4: Run LLM metrics (model resolution happens inside the activity)
		log.info("Step 4: Running LLM metrics");

		let llmResult: Awaited<
			ReturnType<typeof RunLLMMetricsActivityFn>
		> | null = null;

		try {
			llmResult = await runLLMMetricsActivity({
				documentContent,
				documentType,
				expectedSections: goldenRefResult.requiredSections,
				userPrompt,
				userId,
				organizationId,
			});

			if (llmResult) {
				log.info("LLM metrics complete", {
					overallScore: llmResult.overallScore,
					qualityScore: llmResult.quality?.score,
					coherenceScore: llmResult.coherence?.score,
					alignmentScore: llmResult.alignment?.score,
					executionTimeMs: llmResult.executionTimeMs,
					costUsd: llmResult.costUsd,
					provider: llmResult.provider,
					model: llmResult.model,
				});
			} else {
				log.info("No LLM model configured - using NLP-only mode");
			}
		} catch (llmError) {
			log.warn("LLM metrics failed, continuing with NLP-only", {
				error:
					llmError instanceof Error
						? llmError.message
						: "Unknown error",
			});
			// Continue without LLM - will use NLP-only mode
		}

		// Step 5: Calculate scores
		log.info("Step 5: Calculating composite scores");
		const evalMode = llmResult ? "hybrid" : "nlp_only";

		const nlpScoresForCalc = {
			completeness: nlpResult.completeness.score,
			similarity: nlpResult.similarity.score,
			keywords: nlpResult.keywords.score,
			structure: nlpResult.structure.score,
		};

		const llmScoresForCalc = llmResult
			? {
					quality: llmResult.quality?.score ?? null,
					coherence: llmResult.coherence?.score ?? null,
					alignment: llmResult.alignment?.score ?? null,
				}
			: null;

		const overallScore = calculateOverallScore({
			docType: documentType,
			nlpScores: nlpScoresForCalc,
			llmScores: llmScoresForCalc,
		});

		const passed = overallScore >= threshold;

		const nlpScores = {
			completeness: nlpResult.completeness.score,
			similarity: nlpResult.similarity.score,
			keywords: nlpResult.keywords.score,
			structure: nlpResult.structure.score,
			overall: nlpResult.overallScore,
		};

		const llmScores = llmResult
			? {
					quality: llmResult.quality?.score ?? null,
					coherence: llmResult.coherence?.score ?? null,
					alignment: llmResult.alignment?.score ?? null,
					overall: llmResult.overallScore,
				}
			: null;

		const feedback = buildFeedback({
			passed,
			overallScore,
			nlpScore: nlpResult.overallScore,
			llmScore: llmResult?.overallScore ?? null,
		});

		const suggestions = buildSuggestions({
			missingSections: nlpResult.completeness.details.missing,
			missingPhrases: nlpResult.keywords.details.missing,
			structureIssues: nlpResult.structure.details.missing,
			llmWeaknesses:
				(llmResult?.quality?.details?.weaknesses as string[]) ?? [],
		});

		log.info("Scores calculated", {
			evalMode,
			overallScore,
			passed,
			threshold,
		});

		// Step 6: Save to database
		log.info("Step 6: Saving evaluation to database");
		const saveResult = await saveEvalResult({
			projectDocumentId,
			documentContent,
			documentVersion,
			documentType,
			userId,
			organizationId,
			workflowId,
			threshold,
			overallScore,
			passed,
			evalMode,
			nlpScores,
			llmScores,
			feedback,
			suggestions,
			missingSections: nlpResult.completeness.details.missing,
			missingPhrases: nlpResult.keywords.details.missing,
			structureIssues: nlpResult.structure.details.missing,
			executionTimeMs: Date.now() - startTime,
			costUsd: llmResult?.costUsd ?? 0,
			nlpDurationMs: nlpResult.executionTimeMs,
			llmDurationMs: llmResult?.executionTimeMs,
			llmProvider: llmResult?.provider,
			llmModel: llmResult?.model,
		});

		const totalDuration = Date.now() - startTime;

		log.info("🎉 Document Evaluation Workflow Complete", {
			evalId: saveResult.evalId,
			passed,
			overallScore,
			evalMode,
			totalDurationMs: totalDuration,
			costUsd: llmResult?.costUsd ?? 0,
		});

		return {
			success: true,
			evalId: saveResult.evalId,
			passed,
			overallScore,
			evalMode,
			nlpScores,
			llmScores,
			feedback,
			suggestions,
			goldenReference: saveResult.goldenReference,
			executionTimeMs: totalDuration,
			costUsd: llmResult?.costUsd ?? 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		const totalDuration = Date.now() - startTime;

		log.error("❌ Document Evaluation Workflow Failed", {
			error: errorMessage,
			projectDocumentId,
			documentType,
			totalDurationMs: totalDuration,
		});

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DOCUMENT_EVAL_FAILED",
		);
	}
}

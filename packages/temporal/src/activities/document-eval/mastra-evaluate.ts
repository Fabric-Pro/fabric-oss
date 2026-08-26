/**
 * Mastra-powered document evaluation activity.
 */

import { getRequiredGroupsForDocType } from "@repo/agent-prompts";
import type { Prisma, ProjectDocumentType } from "@repo/database";
import { createDocumentEval, findBestGoldenReference } from "@repo/database";
import { heartbeat } from "@temporalio/activity";
import { generateContentHash, getCachedEval } from "./eval-cache";
import { resolveEvalModel, toMastraModelConfig } from "./mastra-config";
import { runLLMMetrics } from "./mastra-llm-metrics";
import { runNLPMetrics } from "./mastra-nlp-metrics";

/**
 * Safe heartbeat wrapper that handles non-activity contexts gracefully
 */
function safeHeartbeat(details?: unknown): void {
	try {
		heartbeat(details);
	} catch (_error) {
		// Not in an activity context (e.g., during testing)
		// Silently ignore - this is expected behavior for non-activity contexts
	}
}

// ============================================================================
// EVAL_VERSION 3: Dynamic Scoring Weights Per Document Type
// ============================================================================

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
		overall: { nlp: 0.45, llm: 0.55 }, // More NLP weight for structured API docs
	},
	user_story: {
		nlp: {
			completeness: 0.4,
			similarity: 0.15,
			keywords: 0.35,
			structure: 0.1,
		},
		overall: { nlp: 0.3, llm: 0.7 }, // More LLM weight for narrative quality
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

// EVAL_VERSION 3: Enhanced evaluation with tighter rules and dynamic scoring
const EVAL_VERSION = 3;

export interface MastraEvalInput {
	projectDocumentId: string;
	documentContent: string;
	documentVersion: number;
	documentType: ProjectDocumentType;
	userId: string;
	organizationId?: string;
	workflowId?: string;
	userPrompt?: string;
	threshold?: number;
	forceRefresh?: boolean;
}

export interface MastraEvalResult {
	evalId: string;
	passed: boolean;
	overallScore: number;
	threshold: number;
	evalMode: "hybrid" | "nlp_only";
	nlpScores: {
		completeness: number;
		similarity: number;
		keywords: number;
		structure: number;
		overall: number;
	};
	llmScores: {
		quality: number | null;
		coherence: number | null;
		alignment: number | null;
		overall: number | null;
	} | null;
	feedback: string;
	suggestions: string[];
	goldenReference: {
		id: string;
		name: string;
		documentType: string;
	} | null;
	executionTimeMs: number;
	costUsd: number;
	contentHash: string;
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

export async function evaluateDocumentWithMastra(
	input: MastraEvalInput,
): Promise<MastraEvalResult> {
	console.log("============================================");
	console.log("[Mastra Eval] START - evaluateDocumentWithMastra called");
	console.log(`[Mastra Eval] EVAL_VERSION = ${EVAL_VERSION}`);
	console.log("[Mastra Eval] Input:", {
		projectDocumentId: input.projectDocumentId,
		documentType: input.documentType,
		userId: input.userId,
		organizationId: input.organizationId,
		contentLength: input.documentContent?.length,
	});
	console.log("============================================");

	const startTime = Date.now();
	const {
		projectDocumentId,
		documentContent,
		documentVersion,
		documentType,
		userId,
		organizationId,
		workflowId,
		userPrompt,
		threshold = 70,
		forceRefresh = false,
	} = input;

	const contentHash = generateContentHash(documentContent);

	// Send initial heartbeat
	safeHeartbeat({
		phase: "initializing",
		message: "Starting document evaluation",
		progress: 0,
	});

	if (!forceRefresh) {
		const cached = await getCachedEval({
			projectDocumentId,
			contentHash,
			evalVersion: EVAL_VERSION,
			userId,
			organizationId,
		});

		if (cached) {
			return {
				evalId: cached.id,
				passed: cached.passed,
				overallScore: cached.overallScore,
				threshold: cached.threshold,
				evalMode: cached.evalMode as "hybrid" | "nlp_only",
				nlpScores: cached.nlpScores as MastraEvalResult["nlpScores"],
				llmScores: cached.llmScores as MastraEvalResult["llmScores"],
				feedback: cached.feedback ?? "",
				suggestions: cached.suggestions ?? [],
				goldenReference: cached.goldenReference
					? {
							id: cached.goldenReference.id,
							name: cached.goldenReference.name,
							documentType: cached.goldenReference.documentType,
						}
					: null,
				executionTimeMs: 0,
				costUsd: 0,
				contentHash,
			};
		}
	}

	const goldenReference = await findBestGoldenReference({
		documentType,
		userId,
		organizationId,
	});

	const requiredSections = goldenReference?.requiredSections?.length
		? goldenReference.requiredSections
		: getRequiredGroupsForDocType(documentType);

	// Send heartbeat before NLP metrics
	safeHeartbeat({
		phase: "nlp_metrics",
		message: "Running NLP metrics",
		progress: 20,
	});

	console.log("[Mastra Eval] Running NLP metrics...");
	const nlpResult = await runNLPMetrics({
		documentContent,
		documentType,
		requiredSections,
		keyPhrases: goldenReference?.keyPhrases ?? [],
		goldenContent: goldenReference?.content,
	});
	console.log("[Mastra Eval] NLP metrics complete:", {
		overallScore: nlpResult.overallScore,
		executionTimeMs: nlpResult.executionTimeMs,
	});

	// Send heartbeat after NLP metrics
	safeHeartbeat({
		phase: "model_resolution",
		message: "Resolving LLM model for evaluation",
		progress: 40,
	});

	console.log("[Mastra Eval] Resolving LLM model for EVAL task...");
	const llmModel = await resolveEvalModel({ userId, organizationId });

	console.log("[Mastra Eval] LLM Model Resolution:", {
		hasModel: !!llmModel,
		provider: llmModel?.metadata?.provider,
		modelString: llmModel?.metadata?.modelString,
		userId,
		organizationId,
	});

	// Send heartbeat before LLM metrics (this is the long-running part)
	safeHeartbeat({
		phase: "llm_metrics",
		message: "Running LLM-based evaluation metrics",
		progress: 50,
	});

	const llmResult = llmModel?.model
		? await runLLMMetrics({
				documentContent,
				documentType,
				expectedSections: requiredSections,
				userPrompt,
				provider: llmModel.metadata.provider,
				model: llmModel.metadata.modelString,
				modelConfig: toMastraModelConfig(llmModel.model),
				organizationId,
				onUsageTracked: llmModel.trackUsage,
			})
		: null;

	// Send heartbeat after LLM metrics
	safeHeartbeat({
		phase: "finalizing",
		message: "Finalizing evaluation results",
		progress: 90,
	});

	console.log("[Mastra Eval] LLM Result:", {
		hasResult: !!llmResult,
		provider: llmResult?.provider,
		model: llmResult?.model,
		overallScore: llmResult?.overallScore,
		qualityScore: llmResult?.quality?.score,
		coherenceScore: llmResult?.coherence?.score,
		alignmentScore: llmResult?.alignment?.score,
		executionTimeMs: llmResult?.executionTimeMs,
		costUsd: llmResult?.costUsd,
	});

	const evalMode = llmResult ? "hybrid" : "nlp_only";
	console.log(`[Mastra Eval] Eval Mode: ${evalMode}`);

	// EVAL_VERSION 3: Use document-type specific scoring weights
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

	if (!goldenReference) {
		return {
			evalId: "",
			passed,
			overallScore,
			threshold,
			evalMode,
			nlpScores,
			llmScores,
			feedback,
			suggestions,
			goldenReference: null,
			executionTimeMs: Date.now() - startTime,
			costUsd: llmResult?.costUsd ?? 0,
			contentHash,
		};
	}

	// Use document-type-specific weights for metrics (consistent with calculateOverallScore)
	const weights = getWeightsForDocType(documentType);

	const metrics = [
		{
			metricName: "nlp_completeness",
			category: "structure" as const,
			score: nlpScores.completeness,
			weight: weights.nlp.completeness,
		},
		{
			metricName: "nlp_similarity",
			category: "similarity" as const,
			score: nlpScores.similarity,
			weight: weights.nlp.similarity,
		},
		{
			metricName: "nlp_keywords",
			category: "content" as const,
			score: nlpScores.keywords,
			weight: weights.nlp.keywords,
		},
		{
			metricName: "nlp_structure",
			category: "quality" as const,
			score: nlpScores.structure,
			weight: weights.nlp.structure,
		},
	];

	if (llmScores) {
		// LLM metrics share the overall.llm weight equally (3 metrics)
		const llmMetricWeight = weights.overall.llm / 3;
		if (llmScores.quality !== null) {
			metrics.push({
				metricName: "llm_quality",
				category: "quality" as const,
				score: llmScores.quality,
				weight: llmMetricWeight,
			});
		}
		if (llmScores.coherence !== null) {
			metrics.push({
				metricName: "llm_coherence",
				category: "quality" as const,
				score: llmScores.coherence,
				weight: llmMetricWeight,
			});
		}
		if (llmScores.alignment !== null) {
			metrics.push({
				metricName: "llm_alignment",
				category: "quality" as const,
				score: llmScores.alignment,
				weight: llmMetricWeight,
			});
		}
	}

	console.log("[Mastra Eval] Saving evaluation to database...");
	console.log("[Mastra Eval] Data to save:", {
		evalVersion: EVAL_VERSION,
		evalMode,
		llmProvider: llmModel?.metadata.provider,
		llmModel: llmModel?.metadata.modelString,
		hasLlmScores: !!llmScores,
		hasNlpScores: !!nlpScores,
		overallScore,
		passed,
	});

	const evalRecord = await createDocumentEval({
		projectDocumentId,
		documentVersion,
		goldenReferenceId: goldenReference.id,
		overallScore,
		passed,
		threshold,
		structureScore: nlpScores.structure,
		coverageScore: nlpScores.completeness,
		similarityScore: nlpScores.similarity,
		qualityScore: llmScores?.quality ?? nlpScores.overall,
		feedback,
		suggestions,
		missingSections: nlpResult.completeness.details.missing,
		missingPhrases: nlpResult.keywords.details.missing,
		workflowId,
		executionTimeMs: Date.now() - startTime,
		userId,
		organizationId,
		metrics,
		evalVersion: EVAL_VERSION,
		contentHash,
		costUsd: llmResult?.costUsd ?? 0,
		evalMode,
		llmProvider: llmModel?.metadata.provider,
		llmModel: llmModel?.metadata.modelString,
		nlpDurationMs: nlpResult.executionTimeMs,
		llmDurationMs: llmResult?.executionTimeMs,
		nlpScores: nlpScores as Prisma.InputJsonValue,
		llmScores: llmScores ? (llmScores as Prisma.InputJsonValue) : undefined,
	});

	console.log("[Mastra Eval] Saved to database with ID:", evalRecord.id);
	console.log("[Mastra Eval] COMPLETE");
	console.log("============================================");

	return {
		evalId: evalRecord.id,
		passed,
		overallScore,
		threshold,
		evalMode,
		nlpScores,
		llmScores,
		feedback,
		suggestions,
		goldenReference: {
			id: goldenReference.id,
			name: goldenReference.name,
			documentType: goldenReference.documentType,
		},
		executionTimeMs: Date.now() - startTime,
		costUsd: llmResult?.costUsd ?? 0,
		contentHash,
	};
}

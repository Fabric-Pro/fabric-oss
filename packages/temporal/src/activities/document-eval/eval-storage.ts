/**
 * Evaluation Result Storage Activity
 *
 * Handles persisting document evaluation results to the database.
 * Extracted from mastra-evaluate.ts to support the new workflow architecture.
 */

import { getRequiredGroupsForDocType } from "@repo/agent-prompts";
import type { Prisma, ProjectDocumentType } from "@repo/database";
import { createDocumentEval, findBestGoldenReference } from "@repo/database";
import { generateContentHash, getCachedEval } from "./eval-cache";

// EVAL_VERSION 3: Enhanced evaluation with tighter rules and dynamic scoring
const EVAL_VERSION = 3;

// =============================================================================
// Types
// =============================================================================

export interface NLPScores {
	completeness: number;
	similarity: number;
	keywords: number;
	structure: number;
	overall: number;
}

export interface LLMScores {
	quality: number | null;
	coherence: number | null;
	alignment: number | null;
	overall: number | null;
}

export interface SaveEvalResultInput {
	projectDocumentId: string;
	documentContent: string;
	documentVersion: number;
	documentType: ProjectDocumentType;
	userId: string;
	organizationId?: string;
	workflowId?: string;
	threshold: number;
	overallScore: number;
	passed: boolean;
	evalMode: "hybrid" | "nlp_only";
	nlpScores: NLPScores;
	llmScores: LLMScores | null;
	feedback: string;
	suggestions: string[];
	missingSections: string[];
	missingPhrases: string[];
	structureIssues: string[];
	executionTimeMs: number;
	costUsd: number;
	nlpDurationMs: number;
	llmDurationMs?: number;
	llmProvider?: string;
	llmModel?: string;
}

export interface SaveEvalResultOutput {
	evalId: string;
	goldenReference: {
		id: string;
		name: string;
		documentType: string;
	} | null;
	contentHash: string;
}

export interface CheckEvalCacheInput {
	projectDocumentId: string;
	documentContent: string;
	userId: string;
	organizationId?: string;
}

export interface CheckEvalCacheOutput {
	cached: boolean;
	result?: {
		evalId: string;
		passed: boolean;
		overallScore: number;
		threshold: number;
		evalMode: "hybrid" | "nlp_only";
		nlpScores: NLPScores;
		llmScores: LLMScores | null;
		feedback: string;
		suggestions: string[];
		goldenReference: {
			id: string;
			name: string;
			documentType: string;
		} | null;
		contentHash: string;
	};
}

export interface GetGoldenReferenceInput {
	documentType: ProjectDocumentType;
	userId: string;
	organizationId?: string;
}

export interface GetGoldenReferenceOutput {
	found: boolean;
	goldenReference?: {
		id: string;
		name: string;
		documentType: string;
		content: string;
		requiredSections: string[];
		keyPhrases: string[];
	};
	requiredSections: string[];
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Check if a cached evaluation exists for the given document content
 */
export async function checkEvalCache(
	input: CheckEvalCacheInput,
): Promise<CheckEvalCacheOutput> {
	const { projectDocumentId, documentContent, userId, organizationId } =
		input;

	const contentHash = generateContentHash(documentContent);

	const cached = await getCachedEval({
		projectDocumentId,
		contentHash,
		evalVersion: EVAL_VERSION,
		userId,
		organizationId,
	});

	if (cached) {
		return {
			cached: true,
			result: {
				evalId: cached.id,
				passed: cached.passed,
				overallScore: cached.overallScore,
				threshold: cached.threshold,
				evalMode: cached.evalMode as "hybrid" | "nlp_only",
				nlpScores: cached.nlpScores as unknown as NLPScores,
				llmScores: cached.llmScores as unknown as LLMScores | null,
				feedback: cached.feedback ?? "",
				suggestions: cached.suggestions ?? [],
				goldenReference: cached.goldenReference
					? {
							id: cached.goldenReference.id,
							name: cached.goldenReference.name,
							documentType: cached.goldenReference.documentType,
						}
					: null,
				contentHash,
			},
		};
	}

	return { cached: false };
}

/**
 * Find the best matching golden reference for a document type
 */
export async function getGoldenReference(
	input: GetGoldenReferenceInput,
): Promise<GetGoldenReferenceOutput> {
	const { documentType, userId, organizationId } = input;

	const goldenReference = await findBestGoldenReference({
		documentType,
		userId,
		organizationId,
	});

	const requiredSections = goldenReference?.requiredSections?.length
		? goldenReference.requiredSections
		: getRequiredGroupsForDocType(documentType);

	if (goldenReference) {
		return {
			found: true,
			goldenReference: {
				id: goldenReference.id,
				name: goldenReference.name,
				documentType: goldenReference.documentType,
				content: goldenReference.content,
				requiredSections: goldenReference.requiredSections,
				keyPhrases: goldenReference.keyPhrases,
			},
			requiredSections,
		};
	}

	return {
		found: false,
		requiredSections,
	};
}

/**
 * Save evaluation result to the database
 */
export async function saveEvalResult(
	input: SaveEvalResultInput,
): Promise<SaveEvalResultOutput> {
	const {
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
		missingSections,
		missingPhrases,
		executionTimeMs,
		costUsd,
		nlpDurationMs,
		llmDurationMs,
		llmProvider,
		llmModel,
	} = input;

	console.log("[saveEvalResult] Starting save", {
		projectDocumentId,
		documentType,
		userId,
		organizationId,
		overallScore,
		passed,
	});

	const contentHash = generateContentHash(documentContent);

	// Find golden reference for saving (optional - can evaluate without one)
	const goldenReference = await findBestGoldenReference({
		documentType,
		userId,
		organizationId,
	});

	console.log("[saveEvalResult] Golden reference lookup", {
		found: !!goldenReference,
		goldenReferenceId: goldenReference?.id ?? null,
	});

	// Build metrics array with null fallbacks to prevent constraint violations
	const metrics = [
		{
			metricName: "nlp_completeness",
			category: "structure" as const,
			score: nlpScores.completeness ?? 0,
			weight: 0.4,
		},
		{
			metricName: "nlp_similarity",
			category: "similarity" as const,
			score: nlpScores.similarity ?? 0,
			weight: 0.25,
		},
		{
			metricName: "nlp_keywords",
			category: "content" as const,
			score: nlpScores.keywords ?? 0,
			weight: 0.25,
		},
		{
			metricName: "nlp_structure",
			category: "quality" as const,
			score: nlpScores.structure ?? 0,
			weight: 0.2,
		},
	];

	if (llmScores) {
		if (llmScores.quality !== null) {
			metrics.push({
				metricName: "llm_quality",
				category: "quality" as const,
				score: llmScores.quality,
				weight: 0.6,
			});
		}
		if (llmScores.coherence !== null) {
			metrics.push({
				metricName: "llm_coherence",
				category: "quality" as const,
				score: llmScores.coherence,
				weight: 0.6,
			});
		}
		if (llmScores.alignment !== null) {
			metrics.push({
				metricName: "llm_alignment",
				category: "quality" as const,
				score: llmScores.alignment,
				weight: 0.6,
			});
		}
	}

	console.log("[saveEvalResult] Creating document eval record...");

	try {
		// Ensure all required numeric fields have valid values (prevent null constraint violations)
		const safeStructureScore = nlpScores.structure ?? 0;
		const safeCoverageScore = nlpScores.completeness ?? 0;
		const safeSimilarityScore = nlpScores.similarity ?? 0;
		const safeQualityScore = llmScores?.quality ?? nlpScores.overall ?? 0;
		const safeOverallScore = overallScore ?? 0;

		const evalRecord = await createDocumentEval({
			projectDocumentId,
			documentVersion,
			goldenReferenceId: goldenReference?.id ?? null,
			overallScore: safeOverallScore,
			passed,
			threshold,
			structureScore: safeStructureScore,
			coverageScore: safeCoverageScore,
			similarityScore: safeSimilarityScore,
			qualityScore: safeQualityScore,
			feedback,
			suggestions,
			missingSections,
			missingPhrases,
			workflowId,
			executionTimeMs,
			userId,
			organizationId,
			metrics,
			evalVersion: EVAL_VERSION,
			contentHash,
			costUsd,
			evalMode,
			llmProvider,
			llmModel,
			nlpDurationMs,
			llmDurationMs,
			nlpScores: nlpScores as unknown as Prisma.InputJsonValue,
			llmScores: llmScores
				? (llmScores as unknown as Prisma.InputJsonValue)
				: undefined,
		});

		console.log("[saveEvalResult] ✅ Eval record created", {
			evalId: evalRecord.id,
			passed: evalRecord.passed,
			overallScore: evalRecord.overallScore,
		});

		return {
			evalId: evalRecord.id,
			goldenReference: goldenReference
				? {
						id: goldenReference.id,
						name: goldenReference.name,
						documentType: goldenReference.documentType,
					}
				: null,
			contentHash,
		};
	} catch (error) {
		console.error("[saveEvalResult] ❌ Failed to create eval record", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			projectDocumentId,
			documentType,
		});
		throw error;
	}
}

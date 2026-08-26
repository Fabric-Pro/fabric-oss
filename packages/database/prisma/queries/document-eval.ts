/**
 * Database queries for Document Evaluation system
 * Handles golden references and evaluation results
 */

import {
	db,
	type GoldenReferenceScope,
	type Prisma,
	type ProjectDocumentType,
} from "../client";

// =============================================================================
// Types
// =============================================================================

export interface EvalMetricInput {
	metricName: string;
	category: "structure" | "content" | "quality" | "similarity";
	score: number;
	weight?: number;
	rawValue?: number;
	description?: string;
	metadata?: Prisma.InputJsonValue;
}

export interface CreateEvalInput {
	projectDocumentId: string;
	documentVersion: number;
	goldenReferenceId?: string | null;
	overallScore: number;
	passed: boolean;
	threshold?: number;
	structureScore: number;
	coverageScore: number;
	similarityScore: number;
	qualityScore: number;
	evalVersion?: number;
	contentHash?: string;
	costUsd?: number;
	evalMode?: string;
	llmProvider?: string;
	llmModel?: string;
	nlpDurationMs?: number;
	llmDurationMs?: number;
	nlpScores?: Prisma.InputJsonValue;
	llmScores?: Prisma.InputJsonValue;
	feedback?: string;
	suggestions?: string[];
	missingSections?: string[];
	missingPhrases?: string[];
	workflowId?: string;
	executionTimeMs?: number;
	userId: string;
	organizationId?: string;
	metrics?: EvalMetricInput[];
}

export interface GoldenReferenceInput {
	documentType: ProjectDocumentType;
	name: string;
	description?: string;
	content: string;
	projectContext?: Prisma.InputJsonValue;
	requiredSections?: string[];
	keyPhrases?: string[];
	scope?: GoldenReferenceScope;
	userId?: string;
	organizationId?: string;
}

// =============================================================================
// Golden Reference Queries
// =============================================================================

/**
 * Create a new golden reference document
 */
export async function createGoldenReference(data: GoldenReferenceInput) {
	const scope = data.scope || "SYSTEM";

	// SECURITY: Validate scope matches tenant fields
	if (scope === "USER" && !data.userId) {
		throw new Error(
			"USER scope requires userId - golden reference must belong to a user",
		);
	}
	if (scope === "ORG" && !data.organizationId) {
		throw new Error(
			"ORG scope requires organizationId - golden reference must belong to an organization",
		);
	}
	if (scope === "SYSTEM" && (data.userId || data.organizationId)) {
		throw new Error(
			"SYSTEM scope cannot have userId or organizationId - system references are global",
		);
	}

	return await db.goldenReference.create({
		data: {
			documentType: data.documentType,
			name: data.name,
			description: data.description,
			content: data.content,
			projectContext: data.projectContext,
			requiredSections: data.requiredSections || [],
			keyPhrases: data.keyPhrases || [],
			scope,
			userId: data.userId,
			organizationId: data.organizationId,
		},
	});
}

/**
 * Get golden reference by ID
 */
export async function getGoldenReferenceById(id: string) {
	return await db.goldenReference.findUnique({
		where: { id },
	});
}

/**
 * Find the best matching golden reference for a document type
 * Prioritizes: ORG > USER > SYSTEM references
 */
export async function findBestGoldenReference(options: {
	documentType: ProjectDocumentType;
	userId?: string;
	organizationId?: string;
}) {
	const { documentType, userId, organizationId } = options;

	// Build priority-ordered conditions
	const conditions: Prisma.GoldenReferenceWhereInput[] = [];

	// 1. Organization-specific reference (highest priority)
	if (organizationId) {
		conditions.push({
			documentType,
			scope: "ORG",
			organizationId,
			isActive: true,
		});
	}

	// 2. User-specific reference
	if (userId) {
		conditions.push({
			documentType,
			scope: "USER",
			userId,
			isActive: true,
		});
	}

	// 3. System reference (fallback)
	conditions.push({
		documentType,
		scope: "SYSTEM",
		isActive: true,
	});

	// Try each condition in order
	for (const where of conditions) {
		const reference = await db.goldenReference.findFirst({
			where,
			orderBy: { version: "desc" },
		});
		if (reference) {
			return reference;
		}
	}

	return null;
}

/**
 * List golden references with filtering
 */
export async function listGoldenReferences(options: {
	documentType?: ProjectDocumentType;
	scope?: GoldenReferenceScope;
	userId?: string;
	organizationId?: string;
	isActive?: boolean;
	limit?: number;
	offset?: number;
}) {
	const {
		documentType,
		scope,
		userId,
		organizationId,
		isActive = true,
		limit = 50,
		offset = 0,
	} = options;

	const where: Prisma.GoldenReferenceWhereInput = {
		isActive,
		...(documentType ? { documentType } : {}),
		...(scope ? { scope } : {}),
		...(userId ? { userId } : {}),
		...(organizationId ? { organizationId } : {}),
	};

	const [references, total] = await Promise.all([
		db.goldenReference.findMany({
			where,
			orderBy: [{ documentType: "asc" }, { version: "desc" }],
			take: limit,
			skip: offset,
		}),
		db.goldenReference.count({ where }),
	]);

	return {
		references,
		total,
		hasMore: offset + limit < total,
	};
}

/**
 * Update golden reference (creates new version)
 */
export async function updateGoldenReference(
	id: string,
	data: Partial<Omit<GoldenReferenceInput, "documentType">>,
	opts: { userId?: string; organizationId?: string },
) {
	const current = await db.goldenReference.findFirst({
		where: {
			id,
			OR: [
				{ scope: "SYSTEM" },
				...(opts.organizationId
					? [
							{
								scope: "ORG" as const,
								organizationId: opts.organizationId,
							},
						]
					: []),
				...(opts.userId
					? [{ scope: "USER" as const, userId: opts.userId }]
					: []),
			],
		},
	});
	if (!current) {
		throw new Error("Golden reference not found");
	}

	return await db.goldenReference.update({
		where: { id },
		data: {
			...(data.name !== undefined ? { name: data.name } : {}),
			...(data.description !== undefined
				? { description: data.description }
				: {}),
			...(data.content !== undefined ? { content: data.content } : {}),
			...(data.projectContext !== undefined
				? { projectContext: data.projectContext }
				: {}),
			...(data.requiredSections !== undefined
				? { requiredSections: data.requiredSections }
				: {}),
			...(data.keyPhrases !== undefined
				? { keyPhrases: data.keyPhrases }
				: {}),
			version: current.version + 1,
		},
	});
}

/**
 * Deactivate a golden reference (soft delete)
 */
export async function deactivateGoldenReference(id: string) {
	return await db.goldenReference.update({
		where: { id },
		data: { isActive: false },
	});
}

// =============================================================================
// Document Eval Queries
// =============================================================================

/**
 * Create a new document evaluation result
 */
export async function createDocumentEval(data: CreateEvalInput) {
	const { metrics, ...evalData } = data;

	return await db.documentEval.create({
		data: {
			...evalData,
			threshold: evalData.threshold ?? 70, // Use ?? to allow 0 as valid threshold
			// Ensure required arrays have defaults (Prisma requires arrays, not undefined)
			suggestions: evalData.suggestions ?? [],
			missingSections: evalData.missingSections ?? [],
			missingPhrases: evalData.missingPhrases ?? [],
			metrics: metrics
				? {
						create: metrics.map((m) => ({
							metricName: m.metricName,
							category: m.category,
							score: m.score,
							weight: m.weight ?? 1.0,
							rawValue: m.rawValue,
							description: m.description,
							metadata: m.metadata,
						})),
					}
				: undefined,
		},
		include: {
			metrics: true,
			goldenReference: {
				select: {
					id: true,
					name: true,
					documentType: true,
				},
			},
		},
	});
}

/**
 * Get document evaluation by ID
 */
export async function getDocumentEvalById(id: string) {
	return await db.documentEval.findUnique({
		where: { id },
		include: {
			metrics: true,
			goldenReference: true,
			projectDocument: {
				select: {
					id: true,
					title: true,
					type: true,
					version: true,
				},
			},
		},
	});
}

/**
 * Get all evaluations for a document
 */
export async function getDocumentEvals(options: {
	projectDocumentId: string;
	limit?: number;
	offset?: number;
}) {
	const { projectDocumentId, limit = 20, offset = 0 } = options;

	const where: Prisma.DocumentEvalWhereInput = { projectDocumentId };

	const [evals, total] = await Promise.all([
		db.documentEval.findMany({
			where,
			include: {
				metrics: true,
				goldenReference: {
					select: {
						id: true,
						name: true,
						documentType: true,
					},
				},
			},
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.documentEval.count({ where }),
	]);

	return {
		evals,
		total,
		hasMore: offset + limit < total,
	};
}

/**
 * Get latest evaluation for a document
 */
export async function getLatestDocumentEval(projectDocumentId: string) {
	return await db.documentEval.findFirst({
		where: { projectDocumentId },
		include: {
			metrics: true,
			goldenReference: {
				select: {
					id: true,
					name: true,
					documentType: true,
				},
			},
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get evaluation statistics for a project
 */
export async function getProjectEvalStats(options: {
	projectId: string;
	userId: string;
	organizationId?: string;
}) {
	const { projectId, userId, organizationId } = options;

	// Build tenant filter
	const tenantFilter = organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };

	// Get all document IDs for the project
	const documents = await db.projectDocument.findMany({
		where: { projectId },
		select: { id: true },
	});

	const documentIds = documents.map((d) => d.id);

	if (documentIds.length === 0) {
		return {
			totalEvals: 0,
			passedEvals: 0,
			failedEvals: 0,
			averageScore: 0,
			scoresByType: {},
		};
	}

	// Get all evals for these documents
	const evals = await db.documentEval.findMany({
		where: {
			projectDocumentId: { in: documentIds },
			...tenantFilter,
		},
		include: {
			projectDocument: {
				select: { type: true },
			},
		},
	});

	// Calculate stats
	const totalEvals = evals.length;
	const passedEvals = evals.filter((e) => e.passed).length;
	const failedEvals = totalEvals - passedEvals;
	const averageScore =
		totalEvals > 0
			? evals.reduce((sum, e) => sum + e.overallScore, 0) / totalEvals
			: 0;

	// Group by document type
	const scoresByType: Record<string, { count: number; avgScore: number }> =
		{};
	for (const eval_ of evals) {
		const type = eval_.projectDocument.type;
		if (!scoresByType[type]) {
			scoresByType[type] = { count: 0, avgScore: 0 };
		}
		scoresByType[type].count++;
		scoresByType[type].avgScore += eval_.overallScore;
	}

	// Calculate averages
	for (const type of Object.keys(scoresByType)) {
		scoresByType[type].avgScore /= scoresByType[type].count;
	}

	return {
		totalEvals,
		passedEvals,
		failedEvals,
		averageScore,
		scoresByType,
	};
}

/**
 * Get evaluation trend over time
 */
export async function getEvalTrend(options: {
	projectDocumentId: string;
	days?: number;
}) {
	const { projectDocumentId, days = 30 } = options;

	const startDate = new Date();
	startDate.setDate(startDate.getDate() - days);

	const evals = await db.documentEval.findMany({
		where: {
			projectDocumentId,
			createdAt: { gte: startDate },
		},
		select: {
			createdAt: true,
			overallScore: true,
			passed: true,
			documentVersion: true,
		},
		orderBy: { createdAt: "asc" },
	});

	return evals;
}

/**
 * Delete old evaluations (cleanup)
 */
export async function deleteOldEvals(options: {
	olderThanDays: number;
	keepLatestPerDocument?: boolean;
}) {
	const { olderThanDays, keepLatestPerDocument = true } = options;

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

	if (keepLatestPerDocument) {
		// Keep at least the latest eval per document
		// First, get the latest eval ID for each document
		const latestEvals = await db.documentEval.findMany({
			distinct: ["projectDocumentId"],
			orderBy: { createdAt: "desc" },
			select: { id: true },
		});

		const latestIds = latestEvals.map((e) => e.id);

		// Delete old evals except the latest ones
		return await db.documentEval.deleteMany({
			where: {
				createdAt: { lt: cutoffDate },
				id: { notIn: latestIds },
			},
		});
	}

	// Delete all old evals
	return await db.documentEval.deleteMany({
		where: {
			createdAt: { lt: cutoffDate },
		},
	});
}

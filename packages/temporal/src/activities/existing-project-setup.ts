/**
 * Existing Project Setup Activities
 *
 * Activities for the existingProjectSetupWorkflow:
 * 1. ingestBacklogForRAG — Fetch PM work items and embed into Qdrant for RAG context
 * 2. createExistingProjectDocumentRecords — Create document records with GENERATING status
 * 3. updateProjectRagSettings — Set optimal RAG settings for the project
 * 4. embedCodeAnalysisContext — Embed code analysis into Qdrant for RAG
 */

import { resolveProviderApiKey } from "@repo/ai";
import {
	db,
	type ProjectDocumentType,
	resolveModelWithCredentials,
	tenantWhere,
} from "@repo/database";
import { logger } from "@repo/logs";
import { embedProjectContext } from "@repo/rag/lib/project-contexts/auto-embed";
import { documentTypeLabel } from "@repo/utils/document-type-catalog";
import type { PMHierarchyResult } from "./pm-integration/fetch-pm-hierarchy";
import { fetchPMWorkItemsByType } from "./pm-integration/fetch-pm-hierarchy";
import { discoverPMToolCapabilities } from "./pm-integration/story-sync";

// ============================================================================
// 1. ingestBacklogForRAG (renamed from fetchAndEmbedBacklogItems)
// ============================================================================

export interface IngestBacklogForRAGInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	mcpConfigId: string;
	containerId: string;
	additionalContext?: Record<string, string>;
}

export interface IngestBacklogForRAGOutput {
	contextId: string;
	itemCounts: {
		epics: number;
		features: number;
		stories: number;
	};
}

/**
 * Fetch all backlog items from PM tool and embed as project context for RAG.
 *
 * This is distinct from `storySyncWorkflow` which bidirectionally syncs individual
 * stories between Fabric Kanban and PM tools. This activity only READS the entire
 * backlog and embeds it as vector context for document generation.
 */
export async function ingestBacklogForRAG(
	input: IngestBacklogForRAGInput,
): Promise<IngestBacklogForRAGOutput> {
	const {
		projectId,
		userId,
		organizationId,
		mcpConfigId,
		containerId,
		additionalContext,
	} = input;

	logger.info("[ExistingProjectSetup] Ingesting backlog for RAG", {
		projectId,
		mcpConfigId,
		containerId,
		hasAdditionalContext: !!additionalContext,
		additionalContextKeys: additionalContext
			? Object.keys(additionalContext)
			: [],
	});

	// Discover PM tool capabilities
	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});

	if (!capabilities) {
		throw new Error(
			`PM tool capability discovery failed for mcpConfigId=${mcpConfigId}. ` +
				"The MCP server may be unreachable or misconfigured.",
		);
	}

	if (!capabilities.taskList) {
		throw new Error(
			`PM tool (${capabilities.detectedType ?? "unknown"}) does not support listing work items. ` +
				`Available tools: ${capabilities.availableTools.slice(0, 10).join(", ")}`,
		);
	}

	// Fetch work items by type
	const hierarchy: PMHierarchyResult = await fetchPMWorkItemsByType({
		projectId,
		mcpConfigId,
		containerId,
		additionalContext,
		userId,
		organizationId,
		capabilities,
	});

	const totalItems =
		hierarchy.epics.length +
		hierarchy.features.length +
		hierarchy.stories.length;

	// Format as structured markdown
	const content = formatBacklogAsMarkdown(hierarchy);

	logger.info("[ExistingProjectSetup] Backlog items fetched", {
		epics: hierarchy.epics.length,
		features: hierarchy.features.length,
		stories: hierarchy.stories.length,
		totalItems,
		contentLength: content.length,
		detectedType: hierarchy.detectedType,
	});

	if (totalItems === 0) {
		logger.warn(
			"[ExistingProjectSetup] No backlog items found — the board may be empty or the container/team config may be wrong",
			{
				containerId,
				additionalContext,
				detectedType: hierarchy.detectedType,
			},
		);
	}

	// Save as ProjectContext
	const context = await db.projectContext.create({
		data: {
			projectId,
			type: "TEXT",
			content,
			sourceTitle: "Backlog Items (PM Backlog Ingest)",
			metadata: {
				provider: "BACKLOG_INGEST",
				mcpConfigId,
				containerId,
				itemCounts: {
					epics: hierarchy.epics.length,
					features: hierarchy.features.length,
					stories: hierarchy.stories.length,
				},
				syncedAt: new Date().toISOString(),
			},
			extractionStatus: "COMPLETED",
			userId,
			organizationId: organizationId ?? null,
		},
	});

	// Embed into Qdrant for RAG retrieval
	const modelConfig = await resolveModelWithCredentials({
		userId,
		organizationId,
		taskType: "EMBEDDING",
	});

	await embedProjectContext({
		contextId: context.id,
		projectId,
		userId,
		organizationId,
		content,
		type: "TEXT",
		apiKey: {
			// Resolve to a real bearer token rather than reading `apiKey`: a
			// service-principal config stores none, and the empty string this
			// used to produce trips the downstream "no provider configured"
			// presence check.
			apiKey: await resolveProviderApiKey(modelConfig),
			provider: modelConfig.provider ?? null,
			baseUrl: modelConfig.baseUrl ?? null,
		},
		metadata: {
			sourceTitle: "Backlog Items (PM Backlog Ingest)",
			provider: "BACKLOG_INGEST",
		},
	});

	logger.info("[ExistingProjectSetup] Backlog items embedded into Qdrant", {
		contextId: context.id,
		totalItems,
	});

	return {
		contextId: context.id,
		itemCounts: {
			epics: hierarchy.epics.length,
			features: hierarchy.features.length,
			stories: hierarchy.stories.length,
		},
	};
}

/**
 * Format PM hierarchy as structured markdown for RAG context.
 */
function formatBacklogAsMarkdown(hierarchy: PMHierarchyResult): string {
	const sections: string[] = ["# Project Backlog Items\n"];

	if (hierarchy.epics.length > 0) {
		sections.push(`## Epics (${hierarchy.epics.length})\n`);
		for (const epic of hierarchy.epics) {
			sections.push(`### ${epic.title} (ID: ${epic.id})`);
			if (epic.description) {
				sections.push(epic.description);
			}
			if (epic.url) {
				sections.push(`URL: ${epic.url}`);
			}
			sections.push("");
		}
	}

	if (hierarchy.features.length > 0) {
		sections.push(`## Features (${hierarchy.features.length})\n`);
		for (const feature of hierarchy.features) {
			sections.push(`### ${feature.title} (ID: ${feature.id})`);
			if (feature.description) {
				sections.push(feature.description);
			}
			if (feature.url) {
				sections.push(`URL: ${feature.url}`);
			}
			sections.push("");
		}
	}

	if (hierarchy.stories.length > 0) {
		// Leaf items of an external PM hierarchy (e.g. ADO User Stories) — labelled
		// "Feature Items" to stay distinct from the FEAT-level "Features" block above.
		sections.push(`## Feature Items (${hierarchy.stories.length})\n`);
		for (const story of hierarchy.stories) {
			sections.push(`### ${story.title} (ID: ${story.id})`);
			if (story.description) {
				sections.push(story.description);
			}
			if (story.url) {
				sections.push(`URL: ${story.url}`);
			}
			sections.push("");
		}
	}

	return sections.join("\n");
}

// ============================================================================
// 2. createExistingProjectDocumentRecords
// ============================================================================

export interface CreateExistingProjectDocumentRecordsInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	documentTypes: string[];
}

export interface CreateExistingProjectDocumentRecordsOutput {
	documents: Array<{
		id: string;
		type: string;
		title: string;
	}>;
}

/**
 * Create ProjectDocument records for all selected document types with GENERATING status.
 */
export async function createExistingProjectDocumentRecords(
	input: CreateExistingProjectDocumentRecordsInput,
): Promise<CreateExistingProjectDocumentRecordsOutput> {
	const { projectId, userId, organizationId, documentTypes } = input;

	const documents = await Promise.all(
		documentTypes.map((type) =>
			db.projectDocument.create({
				data: {
					projectId,
					type: type as ProjectDocumentType,
					title: documentTypeLabel(type),
					content: "",
					status: "GENERATING",
					generationProgress: 0,
					generationStartedAt: new Date(),
					userId,
					organizationId: organizationId ?? null,
				},
			}),
		),
	);

	return {
		documents: documents.map((d) => ({
			id: d.id,
			type: d.type,
			title: d.title,
		})),
	};
}

// ============================================================================
// 3. updateProjectRagSettings
// ============================================================================

export interface UpdateProjectRagSettingsInput {
	projectId: string;
	topK?: number;
	rerankTopK?: number;
	enableReranking?: boolean;
}

/**
 * Set optimal RAG settings for the existing project setup.
 * Uses higher topK and reranking for better document context.
 */
export async function updateProjectRagSettings(
	input: UpdateProjectRagSettingsInput,
): Promise<void> {
	const {
		projectId,
		topK = 50,
		rerankTopK = 20,
		enableReranking = true,
	} = input;

	await db.projectRagSettings.upsert({
		where: { projectId },
		create: { projectId, topK, rerankTopK, enableReranking },
		update: { topK, rerankTopK, enableReranking },
	});

	logger.info("[ExistingProjectSetup] RAG settings updated", {
		projectId,
		topK,
		rerankTopK,
		enableReranking,
	});
}

// ============================================================================
// 4. createAnalysisContextRecord (no content — just metadata)
// ============================================================================

export interface CreateAnalysisContextRecordInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	repositoryOwner: string;
	repositoryName: string;
	repoUrls?: string[];
}

export interface CreateAnalysisContextRecordOutput {
	contextId: string;
}

/**
 * Create a ProjectContext record with empty content for code analysis.
 * Content is appended separately via appendAnalysisContentChunk to avoid
 * Temporal's ~2MB payload size limit.
 */
export async function createAnalysisContextRecord(
	input: CreateAnalysisContextRecordInput,
): Promise<CreateAnalysisContextRecordOutput> {
	const {
		projectId,
		userId,
		organizationId,
		repositoryOwner,
		repositoryName,
		repoUrls,
	} = input;

	const sourceUrl =
		repoUrls && repoUrls.length > 0
			? repoUrls[0]
			: `https://github.com/${repositoryOwner}/${repositoryName}`;

	const source = repoUrls?.some((u) =>
		/dev\.azure\.com|visualstudio\.com/i.test(u),
	)
		? "azure-devops"
		: repoUrls?.some((u) => /gitlab\.com/i.test(u))
			? "gitlab"
			: "github";

	const context = await db.projectContext.create({
		data: {
			projectId,
			type: "TEXT",
			content: "",
			sourceTitle: `Code Analysis: ${repositoryOwner}/${repositoryName}`,
			sourceUrl,
			metadata: {
				provider: "CODE_ANALYSIS",
				source,
				repo: `${repositoryOwner}/${repositoryName}`,
				analyzedAt: new Date().toISOString(),
			},
			extractionStatus: "PENDING",
			userId,
			organizationId: organizationId ?? null,
		},
	});

	logger.info("[ExistingProjectSetup] Analysis context record created", {
		contextId: context.id,
		projectId,
	});

	return { contextId: context.id };
}

// ============================================================================
// 5. appendAnalysisContentChunk
// ============================================================================

export interface AppendAnalysisContentChunkInput {
	contextId: string;
	chunk: string;
	isFinal: boolean;
}

/**
 * Append a chunk of analysis content to an existing ProjectContext record.
 * Uses raw SQL concat to avoid loading full content into memory.
 * When isFinal=true, marks extractionStatus as COMPLETED.
 */
export async function appendAnalysisContentChunk(
	input: AppendAnalysisContentChunkInput,
): Promise<void> {
	const { contextId, chunk, isFinal } = input;

	if (isFinal) {
		await db.$executeRaw`
			UPDATE "project_context"
			SET "content" = COALESCE("content", '') || ${chunk},
			    "extractionStatus" = 'COMPLETED',
			    "extractedAt" = NOW(),
			    "updatedAt" = NOW()
			WHERE "id" = ${contextId}
		`;
	} else {
		await db.$executeRaw`
			UPDATE "project_context"
			SET "content" = COALESCE("content", '') || ${chunk},
			    "updatedAt" = NOW()
			WHERE "id" = ${contextId}
		`;
	}

	logger.info("[ExistingProjectSetup] Appended analysis chunk", {
		contextId,
		chunkLength: chunk.length,
		isFinal,
	});
}

// ============================================================================
// 6. embedCodeAnalysisContext
// ============================================================================

export interface EmbedCodeAnalysisContextInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
}

/**
 * Embed code analysis content into Qdrant so it's available for RAG.
 * Reads content from PostgreSQL to avoid passing large payloads through Temporal.
 */
export async function embedCodeAnalysisContext(
	input: EmbedCodeAnalysisContextInput,
): Promise<void> {
	const { contextId, projectId, userId, organizationId } = input;

	// ProjectContext has no tenant columns of its own; scope through the
	// parent project so a forged contextId from another tenant can't embed
	// someone else's content into the caller's RAG collection.
	const context = await db.projectContext.findFirst({
		where: {
			id: contextId,
			project: {
				id: projectId,
				...tenantWhere(userId, organizationId),
			},
		},
		select: { content: true },
	});
	if (!context) {
		throw new Error(
			`Project context not found or not accessible for this tenant: ${contextId}`,
		);
	}
	const content = context.content ?? "";

	const modelConfig = await resolveModelWithCredentials({
		userId,
		organizationId,
		taskType: "EMBEDDING",
	});

	await embedProjectContext({
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		type: "TEXT",
		apiKey: {
			// See the note in ingestBacklogForRAG: resolve a real token so a
			// service-principal config isn't seen as "no provider configured".
			apiKey: await resolveProviderApiKey(modelConfig),
			provider: modelConfig.provider ?? null,
			baseUrl: modelConfig.baseUrl ?? null,
		},
		metadata: {
			sourceTitle: "Code Analysis",
			provider: "CODE_ANALYSIS",
		},
	});

	logger.info(
		"[ExistingProjectSetup] Code analysis context embedded into Qdrant",
		{
			contextId,
			projectId,
			contentLength: content.length,
		},
	);
}

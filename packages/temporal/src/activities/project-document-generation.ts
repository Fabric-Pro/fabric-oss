/**
 * Activities for Project Document Generation Workflow
 *
 * These activities handle the actual work of document generation:
 * - RAG context retrieval from Qdrant
 * - Document generation via LangGraph agent
 * - Database operations
 * - Version management
 */

import { Client } from "@langchain/langgraph-sdk";
import {
	type DocumentSection,
	getDocumentSections,
	getMarkdownFormattingRulesPrompt,
	PRD_FORBIDDEN_SECTIONS,
	PROPOSAL_FORBIDDEN_SECTIONS,
	validateDocument,
} from "@repo/agent-prompts";
import type { DocumentType } from "@repo/agent-types";
import {
	DEFAULT_BASE_URLS,
	embed,
	getAIEmbeddingModelWithMetadata,
	getAIModelWithMetadata,
	getRAGProviderConfig,
	logEmbeddingUsageAsync,
	logModelUsageAsync,
	readTokenCount,
	streamText,
} from "@repo/ai";
import {
	computeMaxOutputTokenBudget,
	computeScaledOutputTokenBudget,
	DOCUMENT_GENERATION_FALLBACK_CEILING,
} from "@repo/ai/lib/output-token-budget";
import {
	isTextContentType,
	loadSkillBundle,
	readSkillFile,
	type SkillContext,
} from "@repo/ai/skills";
import {
	db,
	getProjectRagSettings,
	hasProjectAccess,
	listEmbeddedDocumentsForSweep,
	type Prisma,
	type ProjectDocumentType,
	recordAuditDurable,
} from "@repo/database";
import {
	applyContextSummary,
	buildDocumentRetrievalQuery,
	deleteStaleDocumentEmbeddingChunks,
	type EpisodeSearchResult,
	embedProjectDocument,
	enrichContextsWithRoleTags,
	extractBaseContextId,
	generateContentHash,
	type RerankerProviderType,
	type RetrievedContext,
	reembedProjectDocument,
	rerankContexts,
	searchSimilarEpisodes,
	searchSimilarProjectContexts,
} from "@repo/rag";
import { documentTypeLabel } from "@repo/utils/document-type-catalog";
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { ApplicationFailure, Context, heartbeat } from "@temporalio/activity";
import { runDecisionPrecheck } from "../lib/decision-precheck";
import { buildRetrievedContextBlock } from "../lib/retrieved-context-block";
import { activityLogger } from "./lib/activity-logger";

// =============================================================================
// Agent Skills resolution
// =============================================================================

/**
 * Map document types (lowercase, agent-side) to the skill slug that should be
 * eager-inlined into the prompt and have its tools (write_document_asset)
 * bound on the agent. Empty map entries are fine — documents without a bound
 * skill behave exactly as before.
 */
const DOCUMENT_TYPE_SKILL_SLUGS: Record<string, string> = {
	architecture: "architecture-diagram",
};

/** Max size of a text asset that we eager-inline into the prompt. */
const EAGER_SKILL_FILE_MAX_BYTES = 32 * 1024;

async function resolveActiveSkillForDocumentType(
	documentType: string,
	ctx: SkillContext,
): Promise<
	| {
			slug: string;
			skillMd: string;
			files: Array<{
				path: string;
				contentType: string;
				body: string;
			}>;
	  }
	| undefined
> {
	const slug = DOCUMENT_TYPE_SKILL_SLUGS[documentType];
	if (!slug) {
		return undefined;
	}

	try {
		const bundle = await loadSkillBundle(slug, ctx);

		const inlineCandidates = bundle.files.filter(
			(f) =>
				f.sizeBytes <= EAGER_SKILL_FILE_MAX_BYTES &&
				isTextContentType(f.contentType),
		);

		const files = await Promise.all(
			inlineCandidates.map(async (f) => {
				const content = await readSkillFile(slug, f.path, ctx);
				return {
					path: f.path,
					contentType: f.contentType,
					body: content.data,
				};
			}),
		);

		return {
			slug: bundle.slug,
			skillMd: bundle.skillMd,
			files,
		};
	} catch (error) {
		activityLogger.warn(
			`[Skills] Failed to load active skill "${slug}" for documentType "${documentType}"; falling back to prompt without skill`,
			{ error },
		);
		return undefined;
	}
}

/**
 * Safe heartbeat wrapper that handles non-activity contexts gracefully
 *
 * Unlike direct heartbeat() calls, this won't throw when invoked outside
 * a Temporal activity context (e.g., during unit tests).
 */
function safeHeartbeat(details?: unknown): void {
	try {
		heartbeat(details);
	} catch (_error) {
		// Not in an activity context (e.g., during testing)
		// Silently ignore - this is expected behavior for non-activity contexts
	}
}

// Document retrieval intent queries and normalization are shared across
// Temporal activities and API procedures. See @repo/rag for the canonical source.
// Import: buildDocumentRetrievalQuery (combines intent + user prompt)

/**
 * Retrieve relevant project contexts from Qdrant using Hybrid Query Expansion
 *
 * Combines enterprise-grade intent queries with user custom instructions
 * to maximize RAG retrieval accuracy.
 */
export async function retrieveProjectContexts(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
	documentType: string;
	userCustomPrompt?: string;
	limit?: number;
	/**
	 * A project context row to leave out of this run's results.
	 *
	 * Used when the caller is already delivering that row's text to the model
	 * directly — source content the user supplied moments before the run — so
	 * the same words must not also arrive through similarity search (R29).
	 *
	 * The filter lives inside this activity because the return type is
	 * `string[]`: identifiers do not survive the boundary, so a caller has
	 * nothing to post-filter on.
	 */
	excludeContextId?: string;
}): Promise<string[]> {
	const {
		projectId,
		userId,
		organizationId,
		documentType,
		userCustomPrompt,
		limit,
		excludeContextId,
	} = params;

	const startTime = Date.now();

	// Get project-specific RAG settings for retrieval configuration
	const ragSettings = await getProjectRagSettings(projectId);
	const retrieveCount = limit ?? ragSettings.topK ?? 10;
	const similarityThreshold = ragSettings.similarityThreshold ?? 0.5;
	const enableReranking = ragSettings.enableReranking ?? true;
	const rerankTopK = ragSettings.rerankTopK ?? 10;
	const rerankerProvider = (ragSettings.rerankerProvider ??
		"cross-encoder") as RerankerProviderType;

	activityLogger.info("Retrieving project contexts", {
		projectId,
		documentType,
		hasCustomPrompt: !!userCustomPrompt,
		retrieveCount,
		similarityThreshold,
	});

	try {
		// Send initial heartbeat to indicate activity has started
		safeHeartbeat({
			phase: "retrieving_contexts",
			message: "Retrieving relevant project contexts from RAG",
			progress: 10,
		});

		// Use centralized single entry point for embedding model access
		const {
			model: embeddingModel,
			metadata,
			trackUsage,
		} = await getAIEmbeddingModelWithMetadata({ userId, organizationId });

		activityLogger.info("Resolved embedding model for RAG query", {
			modelName: metadata.modelString,
			modelProvider: metadata.provider,
		});

		// Track usage (fire-and-forget)
		trackUsage();

		// Build the search query using shared intent map + user prompt
		const finalSearchQuery = buildDocumentRetrievalQuery(
			documentType,
			userCustomPrompt,
		);

		activityLogger.debug("Using hybrid query expansion for RAG retrieval", {
			documentType,
			customPromptLength: userCustomPrompt?.length || 0,
			finalQueryLength: finalSearchQuery.length,
		});

		// Generate embedding for the query using configured model
		const embeddingStart = Date.now();
		const { embedding: queryEmbedding, usage } = await embed({
			model: embeddingModel,
			value: finalSearchQuery,
		});
		logEmbeddingUsageAsync({
			context: { userId, organizationId },
			metadata,
			usageTokens: usage.tokens,
			latencyMs: Date.now() - embeddingStart,
		});

		// Send heartbeat after embedding generation
		safeHeartbeat({
			phase: "embedding_query",
			message: "Generated embedding for RAG query",
			progress: 15,
		});

		// Search for relevant contexts using RAG with project settings
		const results = await searchSimilarProjectContexts({
			projectId,
			userId,
			organizationId,
			queryEmbedding,
			topK: retrieveCount,
			minSimilarity: similarityThreshold,
		});

		// Diagnostic: pin down WHY retrieval can return nothing for a context
		// that is embedded (Business Case QA, AC-4). The query vector dimension
		// vs. the stored vectors, the tenant scope, and the raw hit count
		// together distinguish a dimension/collection mismatch from a threshold
		// miss from an empty collection — the signals that were missing when
		// triaging the "context not incorporated" report.
		activityLogger.info("RAG retrieval result", {
			projectId,
			organizationId: organizationId ?? null,
			queryEmbeddingDimensions: queryEmbedding.length,
			similarityThreshold,
			rawResultCount: results.length,
			topScores: results.slice(0, 5).map((r) => r.score),
		});

		// Fetch actual content from database using contextIds
		// Note: Qdrant stores chunk IDs like "contextId-chunk-0" but DB has original "contextId"
		// Get unique base context IDs for database query (uses extractBaseContextId from @repo/rag)
		const rawContextIds = results.map((r) => r.contextId);
		// Drop the caller-excluded row here, on the BASE id, and nowhere else.
		//
		// This is the last point at which identifiers exist at all: below, the
		// contexts collapse to content strings and the function returns
		// `string[]`. It is also the only point at which the id is in a form
		// that can match — Qdrant payloads carry the CHUNK id
		// (`<contextId>-chunk-N`, written by auto-embed), so an exact-match
		// exclusion pushed down into the vector query would filter an unchunked
		// row and silently miss every chunk of a chunked one, which is the
		// common case for a long paste. `extractBaseContextId` has already
		// normalized that away here.
		const baseContextIds = [
			...new Set(rawContextIds.map(extractBaseContextId)),
		].filter((id) => id !== excludeContextId);

		if (excludeContextId) {
			activityLogger.debug(
				"Excluding a context from this run's retrieval",
				{
					projectId,
					excludeContextId,
					remainingContextIds: baseContextIds.length,
				},
			);
		}

		if (baseContextIds.length === 0) {
			activityLogger.info("No contexts found for RAG retrieval", {
				projectId,
			});
			const summaryOnly = await applyContextSummary([], {
				projectId,
				userId,
				organizationId,
			});
			return summaryOnly.map((c) => c.content);
		}

		activityLogger.debug("Fetching contexts from database", {
			rawContextIdsCount: rawContextIds.length,
			uniqueBaseContextIdsCount: baseContextIds.length,
			sampleRawIds: rawContextIds.slice(0, 3),
			sampleBaseIds: baseContextIds.slice(0, 3),
		});

		const contexts = await db.projectContext.findMany({
			where: {
				id: { in: baseContextIds },
			},
			select: {
				id: true,
				content: true,
				type: true,
				metadata: true,
				originalFilename: true,
				sourceUrl: true,
				sourceTitle: true,
				sourceType: true,
				aiInstructions: true,
			},
		});

		activityLogger.debug("Database query results", {
			requestedCount: baseContextIds.length,
			foundCount: contexts.length,
		});

		// Create a map for quick lookup using base context ID
		const contextMap = new Map(contexts.map((c) => [c.id, c]));

		// Build RetrievedContext array for reranking, preserving Qdrant score order
		// Use base context ID to look up in map
		const retrievedContexts: RetrievedContext[] = [];
		const seenBaseIds = new Set<string>(); // Avoid duplicates from multiple chunks of same doc

		for (const r of results) {
			const baseId = extractBaseContextId(r.contextId);
			// Restated rather than left to the map miss above. The Qdrant
			// payload now carries the chunk text itself, so a future change
			// that builds contexts from the payload instead of from this
			// database map would quietly lose the exclusion if the only guard
			// were the absent map entry.
			if (excludeContextId && baseId === excludeContextId) {
				continue;
			}
			const ctx = contextMap.get(baseId);

			// Skip if we've already added this context (from another chunk)
			if (ctx && !seenBaseIds.has(baseId)) {
				seenBaseIds.add(baseId);
				retrievedContexts.push({
					id: ctx.id,
					type: ctx.type as string, // Cast enum to string for RetrievedContext
					content: ctx.content,
					score: r.score,
					metadata: ctx.metadata as
						| Record<string, unknown>
						| undefined,
					filename: ctx.originalFilename || undefined,
					sourceUrl: ctx.sourceUrl || undefined,
					sourceTitle: ctx.sourceTitle || undefined,
					sourceType: ctx.sourceType ?? undefined,
					aiInstructions: ctx.aiInstructions ?? undefined,
				});
			}
		}

		// Apply reranking if enabled and we have more than 1 context
		let finalContexts = retrievedContexts;
		if (enableReranking && retrievedContexts.length > 1) {
			activityLogger.info(
				`[Retrieval] Reranking ${retrievedContexts.length} contexts → top ${rerankTopK} with ${rerankerProvider || "cross-encoder"}`,
			);

			safeHeartbeat({
				phase: "reranking",
				message: `Reranking ${retrievedContexts.length} contexts`,
				progress: 18,
			});

			try {
				const { contexts: rerankedContexts, stats } =
					await rerankContexts({
						query: finalSearchQuery,
						contexts: retrievedContexts,
						topK: rerankTopK,
						provider: rerankerProvider,
					});

				activityLogger.info(
					`[Retrieval] Reranking complete: ${stats.inputCount} → ${stats.outputCount} in ${stats.latencyMs}ms (provider: ${stats.provider})`,
				);

				finalContexts = rerankedContexts;
			} catch (error) {
				activityLogger.warn(
					`[Retrieval] Reranking failed, returning original results: ${error}`,
				);
				// Use original contexts on reranking failure
				finalContexts = retrievedContexts.slice(0, rerankTopK);
			}
		}

		// Enrich code contexts with live repository role tags
		const enrichedContexts = await enrichContextsWithRoleTags(
			finalContexts,
			projectId,
		);

		// When Context Summarization is on, the compressed summary replaces the
		// older raw context it covers and is prepended as background.
		const withSummary = await applyContextSummary(enrichedContexts, {
			projectId,
			userId,
			organizationId,
		});

		const contextContents = withSummary.map((c) => {
			let content = c.content;
			if (c.sourceType || c.aiInstructions) {
				const header = [
					c.sourceType ? `[Source type: ${c.sourceType}]` : null,
					c.aiInstructions
						? `[Source guidance: ${c.aiInstructions}]`
						: null,
				]
					.filter((line): line is string => line !== null)
					.join("\n");
				content = `${header}\n${content}`;
			}
			const roleTag = c.metadata?.roleTag as string | undefined;
			if (roleTag) {
				const source =
					c.sourceTitle || c.filename || c.sourceUrl || "Codebase";
				content = `--- ${roleTag}: ${source} ---\n${content}`;
			}
			return content;
		});
		const duration = Date.now() - startTime;
		const totalContextLength = contextContents.reduce(
			(sum, c) => sum + c.length,
			0,
		);

		activityLogger.info("Project contexts retrieved successfully", {
			projectId,
			contextCount: contextContents.length,
			totalContextLength,
			avgContextLength:
				contextContents.length > 0
					? Math.round(totalContextLength / contextContents.length)
					: 0,
			durationMs: duration,
			durationSeconds: (duration / 1000).toFixed(2),
		});

		return contextContents;
	} catch (error) {
		const duration = Date.now() - startTime;
		activityLogger.error("Failed to retrieve project contexts", error, {
			projectId,
			documentType,
			durationMs: duration,
		});
		throw error;
	}
}

/**
 * Generate document using LangGraph agent
 */
export async function generateDocumentWithAgent(params: {
	projectId: string;
	/**
	 * ProjectDocument id the generated content will be saved to. Optional
	 * because pipeline callers (prd-to-tasks) generate intermediate content
	 * without persisting to a ProjectDocument. When absent, the agent will
	 * not receive `documentId` or an `activeSkill` and the write_document_asset
	 * tool won't be bound.
	 */
	documentId?: string;
	documentType: string;
	prompt: string;
	contexts: string[];
	userId: string;
	organizationId?: string;
	aiToken: string; // Pre-issued AI token from API layer
	promptId?: string; // Optional custom prompt ID
	currentDocument?: string; // Current document state for regeneration
	/** Explicit flag: true if contexts are from RAG (vector search), false if fallback content */
	hasRagContexts?: boolean;
	/** Whether the project has Teams integration - enables search_teams_messages tool in agent */
	hasTeamsIntegration?: boolean;
	/** Whether the project has Slack integration - enables search_slack_messages tool in agent */
	hasSlackIntegration?: boolean;
}): Promise<{ content: string; resolvedPromptVersionId?: string }> {
	const {
		projectId,
		documentId,
		documentType: rawDocumentType,
		prompt,
		contexts,
		userId,
		organizationId,
		aiToken,
		promptId,
		currentDocument,
		hasRagContexts: explicitHasRagContexts,
		hasTeamsIntegration = false,
		hasSlackIntegration = false,
	} = params;

	// Track the resolved prompt version ID for attribution
	let resolvedPromptVersionId: string | undefined;

	// Normalize document type from database format (uppercase) to agent format (lowercase)
	// Use direct function instead of import to avoid module resolution issues in Temporal worker
	const documentType = rawDocumentType.toLowerCase();
	const startTime = Date.now();

	// Determine if this is a regeneration (existing content being replaced, not first generation)
	const isRegeneration =
		!!currentDocument && currentDocument.trim().length > 0;

	activityLogger.info("Starting document generation with LangGraph agent", {
		projectId,
		documentType,
		rawDocumentType,
		contextCount: contexts.length,
		totalContextLength: contexts.reduce((sum, c) => sum + c.length, 0),
		hasCustomPrompt: !!promptId,
		hasCurrentDocument: !!currentDocument,
		isRegeneration,
	});

	try {
		// Send initial heartbeat to indicate activity has started
		safeHeartbeat({
			phase: "initializing",
			message: "Connecting to LangGraph agent",
			progress: 10,
		});

		// Defense-in-depth access check. Mirrors the procedure-layer guard
		// (`hasProjectAccess`) so invited collaborators on personal projects
		// and project-scoped guests on org projects are recognized — a plain
		// XOR `{ userId, organizationId: null }` filter excludes them and
		// surfaces as "Project not found or access denied".
		const allowed = await hasProjectAccess(
			projectId,
			userId,
			organizationId,
		);
		if (!allowed) {
			throw ApplicationFailure.nonRetryable(
				`Project not found or access denied: ${projectId}`,
				"PROJECT_ACCESS_DENIED",
			);
		}

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				name: true,
				description: true,
				goals: true,
				techStack: true,
				features: true,
				projectTypes: true,
				qaStrategyLevel: true,
			},
		});

		if (!project) {
			throw ApplicationFailure.nonRetryable(
				`Project not found: ${projectId}`,
				"PROJECT_NOT_FOUND",
			);
		}

		// Send heartbeat after project fetch
		safeHeartbeat({
			phase: "loading_project",
			message: "Project context loaded",
			progress: 15,
		});

		// Log project context for debugging
		activityLogger.debug("Project context loaded for document generation", {
			projectId,
			projectName: project.name,
			hasDescription: !!project.description,
			descriptionLength: project.description?.length || 0,
			hasGoals: !!project.goals,
			goalsLength: project.goals?.length || 0,
			techStackCount: project.techStack?.length || 0,
			techStack: project.techStack?.slice(0, 5), // First 5 items
			featuresCount: project.features?.length || 0,
			features: project.features?.slice(0, 5), // First 5 items
			projectTypes: project.projectTypes,
		});

		// QA Strategy depth → boolean flags for the Handlebars template.
		// No custom Handlebars helpers exist in this repo, so branch on booleans.
		const qaDepthVariables = computeQaDepthFlags(project.qaStrategyLevel);

		// NEW: Fetch and render custom prompt if promptId provided
		let systemPrompt: string | undefined;
		if (promptId) {
			activityLogger.info(
				"Fetching custom prompt for document generation",
				{
					promptId,
					projectId,
				},
			);

			// Send heartbeat before prompt fetching
			safeHeartbeat({
				phase: "loading_prompt",
				message: "Fetching custom prompt",
				progress: 18,
			});

			const { renderPromptWithContext } = await import(
				"./prompt-activities"
			);

			try {
				const rendered = await renderPromptWithContext({
					promptId,
					variables: qaDepthVariables,
					projectContext: {
						name: project.name,
						description: project.description ?? undefined,
						goals: project.goals ?? undefined,
						techStack: project.techStack,
						features: project.features,
						projectTypes:
							project.projectTypes.length > 0
								? project.projectTypes
								: undefined,
					},
					ragContexts: contexts,
					// CRITICAL: Don't embed old document in custom prompt during regeneration.
					// Embedding it triggers editing/preservation mode which overrides the custom template.
					currentDocument: isRegeneration
						? undefined
						: currentDocument,
					// SECURITY: Pass tenant context for proper prompt access control
					userId,
					organizationId,
					// CRITICAL: Pass documentType for template-specific override instructions
					documentType,
				});

				systemPrompt = rendered.rendered;
				activityLogger.info("Custom prompt rendered successfully", {
					promptId,
					promptLength: systemPrompt.length,
				});

				// Send heartbeat after prompt rendering
				safeHeartbeat({
					phase: "prompt_loaded",
					message: "Custom prompt rendered",
					progress: 22,
				});
			} catch (error) {
				activityLogger.warn(
					"Failed to render custom prompt, using default",
					{
						promptId,
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					},
				);
				// Fall through to use default prompt building below
			}
		} else {
			// NEW: Try to fetch bound prompt for agent
			// IMPORTANT: Use rawDocumentType (uppercase) for database query, not normalized lowercase version
			activityLogger.debug("Fetching bound prompt for agent", {
				agentName: "project_document_generator",
				documentType: rawDocumentType, // Use raw (uppercase) for database query
			});

			// Send heartbeat before prompt fetching
			safeHeartbeat({
				phase: "loading_prompt",
				message: "Fetching bound prompt",
				progress: 18,
			});

			const { fetchAndRenderPrompt } = await import(
				"./prompt-activities"
			);

			try {
				const result = await fetchAndRenderPrompt({
					agentName: "project_document_generator",
					userId,
					organizationId,
					documentType: rawDocumentType, // Use raw (uppercase) for database query
					variables: qaDepthVariables,
					projectContext: {
						name: project.name,
						description: project.description ?? undefined,
						goals: project.goals ?? undefined,
						techStack: project.techStack,
						features: project.features,
						projectTypes:
							project.projectTypes.length > 0
								? project.projectTypes
								: undefined,
					},
					ragContexts: contexts,
					// CRITICAL: Don't embed old document in bound prompt during regeneration.
					currentDocument: isRegeneration
						? undefined
						: currentDocument,
				});

				if (result) {
					systemPrompt = result.rendered;
					resolvedPromptVersionId = result.promptVersionId;
					activityLogger.info("Bound prompt fetched and rendered", {
						promptId: result.promptId,
						promptName: result.promptName,
						scope: result.scope,
						promptLength: systemPrompt.length,
						promptPreview:
							systemPrompt.substring(0, 500) +
							(systemPrompt.length > 500 ? "..." : ""),
					});

					// Send heartbeat after prompt rendering
					safeHeartbeat({
						phase: "prompt_loaded",
						message: "Bound prompt rendered",
						progress: 22,
					});
				} else {
					activityLogger.debug(
						"No bound prompt found, using default prompt",
					);
				}
			} catch (error) {
				activityLogger.warn(
					"Failed to fetch bound prompt, using default",
					{
						error:
							error instanceof Error
								? error.message
								: "Unknown error",
					},
				);
			}
		}

		// Send heartbeat before model resolution
		safeHeartbeat({
			phase: "resolving_model",
			message: "Resolving AI model configuration",
			progress: 25,
		});

		// Get AI model using centralized single entry point
		// This handles all API key resolution, provider selection, and model creation
		const {
			model: fallbackModel,
			metadata: modelMetadata,
			trackUsage: trackModelUsage,
		} = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId,
				organizationId,
				featureKey: "document-generation",
				promptVersionId: resolvedPromptVersionId,
			},
		);

		// Extract model info for agent headers
		const aiModel = modelMetadata.modelString;
		const aiProvider = modelMetadata.provider;
		// Use provider-specific base URL
		const aiGatewayUrl = DEFAULT_BASE_URLS[aiProvider] || undefined;

		activityLogger.info(
			"Using pre-issued AI token for document generation",
			{
				provider: aiProvider,
				model: aiModel,
				source: modelMetadata.selectionSource,
			},
		);

		// Track usage (fire-and-forget)
		trackModelUsage();

		// Send heartbeat after model resolution
		safeHeartbeat({
			phase: "model_resolved",
			message: `AI model resolved: ${aiProvider}/${aiModel}`,
			progress: 28,
		});

		// Connect to LangGraph agent with AI config headers
		// Agent receives token and exchanges it for API key via Fabric's exchange endpoint
		const agentUrl =
			process.env.PROJECT_DOCUMENT_GENERATOR_URL ||
			"http://localhost:8125";
		// Service-to-service auth — agent-core auth middleware verifies this
		// against the AGENT_API_KEY secret each agent container has.
		// Companion to PR #751, which added the same header to the
		// CopilotKit-driven path in apps/web/app/api/copilotkit/route.ts.
		const agentApiKey = process.env.AGENT_API_KEY?.trim();
		if (!agentApiKey) {
			activityLogger.error(
				"AGENT_API_KEY is not set — LangGraph agent will reject requests with 401",
			);
		}
		const client = new Client({
			apiUrl: agentUrl,
			defaultHeaders: {
				...(agentApiKey && {
					Authorization: `Bearer ${agentApiKey}`,
				}),
				"X-AI-Token": aiToken,
				"X-AI-Model": aiModel,
				...(aiGatewayUrl && { "X-AI-Base-URL": aiGatewayUrl }),
				"X-AI-Provider": aiProvider,
				"X-Tenant-User-ID": userId,
				...(organizationId && {
					"X-Tenant-Organization-ID": organizationId,
				}),
			},
		});

		// Send heartbeat before preflight check
		safeHeartbeat({
			phase: "preflight_check",
			message: "Checking agent availability",
			progress: 30,
		});

		// Brief preflight: wait for agent to be ready to avoid immediate ECONNREFUSED
		const preflightTimeout = Number(
			process.env.AGENT_PREFLIGHT_TIMEOUT_MS ?? 5000,
		);
		const preflightInterval = 300;
		let preflightOk = false;
		const deadline = Date.now() + preflightTimeout;
		let preflightAttempts = 0;
		while (Date.now() < deadline) {
			try {
				// Non-mutating call; confirms server is up and graph is registered
				await client.assistants.getSchemas(
					"project_document_generator",
				);
				preflightOk = true;
				break;
			} catch (_) {
				preflightAttempts++;
				// Send heartbeat every 2 seconds during preflight retries
				if (preflightAttempts % 7 === 0) {
					// ~2 seconds (7 * 300ms)
					safeHeartbeat({
						phase: "preflight_check",
						message: `Agent preflight retry ${preflightAttempts}`,
						progress: 30,
					});
				}
				await new Promise((r) => setTimeout(r, preflightInterval));
			}
		}
		if (!preflightOk) {
			activityLogger.warn(
				"Agent preflight did not succeed within timeout; proceeding with stream/fallback",
				{
					projectId,
					agentUrl,
				},
			);
			// Send heartbeat even if preflight failed
			safeHeartbeat({
				phase: "preflight_failed",
				message: "Agent preflight timeout, proceeding anyway",
				progress: 32,
			});
		} else {
			// Send heartbeat after successful preflight check
			safeHeartbeat({
				phase: "connecting",
				message: "Agent preflight check completed",
				progress: 32,
			});
		}

		// Default prompts for each document type when user doesn't provide custom instructions
		// When regenerating (currentDocument exists), add instructions for fresh content
		const regenerationPrefix = isRegeneration
			? "REGENERATE with a completely fresh approach. Do NOT repeat the same content - create an entirely NEW version with different structure, perspectives, and details. "
			: "";

		// CRITICAL: When RAG contexts exist (from vector search), they define the product scope
		// Don't inject wizard features as they override the actual product content from RAG
		// Use explicit flag if provided, otherwise fall back to checking contexts length
		// This distinction is important: fallback contexts (project description) should NOT suppress features
		const hasRagContexts = explicitHasRagContexts ?? contexts.length > 0;
		const featuresLine =
			!hasRagContexts && project.features.length > 0
				? `Features to cover: ${project.features.join(", ")}`
				: "";

		const DEFAULT_PROMPTS: Record<string, string> = {
			prd: `${regenerationPrefix}Create a PRD following the PM Standard v2 format for ${project.name}.

🚫 CRITICAL: Use this EXACT structure:
1. ## **PRD** - Title: ${project.name}, Owner, Status: Draft, Target Release, Links
2. ### **Benefit Hypothesis** - "If we [build X] for [who], then [measurable outcome] because [reason]"
3. ### **Overview** - Problem, Why now, Goal (max 3 goals), Non-goals
4. ### **Users / Personas** - Primary user, Secondary user, Internal user
5. ### **Success Metrics** - Table format with Goal | Metric columns + "How we'll measure"
6. ### **Scope** - ## **In Scope** and ## **Out of Scope** subsections
7. ### **Requirements** - ## **Must Have**, ## **Nice to Have**, **Non-Functional** (Performance, Security, Reliability)
8. ### **Key Flows / Use Cases** - 1. Happy path, 2. Edge cases, 3. Failure/recovery
9. ### **Dependencies / Risks** - Dependencies with owners/timing, Risks with mitigations
10. ### **Open Questions**, ### **Work Breakdown** (Epics, Features, Stories, Spikes)
11. ### **Stakeholders** (all roles), ### **Release Notes**

${featuresLine}
Tech Stack: ${project.techStack.join(", ")}

❌ DO NOT use these forbidden sections: ${PRD_FORBIDDEN_SECTIONS.join(", ")}`,
			proposal: `${regenerationPrefix}🛑 YOUR FIRST LINE MUST BE EXACTLY: ### **Project Proposal**

Create a project proposal for ${project.name} following the PM Standard v2 format.

## MANDATORY OUTPUT FORMAT

Your response MUST start with this EXACT header (each field on its own line):

### **Project Proposal**

**Title:** ${project.name}

**Client/Team:** [Client/Team Name]

**Sponsor:** [Sponsor Name]

**Owner:** [Owner Name]

**Date:** [Date]

**Version:** 1.0

**Links:** PRD · Timeline · Budget (if any) · Architecture (if any)

---

## MANDATORY SECTIONS (in this exact order):

### **Benefit Hypothesis** - "If we deliver [solution], then [impact] improves by [metric] because [reason]"
### **Overview** - Current state, Proposed solution, Outcome (bullet points)
### **Scope** - with ### **In Scope** and ### **Out of Scope** subsections
### **Deliverables** - Product, Engineering, Quality, Ops categories
### **Plan (Phases)** - Discovery, Build, Test & Launch, Post-launch (each with outputs + decision gate)
### **Success Metrics** - TABLE with Goal | Metric columns
### **Dependencies / Risks** - Dependencies with owners/timing, Risks with mitigations
### **Stakeholders** - All roles with names
### **Open Questions** - Unresolved items
### **Release Notes** - Plain language summary

## 🚫 FORBIDDEN (INSTANT FAILURE):

DO NOT create ANY of these sections:
- Executive Summary, Table of Contents, Problem Statement
- Objectives and Success Metrics (use Success Metrics table only)
- System Architecture, Data Models, Core Modules, Features and Modules
- Timeline, Roadmap, Milestones (use Plan/Phases instead)
- Budget, Resources, Financial Model, ROI Analysis
- Appendix, Terminology, Glossary, Sign-off, Approvals
- ANY numbered sections like "1. Overview", "2. Goals"
- "Prepared for:" / "Prepared by:" format

${featuresLine}
Tech Stack: ${project.techStack.join(", ")}

❌ FULL FORBIDDEN LIST: ${PROPOSAL_FORBIDDEN_SECTIONS.join(", ")}

🚨 START YOUR RESPONSE WITH: ### **Project Proposal**`,
			design_system: `${regenerationPrefix}Create or update a complete Design System Markdown document (design.md) for ${project.name} using only the supplied project context.

Return Markdown only and include the required sections from Visual Theme & Atmosphere through Assets / Source References. Preserve relevant assets, links, repository paths, code examples, Mermaid diagrams, and source references. Never guess design values: write TBD for unsupported colors, typography, spacing, breakpoints, component states, or implementation details. Put missing decisions and contradictions in Design Gaps and Open Questions rather than silently resolving them. Validate consistency across tokens, components, responsive behavior, accessibility guidance, and implementation notes before returning the full document.

${featuresLine}
Tech Stack: ${project.techStack.join(", ")}`,
			business_case: `${regenerationPrefix}Create a decision-oriented Business Case for ${project.name}. This is NOT a PRD — stay at a decision-making altitude and focus on whether to fund/approve and what to do next.

Use this structure:
1. ## **Business Case** — Title: ${project.name}, Owner, Status, Decision Needed By, Links
2. ### **Executive Summary** — Decision ask (Approve / Reject / Approve Discovery / Approve Pilot), what we're solving, proposed approach, expected value, key risks
3. ### **Context & Case for Change** — Problem/opportunity, who is impacted and why now, goals (max 5) and non-goals
4. ### **Options Considered** — 2–4 options (Build / Buy / Partner / Extend existing / Do nothing) with pros/cons, rough cost/effort band, and time-to-value
5. ### **Recommended Option** — the recommendation and why it wins; what we are explicitly NOT doing now
6. ### **Scope (Business-Case Level)** — high-level in/out of scope and key dependencies
7. ### **Value Hypothesis & Success Metrics** — expected benefits plus a 3–7 row metrics table
8. ### **Risks, Constraints, and Mitigations**
9. ### **Delivery Approach** — lightweight phased plan with go/no-go gates
10. ### **Open Questions** — only decision-blocking questions
11. ### **Recommendation & Next Step** — recommended decision and immediate next steps

Use ONLY the provided project context. Do not invent facts, budgets, timelines, or ROI numbers — label anything unsupported as TBD or Assumed and add it to Open Questions. Tag non-trivial claims with a confidence level (Confirmed / Directionally Confirmed / Assumed / TBD).

${featuresLine}
Tech Stack: ${project.techStack.join(", ")}`,
			architecture: `${regenerationPrefix}Design a detailed technical architecture document for ${project.name} covering system components, data flow, technology choices (${project.techStack.join(", ")}), scalability considerations, and deployment strategy.`,
			technical_spec: `${regenerationPrefix}Write a detailed technical specification for ${project.name} including API designs, database schemas, component specifications, and implementation details for the tech stack: ${project.techStack.join(", ")}.`,
			user_story: `${regenerationPrefix}🛑 YOUR FIRST LINE OF OUTPUT MUST BE EXACTLY: # EPIC-001: [Title]

You are generating features for ACTUAL APP FUNCTIONALITY organized in Epic → Feature → Feature Item hierarchy.

❌ FORBIDDEN - DO NOT OUTPUT ANY OF THESE:
- Introduction or overview text
- "User Personas and Goals" section
- "Feature Format Template" section
- "Acceptance Criteria Patterns" section
- "Feature Sizing Guidelines" section
- "Example Stories" section
- ANY numbered section like "1. User Personas"
- ANY explanatory text before the first epic
- ANY feature about "defining personas", "creating templates", or "establishing guidelines"
- ANY meta-feature about documentation, specifications, or story formats
- Features where the role is "product team member" or "documentation writer"
- Flat list of feature items without Epic/Feature grouping
- Bold markers (**) around keywords like GIVEN, WHEN, THEN, roles

✅ YOUR EXACT OUTPUT FORMAT (start immediately with # EPIC-001:):

# EPIC-001: [Epic Title]

[1-2 sentence epic description]

## FEAT-001: [Feature Title]

[1-2 sentence feature description]

### F-001: [Feature Item Title]

Description

As a [role],
I want [goal],
So that [benefit].

Acceptance Criteria

GIVEN [context]
WHEN [action]
THEN [result]
AND [additional result]

GIVEN [edge case context]
WHEN [action]
THEN [expected result]

Notes / Links

Designs:
API:
Test data:

Release Notes

[1-2 sentence plain language summary]

---

### F-002: [Next Feature Item Title]

[Same structure...]

---

## FEAT-002: [Next Feature Title]

[Feature description]

### F-003: [Feature Item Title]

[Same structure...]

---

# EPIC-002: [Next Epic Title]

[Epic description]

## FEAT-003: [Feature Title]

[Continue with more features and feature items...]

RULES:
- 2-5 Epics grouping related features
- 2-4 Features per Epic
- Group related feature items under the same Feature
- Sequential numbering: EPIC-001/002, FEAT-001/002/003, F-001/002/003
- NO bold markers (**) around keywords - use plain text
- Each feature item MUST have all four sections: Description, Acceptance Criteria, Notes / Links, Release Notes
- Separate each feature item with --- horizontal rule

Generate 15-30 feature items for ${project.name}${!hasRagContexts && project.features.length > 0 ? ` covering: ${project.features.join(", ")}` : " based on the provided context documents"}

🚨 CRITICAL: The very first characters of your response must be: # EPIC-001:`,
			api_spec: `${regenerationPrefix}Generate a complete API specification document for ${project.name} including endpoints, request/response schemas, authentication, error handling, and usage examples.`,
			general: `${regenerationPrefix}Create comprehensive documentation for ${project.name} covering its purpose, features, and technical details.`,
		};

		// Build user prompt (fallback if no custom prompt)
		let fullPrompt: string;
		if (systemPrompt) {
			// Custom/bound prompt is set as systemPrompt and passed to the agent.
			// The user message (fullPrompt) should instruct the agent to follow
			// the custom system prompt rather than overriding it with defaults.
			const parts: string[] = [];

			if (isRegeneration) {
				parts.push(
					"REGENERATE this document from scratch following the instructions in the system prompt. " +
						"Create a completely NEW version — do NOT preserve the previous document's structure or content. " +
						"The system prompt contains the custom template and formatting requirements. " +
						"Adhere to its structure and guidelines precisely.",
				);
			} else {
				parts.push(
					"Generate the document following the instructions provided in the system prompt. " +
						"The system prompt contains the complete custom template and formatting requirements. " +
						"Adhere to its structure and guidelines precisely.",
				);
			}

			// Include project context summary for the user message
			parts.push(
				`\nProject: ${project.name}` +
					(project.description
						? `\nDescription: ${project.description}`
						: "") +
					(project.goals ? `\nGoals: ${project.goals}` : "") +
					(project.techStack.length > 0
						? `\nTech Stack: ${project.techStack.join(", ")}`
						: ""),
			);

			// Append any additional user-provided instructions
			if (prompt && prompt.trim().length > 0) {
				parts.push(`\n---\n\nADDITIONAL USER INSTRUCTIONS:\n${prompt}`);
			}

			fullPrompt = parts.join("\n");
		} else {
			// Build context string for fallback prompt with CRITICAL template enforcement instructions
			const contextString = buildRetrievedContextBlock(
				contexts,
				`## 🛑 FINAL REMINDER: TEMPLATE STRUCTURE IS MANDATORY

The contexts above are for CONTENT EXTRACTION ONLY. You MUST use the PM Standard v2 template structure:

For PRD documents:
- START with ## **PRD** header (Title, Owner, Status, Target Release, Links)
- THEN ## **Benefit Hypothesis** ("If we [build X] for [who], then [outcome] because [reason]")
- THEN ## **Overview** (Problem, Why now, Goal, Non-goals)
- Continue with Users/Personas, Success Metrics, Scope, Requirements, Key Flows, Dependencies/Risks, etc.

For Proposal documents:
- START with ### **Project Proposal** header block (Title, Client/Team, Sponsor, Owner, Date, Version, Links)
- THEN ### **Benefit Hypothesis** ("If we deliver [solution], then [impact] improves by [metric] because [reason]")
- THEN ### **Overview** (Current state, Proposed solution, Outcome)
- Continue with Scope (In/Out), Deliverables, Plan (Phases), Success Metrics, Dependencies/Risks, Stakeholders, Open Questions, Release Notes

❌ PRD FORBIDDEN SECTIONS (NEVER USE): ${PRD_FORBIDDEN_SECTIONS.join(", ")}

❌ PROPOSAL FORBIDDEN SECTIONS (NEVER USE): ${PROPOSAL_FORBIDDEN_SECTIONS.join(", ")}

For Feature documents:
- START with # EPIC-001: [Epic Title] (Epic → Feature → Feature Item hierarchy)
- Use ## FEAT-001: for Features, ### F-001: for Feature Items
- Each feature item has 4 sections: Description, Acceptance Criteria, Notes / Links, Release Notes
- NO bold markers (**) around keywords - use plain text
- NO flat feature item lists - must be grouped under Features and Epics

Extract CONTENT from the contexts above but output using the EXACT template structure.`,
			);

			// Add regeneration instructions if this is a regeneration
			const regenerationInstructions = isRegeneration
				? `\n\nIMPORTANT: This is a REGENERATION request. You MUST create completely NEW content with:
- Different structure and organization
- Fresh perspectives and insights
- New examples and details
- Alternative approaches where applicable
DO NOT simply rephrase or repeat the existing content.\n`
				: "";

			// CRITICAL: Include markdown formatting rules for proper GFM table syntax
			const formattingRules = getMarkdownFormattingRulesPrompt();

			// Get document-type-specific instructions from DEFAULT_PROMPTS (includes PM Standard v2 for PRD)
			const typeSpecificInstructions =
				DEFAULT_PROMPTS[documentType] || DEFAULT_PROMPTS.general;

			// Fallback: Combine document-type-specific instructions with project details
			// CRITICAL: When RAG contexts exist, they define the product - don't inject wizard features
			fullPrompt = `${typeSpecificInstructions}

Project Details:
- Name: ${project.name}
- Description: ${project.description || "N/A"}
- Goals: ${project.goals || "N/A"}
- Tech Stack: ${project.techStack.join(", ")}
${!hasRagContexts && project.features.length > 0 ? `- Features: ${project.features.join(", ")}` : ""}
- Project Types: ${project.projectTypes.join(", ") || "N/A"}

${prompt ? `Additional Instructions: ${prompt}` : ""}${contextString}${regenerationInstructions}

${formattingRules}`;
		}

		activityLogger.info(
			"Invoking LangGraph agent for document generation",
			{
				projectId,
				documentType,
				promptLength: fullPrompt.length,
				hasSystemPrompt: !!systemPrompt,
				systemPromptLength: systemPrompt?.length || 0,
				systemPromptPreview: systemPrompt?.substring(0, 200),
				isRegeneration,
				currentDocumentLength: currentDocument?.length || 0,
				contextCount: contexts.length,
			},
		);

		// Send heartbeat before starting stream
		safeHeartbeat({
			phase: "streaming",
			message: "Starting document generation stream",
			progress: 35,
		});

		// Stream document generation
		// Use null for thread_id to create a new thread for each document
		let documentContent = "";
		let chunkCount = 0; // Declare outside try block for use in catch
		// Set when the primary agent stream fails and the fallback takes over.
		// Read by both truncation branches so the surfaced error names the FIRST
		// failure rather than the fallback's symptom (Fizzy #2210).
		let primaryStreamFailure: string | undefined;
		// Hoist heartbeat state so the catch block can clean up on stream init failure
		const HEARTBEAT_INTERVAL_MS = 10000; // Send heartbeat every 10 seconds (well under 2m timeout)
		let streamComplete = false;
		let heartbeatLoop: ReturnType<typeof setInterval> | undefined;
		try {
			// CRITICAL: Start background heartbeat loop BEFORE stream initialization.
			// The stream call can take a long time for complex documents (architecture, tech specs)
			// as the agent processes context before returning the first chunk.
			// Without early heartbeats, Temporal thinks the activity is dead and kills it.

			heartbeatLoop = setInterval(() => {
				if (!streamComplete) {
					safeHeartbeat({
						phase: "streaming",
						message:
							chunkCount > 0
								? `Processing document (${chunkCount} chunks received, ${documentContent.length} chars)`
								: "Waiting for agent to start generating...",
						progress:
							chunkCount > 0
								? Math.min(40 + chunkCount * 2, 90)
								: 36,
					});
					activityLogger.debug("Background heartbeat sent", {
						chunkCount,
						documentLength: documentContent.length,
					});
				}
			}, HEARTBEAT_INTERVAL_MS);

			// Resolve the per-document-type skill (Anthropic Agent Skills):
			// currently architecture docs get the "architecture-diagram" skill
			// eager-inlined into the prompt + the write_document_asset tool.
			// Only runs when a concrete documentId is provided (pipeline paths
			// that don't persist to a ProjectDocument skip this).
			const activeSkill = documentId
				? await resolveActiveSkillForDocumentType(documentType, {
						userId,
						organizationId,
					})
				: undefined;
			if (activeSkill) {
				activityLogger.info("Active skill loaded for document", {
					documentType,
					slug: activeSkill.slug,
					fileCount: activeSkill.files.length,
				});
			}

			const stream = client.runs.stream(
				null, // thread_id - null creates a new thread
				"project_document_generator", // assistant_id (graph_id)
				{
					input: {
						messages: [
							{
								role: "user",
								content: fullPrompt,
							},
						],
						documentType,
						systemPrompt, // Pass system prompt to agent
						projectContext: {
							name: project.name,
							description: project.description ?? undefined,
							goals: project.goals ?? undefined,
							techStack: project.techStack,
							// CRITICAL: When RAG contexts exist, they define the product
							// Don't pass wizard features as they override RAG content
							features: hasRagContexts ? [] : project.features,
							projectTypes:
								project.projectTypes.length > 0
									? project.projectTypes
									: undefined,
						},
						// CRITICAL: Only pass ragContexts if NOT already embedded in systemPrompt
						// When systemPrompt comes from fetchAndRenderPrompt, it already includes RAG contexts
						// Passing them again causes double-RAG which confuses the AI
						ragContexts: systemPrompt ? [] : contexts,
						tools: [],
						// CRITICAL: Don't pass old document during regeneration.
						// The old document triggers editing/preservation mode in the agent's prompt builder,
						// which tells the model to preserve the old format instead of following the custom template.
						document: isRegeneration ? undefined : currentDocument,
						isRegeneration, // Flag to indicate this is a regeneration request
						// Teams integration state for server-side tool execution
						hasTeamsIntegration,
						hasSlackIntegration,
						projectId,
						documentId,
						userId,
						organizationId,
						activeSkill,
					},
				},
			);

			const collectPromise = (async () => {
				try {
					for await (const chunk of stream) {
						chunkCount++;

						if (chunk.event === "values" && chunk.data) {
							const data = chunk.data as { document?: string };
							if (data.document) {
								documentContent = data.document;
								// Log progress (heartbeat is handled by background loop)
								activityLogger.debug(
									"Document content received",
									{
										chunkCount,
										documentLength: documentContent.length,
									},
								);
							}
						}
					}
					return documentContent;
				} finally {
					// Ensure heartbeat loop is cleared
					clearInterval(heartbeatLoop);
					streamComplete = true;
				}
			})();
			const timeoutMs = Number(
				process.env.AGENT_STREAM_TIMEOUT_MS ?? 300000, // 5 minutes for longer documents
			);
			const timedOut = new Promise<string>((resolve) =>
				setTimeout(() => {
					clearInterval(heartbeatLoop); // Clear heartbeat loop on timeout
					streamComplete = true;
					resolve("__TIMED_OUT__");
				}, timeoutMs),
			);
			const result = await Promise.race([collectPromise, timedOut]);
			if (result === "__TIMED_OUT__") {
				throw new Error(`Agent stream timeout after ${timeoutMs}ms`);
			}
			const streamDuration = Date.now() - startTime;
			activityLogger.info("Document stream completed successfully", {
				projectId,
				documentType,
				documentLength: documentContent.length,
				chunkCount,
				streamDurationMs: streamDuration,
				streamDurationSeconds: (streamDuration / 1000).toFixed(2),
			});
		} catch (err) {
			// Clear the stream heartbeat loop — if stream() threw synchronously,
			// the collectPromise finally block never runs and the interval leaks.
			if (heartbeatLoop) {
				clearInterval(heartbeatLoop);
			}
			streamComplete = true;

			const streamDuration = Date.now() - startTime;
			// The primary failure is the CAUSE of everything that follows. Before
			// Fizzy #2210 it lived only in this warn line, so a user whose fallback
			// then truncated was told the document was too large — a claim about
			// their content, for a dependency that was never reached. Keep it.
			primaryStreamFailure =
				err instanceof Error ? err.message : String(err);
			activityLogger.warn(
				"Agent stream failed; falling back to Gateway generation",
				{
					projectId,
					documentType,
					chunkCount,
					streamDurationMs: streamDuration,
					error: err instanceof Error ? err.message : String(err),
					...(err instanceof Error && { stack: err.stack }),
				},
			);
			// Durable, and AWAITED. The fire-and-forget variant returns before the
			// insert lands and turns a write failure into a log line — which is the
			// same disappearing act this whole change exists to stop. The activity
			// must not complete before this settles, including when the fallback
			// below then SUCCEEDS: a generation that quietly ran on the degraded
			// path is exactly what nobody could see for two weeks.
			//
			// `organizationId` is deliberately omitted rather than guessed: the
			// recorder derives it from the project, and a project-scoped row written
			// without one is invisible in the organization's audit view.
			if (documentId) {
				// Heartbeat across the ledger write. The primary stream's own
				// interval was cleared just above, and the next beat is not sent
				// until the fallback starts — so a stalled INSERT (pool exhaustion,
				// a DB blip) could outlast the activity's heartbeat timeout and let
				// the server start a SECOND attempt while this one keeps running.
				// This is the branch that runs when infrastructure is already
				// degraded, which is exactly when that stall is plausible.
				const auditHeartbeatLoop = setInterval(() => {
					safeHeartbeat({
						phase: "recording_generation_failure",
						message: "Recording the generation failure",
						progress: 45,
					});
				}, 10_000);
				// Bounded. Heartbeating keeps Temporal from declaring the activity
				// dead, but it does not get the USER their document: until this
				// settles the fallback has not started. Observability must not
				// become a hard dependency of generation — least of all on the
				// branch that runs when the database may itself be the degraded
				// thing. Time out, log, and fall back.
				const AUDIT_WRITE_TIMEOUT_MS = 10_000;
				try {
					await Promise.race([
						recordAuditDurable({
							action: "project.document_generation.failed",
							severity: "warning",
							outcome: "failure",
							actor: {
								type: "system",
								nameSnapshot: "document-generation",
							},
							projectId,
							resource: {
								type: "project_document",
								id: documentId,
							},
							metadata: {
								documentType,
								phase: "agent_stream",
								error: primaryStreamFailure,
								streamDurationMs: streamDuration,
								chunkCount,
							},
						}),
						new Promise((_, reject) =>
							setTimeout(
								() =>
									reject(
										new Error(
											"audit write timed out; continuing to the fallback",
										),
									),
								AUDIT_WRITE_TIMEOUT_MS,
							),
						),
					]);
				} catch (auditError) {
					// Never let the ledger write replace the failure it describes.
					activityLogger.error(
						"Failed to record generation-failure audit row",
						{
							projectId,
							documentType,
							error:
								auditError instanceof Error
									? auditError.message
									: String(auditError),
						},
					);
				} finally {
					clearInterval(auditHeartbeatLoop);
				}
			}
			// Whole-document generation from a short prompt — maximal mode. Without
			// an explicit budget Databricks/Anthropic-direct cap the document at
			// their injected defaults (8,192 / 4,096) and silently truncate it.
			//
			// The ceiling matches what the agent allows ITSELF. This path stands in
			// for the agent, and a stand-in that asks for less output than the thing
			// it replaces turns an outage into a truncated document (Fizzy #2210).
			const fallbackMaxOutputTokens = computeMaxOutputTokenBudget(
				modelMetadata,
				{
					promptChars:
						(systemPrompt?.length ?? 0) + fullPrompt.length,
					ceilingTokens: DOCUMENT_GENERATION_FALLBACK_CEILING,
				},
			);
			// Use streamText instead of generateText to keep the gateway connection alive
			// and prevent idle timeout errors on long-running generations
			const fallbackStream = streamText({
				model: fallbackModel,
				system: systemPrompt,
				prompt: fullPrompt,
				...(fallbackMaxOutputTokens !== undefined
					? { maxOutputTokens: fallbackMaxOutputTokens }
					: {}),
			});
			let fallbackText = "";
			safeHeartbeat({
				phase: "fallback_generation",
				message: "Generating document via fallback model",
				progress: 50,
			});
			const fallbackHeartbeatLoop = setInterval(() => {
				safeHeartbeat({
					phase: "fallback_generation",
					message: "Generating document via fallback model",
					progress: 50,
				});
			}, 10_000);
			try {
				for await (const chunk of fallbackStream.textStream) {
					fallbackText += chunk;
				}
			} finally {
				clearInterval(fallbackHeartbeatLoop);
			}
			// Fail loudly: a document cut off at the output-token limit is not a
			// success. Throw rather than save a truncated document (workflows must
			// fail loudly — same rule as ContextUpdateTruncatedError).
			const fallbackFinishReason = await fallbackStream.finishReason;
			if (fallbackFinishReason === "length") {
				throw new Error(
					describeTruncation({
						documentType,
						requestedBudget: fallbackMaxOutputTokens,
						observedOutputTokens: await readOutputTokens(
							fallbackStream.usage,
						),
						primaryStreamFailure,
					}),
				);
			}
			documentContent = fallbackText.trim();
		}

		if (!documentContent) {
			activityLogger.warn(
				"No document content from agent; falling back to direct generation",
				{
					projectId,
					documentType,
				},
			);
			// Whole-document generation from a short prompt — maximal mode (see the
			// agent-stream fallback above for why an explicit budget is required).
			const directFallbackMaxOutputTokens = computeMaxOutputTokenBudget(
				modelMetadata,
				{
					promptChars:
						(systemPrompt?.length ?? 0) + fullPrompt.length,
					ceilingTokens: DOCUMENT_GENERATION_FALLBACK_CEILING,
				},
			);
			// Use streamText instead of generateText to keep the gateway connection alive
			// and prevent idle timeout errors on long-running generations
			const directFallbackStream = streamText({
				model: fallbackModel,
				system: systemPrompt,
				prompt: fullPrompt,
				...(directFallbackMaxOutputTokens !== undefined
					? { maxOutputTokens: directFallbackMaxOutputTokens }
					: {}),
			});
			let directFallbackText = "";
			safeHeartbeat({
				phase: "direct_fallback_generation",
				message: "Generating document via direct fallback",
				progress: 55,
			});
			const directFallbackHeartbeatLoop = setInterval(() => {
				safeHeartbeat({
					phase: "direct_fallback_generation",
					message: "Generating document via direct fallback",
					progress: 55,
				});
			}, 10_000);
			try {
				for await (const chunk of directFallbackStream.textStream) {
					directFallbackText += chunk;
				}
			} finally {
				clearInterval(directFallbackHeartbeatLoop);
			}
			// Fail loudly on an output-limit cut-off rather than saving a truncated
			// document as a success (see the agent-stream fallback above).
			const directFallbackFinishReason =
				await directFallbackStream.finishReason;
			if (directFallbackFinishReason === "length") {
				throw new Error(
					describeTruncation({
						documentType,
						requestedBudget: directFallbackMaxOutputTokens,
						observedOutputTokens: await readOutputTokens(
							directFallbackStream.usage,
						),
						primaryStreamFailure,
					}),
				);
			}
			documentContent = directFallbackText.trim();
			if (!documentContent) {
				throw new Error("Fallback generation produced empty content");
			}
		}

		// DEBUG: Check if AI output contains GFM table syntax
		// NOTE: contentPreview moved to debug level to avoid leaking user content in logs
		const hasTablePipes = documentContent.includes("|");
		const hasTableSeparator = /\|[-:]+\|/.test(documentContent);
		activityLogger.debug("Document content table check", {
			projectId,
			hasPipes: hasTablePipes,
			hasTableSeparator: hasTableSeparator,
			contentPreview: documentContent.slice(0, 500),
		});

		// Post-stream validation
		try {
			// documentType is already normalized to lowercase
			const requiredSections = getDocumentSections(
				documentType as DocumentType,
			)
				.filter((s: DocumentSection) => s.required)
				.map((s: DocumentSection) => s.name);

			// Pass original document for content preservation validation
			const validation = validateDocument(
				documentContent,
				documentType as DocumentType,
				requiredSections.length > 0 ? requiredSections : undefined,
				contexts,
				currentDocument, // Original document for content preservation checks
			);

			if (!validation.isValid && validation.errors.length > 0) {
				activityLogger.warn(
					"Document validation failed after generation",
					{
						projectId,
						documentType,
						documentLength: documentContent.length,
						errors: validation.errors,
						errorCount: validation.errors.length,
						score: validation.score,
						summary: validation.summary,
					},
				);
			} else {
				activityLogger.info("Document validation passed", {
					projectId,
					documentType,
					documentLength: documentContent.length,
					score: validation.score,
					warnings: validation.warnings.length,
					summary: validation.summary,
				});
			}

			// Log warnings
			if (validation.warnings.length > 0) {
				activityLogger.warn("Document validation warnings", {
					projectId,
					warnings: validation.warnings,
				});
			}
		} catch (validationError) {
			// Don't fail document generation if validation fails
			activityLogger.warn("Validation error (non-fatal):", {
				projectId,
				error:
					validationError instanceof Error
						? validationError.message
						: String(validationError),
			});
		}

		const totalDuration = Date.now() - startTime;
		activityLogger.info("Document generation completed successfully", {
			projectId,
			documentType,
			documentLength: documentContent.length,
			wordCount: documentContent.split(/\s+/).length,
			totalDurationMs: totalDuration,
			totalDurationSeconds: (totalDuration / 1000).toFixed(2),
		});

		// Normalize HERE, at the single point the content leaves this activity,
		// rather than only inside `saveProjectDocument`. The workflow hands this
		// same string to BOTH the document write and `createDocumentVersion`, so
		// normalizing at the save seam alone left the version row holding text
		// that differs from the document at the same version number — and
		// restoring that version would put the artifacts back. `saveProjectDocument`
		// still normalizes defensively; the transform is a fixed point, so running
		// it twice costs nothing.
		return {
			content: normalizeQuoteArtifacts(documentContent),
			resolvedPromptVersionId,
		};
	} catch (error) {
		const totalDuration = Date.now() - startTime;
		activityLogger.error("Failed to generate document", error, {
			projectId,
			documentType,
			contextCount: contexts.length,
			totalDurationMs: totalDuration,
			totalDurationSeconds: (totalDuration / 1000).toFixed(2),
		});
		throw error;
	}
}

/**
 * Mermaid diagram language identifiers used to detect diagram code fences.
 */
const MERMAID_FENCE_LANGUAGES = new Set([
	"mermaid",
	"c4context",
	"c4container",
	"c4component",
	"c4deployment",
	"c4dynamic",
	"flowchart",
	"sequencediagram",
	"classdiagram",
	"statediagram",
	"erdiagram",
	"gantt",
	"pie",
	"mindmap",
	"timeline",
	"gitgraph",
	"journey",
	"quadrantchart",
	"sankey",
	"xychart",
	"block",
]);

const MERMAID_LANGUAGE_PATTERN =
	/^(mermaid|c4context|c4container|c4component|c4deployment|c4dynamic|flowchart|sequencediagram|classdiagram|statediagram|erdiagram|gantt|pie|mindmap|timeline|gitgraph|journey|quadrantchart|sankey|xychart|block|graph\s+[TL][BDRB])/i;

/**
 * Repair AI-generated markdown where mermaid code fences are left unclosed.
 *
 * A common AI failure mode is forgetting to close a mermaid fence before
 * continuing with headings or prose.  This causes the downstream TipTap
 * parser to swallow the entire remainder of the document into one code block.
 *
 * The repair walks line-by-line:
 *  - Inside a mermaid/diagram fence, a markdown heading (`## …`) signals
 *    the AI forgot to close the fence → auto-close before the heading.
 *  - A bare ` ``` ` (no language) followed by structured markdown is treated
 *    as a stray marker and discarded instead of opening a code block.
 */
/**
 * Read the output-token count a finished stream actually produced.
 *
 * Reported alongside the requested budget so a truncation says which of two very
 * different things happened: the provider clamped BELOW what we asked for (the
 * numbers disagree), or the model genuinely generated to the ceiling and was
 * still going (they match). Before Fizzy #2210 only the requested number was
 * printed, so those two cases were indistinguishable and the message blamed the
 * document for both.
 *
 * Never throws: a usage figure is diagnostic detail on an error path, and losing
 * it must not replace the truncation error with a different one.
 */
async function readOutputTokens(
	usage: PromiseLike<unknown>,
): Promise<number | undefined> {
	try {
		const resolved = await usage;
		if (
			typeof resolved === "object" &&
			resolved !== null &&
			"outputTokens" in resolved
		) {
			// Not always a plain number: since the AI SDK v6 provider interface
			// some providers report a `{ total, … }` breakdown instead, and a
			// bare typeof check drops the count on exactly those.
			// `readTokenCount` is the repo's reader for both shapes.
			const raw = (resolved as { outputTokens?: unknown }).outputTokens;
			// A reported ZERO is the most diagnostic value there is on this path:
			// the provider admitted the request and produced nothing. Collapsing it
			// into "unreported" would hide exactly the case the two numbers exist
			// to separate, so only an ABSENT field returns undefined.
			if (raw === undefined || raw === null) {
				return undefined;
			}
			return readTokenCount(raw);
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build the user-facing message for a generation that stopped on the model's
 * output-token limit.
 *
 * Deliberately does NOT claim the document is too large. That claim was in the
 * old message unconditionally, and it was usually false: this branch is only
 * reachable after the primary agent already failed, and the document that
 * produced the original report needed roughly a third of the budget the message
 * accused it of exceeding. State the numbers, name the first failure, and let
 * the reader draw the conclusion the evidence supports.
 */
function describeTruncation(input: {
	documentType: string;
	requestedBudget: number | undefined;
	observedOutputTokens: number | undefined;
	primaryStreamFailure: string | undefined;
}): string {
	const budget = input.requestedBudget ?? "provider default";
	const produced =
		input.observedOutputTokens === undefined
			? "an unreported number of"
			: `${input.observedOutputTokens}`;

	// Names the FIRST failure without quoting it. `primaryStreamFailure` is the
	// generation client's own error text — an HTTP body from the internal service,
	// or a socket error carrying its host and port — and this string is rendered
	// verbatim to every project member through `generationError`. The raw cause
	// belongs in the audit ledger, which is admin-gated; here it would be both
	// unusable to the reader and an internal-topology leak.
	const cause = input.primaryStreamFailure
		? " This ran as a fallback because the document generation service could not be reached; an administrator can find the underlying error in the audit log."
		: "";

	return `Document generation for "${input.documentType}" stopped at the model's output-token limit after producing ${produced} tokens against a requested budget of ${budget}.${cause}`;
}

export function repairMalformedMermaidFences(source: string): string {
	const lines = source.split("\n");
	const output: string[] = [];
	let inFence = false;
	let fenceLanguage = "";
	let fenceBody: string[] = [];

	const flushFence = () => {
		if (!inFence) {
			return;
		}
		output.push(`\`\`\`${fenceLanguage}`.trimEnd());
		output.push(...fenceBody);
		output.push("```");
		inFence = false;
		fenceLanguage = "";
		fenceBody = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect fence opening
		if (!inFence && trimmed.startsWith("```")) {
			const lang = trimmed.slice(3).trim().toLowerCase();

			// A bare ``` with no language — check if the next non-empty content
			// is structured markdown.  If so, skip it (stray marker).
			if (!lang) {
				inFence = true;
				fenceLanguage = "";
				fenceBody = [];
				continue;
			}

			inFence = true;
			fenceLanguage = lang;
			fenceBody = [];
			continue;
		}

		// Detect fence closing
		if (inFence && trimmed === "```") {
			flushFence();
			continue;
		}

		if (inFence) {
			// Detect language on first non-empty line for bare fences
			if (
				!fenceLanguage &&
				fenceBody.length === 0 &&
				trimmed &&
				/^[a-z0-9_+-]+$/i.test(trimmed)
			) {
				fenceLanguage = trimmed.toLowerCase();
				continue;
			}

			// Auto-close mermaid fences when a heading is encountered
			const isMermaid =
				MERMAID_FENCE_LANGUAGES.has(fenceLanguage) ||
				MERMAID_LANGUAGE_PATTERN.test(fenceLanguage);

			if (isMermaid && /^#{1,6}\s/.test(trimmed)) {
				flushFence();
				output.push(line);
				continue;
			}

			// A bare ``` (no language) with structured markdown → discard fence,
			// emit accumulated body as regular markdown
			if (!fenceLanguage && /^#{1,6}\s/.test(trimmed)) {
				for (const bodyLine of fenceBody) {
					output.push(bodyLine);
				}
				inFence = false;
				fenceLanguage = "";
				fenceBody = [];
				output.push(line);
				continue;
			}

			fenceBody.push(line);
			continue;
		}

		// Detect bare mermaid keyword on its own line (no ``` prefix).
		// AI sometimes outputs just "mermaid" followed by diagram content
		// instead of "```mermaid".  Only treat as a fence if the NEXT
		// non-empty line starts with a known diagram type declaration,
		// so we don't accidentally swallow the word "mermaid" in prose.
		if (
			trimmed.toLowerCase() === "mermaid" &&
			trimmed.length === 7 // exact match, not "mermaid-like-word"
		) {
			// Look ahead for a diagram type declaration
			const remaining = lines.slice(lines.indexOf(line) + 1);
			const nextNonEmpty = remaining.find((l) => l.trim().length > 0);
			const diagramStarters =
				/^(C4Context|C4Container|C4Component|C4Deployment|C4Dynamic|flowchart|graph\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey|quadrantChart|sankey|xychart|block-beta)/i;
			if (nextNonEmpty && diagramStarters.test(nextNonEmpty.trim())) {
				inFence = true;
				fenceLanguage = "mermaid";
				fenceBody = [];
				continue;
			}
		}

		output.push(line);
	}

	// Flush any remaining unclosed fence at end of document
	flushFence();

	return output.join("\n");
}

/**
 * Save generated document to database
 * Preserves existing status unless document is new (DRAFT)
 *
 * When the document already has content (regeneration), a version snapshot
 * of the previous content is created first. This ensures the user can
 * recover the old content from version history even if they close the page
 * before accepting/rejecting the regeneration.
 */
export async function saveProjectDocument(
	documentId: string,
	rawContent: string,
	userId?: string,
): Promise<void> {
	activityLogger.info("Saving project document", { documentId });

	// Normalize malformed mermaid code fences before persisting.
	// AI models sometimes forget to close a mermaid fence before continuing
	// with markdown headings, causing all subsequent content to be swallowed
	// into one giant code block.  We repair this at save-time so the stored
	// document is always well-formed.
	const content = normalizeQuoteArtifacts(
		repairMalformedMermaidFences(rawContent),
	);

	try {
		// Get current document to preserve status and snapshot existing content
		const currentDoc = await db.projectDocument.findUnique({
			where: { id: documentId },
			select: { status: true, content: true, version: true },
		});

		if (!currentDoc) {
			throw new Error(`Document not found: ${documentId}`);
		}

		// Snapshot the previous content before overwriting (regeneration safety net).
		// If the user closes the page before accepting/rejecting, this version
		// record lets them recover the old content from version history.
		const hasExistingContent =
			currentDoc.content && currentDoc.content.trim().length > 0;
		if (hasExistingContent) {
			try {
				// Check if a version for the current version number already exists
				const existingVersion = await db.documentVersion.findFirst({
					where: {
						documentId,
						version: currentDoc.version,
					},
				});

				if (!existingVersion) {
					await db.documentVersion.create({
						data: {
							documentId,
							version: currentDoc.version,
							content: currentDoc.content,
							changeDescription:
								"Pre-regeneration snapshot (auto)",
							changedBy: userId,
						},
					});

					activityLogger.info(
						"Created pre-regeneration version snapshot",
						{
							documentId,
							version: currentDoc.version,
						},
					);
				}
			} catch (snapshotError) {
				// Non-fatal — saving the new content is more important
				activityLogger.warn(
					"Failed to create pre-regeneration snapshot",
					{
						documentId,
						error:
							snapshotError instanceof Error
								? snapshotError.message
								: "Unknown error",
					},
				);
			}
		}

		// Calculate word count
		const wordCount = content
			.split(/\s+/)
			.filter((word) => word.length > 0).length;

		// Set to COMPLETE if document was DRAFT or GENERATING (code-based setup)
		const newStatus =
			currentDoc.status === "DRAFT" || currentDoc.status === "GENERATING"
				? "COMPLETE"
				: currentDoc.status;

		await db.projectDocument.update({
			where: { id: documentId },
			data: {
				content,
				wordCount,
				status: newStatus,
				updatedAt: new Date(),
			},
		});

		activityLogger.info("Project document saved", {
			documentId,
			wordCount,
			status: newStatus,
		});
	} catch (error) {
		activityLogger.error("Failed to save project document", error, {
			documentId,
		});
		throw error;
	}
}

/**
 * Async decision pre-check for a freshly generated document.
 *
 * Runs AFTER the document is saved: reads the persisted content, checks it
 * against the project's ACCEPTED/REJECTED architecture decisions, and stores any
 * findings on `ProjectDocument.decisionPrecheck` so the editor can flag a
 * contradiction before the reviewer accepts the generated content.
 *
 * Strictly additive and fully self-contained: the calling workflow stays
 * deterministic and always schedules this call under its `patched()` gate, and
 * every failure is swallowed to a `warn`. It never throws, so any error leaves
 * the generated document exactly as it was.
 *
 * `checkedContentHash` is computed from the judged content with the same
 * `generateContentHash` the document read path recomputes for the banner's
 * freshness gate, so the editor can tell whether the findings still describe the
 * current content (a later edit/regeneration changes the hash and marks them
 * stale). Freshness is deliberately NOT tied to the embed-owned `contentHash`
 * column: the banner compares `checkedContentHash` against a hash freshly
 * computed from the live content on read (`getDocumentById.currentContentHash`),
 * so a failed, skipped, or not-yet-run embed no longer hides the warning.
 */
export async function runDocumentDecisionPrecheckActivity(params: {
	documentId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	const { documentId, projectId, userId, organizationId } = params;

	try {
		const document = await db.projectDocument.findUnique({
			where: { id: documentId },
			select: { content: true },
		});
		const content = document?.content;
		if (!content || content.trim().length === 0) {
			return;
		}

		const result = await runDecisionPrecheck({
			projectId,
			userId,
			organizationId,
			artifact: {
				surface: "document",
				items: [{ text: content }],
			},
		});

		const checkedContentHash = generateContentHash(content);

		// Superseded-run guard. This activity is single-attempt, does not
		// heartbeat, and never observes cancellation, so when a newer generation
		// TERMINATE_EXISTINGs the older workflow the older run's pre-check keeps
		// running to completion and its write still lands. Persisting
		// unconditionally would let a stale run overwrite a newer run's findings
		// with a verdict judged over now-replaced content — and stamp a
		// `checkedContentHash` that no longer matches the live content, which the
		// banner reads as "stale" and hides, permanently suppressing a real
		// conflict. Condition the write on the content still being exactly what
		// was judged (the same superseded-run hazard the embed step guards with
		// `expectedVersion: document.version`); a superseded run then matches 0
		// rows and no-ops instead of clobbering the live findings.
		const { count } = await db.projectDocument.updateMany({
			where: { id: documentId, content },
			data: {
				decisionPrecheck: {
					...result,
					checkedContentHash,
				} as unknown as Prisma.InputJsonValue,
			},
		});

		if (count === 0) {
			activityLogger.info(
				"Decision pre-check result discarded: document content changed since it was judged (superseded run)",
				{ documentId, projectId },
			);
		}
	} catch (error) {
		activityLogger.warn(
			"Decision pre-check failed; leaving document without warnings",
			{
				documentId,
				projectId,
				error: error instanceof Error ? error.message : "Unknown error",
			},
		);
	}
}

/**
 * Create document version record for the generated content.
 * Determines the correct version number based on existing versions.
 * For initial generation, creates version 1.
 * For regeneration, creates the next version after the current one.
 */
export async function createDocumentVersion(
	documentId: string,
	content: string,
	userId: string,
	promptVersionId?: string,
): Promise<void> {
	activityLogger.info("Creating document version", { documentId });

	try {
		// Use the highest existing version record to determine the next version number.
		// This avoids slot collisions when the editor's pre-edit snapshot already occupies
		// the document's current version number.
		const maxVersion = await db.documentVersion.findFirst({
			where: { documentId },
			orderBy: { version: "desc" },
			select: { version: true },
		});

		const nextVersion = maxVersion ? maxVersion.version + 1 : 1;
		const isInitial = nextVersion <= 1;

		await db.documentVersion.create({
			data: {
				documentId,
				content,
				version: nextVersion,
				changeDescription: isInitial
					? "Initial version"
					: "Regenerated version",
				changedBy: userId,
				promptVersionId,
			},
		});

		// Keep the document's version field in sync
		await db.projectDocument.update({
			where: { id: documentId },
			data: { version: nextVersion },
		});

		activityLogger.info("Document version created", {
			documentId,
			version: nextVersion,
		});
	} catch (error) {
		activityLogger.error("Failed to create document version", error, {
			documentId,
		});
		throw error;
	}
}

/**
 * Compute boolean flags for the QA Strategy depth tier.
 * Defaults to STANDARD when the level is null or undefined.
 * Exactly one flag is true; the Handlebars template branches on these
 * because the repo does not register custom Handlebars helpers.
 */
export function computeQaDepthFlags(
	qaStrategyLevel: "LIGHT" | "STANDARD" | "STRICT" | null | undefined,
): { isLightQA: boolean; isStandardQA: boolean; isStrictQA: boolean } {
	const level = qaStrategyLevel ?? "STANDARD";
	return {
		isLightQA: level === "LIGHT",
		isStandardQA: level === "STANDARD",
		isStrictQA: level === "STRICT",
	};
}

/**
 * Document types that should be embedded for RAG
 * All document types are embedded so they can serve as cross-document context
 * (e.g., TECHNICAL_SPEC as context for API_SPEC generation, imported docs as RAG context)
 */
export const EMBEDDABLE_DOCUMENT_TYPES = [
	"BUSINESS_CASE",
	"DESIGN_SYSTEM",
	"PRD",
	"PROPOSAL",
	"TECHNICAL_SPEC",
	"API_SPEC",
	"ARCHITECTURE",
	"USER_STORY",
	"QA_STRATEGY",
	"SRS",
];

/**
 * Embed a project document for RAG retrieval
 * Called after document generation to make PRD/Proposal available as context
 */
export async function embedProjectDocumentActivity(params: {
	documentId: string;
	userId: string;
	organizationId?: string;
}): Promise<{ success: boolean; error?: string }> {
	const { documentId, userId, organizationId } = params;

	activityLogger.info("Embedding project document", { documentId });

	// Grab the cancellation signal so the embed loop can bail out quickly when
	// the workflow is terminated (e.g. TERMINATE_EXISTING on rapid save).
	// The SDK flips `cancellationSignal.aborted` inside `cancel()` as soon as
	// the heartbeat response carries a cancellation, so as long as we keep
	// heartbeating the signal stays accurate. The heartbeat interval is kept
	// aggressively short (1 s) so even single-chunk embeds (which can finish
	// in under a second) have a chance to see cancellation before they
	// complete their Qdrant upsert.
	let cancellationSignal: AbortSignal | undefined;
	try {
		cancellationSignal = Context.current().cancellationSignal;
	} catch {
		// Not running inside a Temporal activity context (e.g. unit tests).
		// Leave cancellationSignal undefined; the embed loop treats absence
		// as "cancellation never occurs" and behaves exactly as before.
	}

	// Embedding a large chunked document can easily exceed the 30s heartbeat
	// timeout (many sequential embedding + Qdrant upsert calls). Fire a
	// periodic heartbeat so Temporal knows the worker is alive until the
	// embed + store loop finishes. See docs/bugs — previously surfaced as
	// TIMEOUT_TYPE_HEARTBEAT on documentEmbeddingWorkflow.
	safeHeartbeat({ stage: "started", documentId });
	const heartbeatInterval = setInterval(() => {
		safeHeartbeat({ stage: "embedding", documentId });
	}, 1_000);

	try {
		// Get document with all required fields.
		// `version` is threaded through as a race guard: the final
		// markDocumentAsEmbedded step is gated on the row still being at
		// this version, which prevents a superseded run (started before a
		// newer save that TERMINATE_EXISTING-d its workflow but whose
		// activity kept running) from overwriting the DB with stale state.
		const document = await db.projectDocument.findUnique({
			where: { id: documentId },
			select: {
				id: true,
				projectId: true,
				type: true,
				title: true,
				content: true,
				contentHash: true,
				status: true,
				isActive: true,
				userId: true,
				organizationId: true,
				version: true,
			},
		});

		if (!document) {
			throw new Error(`Document not found: ${documentId}`);
		}

		// Only embed supported document types
		if (!EMBEDDABLE_DOCUMENT_TYPES.includes(document.type)) {
			activityLogger.info(
				`Skipping embedding for document type ${document.type}`,
				{ documentId },
			);
			return { success: true };
		}

		// Only embed completed documents
		if (document.status !== "COMPLETE") {
			activityLogger.info(
				`Skipping embedding for non-complete document (status: ${document.status})`,
				{ documentId },
			);
			return { success: true };
		}

		// Only embed active documents (inactive docs should not be in RAG)
		if (!document.isActive) {
			activityLogger.info("Skipping embedding for inactive document", {
				documentId,
			});
			return { success: true };
		}

		// Get provider config for embedding
		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});

		// Check if we need to re-embed (content changed)
		const hasExistingEmbedding = !!document.contentHash;

		const embedOptions = {
			documentId: document.id,
			projectId: document.projectId,
			userId: document.userId || userId,
			organizationId: document.organizationId || organizationId,
			content: document.content,
			documentType: document.type,
			title: document.title,
			apiKey: {
				apiKey: providerConfig.apiKey,
				provider: providerConfig.provider,
				baseUrl: providerConfig.baseUrl,
			},
			// Race guard: the mark step will only succeed if the DB row is
			// still at this version when the embedding finishes. A newer
			// save bumps `version`, so if this run is superseded the
			// conditional mark becomes a no-op.
			expectedVersion: document.version,
			// Cancellation hook: the embed loop checks this between each
			// batch and each upsert window, so a superseded run stops
			// calling storeProjectContext as soon as Temporal propagates
			// termination through the next heartbeat. Without this a stale
			// run could keep upserting Qdrant point IDs after a newer run
			// had already landed, leaving retrieval stale.
			abortSignal: cancellationSignal,
		};

		let result:
			| Awaited<ReturnType<typeof reembedProjectDocument>>
			| undefined;
		if (hasExistingEmbedding) {
			// Re-embed (will check content hash and skip if unchanged)
			result = await reembedProjectDocument(
				embedOptions,
				document.contentHash || undefined,
			);
		} else {
			// First-time embedding
			result = await embedProjectDocument(embedOptions);
		}

		if (result.success) {
			activityLogger.info("Project document embedded successfully", {
				documentId,
				chunksCreated: result.chunksCreated,
				contentHash: result.contentHash,
			});
		} else {
			activityLogger.warn("Project document embedding failed", {
				documentId,
				error: result.error,
			});
		}

		return { success: result.success, error: result.error };
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		activityLogger.error("Failed to embed project document", error, {
			documentId,
		});
		// Don't throw - embedding failure shouldn't fail the workflow
		return { success: false, error: errorMessage };
	} finally {
		clearInterval(heartbeatInterval);
	}
}

/**
 * Save external PRD content as a ProjectDocument
 *
 * When PRD comes from an external source (Notion, Confluence, etc.),
 * this activity saves it as a ProjectDocument so it can be:
 * 1. Embedded for RAG retrieval
 * 2. Edited by users in the document editor
 * 3. Tracked with version history
 *
 * Uses upsert pattern - only ONE PRD exists per project at any time.
 */
export async function saveExternalPrd(params: {
	projectId: string;
	content: string;
	sourceUrl?: string;
	sourceTitle?: string;
	mcpConfigId: string;
	toolName: string;
	userId: string;
	organizationId?: string;
}): Promise<{ id: string }> {
	const {
		projectId,
		content,
		sourceUrl,
		sourceTitle,
		mcpConfigId,
		toolName,
		userId,
		organizationId,
	} = params;

	activityLogger.info("Saving external PRD as ProjectDocument", {
		projectId,
		sourceUrl,
		sourceTitle,
		mcpConfigId,
		toolName,
	});

	try {
		// Check if PRD already exists for this project
		const existingPrd = await db.projectDocument.findFirst({
			where: { projectId, type: "PRD" },
			select: { id: true, version: true },
		});

		// Build generation prompt to store source information
		// This provides context about where the PRD came from
		const sourceInfo = [
			`Source: External (${toolName})`,
			sourceUrl ? `URL: ${sourceUrl}` : null,
			`Synced: ${new Date().toISOString()}`,
			`MCP Config: ${mcpConfigId}`,
		]
			.filter(Boolean)
			.join("\n");

		// Calculate word count
		const wordCount = content
			.split(/\s+/)
			.filter((word) => word.length > 0).length;

		if (existingPrd) {
			// Update existing PRD document
			const newVersion = existingPrd.version + 1;

			// Save current content as a version before updating
			const currentDoc = await db.projectDocument.findUnique({
				where: { id: existingPrd.id },
				select: { content: true },
			});

			if (currentDoc) {
				await db.documentVersion.create({
					data: {
						documentId: existingPrd.id,
						version: existingPrd.version,
						content: currentDoc.content,
						changeDescription: "Version before external PRD sync",
						changedBy: userId,
					},
				});
			}

			await db.projectDocument.update({
				where: { id: existingPrd.id },
				data: {
					content,
					version: newVersion,
					wordCount,
					status: "COMPLETE",
					generationPrompt: sourceInfo,
					lastEditedBy: userId,
					updatedAt: new Date(),
				},
			});

			activityLogger.info("External PRD updated existing document", {
				documentId: existingPrd.id,
				version: newVersion,
				wordCount,
			});

			return { id: existingPrd.id };
		}

		// Create new PRD document
		const doc = await db.projectDocument.create({
			data: {
				projectId,
				type: "PRD",
				title: sourceTitle || "Product Requirements Document",
				content,
				status: "COMPLETE",
				version: 1,
				wordCount,
				userId,
				organizationId,
				generationPrompt: sourceInfo,
				lastEditedBy: userId,
			},
		});

		// Create initial version
		await db.documentVersion.create({
			data: {
				documentId: doc.id,
				version: 1,
				content,
				changeDescription: "Initial version from external source",
				changedBy: userId,
			},
		});

		activityLogger.info("External PRD saved as new document", {
			documentId: doc.id,
			version: 1,
			wordCount,
		});

		return { id: doc.id };
	} catch (error) {
		activityLogger.error("Failed to save external PRD", error, {
			projectId,
			mcpConfigId,
		});
		throw error;
	}
}

/**
 * Update project workflow status in database
 */
export async function updateProjectWorkflowStatus(
	projectId: string,
	workflowId: string,
	runId: string,
	status: "RUNNING" | "COMPLETED" | "FAILED",
): Promise<void> {
	activityLogger.info("Updating project workflow status", {
		projectId,
		workflowId,
		runId,
		status,
	});

	try {
		// Store workflow status in project metadata
		await db.project.update({
			where: { id: projectId },
			data: {
				updatedAt: new Date(),
			},
		});

		activityLogger.info("Project workflow status updated", {
			projectId,
			status,
		});
	} catch (err) {
		activityLogger.error("Failed to update project workflow status", err, {
			projectId,
		});
		// Don't throw - this is not critical
	}
}

/**
 * Update project document generation status
 */
export async function updateProjectDocumentStatus(params: {
	documentId: string;
	status:
		| "DRAFT"
		| "GENERATING"
		| "IN_PROGRESS"
		| "REVIEW"
		| "COMPLETE"
		| "FAILED";
	progress: number;
	error?: string;
}): Promise<void> {
	const { documentId, status, progress, error } = params;

	activityLogger.info("Updating project document status", {
		documentId,
		status,
		progress,
	});

	try {
		const updateData: any = {
			status,
			generationProgress: progress,
			updatedAt: new Date(),
		};

		if (status === "GENERATING" && progress === 0) {
			updateData.generationStartedAt = new Date();
		}

		if (status === "COMPLETE") {
			updateData.generationCompletedAt = new Date();
		}

		if (status === "FAILED" && error) {
			updateData.generationError = error;
		}

		await db.projectDocument.update({
			where: { id: documentId },
			data: updateData,
		});

		activityLogger.info("Project document status updated", {
			documentId,
			status,
		});
	} catch (err) {
		activityLogger.error("Failed to update project document status", err, {
			documentId,
		});
		throw err;
	}
}

/**
 * Create or update a stories document for the pipeline output
 * This saves the generated stories content as a ProjectDocument that users can edit
 */
export async function createOrUpdateStoriesDocument(params: {
	projectId: string;
	content: string;
	pipelineExecutionId: string;
	userId: string;
}): Promise<{ documentId: string; version: number; isNew: boolean }> {
	const { projectId, content, pipelineExecutionId, userId } = params;

	activityLogger.info("Creating/updating stories document", {
		projectId,
		pipelineExecutionId,
	});

	try {
		// Check if a USER_STORY document already exists for this project
		const existingDoc = await db.projectDocument.findFirst({
			where: {
				projectId,
				type: "USER_STORY",
			},
			orderBy: { createdAt: "desc" },
		});

		// Calculate word count
		const wordCount = content
			.split(/\s+/)
			.filter((word) => word.length > 0).length;

		if (existingDoc) {
			// Increment version and update content
			const newVersion = existingDoc.version + 1;

			// Save current content as a version before updating
			await db.documentVersion.create({
				data: {
					documentId: existingDoc.id,
					version: existingDoc.version,
					content: existingDoc.content,
					changeDescription: "Version before pipeline regeneration",
					changedBy: userId,
				},
			});

			// Update the document with new content
			await db.projectDocument.update({
				where: { id: existingDoc.id },
				data: {
					content,
					version: newVersion,
					wordCount,
					status: "DRAFT",
					workflowId: pipelineExecutionId,
					lastEditedBy: userId,
					updatedAt: new Date(),
				},
			});

			activityLogger.info("Stories document updated", {
				documentId: existingDoc.id,
				version: newVersion,
			});

			return {
				documentId: existingDoc.id,
				version: newVersion,
				isNew: false,
			};
		}
		// Create new document
		const newDoc = await db.projectDocument.create({
			data: {
				projectId,
				type: "USER_STORY",
				title: "Features",
				content,
				status: "DRAFT",
				version: 1,
				wordCount,
				workflowId: pipelineExecutionId,
				lastEditedBy: userId,
			},
		});

		// Create initial version
		await db.documentVersion.create({
			data: {
				documentId: newDoc.id,
				version: 1,
				content,
				changeDescription: "Initial version from pipeline",
				changedBy: userId,
			},
		});

		activityLogger.info("Stories document created", {
			documentId: newDoc.id,
			version: 1,
		});

		return {
			documentId: newDoc.id,
			version: 1,
			isNew: true,
		};
	} catch (error) {
		activityLogger.error(
			"Failed to create/update stories document",
			error,
			{
				projectId,
			},
		);
		throw error;
	}
}

/**
 * Retrieve and format episodic memories for a project (combined activity)
 *
 * This activity combines retrieval and formatting in one call, making it
 * suitable for use in Temporal workflows that can only call async activities.
 */
export async function retrieveAndFormatEpisodicMemory(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
	query: string;
	limit?: number;
}): Promise<{ formattedContext: string; episodeCount: number }> {
	const episodes = await retrieveEpisodicMemoryForProject(params);
	const formattedContext = formatEpisodicMemoriesForContext(episodes);

	return {
		formattedContext,
		episodeCount: episodes.length,
	};
}

/**
 * Retrieve episodic memories for a project from user-level conversations
 *
 * This searches across ALL user conversations (not project-specific) to find
 * relevant past discussions that might inform the current document generation.
 */
export async function retrieveEpisodicMemoryForProject(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
	query: string;
	limit?: number;
}): Promise<EpisodeSearchResult[]> {
	const { projectId, userId, organizationId, query, limit = 10 } = params;

	const startTime = Date.now();
	activityLogger.info("Retrieving user-level episodic memory", {
		userId,
		hasOrgContext: !!organizationId,
		limit,
	});

	try {
		// Check if episodic memory is enabled for this project
		const ragSettings = await getProjectRagSettings(projectId);
		const enableEpisodicMemory = ragSettings.enableEpisodicMemory ?? true;

		if (!enableEpisodicMemory) {
			activityLogger.info("Episodic memory disabled for project", {
				projectId,
			});
			return [];
		}

		// Use centralized single entry point for embedding model access
		const {
			model: embeddingModel,
			metadata,
			trackUsage,
		} = await getAIEmbeddingModelWithMetadata({ userId, organizationId });

		activityLogger.debug(
			"Resolved embedding model for episodic memory query",
			{
				modelName: metadata.modelString,
				modelProvider: metadata.provider,
			},
		);

		// Track usage (fire-and-forget)
		trackUsage();

		// Generate embedding for the query
		const embeddingStart = Date.now();
		const { embedding: queryEmbedding, usage } = await embed({
			model: embeddingModel,
			value: query,
		});
		logEmbeddingUsageAsync({
			context: { userId, organizationId },
			metadata,
			usageTokens: usage.tokens,
			latencyMs: Date.now() - embeddingStart,
		});

		// Search for relevant past episodes at USER level (no projectId filter)
		// This retrieves memories from all user conversations, not just project-specific ones
		const episodes = await searchSimilarEpisodes({
			queryEmbedding,
			userId,
			organizationId,
			// NOTE: projectId intentionally NOT passed - we want user-level memories
			topK: limit,
			minSimilarity: 0.4, // Lower threshold for episodic memory
		});

		const duration = Date.now() - startTime;
		activityLogger.info("User-level episodic memory retrieval complete", {
			userId,
			episodeCount: episodes.length,
			durationMs: duration,
			topSimilarity: episodes[0]?.similarity?.toFixed(3) || "N/A",
		});

		return episodes;
	} catch (error) {
		const duration = Date.now() - startTime;
		activityLogger.warn("Failed to retrieve episodic memory", {
			userId,
			error: error instanceof Error ? error.message : String(error),
			durationMs: duration,
		});
		// Return empty array on error - episodic memory is optional
		return [];
	}
}

/**
 * Format episodic memories for inclusion in document generation context
 *
 * Converts episode search results into a formatted string that provides
 * context about past project discussions and decisions.
 */
export function formatEpisodicMemoriesForContext(
	episodes: EpisodeSearchResult[],
): string {
	if (episodes.length === 0) {
		return "";
	}

	const formattedEpisodes = episodes.map((ep, index) => {
		const topicsStr =
			ep.keyTopics.length > 0 ? `Topics: ${ep.keyTopics.join(", ")}` : "";

		return `### Past Discussion ${index + 1}: ${ep.title}
${topicsStr}
${ep.summary}
(Relevance: ${(ep.similarity * 100).toFixed(0)}%)`;
	});

	return `
<past_project_discussions>
The following are summaries of relevant past discussions about this project.
Use these to maintain consistency with previous decisions and discussions:

${formattedEpisodes.join("\n\n")}
</past_project_discussions>
`.trim();
}

/**
 * Document types for batch generation in pipeline
 */
export const PIPELINE_DOCUMENT_TYPES = [
	"TECHNICAL_SPEC",
	"API_SPEC",
	"ARCHITECTURE",
	"USER_STORY",
] as const;

/**
 * Document metadata for batch generation
 */
export interface PipelineDocumentConfig {
	type: (typeof PIPELINE_DOCUMENT_TYPES)[number];
	title: string;
	promptKey: string;
}

/**
 * Default configuration for pipeline documents
 */
export const PIPELINE_DOCUMENT_CONFIGS: PipelineDocumentConfig[] = [
	{
		type: "TECHNICAL_SPEC",
		title: "Technical Specification",
		promptKey: "technical_spec_template",
	},
	{
		type: "API_SPEC",
		title: "API Specification",
		promptKey: "api_spec_template",
	},
	{
		type: "ARCHITECTURE",
		title: "Technical Architecture",
		promptKey: "architecture_template",
	},
	{
		type: "USER_STORY",
		title: "Features",
		promptKey: "user_story_template",
	},
];

/**
 * Create document placeholders for batch generation
 *
 * Creates 4 document records (TECHNICAL_SPEC, API_SPEC, ARCHITECTURE, USER_STORY)
 * with GENERATING status so they can be populated by the batch generation workflow.
 */
export async function createPipelineDocumentPlaceholders(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
	pipelineExecutionId: string;
	documentConfig?: Array<{
		type: string;
		action: string;
		prompt?: string;
		promptId?: string;
	}>;
}): Promise<
	Array<{
		id: string;
		type: string;
		title: string;
		promptKey: string;
	}>
> {
	const {
		projectId,
		userId,
		organizationId,
		pipelineExecutionId,
		documentConfig,
	} = params;

	activityLogger.info("Creating pipeline document placeholders", {
		projectId,
		pipelineExecutionId,
		documentTypes: PIPELINE_DOCUMENT_CONFIGS.map((c) => c.type),
	});

	const results: Array<{
		id: string;
		type: string;
		title: string;
		promptKey: string;
	}> = [];

	for (const config of PIPELINE_DOCUMENT_CONFIGS) {
		// Check if user chose to keep existing document for this type
		const userConfig = documentConfig?.find((d) => d.type === config.type);
		if (userConfig?.action === "use_existing") {
			activityLogger.info(
				"Skipping document type - user chose to use existing",
				{
					type: config.type,
				},
			);
			continue;
		}

		try {
			// Check if document of this type already exists
			const existingDoc = await db.projectDocument.findFirst({
				where: {
					projectId,
					type: config.type,
				},
				orderBy: { createdAt: "desc" },
			});

			if (existingDoc) {
				// Update existing document to GENERATING status
				await db.projectDocument.update({
					where: { id: existingDoc.id },
					data: {
						status: "GENERATING",
						workflowId: pipelineExecutionId,
						updatedAt: new Date(),
					},
				});

				results.push({
					id: existingDoc.id,
					type: config.type,
					title: existingDoc.title,
					promptKey: config.promptKey,
				});

				activityLogger.info("Updated existing document to GENERATING", {
					documentId: existingDoc.id,
					type: config.type,
				});
			} else {
				// Create new document placeholder
				const newDoc = await db.projectDocument.create({
					data: {
						projectId,
						type: config.type,
						title: config.title,
						content: "", // Will be populated by generation
						status: "GENERATING",
						version: 1,
						wordCount: 0,
						workflowId: pipelineExecutionId,
						lastEditedBy: userId,
						userId,
						organizationId,
					},
				});

				results.push({
					id: newDoc.id,
					type: config.type,
					title: newDoc.title,
					promptKey: config.promptKey,
				});

				activityLogger.info("Created new document placeholder", {
					documentId: newDoc.id,
					type: config.type,
				});
			}
		} catch (error) {
			activityLogger.error(
				`Failed to create placeholder for ${config.type}`,
				error,
				{ projectId },
			);
			throw error;
		}
	}

	activityLogger.info("Pipeline document placeholders created", {
		projectId,
		count: results.length,
		documentIds: results.map((r) => r.id),
	});

	return results;
}

// ============================================================================
// Document Import from Tagged Contexts
// ============================================================================

/**
 * Clean up raw extracted text into well-structured markdown.
 *
 * PDF/DOCX extraction produces unformatted text. This activity uses a fast
 * AI model (SIMPLE task type) to add proper markdown formatting — headers,
 * lists, tables, code blocks — without adding, removing, or modifying content.
 *
 * Cost: ~$0.01-0.02 per document (SIMPLE model, input-heavy).
 */
export async function cleanupImportedContent(params: {
	rawContent: string;
	documentType: string;
	documentTitle?: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
}): Promise<string> {
	const {
		rawContent,
		documentType,
		documentTitle,
		userId,
		organizationId,
		projectId,
	} = params;

	// Skip cleanup for very short content or already-markdown content
	if (rawContent.length < 100) {
		return rawContent;
	}

	// If content already looks like markdown (has headers), skip cleanup
	const markdownHeaderCount = (rawContent.match(/^#{1,3}\s/gm) || []).length;
	if (markdownHeaderCount >= 3) {
		activityLogger.info(
			"Content already has markdown headers, skipping cleanup",
			{ headerCount: markdownHeaderCount, documentType },
		);
		return rawContent;
	}

	try {
		const {
			model,
			metadata: modelMetadata,
			trackUsage,
		} = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId, organizationId, featureKey: "document-generation" },
		);

		activityLogger.info("Cleaning up imported content", {
			documentType,
			contentLength: rawContent.length,
			model: modelMetadata.modelString,
		});

		// Truncate very long content to avoid token limits on SIMPLE models
		// Only the first portion is sent to the LLM; the remainder is appended raw afterwards
		const maxInputChars = 60000;
		const truncated = rawContent.slice(0, maxInputChars);

		const generationStart = Date.now();
		const cleanupSystem = `You are a document formatter. Convert raw extracted text into clean, well-structured markdown.

Rules:
- Preserve ALL original content exactly — do not add, remove, or modify any information
- Add proper markdown headers (#, ##, ###) based on document structure
- Format lists as bullet points or numbered lists where appropriate
- Format tables using markdown table syntax if tabular data is detected
- Wrap code snippets in code blocks
- Add paragraph breaks for readability
- Do NOT add a title header if the document already starts with one
- Do NOT add any commentary, summaries, or notes of your own`;
		const cleanupPrompt = `Document type: ${documentType}${documentTitle ? `\nDocument title: ${documentTitle}` : ""}

Convert this extracted text to clean markdown:

${truncated}`;

		// The reformat returns the cleaned markdown of the (truncated) input, so
		// output tracks the content actually sent — scaled mode on truncated.length,
		// not rawContent.length. Without an explicit budget Databricks/Anthropic-
		// direct truncate the reformat at their injected defaults (8,192 / 4,096).
		const cleanupMaxOutputTokens = computeScaledOutputTokenBudget(
			modelMetadata,
			{
				inputChars: truncated.length,
				promptChars: cleanupSystem.length + cleanupPrompt.length,
			},
		);

		// Use streamText instead of generateText to keep the gateway connection alive
		// and prevent idle timeout errors on long-running generations
		const cleanupStream = streamText({
			model,
			system: cleanupSystem,
			prompt: cleanupPrompt,
			...(cleanupMaxOutputTokens !== undefined
				? { maxOutputTokens: cleanupMaxOutputTokens }
				: {}),
		});
		let cleanupText = "";
		for await (const chunk of cleanupStream.textStream) {
			cleanupText += chunk;
		}
		const usage = await cleanupStream.usage;

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata: modelMetadata,
			taskType: "SIMPLE",
			usage,
			latencyMs: Date.now() - generationStart,
			projectId,
		});

		const cleaned = cleanupText.trim();
		if (!cleaned || cleaned.length < rawContent.length * 0.3) {
			// If cleanup produced significantly less content, use original
			activityLogger.warn(
				"Cleanup produced too little content, using original",
				{
					originalLength: rawContent.length,
					cleanedLength: cleaned?.length ?? 0,
				},
			);
			return rawContent;
		}

		// If content was truncated, append the remaining raw content
		if (rawContent.length > maxInputChars) {
			const remainder = rawContent.slice(maxInputChars);
			return `${cleaned}\n\n${remainder}`;
		}

		activityLogger.info("Content cleanup complete", {
			originalLength: rawContent.length,
			cleanedLength: cleaned.length,
		});

		return cleaned;
	} catch (error) {
		// Cleanup is best-effort — return raw content on failure
		const errMsg = error instanceof Error ? error.message : "Unknown error";
		activityLogger.warn("Content cleanup failed, using raw content", {
			error: errMsg,
			documentType,
		});
		return rawContent;
	}
}

/**
 * Create a ProjectDocument from extracted context content.
 *
 * Called by the context processing workflow when a context has a documentTag
 * in its metadata (set during upload in the wizard).
 *
 * If an active document of the same type already exists, the new one becomes
 * inactive (the user can activate it from the Documents tab).
 */
/**
 * Write an extracted file's text into a document created before the upload.
 *
 * The sibling of `createImportedDocument`, for the path where the row already
 * exists. The create flow writes it GENERATING so the documents list can show
 * the file arriving; this fills it in. Its id is already in the URL the dialog
 * navigated to, so creating a second row here would strand the user on an empty
 * one.
 *
 * Returns whether the write applied. It does not when the row has left
 * GENERATING — a user edited it, or a second attempt finished first — and the
 * caller treats that as done rather than as an error, because something else
 * has already produced a better answer than this late extraction would.
 */
/**
 * Issue an AI token for a run this worker is about to start on its own.
 *
 * Generation is normally dispatched from the API, which issues the token and
 * passes it in — the type on `ProjectDocumentGenerationInput` still says the
 * secret only lives there. It does not: the worker already issues tokens for
 * delegated scrapes, and needs to here for the same reason. A file used as
 * context has no text at the moment the user submits, so the run cannot be
 * started until extraction finishes, by which point the API request is long
 * gone and there is nobody left to hand a token over.
 */
export async function issueGenerationToken(params: {
	userId: string;
	organizationId?: string;
}): Promise<{ aiToken: string }> {
	const { issueAIToken } = await import("@repo/ai-token");
	const aiToken = await issueAIToken({
		userId: params.userId,
		organizationId: params.organizationId,
		source: "project-document-generation",
	});
	return { aiToken };
}

export async function fillTargetDocument(params: {
	documentId: string;
	contextId: string;
	content: string;
	userId: string;
	organizationId?: string;
}): Promise<{ applied: boolean }> {
	const { fillGeneratingDocument } = await import(
		"@repo/database/prisma/queries/projects/documents"
	);
	const count = await fillGeneratingDocument({
		documentId: params.documentId,
		content: params.content,
		contextId: params.contextId,
	});
	return { applied: count > 0 };
}

/**
 * Mark a pre-created document failed, with a reason written for its reader.
 *
 * Reached when extraction produced nothing usable. Before the row existed up
 * front this outcome was silent — no document appeared and nothing said why —
 * which is the case the ticket's "warn the user on unreadable or corrupted
 * source" requirement names.
 */
export async function failTargetDocument(params: {
	documentId: string;
	reason: string;
}): Promise<{ applied: boolean }> {
	const { failGeneratingDocument } = await import(
		"@repo/database/prisma/queries/projects/documents"
	);
	const count = await failGeneratingDocument({
		documentId: params.documentId,
		reason: params.reason,
	});
	return { applied: count > 0 };
}

export async function createImportedDocument(params: {
	projectId: string;
	contextId: string;
	documentType: string;
	title?: string;
	content: string;
	userId: string;
	organizationId?: string;
}): Promise<{ documentId: string }> {
	const {
		projectId,
		contextId,
		documentType,
		title,
		content,
		userId,
		organizationId,
	} = params;

	activityLogger.info("Creating imported document from context", {
		projectId,
		contextId,
		documentType,
	});

	const wordCount = content
		.split(/\s+/)
		.filter((word) => word.length > 0).length;

	// Validate documentType against known enum values before casting
	const VALID_DOCUMENT_TYPES: readonly string[] = [
		"GENERAL",
		"PRD",
		"PROPOSAL",
		"BUSINESS_CASE",
		"DESIGN_SYSTEM",
		"ARCHITECTURE",
		"TECHNICAL_SPEC",
		"USER_STORY",
		"API_SPEC",
		"SRS",
	];
	const normalizedType = documentType.toUpperCase();
	if (!VALID_DOCUMENT_TYPES.includes(normalizedType)) {
		activityLogger.warn("Unknown document type, defaulting to GENERAL", {
			documentType,
			normalizedType,
		});
	}
	const docType = (
		VALID_DOCUMENT_TYPES.includes(normalizedType)
			? normalizedType
			: "GENERAL"
	) as ProjectDocumentType;
	const existingActive = await db.projectDocument.findFirst({
		where: {
			projectId,
			type: docType,
			isActive: true,
		},
	});

	// Use transaction to ensure document + initial version are created atomically
	const doc = await db.$transaction(async (tx) => {
		const created = await tx.projectDocument.create({
			data: {
				projectId,
				type: docType,
				// One catalog, so an imported document and one created from the
				// Documents tab do not end up with different names for the same
				// type. The local map this replaced had drifted on exactly that:
				// ARCHITECTURE read "Architecture Document" here and "Technical
				// Architecture" everywhere else.
				title: title || documentTypeLabel(documentType),
				content,
				status: "COMPLETE",
				source: "IMPORTED",
				sourceContextId: contextId,
				isActive: !existingActive, // Only active if no existing active doc
				wordCount,
				version: 1,
				userId,
				organizationId: organizationId ?? null,
			},
		});

		// Create initial version record for version history
		await tx.documentVersion.create({
			data: {
				documentId: created.id,
				version: 1,
				content,
				changeDescription: "Initial version from imported document",
				changedBy: userId,
				userId,
				organizationId: organizationId ?? null,
			},
		});

		return created;
	});

	activityLogger.info("Imported document created", {
		documentId: doc.id,
		documentType,
		isActive: !existingActive,
		wordCount,
	});

	return { documentId: doc.id };
}

/**
 * Zombie-sweep activity for project-document embeddings.
 *
 * Lists a batch of currently-embedded documents and, for each one, issues
 * a Qdrant filter-based delete that targets points whose `documentVersion`
 * payload is older than the document's current `version`. Those points
 * are stragglers from embed runs that were superseded (e.g. the workflow
 * was TERMINATE_EXISTING-d mid-run but the activity kept running long
 * enough to finish its upserts).
 *
 * Heartbeats between documents so the scheduler can cancel a long batch
 * gracefully, and returns the cursor for the next page so the workflow
 * can loop until exhausted.
 */
export async function sweepStaleDocumentEmbeddingsActivity(params: {
	batchSize?: number;
	cursor?: string;
}): Promise<{
	scanned: number;
	sweptDocuments: number;
	nextCursor?: string;
}> {
	const batchSize = params.batchSize ?? 100;

	activityLogger.info("Sweeping stale document embeddings", {
		batchSize,
		cursor: params.cursor,
	});

	const documents = await listEmbeddedDocumentsForSweep({
		limit: batchSize,
		cursor: params.cursor,
	});

	if (documents.length === 0) {
		return { scanned: 0, sweptDocuments: 0 };
	}

	let sweptDocuments = 0;
	for (const doc of documents) {
		safeHeartbeat({ stage: "sweeping", documentId: doc.id });
		try {
			await deleteStaleDocumentEmbeddingChunks({
				documentId: doc.id,
				currentVersion: doc.version,
				organizationId: doc.organizationId ?? undefined,
			});
			sweptDocuments += 1;
		} catch (error) {
			// `deleteStaleDocumentEmbeddingChunks` already logs + swallows
			// per-document failures, but guard here too so one broken org
			// can't stop the rest of the batch from sweeping.
			activityLogger.warn("Failed to sweep document embeddings", {
				documentId: doc.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const nextCursor =
		documents.length === batchSize
			? documents[documents.length - 1]?.id
			: undefined;

	activityLogger.info("Stale document embedding sweep batch complete", {
		scanned: documents.length,
		sweptDocuments,
		nextCursor,
	});

	return {
		scanned: documents.length,
		sweptDocuments,
		nextCursor,
	};
}

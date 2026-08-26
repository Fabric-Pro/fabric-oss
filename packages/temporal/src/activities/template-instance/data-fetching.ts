/**
 * Data Fetching Activities
 *
 * Refactored data fetching using the new handler-based architecture.
 * Supports explicit data source types (MCP, Integration, etc.) and RAG processing.
 */

import type { AiJobKey } from "@repo/ai";
import { logger } from "@repo/logs";
import { generateEmbedding } from "@repo/rag";
import { heartbeat } from "@temporalio/activity";
import { getHandlerForDataSource, inferDataSourceType } from "./handlers";
import {
	buildRagContextPrompt,
	deleteReportCollection,
	processDataForRag,
	searchReportCollection,
} from "./rag-processing";
import type {
	AiTaskDefinition,
	DataProcessingConfig,
	DataSourceDefinition,
	DataSourceType,
	FetchContext,
	FetchResult,
	IncrementalFetchState,
	InstanceConnections,
	RagProcessingResult,
} from "./types";
import { getProcessingConfig } from "./types";

// Local result type that uses string for sourceType (workflow compatibility)
export interface DataSourceResult {
	sourceId: string;
	sourceType: string;
	provider: string;
	data: unknown;
	recordCount: number;
	ragProcessing?: RagProcessingResult;
	error?: string;
}

export interface AiAnalysisResult {
	agentId: string;
	task: string;
	output: string;
	outputVariable?: string;
	chunksUsed?: number;
	error?: string;
}

// Types are defined locally above for workflow compatibility

// =============================================================================
// Data Fetching
// =============================================================================

/**
 * Relaxed data source definition that accepts string types (for workflow compatibility)
 */
export interface WorkflowDataSourceDefinition {
	id: string;
	type: string; // Accepts any string, will be normalized
	provider: string;
	operation: string;
	config: Record<string, unknown>;
	processing?: Partial<DataProcessingConfig>;
}

export interface FetchDataSourcesInput {
	dataSources: WorkflowDataSourceDefinition[];
	connections: InstanceConnections;
	userId: string;
	organizationId?: string;
	executionId: string;
	parameters?: Record<string, unknown>;
	dateRange?: { start: string; end: string };
	previousFetchStates?: Record<string, IncrementalFetchState>;
	/** Enable RAG processing for large datasets */
	enableRag?: boolean;
}

export interface FetchDataSourcesResult {
	results: DataSourceResult[];
	/** Qdrant collection name if RAG was used */
	qdrantCollectionId?: string;
	/** Updated fetch states for incremental mode */
	fetchStates: Record<string, IncrementalFetchState>;
	/** Total records fetched across all sources */
	totalRecords: number;
}

/**
 * Fetch data from all configured data sources
 */
export async function fetchDataSources(
	input: FetchDataSourcesInput,
): Promise<FetchDataSourcesResult> {
	const {
		dataSources,
		connections,
		userId,
		organizationId,
		executionId,
		parameters = {},
		dateRange,
		previousFetchStates = {},
		enableRag = false,
	} = input;

	logger.info("[DataFetching] Starting data fetch", {
		executionId,
		dataSourceCount: dataSources.length,
		enableRag,
	});

	const results: DataSourceResult[] = [];
	const fetchStates: Record<string, IncrementalFetchState> = {};
	let totalRecords = 0;
	let qdrantCollectionId: string | undefined;

	// Build fetch context
	const context: FetchContext = {
		userId,
		organizationId,
		executionId,
		parameters,
		dateRange,
	};

	// Process each data source
	for (const dataSource of dataSources) {
		try {
			// Ensure data source has explicit type (backward compat)
			const normalizedDataSource = normalizeDataSource(dataSource);

			// Get appropriate handler
			const handler = getHandlerForDataSource(normalizedDataSource);

			if (!handler) {
				logger.error(
					"[DataFetching] No handler found for data source",
					{
						dataSourceId: normalizedDataSource.id,
						type: normalizedDataSource.type,
						provider: normalizedDataSource.provider,
					},
				);
				results.push({
					sourceId: normalizedDataSource.id,
					sourceType: normalizedDataSource.type,
					provider: normalizedDataSource.provider,
					data: null,
					recordCount: 0,
					error: `No handler available for data source type "${normalizedDataSource.type}" with provider "${normalizedDataSource.provider}"`,
				});
				continue;
			}

			// Validate connection
			const validation = await handler.validateConnection(
				normalizedDataSource,
				connections,
				userId,
				organizationId,
			);

			if (!validation.valid) {
				logger.warn("[DataFetching] Connection validation failed", {
					dataSourceId: normalizedDataSource.id,
					error: validation.error,
				});
				results.push({
					sourceId: normalizedDataSource.id,
					sourceType: normalizedDataSource.type,
					provider: normalizedDataSource.provider,
					data: null,
					recordCount: 0,
					error: validation.error,
				});
				continue;
			}

			// Determine fetch mode
			const fetchMode = normalizedDataSource.config.fetchMode || "full";
			const previousState = previousFetchStates[normalizedDataSource.id];

			let fetchResult: FetchResult;

			if (
				fetchMode === "incremental" &&
				previousState?.lastFetchTimestamp &&
				handler.fetchIncremental
			) {
				logger.info("[DataFetching] Using incremental fetch", {
					dataSourceId: normalizedDataSource.id,
					since: previousState.lastFetchTimestamp,
				});
				fetchResult = await handler.fetchIncremental(
					normalizedDataSource,
					previousState.lastFetchTimestamp,
					connections,
					context,
				);
			} else {
				fetchResult = await handler.fetchData(
					normalizedDataSource,
					connections,
					context,
				);
			}

			// Update fetch state for next run
			if (fetchResult.success) {
				fetchStates[normalizedDataSource.id] = {
					dataSourceId: normalizedDataSource.id,
					lastFetchTimestamp:
						fetchResult.metadata.latestTimestamp ||
						new Date().toISOString(),
					lastCursor: fetchResult.cursor,
					lastRecordCount: fetchResult.recordCount,
				};
			}

			// Process data for RAG if enabled and we have substantial data
			// Skip RAG for small datasets (< 200 records) - direct context is more reliable
			let ragProcessing: RagProcessingResult | undefined;
			const processingConfig = getProcessingConfig(
				normalizedDataSource.processing,
			);
			const RAG_MIN_RECORDS_THRESHOLD = 200;

			if (
				fetchResult.success &&
				(enableRag || processingConfig.embedForRag) &&
				fetchResult.recordCount >= RAG_MIN_RECORDS_THRESHOLD
			) {
				try {
					ragProcessing = await processDataForRag(
						executionId,
						normalizedDataSource,
						fetchResult.data,
						userId,
						organizationId,
					);
					qdrantCollectionId = ragProcessing.collectionName;
				} catch (ragError) {
					logger.warn(
						"[DataFetching] RAG processing failed, continuing without",
						{
							dataSourceId: normalizedDataSource.id,
							error:
								ragError instanceof Error
									? ragError.message
									: "Unknown error",
						},
					);
				}
			} else if (
				fetchResult.success &&
				fetchResult.recordCount > 0 &&
				fetchResult.recordCount < RAG_MIN_RECORDS_THRESHOLD
			) {
				logger.info(
					"[DataFetching] Skipping RAG for small dataset, using direct context",
					{
						dataSourceId: normalizedDataSource.id,
						recordCount: fetchResult.recordCount,
						threshold: RAG_MIN_RECORDS_THRESHOLD,
					},
				);
			}

			totalRecords += fetchResult.recordCount;

			results.push({
				sourceId: normalizedDataSource.id,
				sourceType: normalizedDataSource.type,
				provider: normalizedDataSource.provider,
				data: fetchResult.data,
				recordCount: fetchResult.recordCount,
				ragProcessing,
				error: fetchResult.error,
			});

			logger.info("[DataFetching] Data source fetch complete", {
				dataSourceId: normalizedDataSource.id,
				recordCount: fetchResult.recordCount,
				hasRag: !!ragProcessing,
			});
		} catch (error) {
			logger.error("[DataFetching] Exception fetching data source", {
				dataSourceId: dataSource.id,
				error: error instanceof Error ? error.message : "Unknown error",
			});
			results.push({
				sourceId: dataSource.id,
				sourceType: dataSource.type || "unknown",
				provider: dataSource.provider,
				data: null,
				recordCount: 0,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	logger.info("[DataFetching] All data sources processed", {
		executionId,
		totalRecords,
		successCount: results.filter((r) => !r.error).length,
		errorCount: results.filter((r) => r.error).length,
		hasRag: !!qdrantCollectionId,
	});

	return {
		results,
		qdrantCollectionId,
		fetchStates,
		totalRecords,
	};
}

/**
 * Normalize data source definition (convert string type to DataSourceType)
 */
function normalizeDataSource(
	dataSource: WorkflowDataSourceDefinition,
): DataSourceDefinition {
	const validTypes: DataSourceType[] = [
		"mcp",
		"integration",
		"workspace",
		"user-input",
		"fabric",
	];

	// Normalize the type
	let normalizedType: DataSourceType;
	const inputType = (dataSource.type || "").toLowerCase();

	if (validTypes.includes(inputType as DataSourceType)) {
		normalizedType = inputType as DataSourceType;
	} else {
		// Infer from provider if type is invalid or missing
		normalizedType = inferDataSourceType(dataSource.provider);
		logger.warn("[DataFetching] Inferring data source type", {
			dataSourceId: dataSource.id,
			provider: dataSource.provider,
			inputType: dataSource.type,
			inferredType: normalizedType,
		});
	}

	return {
		id: dataSource.id,
		type: normalizedType,
		provider: dataSource.provider,
		operation: dataSource.operation,
		config: dataSource.config,
		processing: dataSource.processing,
	};
}

// =============================================================================
// RAG-Enhanced AI Analysis
// =============================================================================

/** Section definition for report structure */
export interface ReportSection {
	id: string;
	title: string;
	type: string;
	config?: Record<string, unknown>;
}

export interface ExecuteAiAnalysisInput {
	aiAgents: AiTaskDefinition[];
	dataResults: DataSourceResult[];
	qdrantCollectionId?: string;
	enrichedSystemPrompt?: string;
	/** Skills content to append to system prompt */
	skillsContent?: string;
	userId: string;
	organizationId?: string;
	/** Background-attribution label threaded from the workflow input (Fizzy #1894). */
	jobType?: AiJobKey;
	parameters?: Record<string, unknown>;
	/** Report sections - informs AI about expected output structure */
	sections?: ReportSection[];
	/** Output format — determines whether LLM generates markdown, HTML, etc. */
	outputFormat?: string;
}

/**
 * Execute AI analysis tasks with RAG enhancement when available
 */
export async function executeAiAnalysis(
	input: ExecuteAiAnalysisInput,
): Promise<AiAnalysisResult[]> {
	const {
		aiAgents,
		dataResults,
		qdrantCollectionId,
		enrichedSystemPrompt,
		skillsContent,
		userId,
		organizationId,
		jobType,
		parameters = {},
		sections = [],
		outputFormat = "MARKDOWN",
	} = input;

	const results: AiAnalysisResult[] = [];

	// Import AI utilities. Resolve via getAIModelWithMetadata directly (instead of
	// the getAiModel wrapper, which discards metadata) so the streamText call can
	// size an explicit output-token budget — long HTML generation truncates at
	// Databricks/Anthropic-direct injected defaults without one.
	// generateText replaced by streamText to prevent gateway idle timeouts.
	const { getAIModelWithMetadata, streamText } = await import("@repo/ai");
	const { computeMaxOutputTokenBudget } = await import(
		"@repo/ai/lib/output-token-budget"
	);

	for (const agent of aiAgents) {
		try {
			// Heartbeat before each AI generation to keep Temporal informed
			heartbeat(`Starting AI analysis for agent ${agent.agentId}`);

			let contextPrompt: string;

			if (qdrantCollectionId) {
				// Use RAG for context retrieval
				contextPrompt = await buildRagEnhancedPrompt(
					agent.task,
					qdrantCollectionId,
					userId,
					organizationId,
					sections,
					outputFormat,
				);
			} else {
				// Fallback to direct data context (for small datasets)
				contextPrompt = buildDirectContextPrompt(
					agent.task,
					dataResults,
					parameters,
					sections,
					outputFormat,
				);
			}

			// Get AI model. Preserve the getAiModel wrapper's exact behavior:
			// taskType COMPLEX (no tools), complexity "medium", fire-and-forget
			// trackUsage, and the same "[Orchestrator] Dynamic model selected" log.
			const {
				model,
				metadata: modelMetadata,
				trackUsage,
			} = await getAIModelWithMetadata(
				{
					taskType: "COMPLEX",
					complexity: "medium",
					requiresToolCalling: false,
				},
				{ userId, organizationId, jobType },
			);
			console.log(
				`[Orchestrator] Dynamic model selected: ${modelMetadata.modelString} (source: ${modelMetadata.selectionSource}, provider: ${modelMetadata.provider})`,
			);
			trackUsage();

			// Generate analysis
			const baseSystem =
				enrichedSystemPrompt ||
				agent.systemPrompt ||
				getDefaultSystemPrompt();
			const systemWithFormat = getOutputFormatInstruction(outputFormat)
				? `${baseSystem}\n\n${getOutputFormatInstruction(outputFormat)}`
				: baseSystem;
			const systemWithSkills = skillsContent
				? `${systemWithFormat}\n\n${skillsContent}`
				: systemWithFormat;

			// Whole HTML/markdown analysis from short prompts — maximal mode.
			const maxOutputTokens = computeMaxOutputTokenBudget(modelMetadata, {
				promptChars: systemWithSkills.length + contextPrompt.length,
			});

			// Use streamText to keep the gateway connection alive during
			// long HTML generation (prevents idle timeout / socket close)
			const stream = streamText({
				model,
				system: systemWithSkills,
				prompt: contextPrompt,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});

			// Consume stream, heartbeating periodically
			let lastHb = Date.now();
			for await (const _chunk of stream.textStream) {
				if (Date.now() - lastHb > 30_000) {
					heartbeat(`AI analysis streaming for ${agent.agentId}`);
					lastHb = Date.now();
				}
			}

			const text = await stream.text;

			results.push({
				agentId: agent.agentId,
				task: agent.task,
				output: text,
				outputVariable: agent.outputVariable,
				chunksUsed: qdrantCollectionId ? 20 : undefined, // Approximate
			});

			// Heartbeat after completion to reset timeout
			heartbeat(`Completed AI analysis for agent ${agent.agentId}`);

			logger.info("[DataFetching] AI analysis complete", {
				agentId: agent.agentId,
				outputLength: text.length,
				usedRag: !!qdrantCollectionId,
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			logger.error("[DataFetching] AI analysis failed", {
				agentId: agent.agentId,
				error: errorMessage,
				stack: errorStack,
			});
			results.push({
				agentId: agent.agentId,
				task: agent.task,
				output: "",
				outputVariable: agent.outputVariable,
				error: errorMessage,
			});
		}
	}

	return results;
}

/**
 * Build RAG-enhanced prompt by retrieving relevant chunks
 */
async function buildRagEnhancedPrompt(
	task: string,
	collectionName: string,
	userId: string,
	organizationId?: string,
	sections: ReportSection[] = [],
	outputFormat = "MARKDOWN",
): Promise<string> {
	try {
		// Get embedding provider config
		const { getEmbeddingConfig } = await import(
			"../orchestrator/utils/model-selector"
		);
		const embeddingConfig = await getEmbeddingConfig(
			userId,
			organizationId,
		);

		// Generate query embedding
		const queryEmbedding = await generateEmbedding(
			task,
			{ userId, organizationId, tags: ["report-analysis"] },
			embeddingConfig,
		);

		// Search for relevant chunks
		const chunks = await searchReportCollection(
			collectionName,
			queryEmbedding.embedding,
			{ topK: 20, minSimilarity: 0.4 },
		);

		// Build context prompt with section guidance
		return buildRagContextPrompt(chunks, task, sections, outputFormat);
	} catch (error) {
		logger.warn("[DataFetching] RAG retrieval failed, using fallback", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return task;
	}
}

/**
 * Build direct context prompt (for small datasets without RAG)
 */
function buildDirectContextPrompt(
	task: string,
	dataResults: DataSourceResult[],
	parameters: Record<string, unknown>,
	sections: ReportSection[] = [],
	outputFormat = "MARKDOWN",
): string {
	const successfulSources = dataResults
		.filter((d) => d.data && !d.error)
		.map(
			(d) =>
				`## Data from ${d.sourceId} (${d.provider}):\n${JSON.stringify(d.data, null, 2)}`,
		);

	const failedSources = dataResults
		.filter((d) => d.error)
		.map(
			(d) =>
				`## ⚠️ Failed to fetch data from ${d.sourceId} (${d.provider}):\nError: ${d.error}`,
		);

	const contextSummary = [...successfulSources, ...failedSources].join(
		"\n\n",
	);

	// Build section structure guidance if sections are provided
	const isHtmlFormat = outputFormat === "HTML" || outputFormat === "PDF";
	let sectionGuidance = "";
	if (sections.length > 0) {
		const sectionList = sections
			.map((s) => {
				const template = s.config?.template as string | undefined;
				if (template) {
					return `- **${s.title}**: ${template}`;
				}
				return `- **${s.title}**`;
			})
			.join("\n");
		const formatInstruction = isHtmlFormat
			? "Generate content for each section based on the available data. Use HTML heading tags (<h2>) for each section."
			: "Generate content for each section based on the available data. Use markdown headers (## Section Title) for each section.";
		sectionGuidance = `## Expected Report Structure
Please structure your response with these sections and their descriptions:
${sectionList}

${formatInstruction}
`;
	}

	return `## Task
${task}

## Available Data
${contextSummary}

${Object.keys(parameters).length > 0 ? `## Parameters\n${JSON.stringify(parameters, null, 2)}\n` : ""}
${sectionGuidance}
Please complete the task based on the available data.`;
}

function getDefaultSystemPrompt(): string {
	return `You are an AI assistant helping to generate reports and analyze data.
Be concise, accurate, and format your response in markdown when appropriate.
Base your analysis only on the provided data context.
Cite specific data points when making claims.`;
}

/**
 * Get output format instruction to append to the system prompt.
 * Tells the LLM to generate content in the appropriate format.
 */
function getOutputFormatInstruction(outputFormat: string): string {
	switch (outputFormat) {
		case "HTML":
			return `## Output Format: HTML
You MUST generate your response as well-structured, semantic HTML content.

Rules:
- Use proper HTML tags: <h1>, <h2>, <h3> for headings, <p> for paragraphs, <ul>/<ol>/<li> for lists, <table>/<thead>/<tbody>/<tr>/<th>/<td> for tables, <strong>, <em> for emphasis, <blockquote> for quotes, <pre><code> for code blocks.
- Do NOT include <html>, <head>, <body>, or <style> tags — only generate the inner content that goes inside a <body>.
- Do NOT use markdown syntax (no #, **, -, \`\`\`, etc.). Use HTML tags exclusively.
- Use CSS class names for styling hints: "summary-box", "metric-card", "highlight", "warning", "data-table".
- Make tables properly structured with <thead> and <tbody>.
- Use <section> tags to group related content.
- Ensure all tags are properly closed and nested.`;
		case "PDF":
			return `## Output Format: PDF-Ready HTML
You MUST generate your response as clean, print-friendly HTML content suitable for PDF conversion.

Rules:
- Use proper HTML tags: <h1>, <h2>, <h3> for headings, <p> for paragraphs, <ul>/<ol>/<li> for lists, <table>/<thead>/<tbody>/<tr>/<th>/<td> for tables.
- Do NOT include <html>, <head>, <body>, or <style> tags — only generate the inner content.
- Do NOT use markdown syntax. Use HTML tags exclusively.
- Avoid complex layouts — use simple, linear content flow suitable for print.
- Use <section> tags to group related content with page-break hints: <section style="page-break-before: always">.
- Make tables properly structured with <thead> and <tbody>.
- Ensure all tags are properly closed and nested.`;
		default:
			// MARKDOWN or unrecognized — default behavior, no extra instruction needed
			return "";
	}
}

// =============================================================================
// Cleanup
// =============================================================================

/**
 * Cleanup RAG collection after report is generated
 */
export async function cleanupRagCollection(
	collectionName: string,
): Promise<void> {
	try {
		await deleteReportCollection(collectionName);
		logger.info("[DataFetching] Cleaned up RAG collection", {
			collectionName,
		});
	} catch (error) {
		logger.warn("[DataFetching] Failed to cleanup RAG collection", {
			collectionName,
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
}

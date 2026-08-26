/**
 * RAG Processing for Report Data
 *
 * Handles chunking, embedding, and storage of report data in Qdrant
 * for efficient retrieval during AI analysis.
 */

import { logger } from "@repo/logs";
import { generateEmbedding } from "@repo/rag";
import {
	DISTANCE_METRIC,
	qdrantClient,
	VECTOR_SIZE,
} from "@repo/rag/lib/vector-store/client";
import type {
	DataProcessingConfig,
	DataSourceDefinition,
	RagProcessingResult,
	RetrievedChunk,
	TextChunk,
} from "./types";
import { getProcessingConfig } from "./types";

// =============================================================================
// Collection Management
// =============================================================================

/**
 * Initialize an ephemeral Qdrant collection for report execution
 */
export async function initializeReportCollection(
	collectionName: string,
): Promise<boolean> {
	try {
		// Check if collection already exists
		const collections = await qdrantClient.getCollections();
		const exists = collections.collections.some(
			(col) => col.name === collectionName,
		);

		if (exists) {
			logger.info(
				`[RagProcessing] Collection "${collectionName}" already exists`,
			);
			return true;
		}

		// Create collection
		await qdrantClient.createCollection(collectionName, {
			vectors: {
				size: VECTOR_SIZE,
				distance: DISTANCE_METRIC,
			},
			optimizers_config: {
				indexing_threshold: 1000, // Lower threshold for faster indexing
			},
		});

		// Create payload indexes for filtering
		await qdrantClient.createPayloadIndex(collectionName, {
			field_name: "dataSourceId",
			field_schema: "keyword",
		});

		await qdrantClient.createPayloadIndex(collectionName, {
			field_name: "timestamp",
			field_schema: "datetime",
		});

		logger.info(`[RagProcessing] Created collection "${collectionName}"`);
		return true;
	} catch (error) {
		logger.error(
			`[RagProcessing] Failed to initialize collection: ${error}`,
		);
		return false;
	}
}

/**
 * Delete an ephemeral report collection (cleanup)
 */
export async function deleteReportCollection(
	collectionName: string,
): Promise<boolean> {
	try {
		await qdrantClient.deleteCollection(collectionName);
		logger.info(`[RagProcessing] Deleted collection "${collectionName}"`);
		return true;
	} catch (error) {
		logger.warn(`[RagProcessing] Failed to delete collection: ${error}`);
		return false;
	}
}

// =============================================================================
// Data Processing
// =============================================================================

/**
 * Process data from a data source for RAG indexing
 */
export async function processDataForRag(
	executionId: string,
	dataSource: DataSourceDefinition,
	data: unknown[],
	userId: string,
	organizationId?: string,
): Promise<RagProcessingResult> {
	const collectionName = `report_exec_${executionId}`;
	const config = getProcessingConfig(dataSource.processing);

	logger.info("[RagProcessing] Processing data for RAG", {
		executionId,
		dataSourceId: dataSource.id,
		recordCount: data.length,
		config,
	});

	// 1. Initialize collection if needed
	const initialized = await initializeReportCollection(collectionName);
	if (!initialized) {
		throw new Error(
			`Failed to initialize Qdrant collection: ${collectionName}`,
		);
	}

	// 2. Convert data to text chunks
	const textChunks = convertToTextChunks(data, dataSource, config);

	if (textChunks.length === 0) {
		logger.warn("[RagProcessing] No chunks generated from data");
		return {
			collectionName,
			chunkCount: 0,
			bytesProcessed: 0,
		};
	}

	// 3. Get embedding provider config
	const { getEmbeddingConfig } = await import(
		"../orchestrator/utils/model-selector"
	);
	const embeddingConfig = await getEmbeddingConfig(userId, organizationId);

	// 4. Generate embeddings in batches
	const batchSize = 50;
	const allEmbeddings: number[][] = [];

	for (let i = 0; i < textChunks.length; i += batchSize) {
		const batch = textChunks.slice(i, i + batchSize);
		const batchEmbeddings = await Promise.all(
			batch.map(async (chunk) => {
				const result = await generateEmbedding(
					chunk.content,
					{ userId, organizationId, tags: ["report-data"] },
					embeddingConfig,
				);
				return result.embedding;
			}),
		);
		allEmbeddings.push(...batchEmbeddings);

		logger.info("[RagProcessing] Embedded batch", {
			batch: Math.floor(i / batchSize) + 1,
			total: Math.ceil(textChunks.length / batchSize),
		});
	}

	// 5. Store in Qdrant
	const points = textChunks.map((chunk, index) => ({
		id: generatePointId(executionId, dataSource.id, index),
		vector: allEmbeddings[index],
		payload: {
			content: chunk.content,
			dataSourceId: chunk.metadata.dataSourceId,
			itemIndex: chunk.metadata.itemIndex,
			chunkIndex: chunk.metadata.chunkIndex,
			timestamp: chunk.metadata.timestamp,
			provider: dataSource.provider,
			operation: dataSource.operation,
		},
	}));

	// Upsert in batches
	for (let i = 0; i < points.length; i += batchSize) {
		const batch = points.slice(i, i + batchSize);
		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: batch,
		});
	}

	const bytesProcessed = textChunks.reduce(
		(acc, chunk) => acc + chunk.content.length,
		0,
	);

	logger.info("[RagProcessing] RAG processing complete", {
		collectionName,
		chunkCount: textChunks.length,
		bytesProcessed,
	});

	return {
		collectionName,
		chunkCount: textChunks.length,
		bytesProcessed,
	};
}

/**
 * Convert raw data to text chunks
 */
function convertToTextChunks(
	data: unknown[],
	dataSource: DataSourceDefinition,
	config: DataProcessingConfig,
): TextChunk[] {
	const chunks: TextChunk[] = [];

	for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
		const item = data[itemIndex];
		const text = formatItemAsText(item, dataSource.provider);

		if (!text || text.trim().length === 0) {
			continue;
		}

		// Split into chunks with overlap
		const itemChunks = splitIntoChunks(
			text,
			config.chunkSize,
			config.chunkOverlap,
		);

		for (let chunkIndex = 0; chunkIndex < itemChunks.length; chunkIndex++) {
			chunks.push({
				content: itemChunks[chunkIndex],
				metadata: {
					dataSourceId: dataSource.id,
					itemIndex,
					chunkIndex,
					timestamp: extractTimestamp(item),
				},
			});
		}
	}

	return chunks;
}

/**
 * Format a data item as text for embedding
 */
function formatItemAsText(item: unknown, provider: string): string {
	if (typeof item === "string") {
		return item;
	}

	if (!item || typeof item !== "object") {
		return "";
	}

	const obj = item as Record<string, unknown>;

	// Provider-specific formatting
	switch (provider.toLowerCase()) {
		case "slack":
			return formatSlackMessage(obj);
		case "github":
			return formatGitHubItem(obj);
		case "linear":
			return formatLinearIssue(obj);
		case "jira":
			return formatJiraIssue(obj);
		case "fizzy":
			return formatFizzyCard(obj);
		default:
			return formatGenericItem(obj);
	}
}

function formatSlackMessage(msg: Record<string, unknown>): string {
	const ts = msg.ts as string;
	const user = msg.user as string;
	const text = msg.text as string;
	const threadTs = msg.thread_ts as string;

	let formatted = "";
	if (ts) {
		const date = new Date(Number.parseFloat(ts) * 1000);
		formatted += `[${date.toISOString()}] `;
	}
	if (user) {
		formatted += `${user}: `;
	}
	formatted += text || "";

	if (threadTs && threadTs !== ts) {
		formatted += " (in thread)";
	}

	return formatted;
}

function formatGitHubItem(item: Record<string, unknown>): string {
	// Issue or PR
	if (item.number && item.title) {
		const type = item.pull_request ? "PR" : "Issue";
		const number = item.number;
		const title = item.title;
		const state = item.state;
		const body = item.body || "";
		const labels = (item.labels as { name: string }[] | undefined)
			?.map((l) => l.name)
			.join(", ");
		const assignee = (item.assignee as { login: string } | undefined)
			?.login;
		const createdAt = item.created_at;

		let formatted = `${type} #${number}: ${title}\n`;
		formatted += `State: ${state}`;
		if (labels) {
			formatted += ` | Labels: ${labels}`;
		}
		if (assignee) {
			formatted += ` | Assignee: ${assignee}`;
		}
		if (createdAt) {
			formatted += ` | Created: ${createdAt}`;
		}
		if (body) {
			formatted += `\n\n${body}`;
		}

		return formatted;
	}

	// Commit
	if (item.sha && item.commit) {
		const sha = (item.sha as string).substring(0, 7);
		const commit = item.commit as {
			message?: string;
			author?: { name?: string; date?: string };
		};
		const message = commit.message || "";
		const author = commit.author?.name || "Unknown";
		const date = commit.author?.date || "";

		return `Commit ${sha} by ${author} (${date}): ${message}`;
	}

	return formatGenericItem(item);
}

function formatLinearIssue(issue: Record<string, unknown>): string {
	const identifier = issue.identifier;
	const title = issue.title;
	const description = issue.description || "";
	const state = (issue.state as { name?: string })?.name;
	const priority = issue.priority;
	const assignee = (issue.assignee as { name?: string })?.name;
	const labels = (issue.labels as { nodes?: { name: string }[] })?.nodes
		?.map((l) => l.name)
		.join(", ");

	let formatted = `${identifier}: ${title}\n`;
	if (state) {
		formatted += `State: ${state}`;
	}
	if (priority) {
		formatted += ` | Priority: ${priority}`;
	}
	if (assignee) {
		formatted += ` | Assignee: ${assignee}`;
	}
	if (labels) {
		formatted += ` | Labels: ${labels}`;
	}
	if (description) {
		formatted += `\n\n${description}`;
	}

	return formatted;
}

function formatJiraIssue(issue: Record<string, unknown>): string {
	const key = issue.key;
	const fields = issue.fields as Record<string, unknown> | undefined;
	if (!fields) {
		return formatGenericItem(issue);
	}

	const summary = fields.summary;
	const description = fields.description || "";
	const status = (fields.status as { name?: string })?.name;
	const priority = (fields.priority as { name?: string })?.name;
	const assignee = (fields.assignee as { displayName?: string })?.displayName;

	let formatted = `${key}: ${summary}\n`;
	if (status) {
		formatted += `Status: ${status}`;
	}
	if (priority) {
		formatted += ` | Priority: ${priority}`;
	}
	if (assignee) {
		formatted += ` | Assignee: ${assignee}`;
	}
	if (description) {
		formatted += `\n\n${description}`;
	}

	return formatted;
}

function formatFizzyCard(card: Record<string, unknown>): string {
	const title = card.title || card.name;
	const description = card.description || "";
	const status = card.status || (card.column as { name?: string })?.name;
	const assignee = (card.assignee as { name?: string })?.name;

	let formatted = `${title}\n`;
	if (status) {
		formatted += `Status: ${status}`;
	}
	if (assignee) {
		formatted += ` | Assignee: ${assignee}`;
	}
	if (description) {
		formatted += `\n\n${description}`;
	}

	return formatted;
}

function formatGenericItem(item: Record<string, unknown>): string {
	// Try to extract meaningful text fields
	const textFields = [
		"content",
		"text",
		"body",
		"message",
		"description",
		"summary",
		"title",
		"name",
	];

	for (const field of textFields) {
		if (typeof item[field] === "string" && item[field]) {
			return item[field] as string;
		}
	}

	// Fallback to JSON
	return JSON.stringify(item, null, 2);
}

/**
 * Split text into chunks with overlap
 */
function splitIntoChunks(
	text: string,
	chunkSize: number,
	overlap: number,
): string[] {
	if (text.length <= chunkSize) {
		return [text];
	}

	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		const end = Math.min(start + chunkSize, text.length);
		chunks.push(text.slice(start, end));

		// Move start forward, accounting for overlap
		start = end - overlap;
		if (start >= text.length - overlap) {
			break;
		}
	}

	return chunks;
}

/**
 * Extract timestamp from a data item
 */
function extractTimestamp(item: unknown): string | undefined {
	if (!item || typeof item !== "object") {
		return undefined;
	}

	const obj = item as Record<string, unknown>;
	const timestampFields = [
		"ts",
		"timestamp",
		"created_at",
		"createdAt",
		"updated_at",
		"updatedAt",
		"date",
	];

	for (const field of timestampFields) {
		const value = obj[field];
		if (value) {
			// Slack-style timestamp
			if (typeof value === "string" && /^\d+\.\d+$/.test(value)) {
				return new Date(Number.parseFloat(value) * 1000).toISOString();
			}
			// ISO string or Date
			if (typeof value === "string" || value instanceof Date) {
				const date = new Date(value as string | Date);
				if (!Number.isNaN(date.getTime())) {
					return date.toISOString();
				}
			}
		}
	}

	return undefined;
}

/**
 * Generate a unique point ID for Qdrant
 */
function generatePointId(
	executionId: string,
	dataSourceId: string,
	chunkIndex: number,
): string {
	// Create a UUID-like string from the components
	const combined = `${executionId}-${dataSourceId}-${chunkIndex}`;
	const hash = simpleHash(combined);
	return formatAsUuid(hash);
}

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	// Convert to positive hex
	return Math.abs(hash).toString(16).padStart(32, "0").slice(0, 32);
}

function formatAsUuid(hash: string): string {
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		hash.slice(12, 16),
		hash.slice(16, 20),
		hash.slice(20, 32),
	].join("-");
}

// =============================================================================
// Retrieval
// =============================================================================

/**
 * Search the report collection for relevant chunks
 */
export async function searchReportCollection(
	collectionName: string,
	queryEmbedding: number[],
	options: {
		topK?: number;
		minSimilarity?: number;
		dataSourceId?: string;
	} = {},
): Promise<RetrievedChunk[]> {
	const { topK = 20, minSimilarity = 0.5, dataSourceId } = options;

	try {
		const filter = dataSourceId
			? {
					must: [
						{ key: "dataSourceId", match: { value: dataSourceId } },
					],
				}
			: undefined;

		const results = await qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			limit: topK,
			score_threshold: minSimilarity,
			filter,
		});

		return results.map((result) => ({
			content: result.payload?.content as string,
			similarity: result.score,
			metadata: {
				dataSourceId: result.payload?.dataSourceId as string,
				itemIndex: result.payload?.itemIndex as number,
				chunkIndex: result.payload?.chunkIndex as number,
				timestamp: result.payload?.timestamp as string,
				provider: result.payload?.provider as string,
			},
		}));
	} catch (error) {
		logger.error(`[RagProcessing] Search failed: ${error}`);
		return [];
	}
}

/** Section definition for report structure */
interface ReportSection {
	id: string;
	title: string;
	type: string;
	config?: Record<string, unknown>;
}

/**
 * Build a RAG context prompt from retrieved chunks
 */
export function buildRagContextPrompt(
	chunks: RetrievedChunk[],
	taskDescription: string,
	sections: ReportSection[] = [],
	outputFormat = "MARKDOWN",
): string {
	if (chunks.length === 0) {
		return taskDescription;
	}

	const contextParts = chunks.map((chunk, i) => {
		const meta = chunk.metadata;
		const relevance = (chunk.similarity * 100).toFixed(1);
		return `[Chunk ${i + 1}] (relevance: ${relevance}%, source: ${meta.provider || "unknown"})
${chunk.content}`;
	});

	const isHtmlFormat = outputFormat === "HTML" || outputFormat === "PDF";

	// Build section structure guidance if sections are provided
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
		sectionGuidance = `
## Expected Report Structure
Please structure your response with these sections and their descriptions:
${sectionList}

${formatInstruction}
`;
	}

	const formatInstruction = isHtmlFormat
		? "Format using semantic HTML tags for structure"
		: "Format using markdown for readability";

	return `## Your Task
${taskDescription}

## Relevant Data Context
The following ${chunks.length} data excerpts are most relevant to your analysis task.
They are sorted by relevance to your task.

${contextParts.join("\n\n---\n\n")}
${sectionGuidance}
## Instructions
- Base your analysis ONLY on the provided data context
- Cite specific data points when making claims
- Highlight trends, patterns, and anomalies
- Be concise but comprehensive
- ${formatInstruction}`;
}

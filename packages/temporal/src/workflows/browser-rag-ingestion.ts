/**
 * Browser RAG Ingestion Workflow
 *
 * Workflow for ingesting web content into the RAG pipeline.
 * Combines browser automation with document chunking and embedding.
 *
 * Use cases:
 * - Extracting content from Confluence Server (browser auth required)
 * - Scraping authenticated internal wikis
 * - Processing JavaScript-rendered pages for RAG
 */

import { proxyActivities, sleep } from "@temporalio/workflow";

import type * as browserActivities from "../activities/browser-automation/activities";
import type * as ragActivities from "../activities/document-processing";

// Browser activities with longer timeout for web operations
const browser = proxyActivities<typeof browserActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		backoffCoefficient: 2,
	},
});

// RAG activities for chunking and embedding
const rag = proxyActivities<typeof ragActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		maximumAttempts: 3,
		initialInterval: "1s",
	},
});

/**
 * Input for browser RAG ingestion workflow
 */
export interface BrowserRagIngestionInput {
	/** URLs to ingest */
	urls: string[];
	/** Chat ID to associate with chunks */
	chatId: string;
	/** User ID for multi-tenancy */
	userId: string;
	/** Organization ID for multi-tenancy */
	organizationId?: string;
	/** CSS selectors for content extraction */
	selectors?: {
		content?: string;
		title?: string;
		exclude?: string[];
	};
	/** Wait for specific element before extraction */
	waitForSelector?: string;
	/** Authentication configuration */
	auth?: {
		mcpConfigId?: string;
	};
	/** Maximum concurrent browser sessions */
	concurrency?: number;
}

/**
 * Output from browser RAG ingestion workflow
 */
export interface BrowserRagIngestionOutput {
	/** Number of URLs processed */
	urlsProcessed: number;
	/** Total chunks created */
	totalChunks: number;
	/** Results per URL */
	results: Array<{
		url: string;
		success: boolean;
		chunkCount?: number;
		error?: string;
	}>;
}

/**
 * Browser RAG Ingestion Workflow
 *
 * Processes web URLs and ingests content into the RAG pipeline.
 * Each URL is processed sequentially to manage browser resources.
 */
export async function browserRagIngestionWorkflow(
	input: BrowserRagIngestionInput,
): Promise<BrowserRagIngestionOutput> {
	const {
		urls,
		chatId,
		userId,
		organizationId,
		selectors,
		waitForSelector,
		auth: _auth,
	} = input;

	const results: BrowserRagIngestionOutput["results"] = [];
	let totalChunks = 0;

	// Generate a task ID for session management
	const taskId = `rag-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

	for (const url of urls) {
		try {
			// Step 1: Create browser session
			const sessionResult = await browser.createBrowserSession({
				taskId,
				userId,
				organizationId,
				options: {
					headless: true,
					timeout: 120000,
					blockResources: ["image", "stylesheet", "font"],
				},
			});

			try {
				// Step 2: Navigate to URL
				await browser.navigateToUrl({
					sessionId: sessionResult.sessionId,
					url,
					waitForSelector,
					timeout: 30000,
				});

				// Step 3: Extract content
				const extractors = buildExtractors(selectors);
				const extracted = await browser.extractContent({
					sessionId: sessionResult.sessionId,
					extractors,
				});

				// Build text content
				const text = buildTextFromExtraction(extracted, url);

				if (!text || text.length < 50) {
					results.push({
						url,
						success: false,
						error: "Insufficient content extracted",
					});
					continue;
				}

				// Step 4: Chunk and embed the content
				const chunkResult = await rag.chunkAndStoreWebContent({
					url,
					text,
					chatId,
					userId,
					organizationId,
				});

				totalChunks += chunkResult.chunkCount;
				results.push({
					url,
					success: true,
					chunkCount: chunkResult.chunkCount,
				});
			} finally {
				// Always close the browser session
				await browser.closeBrowserSession({
					sessionId: sessionResult.sessionId,
					persistStorage: false,
				});
			}

			// Small delay between URLs to avoid overwhelming resources
			await sleep("500ms");
		} catch (error) {
			results.push({
				url,
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return {
		urlsProcessed: urls.length,
		totalChunks,
		results,
	};
}

/**
 * Build extractors configuration from selectors
 */
function buildExtractors(selectors?: BrowserRagIngestionInput["selectors"]) {
	return [
		// Title extractor
		{
			name: "title",
			selector: selectors?.title || "h1, title",
			multiple: false,
			transform: "text" as const,
		},
		// Main content extractor
		{
			name: "content",
			selector:
				selectors?.content || "article, main, .content, #content, body",
			multiple: false,
			transform: "text" as const,
		},
		// Description/meta extractor
		{
			name: "description",
			selector: 'meta[name="description"]',
			attribute: "content",
			multiple: false,
			transform: "text" as const,
		},
	];
}

/**
 * Build text content from extraction results
 */
function buildTextFromExtraction(
	extracted: Record<string, unknown>,
	url: string,
): string {
	const parts: string[] = [];

	// Add URL as source
	parts.push(`Source: ${url}`);
	parts.push("");

	if (extracted.title) {
		parts.push(`# ${extracted.title}`);
		parts.push("");
	}

	if (extracted.description) {
		parts.push(`> ${extracted.description}`);
		parts.push("");
	}

	if (extracted.content) {
		// Clean up the content (remove excessive whitespace)
		const content = String(extracted.content).replace(/\s+/g, " ").trim();
		parts.push(content);
	}

	return parts.join("\n").trim();
}

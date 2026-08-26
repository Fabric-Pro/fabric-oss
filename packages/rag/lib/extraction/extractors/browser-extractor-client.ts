/**
 * Browser Extractor Client
 *
 * Connects to Temporal to execute browser extraction workflows.
 * Separated from main extractor to allow lazy loading and avoid circular dependencies.
 */

import { logger } from "@repo/logs";
import { Client, Connection } from "@temporalio/client";

// Temporal connection configuration
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || "default";
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || "fabric-worker";

/**
 * Input for web content extraction
 */
export interface ExtractWebContentInput {
	url: string;
	userId?: string;
	organizationId?: string;
	selectors?: {
		content?: string;
		title?: string;
		exclude?: string[];
	};
	waitForSelector?: string;
	auth?: {
		mcpConfigId?: string;
		basicAuth?: { username: string; password: string };
	};
	screenshot?: boolean;
	timeout?: number;
}

/**
 * Result of web content extraction
 */
export interface ExtractWebContentResult {
	text: string;
	title?: string;
	screenshotUrl?: string;
}

// Cached Temporal client
let temporalClient: Client | null = null;

/**
 * Get or create Temporal client
 */
async function getTemporalClient(): Promise<Client> {
	if (temporalClient) {
		return temporalClient;
	}

	logger.info(
		`[BrowserExtractorClient] Connecting to Temporal at ${TEMPORAL_ADDRESS}`,
	);

	const connection = await Connection.connect({
		address: TEMPORAL_ADDRESS,
	});

	temporalClient = new Client({
		connection,
		namespace: TEMPORAL_NAMESPACE,
	});

	return temporalClient;
}

/**
 * Extract content from a web page using Temporal browser automation workflow
 */
export async function extractWebContent(
	input: ExtractWebContentInput,
): Promise<ExtractWebContentResult> {
	const client = await getTemporalClient();

	// Generate a unique workflow ID
	const workflowId = `browser-extract-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

	logger.info(
		`[BrowserExtractorClient] Starting workflow ${workflowId} for ${input.url}`,
	);

	// Build extractors from selectors
	const extractors = buildExtractors(input.selectors);

	// Start the browser extraction workflow
	const handle = await client.workflow.start(
		"browserExtractContentWorkflow",
		{
			taskQueue: TEMPORAL_TASK_QUEUE,
			workflowId,
			args: [
				{
					url: input.url,
					userId: input.userId || "system",
					organizationId: input.organizationId,
					extractors,
					screenshot: input.screenshot,
					options: {
						headless: true,
						timeout: input.timeout || 60000,
						blockResources: [
							"image",
							"stylesheet",
							"font",
						] as const,
					},
				},
			],
		},
	);

	// Wait for workflow completion
	const result = await handle.result();

	// Extract text from the extraction result
	const text = buildTextFromExtraction(result.extracted || {});
	const title = result.extracted?.title as string | undefined;

	return {
		text,
		title,
		screenshotUrl: result.screenshotUrl,
	};
}

/**
 * Build extractors configuration from selectors
 */
function buildExtractors(selectors?: ExtractWebContentInput["selectors"]) {
	const extractors = [];

	// Title extractor
	extractors.push({
		name: "title",
		selector: selectors?.title || "h1, title",
		attribute: "textContent",
	});

	// Main content extractor
	extractors.push({
		name: "content",
		selector:
			selectors?.content || "article, main, .content, #content, body",
		attribute: "textContent",
	});

	// Description/meta extractor
	extractors.push({
		name: "description",
		selector: 'meta[name="description"]',
		attribute: "content",
	});

	return extractors;
}

/**
 * Build text content from extraction results
 */
function buildTextFromExtraction(extracted: Record<string, unknown>): string {
	const parts: string[] = [];

	if (extracted.title) {
		parts.push(`# ${extracted.title}`);
		parts.push("");
	}

	if (extracted.description) {
		parts.push(`> ${extracted.description}`);
		parts.push("");
	}

	if (extracted.content) {
		parts.push(String(extracted.content));
	}

	return parts.join("\n").trim();
}

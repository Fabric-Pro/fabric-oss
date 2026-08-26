/**
 * Browser Extract Step
 *
 * Extracts content from a web page using CSS selectors.
 * Useful for scraping data from pages that require JavaScript rendering.
 */

import type { ContentExtractor } from "../../browser-automation";
import {
	closeBrowserSession,
	createBrowserSession,
	extractContent,
	navigateToUrl,
} from "../../browser-automation";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

interface BrowserExtractConfig {
	url?: string;
	extractors?: ContentExtractor[];
	waitForSelector?: string;
	timeout?: number;
	headless?: boolean;
	blockResources?: ("image" | "stylesheet" | "font" | "media")[];
}

export async function executeBrowserExtractStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const config = params.nodeConfig as BrowserExtractConfig;

	if (!config.url) {
		return { success: false, error: "URL is required" };
	}

	if (!config.extractors || config.extractors.length === 0) {
		return { success: false, error: "At least one extractor is required" };
	}

	const interpolatedUrl = interpolateTemplate(config.url, params.inputs);
	const taskId = `workflow-extract-${Date.now()}`;
	let sessionId: string | null = null;

	try {
		// Create browser session with optimized settings for extraction
		const sessionResult = await createBrowserSession({
			taskId,
			userId: params.userId,
			organizationId: params.organizationId,
			options: {
				headless: config.headless ?? true,
				timeout: config.timeout || 30000,
				// Block unnecessary resources for faster loading
				blockResources: config.blockResources || [
					"image",
					"stylesheet",
					"font",
				],
			},
		});
		sessionId = sessionResult.sessionId;

		// Navigate to URL
		const navResult = await navigateToUrl({
			sessionId,
			url: interpolatedUrl,
			waitForSelector: config.waitForSelector,
			timeout: config.timeout,
		});

		if (!navResult.success) {
			return {
				success: false,
				error: navResult.error || "Navigation failed",
			};
		}

		// Extract content
		const extraction = await extractContent({
			sessionId,
			extractors: config.extractors,
		});

		// Close session
		await closeBrowserSession({ sessionId });

		return {
			success: true,
			output: {
				url: interpolatedUrl,
				data: extraction,
			},
		};
	} catch (error) {
		// Cleanup session on error
		if (sessionId) {
			try {
				await closeBrowserSession({ sessionId });
			} catch {
				// Ignore cleanup errors
			}
		}

		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Browser extraction failed",
		};
	}
}

/**
 * Browser Navigate Step
 *
 * Navigates to a URL and optionally extracts content.
 * Uses Playwright for browser automation.
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

interface BrowserNavigateConfig {
	url?: string;
	waitForSelector?: string;
	timeout?: number;
	extractors?: ContentExtractor[];
	headless?: boolean;
}

export async function executeBrowserNavigateStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const config = params.nodeConfig as BrowserNavigateConfig;

	if (!config.url) {
		return { success: false, error: "URL is required" };
	}

	const interpolatedUrl = interpolateTemplate(config.url, params.inputs);
	const taskId = `workflow-${Date.now()}`;
	let sessionId: string | null = null;

	try {
		// Create browser session
		const sessionResult = await createBrowserSession({
			taskId,
			userId: params.userId,
			organizationId: params.organizationId,
			options: {
				headless: config.headless ?? true,
				timeout: config.timeout || 30000,
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

		// Extract content if extractors provided
		let extraction: Record<string, string | string[] | null> | undefined;
		if (config.extractors && config.extractors.length > 0) {
			extraction = await extractContent({
				sessionId,
				extractors: config.extractors,
			});
		}

		// Close session
		await closeBrowserSession({ sessionId });

		return {
			success: true,
			output: {
				url: interpolatedUrl,
				pageInfo: navResult.output,
				extraction,
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
					: "Browser navigation failed",
		};
	}
}

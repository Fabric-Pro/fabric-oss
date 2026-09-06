/**
 * Browser Screenshot Step
 *
 * Captures a screenshot of a web page.
 * Useful for visual documentation and monitoring.
 */

import {
	closeBrowserSession,
	createBrowserSession,
	navigateToUrl,
	takeScreenshot,
} from "../../browser-automation";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

interface BrowserScreenshotConfig {
	url?: string;
	fullPage?: boolean;
	waitForSelector?: string;
	timeout?: number;
	name?: string;
	viewport?: {
		width: number;
		height: number;
	};
}

export async function executeBrowserScreenshotStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const config = params.nodeConfig as BrowserScreenshotConfig;

	if (!config.url) {
		return { success: false, error: "URL is required" };
	}

	const interpolatedUrl = interpolateTemplate(config.url, params.inputs);
	const taskId = `workflow-screenshot-${Date.now()}`;
	let sessionId: string | null = null;

	try {
		// Create browser session
		const sessionResult = await createBrowserSession({
			taskId,
			userId: params.userId,
			organizationId: params.organizationId,
			options: {
				headless: true,
				timeout: config.timeout || 30000,
				viewport: config.viewport || { width: 1920, height: 1080 },
			},
		});
		sessionId = sessionResult.sessionId;

		// Navigate to URL
		const navResult = await navigateToUrl({
			sessionId,
			userId: params.userId,
			organizationId: params.organizationId,
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

		// Take screenshot
		const screenshotResult = await takeScreenshot({
			sessionId,
			userId: params.userId,
			organizationId: params.organizationId,
			taskId,
			fullPage: config.fullPage ?? true,
			name: config.name || `screenshot-${Date.now()}`,
		});

		// Close session
		await closeBrowserSession({
			sessionId,
			userId: params.userId,
			organizationId: params.organizationId,
		});

		if (!screenshotResult.url) {
			return {
				success: false,
				error: "Failed to capture screenshot",
			};
		}

		return {
			success: true,
			output: {
				url: interpolatedUrl,
				screenshotUrl: screenshotResult.url,
			},
		};
	} catch (error) {
		// Cleanup session on error
		if (sessionId) {
			try {
				await closeBrowserSession({
					sessionId,
					userId: params.userId,
					organizationId: params.organizationId,
				});
			} catch {
				// Ignore cleanup errors
			}
		}

		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Browser screenshot failed",
		};
	}
}

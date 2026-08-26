/**
 * Browser Action Step
 *
 * Executes a sequence of browser actions (click, type, select, etc.)
 * Useful for form filling and interactive automation.
 */

import type { BrowserAction, ContentExtractor } from "../../browser-automation";
import {
	closeBrowserSession,
	createBrowserSession,
	executeAction,
	extractContent,
	navigateToUrl,
} from "../../browser-automation";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

interface BrowserActionConfig {
	url?: string;
	actions?: BrowserAction[];
	extractors?: ContentExtractor[];
	waitForSelector?: string;
	timeout?: number;
	headless?: boolean;
}

export async function executeBrowserActionStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const config = params.nodeConfig as BrowserActionConfig;

	if (!config.url) {
		return { success: false, error: "URL is required" };
	}

	if (!config.actions || config.actions.length === 0) {
		return { success: false, error: "At least one action is required" };
	}

	const interpolatedUrl = interpolateTemplate(config.url, params.inputs);
	const taskId = `workflow-action-${Date.now()}`;
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

		// Execute actions sequentially
		const actionResults = [];
		for (const action of config.actions) {
			// Interpolate action values
			const interpolatedAction = { ...action };
			if (action.value) {
				interpolatedAction.value = interpolateTemplate(
					action.value,
					params.inputs,
				);
			}
			if (action.url) {
				interpolatedAction.url = interpolateTemplate(
					action.url,
					params.inputs,
				);
			}

			const result = await executeAction({
				sessionId,
				action: interpolatedAction,
			});

			actionResults.push(result);

			if (!result.success) {
				// Close session before returning error
				await closeBrowserSession({ sessionId });
				return {
					success: false,
					error: `Action ${action.type} failed: ${result.error}`,
					output: { actionResults },
				};
			}
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
				actionResults,
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
					: "Browser action failed",
		};
	}
}

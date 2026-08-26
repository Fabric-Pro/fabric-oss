/**
 * Browser Automation Workflow
 *
 * Durable workflow for orchestrating browser automation tasks.
 * Handles session lifecycle, action execution, and content extraction.
 *
 * Inspired by CUGA (ConfigUrable Generalist Agent) patterns,
 * adapted for fabric-portal's multi-tenant Temporal architecture.
 */

import {
	ApplicationFailure,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import type * as browserActivities from "../activities/browser-automation/activities";
import type {
	BrowserAction,
	BrowserActionResult,
	BrowserAuthConfig,
	BrowserSessionOptions,
	BrowserTaskResult,
	ContentExtractor,
} from "../activities/browser-automation/types";

// =============================================================================
// Activity Proxies
// =============================================================================

const {
	createBrowserSession,
	closeBrowserSession,
	executeAction,
	extractContent,
	takeScreenshot,
} = proxyActivities<typeof browserActivities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Long timeout for navigation and auth
const longTimeoutActivities = proxyActivities<typeof browserActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Workflow Input/Output Types
// =============================================================================

export interface BrowserAutomationInput {
	taskId: string;
	userId: string;
	organizationId?: string;
	url: string;
	actions: BrowserAction[];
	extractors?: ContentExtractor[];
	auth?: BrowserAuthConfig;
	options?: BrowserSessionOptions;
	takeScreenshotAfterEachAction?: boolean;
	takeScreenshotOnError?: boolean;
}

// =============================================================================
// Workflow Implementation
// =============================================================================

/**
 * Browser Automation Workflow
 *
 * Executes a sequence of browser actions with:
 * - Multi-tenant session isolation
 * - Automatic retries on failure
 * - Content extraction
 * - Screenshot capture
 */
export async function browserAutomationWorkflow(
	input: BrowserAutomationInput,
): Promise<BrowserTaskResult> {
	const startTime = Date.now();
	const actionResults: BrowserActionResult[] = [];
	const screenshots: string[] = [];
	let sessionId: string | null = null;

	try {
		// 1. Create browser session
		console.log(
			`[Workflow] Creating browser session for task ${input.taskId}`,
		);
		const sessionResult = await createBrowserSession({
			taskId: input.taskId,
			userId: input.userId,
			organizationId: input.organizationId,
			options: input.options,
		});
		sessionId = sessionResult.sessionId;

		// 2. Handle authentication if configured
		if (input.auth) {
			console.log("[Workflow] Authenticating...");
			const authResult = await longTimeoutActivities.authenticate({
				sessionId,
				config: input.auth,
				loginUrl: input.url,
			});

			if (!authResult.success) {
				throw new Error(`Authentication failed: ${authResult.error}`);
			}

			// Navigate to target URL after auth
			const navResult = await longTimeoutActivities.navigateToUrl({
				sessionId,
				url: input.url,
			});
			actionResults.push(navResult);

			if (!navResult.success) {
				throw new Error(`Navigation failed: ${navResult.error}`);
			}
		} else {
			// 3. Navigate to URL
			console.log(`[Workflow] Navigating to ${input.url}`);
			const navResult = await longTimeoutActivities.navigateToUrl({
				sessionId,
				url: input.url,
			});
			actionResults.push(navResult);

			if (!navResult.success) {
				throw new Error(`Navigation failed: ${navResult.error}`);
			}
		}

		// 4. Execute actions sequentially
		for (const action of input.actions) {
			console.log(`[Workflow] Executing action: ${action.type}`);

			// Handle screenshot action specially
			if (action.type === "screenshot") {
				const screenshotResult = await takeScreenshot({
					sessionId,
					taskId: input.taskId,
					fullPage: action.screenshotOptions?.fullPage,
					name: action.screenshotOptions?.name,
				});
				if (screenshotResult.url) {
					screenshots.push(screenshotResult.url);
				}
				actionResults.push({
					success: true,
					action,
					screenshot: screenshotResult.url || undefined,
					duration: 0,
				});
				continue;
			}

			const result = await executeAction({ sessionId, action });
			actionResults.push(result);

			if (!result.success) {
				// Take error screenshot if configured
				if (input.takeScreenshotOnError) {
					const errorScreenshot = await takeScreenshot({
						sessionId,
						taskId: input.taskId,
						name: `error-${action.type}-${Date.now()}`,
					});
					if (errorScreenshot.url) {
						screenshots.push(errorScreenshot.url);
					}
				}
				throw new Error(
					`Action ${action.type} failed: ${result.error}`,
				);
			}

			// Take screenshot after action if configured
			if (input.takeScreenshotAfterEachAction) {
				const actionScreenshot = await takeScreenshot({
					sessionId,
					taskId: input.taskId,
					name: `after-${action.type}-${Date.now()}`,
				});
				if (actionScreenshot.url) {
					screenshots.push(actionScreenshot.url);
				}
			}

			// Small delay between actions for stability
			await sleep(100);
		}

		// 5. Extract content if extractors provided
		let extraction: Record<string, string | string[] | null> | undefined;
		if (input.extractors && input.extractors.length > 0) {
			console.log("[Workflow] Extracting content...");
			extraction = await extractContent({
				sessionId,
				extractors: input.extractors,
			});
		}

		// 6. Close session
		await closeBrowserSession({
			sessionId,
			persistStorage: input.options?.persistStorage,
		});

		return {
			success: true,
			actionResults,
			extraction,
			screenshots,
			totalDuration: Date.now() - startTime,
		};
	} catch (error) {
		console.error("[Workflow] Browser automation failed:", error);

		// Cleanup session on error
		if (sessionId) {
			try {
				await closeBrowserSession({ sessionId });
			} catch (cleanupError) {
				console.error(
					"[Workflow] Session cleanup failed:",
					cleanupError,
				);
			}
		}

		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"BROWSER_AUTOMATION_FAILED",
		);
	}
}

// =============================================================================
// Specialized Workflows
// =============================================================================

/**
 * Simple content extraction workflow
 *
 * Navigates to URL and extracts content without additional actions.
 * Useful for RAG content ingestion.
 */
export async function browserExtractContentWorkflow(input: {
	taskId: string;
	userId: string;
	organizationId?: string;
	url: string;
	extractors: ContentExtractor[];
	auth?: BrowserAuthConfig;
}): Promise<BrowserTaskResult> {
	return browserAutomationWorkflow({
		taskId: input.taskId,
		userId: input.userId,
		organizationId: input.organizationId,
		url: input.url,
		actions: [], // No additional actions
		extractors: input.extractors,
		auth: input.auth,
		options: {
			headless: true,
			blockResources: ["image", "stylesheet", "font"], // Faster loading for extraction
		},
	});
}

/**
 * Screenshot capture workflow
 *
 * Navigates to URL and captures screenshot(s).
 */
export async function browserScreenshotWorkflow(input: {
	taskId: string;
	userId: string;
	organizationId?: string;
	url: string;
	fullPage?: boolean;
	auth?: BrowserAuthConfig;
}): Promise<BrowserTaskResult> {
	return browserAutomationWorkflow({
		taskId: input.taskId,
		userId: input.userId,
		organizationId: input.organizationId,
		url: input.url,
		actions: [
			{
				type: "screenshot",
				screenshotOptions: {
					fullPage: input.fullPage ?? true,
					name: "capture",
				},
			},
		],
		auth: input.auth,
	});
}

/**
 * Hybrid Step
 *
 * Executes a sequence of API and browser steps with automatic fallback.
 * When an API endpoint is unavailable or fails, can fall back to browser automation.
 *
 * This enables CUGA-inspired workflows where:
 * 1. Primary: Try API call first (faster, more reliable)
 * 2. Fallback: Use browser automation if API fails/unavailable
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

// =============================================================================
// Types
// =============================================================================

export type HybridStepMode =
	| "api-first"
	| "browser-first"
	| "api-only"
	| "browser-only"
	| "parallel";

export interface ApiStepConfig {
	url: string;
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	headers?: Record<string, string>;
	body?: unknown;
	timeout?: number;
}

export interface BrowserStepConfig {
	url: string;
	actions?: BrowserAction[];
	extractors?: ContentExtractor[];
	waitForSelector?: string;
	timeout?: number;
	headless?: boolean;
}

export interface HybridStepConfig {
	mode?: HybridStepMode;
	api?: ApiStepConfig;
	browser?: BrowserStepConfig;
	fallbackOnError?: boolean;
	fallbackOnStatus?: number[];
	maxRetries?: number;
	retryDelayMs?: number;
}

// =============================================================================
// Execution Functions
// =============================================================================

/**
 * Execute an API step
 */
async function executeApiStep(
	config: ApiStepConfig,
	inputs: Record<string, unknown>,
): Promise<NodeExecutionResult> {
	const url = interpolateTemplate(config.url, inputs);
	const method = config.method ?? "GET";
	const timeout = config.timeout ?? 30000;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		const response = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				...config.headers,
			},
			body: config.body ? JSON.stringify(config.body) : undefined,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		const text = await response.text();
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}

		return {
			success: response.ok,
			output: {
				mode: "api",
				status: response.status,
				data,
			},
			error: response.ok ? undefined : `HTTP ${response.status}`,
		};
	} catch (error) {
		return {
			success: false,
			output: { mode: "api" },
			error:
				error instanceof Error ? error.message : "API request failed",
		};
	}
}

/**
 * Execute a browser step
 */
async function executeBrowserStep(
	config: BrowserStepConfig,
	inputs: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<NodeExecutionResult> {
	const url = interpolateTemplate(config.url, inputs);
	const taskId = `hybrid-${Date.now()}`;

	try {
		// Create session
		const session = await createBrowserSession({
			taskId,
			userId,
			organizationId,
			options: {
				headless: config.headless ?? true,
				timeout: config.timeout ?? 60000,
			},
		});

		try {
			// Navigate
			await navigateToUrl({
				sessionId: session.sessionId,
				userId,
				organizationId,
				url,
				waitForSelector: config.waitForSelector,
			});

			// Execute actions
			if (config.actions?.length) {
				for (const action of config.actions) {
					await executeAction({
						sessionId: session.sessionId,
						userId,
						organizationId,
						action,
					});
				}
			}

			// Extract content
			let extracted: Record<string, unknown> = {};
			if (config.extractors?.length) {
				extracted = await extractContent({
					sessionId: session.sessionId,
					userId,
					organizationId,
					extractors: config.extractors,
				});
			}

			return {
				success: true,
				output: {
					mode: "browser",
					data: extracted,
				},
			};
		} finally {
			await closeBrowserSession({
				sessionId: session.sessionId,
				userId,
				organizationId,
			});
		}
	} catch (error) {
		return {
			success: false,
			output: { mode: "browser" },
			error:
				error instanceof Error ? error.message : "Browser step failed",
		};
	}
}

// =============================================================================
// Main Hybrid Step Executor
// =============================================================================

/**
 * Execute a hybrid step with API/Browser fallback
 */
export async function executeHybridStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const config = params.nodeConfig as HybridStepConfig;
	const mode = config.mode ?? "api-first";
	const fallbackOnError = config.fallbackOnError ?? true;
	const fallbackOnStatus = config.fallbackOnStatus ?? [500, 502, 503, 504];

	// Validate configuration
	if (mode === "api-only" && !config.api) {
		return {
			success: false,
			error: "API configuration required for api-only mode",
		};
	}
	if (mode === "browser-only" && !config.browser) {
		return {
			success: false,
			error: "Browser configuration required for browser-only mode",
		};
	}
	if (
		(mode === "api-first" || mode === "browser-first") &&
		!config.api &&
		!config.browser
	) {
		return {
			success: false,
			error: "At least one of API or browser configuration required",
		};
	}

	// Execute based on mode
	switch (mode) {
		case "api-only": {
			if (!config.api) {
				return { success: false, error: "API configuration required" };
			}
			return executeApiStep(config.api, params.inputs);
		}

		case "browser-only": {
			if (!config.browser) {
				return {
					success: false,
					error: "Browser configuration required",
				};
			}
			return executeBrowserStep(
				config.browser,
				params.inputs,
				params.userId,
				params.organizationId,
			);
		}

		case "api-first": {
			// Try API first
			if (config.api) {
				const apiResult = await executeApiStep(
					config.api,
					params.inputs,
				);

				// Check if we should fallback
				const shouldFallback =
					!apiResult.success && fallbackOnError && config.browser;

				const statusFallback =
					apiResult.output &&
					typeof apiResult.output === "object" &&
					"status" in apiResult.output &&
					fallbackOnStatus.includes(
						apiResult.output.status as number,
					);

				if ((shouldFallback || statusFallback) && config.browser) {
					console.log(
						"[HybridStep] API failed, falling back to browser",
					);
					const browserResult = await executeBrowserStep(
						config.browser,
						params.inputs,
						params.userId,
						params.organizationId,
					);
					return {
						...browserResult,
						output: {
							...browserResult.output,
							fallback: true,
							apiError: apiResult.error,
						},
					};
				}

				return apiResult;
			}
			// No API config, use browser
			if (!config.browser) {
				return {
					success: false,
					error: "Browser configuration required for fallback",
				};
			}
			return executeBrowserStep(
				config.browser,
				params.inputs,
				params.userId,
				params.organizationId,
			);
		}

		case "browser-first": {
			// Try browser first
			if (config.browser) {
				const browserResult = await executeBrowserStep(
					config.browser,
					params.inputs,
					params.userId,
					params.organizationId,
				);

				if (!browserResult.success && fallbackOnError && config.api) {
					console.log(
						"[HybridStep] Browser failed, falling back to API",
					);
					const apiResult = await executeApiStep(
						config.api,
						params.inputs,
					);
					return {
						...apiResult,
						output: {
							...apiResult.output,
							fallback: true,
							browserError: browserResult.error,
						},
					};
				}

				return browserResult;
			}
			// No browser config, use API
			if (!config.api) {
				return {
					success: false,
					error: "API configuration required for fallback",
				};
			}
			return executeApiStep(config.api, params.inputs);
		}

		case "parallel": {
			// Execute both in parallel, return first success
			const promises: Promise<NodeExecutionResult>[] = [];

			if (config.api) {
				promises.push(executeApiStep(config.api, params.inputs));
			}
			if (config.browser) {
				promises.push(
					executeBrowserStep(
						config.browser,
						params.inputs,
						params.userId,
						params.organizationId,
					),
				);
			}

			const results = await Promise.allSettled(promises);
			const successResult = results.find(
				(r) => r.status === "fulfilled" && r.value.success,
			);

			if (successResult && successResult.status === "fulfilled") {
				return {
					...successResult.value,
					output: {
						...successResult.value.output,
						parallel: true,
					},
				};
			}

			// Return first error if none succeeded
			const firstResult = results[0];
			if (firstResult?.status === "fulfilled") {
				return firstResult.value;
			}
			if (firstResult?.status === "rejected") {
				return {
					success: false,
					error:
						firstResult.reason?.message ??
						"Parallel execution failed",
				};
			}

			return { success: false, error: "No execution path configured" };
		}

		default:
			return { success: false, error: `Unknown hybrid mode: ${mode}` };
	}
}

/**
 * Hybrid Execution Workflow
 *
 * Enables combined API + Browser workflows with intelligent fallback.
 * Inspired by CUGA (ConfigUrable Generalist Agent) patterns.
 *
 * Use cases:
 * 1. API-first with browser fallback (for unreliable APIs)
 * 2. Browser-first with API fallback (for sites without APIs)
 * 3. Parallel execution (race condition - first success wins)
 * 4. Sequential with data transformation between steps
 */

import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as browserActivities from "../activities/browser-automation/activities";
import type {
	BrowserAction,
	BrowserSessionOptions,
	ContentExtractor,
} from "../activities/browser-automation/types";
import type * as preflightActivities from "../activities/preflight-validation";

// Proxy browser activities
const {
	createBrowserSession,
	navigateToUrl,
	executeAction,
	extractContent,
	closeBrowserSession,
} = proxyActivities<typeof browserActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Proxy preflight validation activities
const { preflightValidation, createApprovalRequest, waitForApproval } =
	proxyActivities<typeof preflightActivities>({
		startToCloseTimeout: "5 minutes",
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "1s",
			maximumAttempts: 2,
		},
	});

// =============================================================================
// Types
// =============================================================================

export type HybridMode =
	| "api-first"
	| "browser-first"
	| "api-only"
	| "browser-only"
	| "parallel";

export interface ApiStep {
	type: "api";
	name?: string;
	url: string;
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	headers?: Record<string, string>;
	body?: unknown;
	timeout?: number;
	outputMapping?: Record<string, string>;
}

export interface BrowserStep {
	type: "browser";
	name?: string;
	url: string;
	actions?: BrowserAction[];
	extractors?: ContentExtractor[];
	waitForSelector?: string;
	timeout?: number;
	outputMapping?: Record<string, string>;
}

export type HybridStep = ApiStep | BrowserStep;

export interface HybridExecutionInput {
	taskId: string;
	userId: string;
	organizationId?: string;
	mode: HybridMode;
	steps: HybridStep[];
	fallbackOnError?: boolean;
	fallbackOnStatusCodes?: number[];
	browserOptions?: BrowserSessionOptions;
	variables?: Record<string, unknown>;
	// Pre-flight validation options
	skipPreflightValidation?: boolean;
	requireApprovalForHighRisk?: boolean;
	approvalThreshold?: number;
}

export interface StepResult {
	stepName?: string;
	stepType: "api" | "browser";
	success: boolean;
	data?: unknown;
	error?: string;
	duration: number;
	fallback?: boolean;
}

export interface HybridExecutionResult {
	taskId: string;
	success: boolean;
	mode: HybridMode;
	results: StepResult[];
	aggregatedData: Record<string, unknown>;
	error?: string;
	duration: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function interpolate(template: string, vars: Record<string, unknown>): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
		const value = vars[key.trim()];
		return value !== undefined ? String(value) : `{{${key}}}`;
	});
}

async function executeApiCall(
	step: ApiStep,
	variables: Record<string, unknown>,
): Promise<StepResult> {
	const startTime = Date.now();
	const url = interpolate(step.url, variables);
	const method = step.method ?? "GET";
	const timeout = step.timeout ?? 30000;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		const response = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				...step.headers,
			},
			body: step.body ? JSON.stringify(step.body) : undefined,
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
			stepName: step.name,
			stepType: "api",
			success: response.ok,
			data,
			error: response.ok ? undefined : `HTTP ${response.status}`,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		return {
			stepName: step.name,
			stepType: "api",
			success: false,
			error: error instanceof Error ? error.message : "API call failed",
			duration: Date.now() - startTime,
		};
	}
}

async function executeBrowserCall(
	step: BrowserStep,
	variables: Record<string, unknown>,
	sessionId: string,
): Promise<StepResult> {
	const startTime = Date.now();
	const url = interpolate(step.url, variables);

	try {
		// Navigate to URL
		await navigateToUrl({
			sessionId,
			url,
			waitForSelector: step.waitForSelector,
			timeout: step.timeout,
		});

		// Execute actions if provided
		if (step.actions?.length) {
			for (const action of step.actions) {
				await executeAction({ sessionId, action });
			}
		}

		// Extract content if extractors provided
		let data: Record<string, unknown> = {};
		if (step.extractors?.length) {
			data = await extractContent({
				sessionId,
				extractors: step.extractors,
			});
		}

		return {
			stepName: step.name,
			stepType: "browser",
			success: true,
			data,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		return {
			stepName: step.name,
			stepType: "browser",
			success: false,
			error:
				error instanceof Error ? error.message : "Browser step failed",
			duration: Date.now() - startTime,
		};
	}
}

// =============================================================================
// Main Workflow
// =============================================================================

/**
 * Hybrid Execution Workflow
 *
 * Executes a sequence of API and browser steps with intelligent fallback.
 */
export async function hybridExecutionWorkflow(
	input: HybridExecutionInput,
): Promise<HybridExecutionResult> {
	const startTime = Date.now();
	const results: StepResult[] = [];
	const aggregatedData: Record<string, unknown> = { ...input.variables };
	let sessionId: string | null = null;

	const fallbackOnError = input.fallbackOnError ?? true;
	const fallbackOnStatusCodes = input.fallbackOnStatusCodes ?? [
		500, 502, 503, 504,
	];

	try {
		// Create browser session if any browser steps exist
		const hasBrowserSteps = input.steps.some((s) => s.type === "browser");
		const needsBrowserFallback =
			input.mode === "api-first" ||
			input.mode === "browser-first" ||
			input.mode === "parallel";

		if (hasBrowserSteps || (needsBrowserFallback && fallbackOnError)) {
			const session = await createBrowserSession({
				taskId: input.taskId,
				userId: input.userId,
				organizationId: input.organizationId,
				options: input.browserOptions,
			});
			sessionId = session.sessionId;
		}

		// Execute steps based on mode
		for (let i = 0; i < input.steps.length; i++) {
			const step = input.steps[i];
			let result: StepResult;

			// === STEP-LEVEL PRE-FLIGHT VALIDATION ===
			if (!input.skipPreflightValidation) {
				const stepType =
					step.type === "api" ? "http-request" : "browser-automation";
				const stepValidation = await preflightValidation({
					executionId: input.taskId,
					stepId: `step-${i}`,
					stepType,
					stepConfig: step as unknown as Record<string, unknown>,
					userId: input.userId,
					organizationId: input.organizationId,
					requireApprovalForHighRisk:
						input.requireApprovalForHighRisk ?? false,
					approvalThreshold: input.approvalThreshold ?? 70,
				});

				if (!stepValidation.valid) {
					const errors = stepValidation.issues
						.map((issue) => issue.message)
						.join(", ");
					throw new Error(
						`Validation failed for step "${step.name}": ${errors}`,
					);
				}

				// Handle approval requirement for high-risk steps
				if (
					stepValidation.requiresApproval &&
					stepValidation.riskAssessment
				) {
					const approvalId = await createApprovalRequest({
						executionId: input.taskId,
						stepId: `step-${i}`,
						stepType,
						riskScore: stepValidation.riskAssessment.score,
						riskFactors: stepValidation.riskAssessment.factors,
						userId: input.userId,
						organizationId: input.organizationId,
					});

					const approvalResult = await waitForApproval(
						approvalId,
						300000,
					);
					if (!approvalResult.approved) {
						throw new Error(
							`Step "${step.name}" was not approved: ${approvalResult.message}`,
						);
					}
				}
			}

			if (step.type === "api") {
				// Execute API step
				result = await executeApiCall(step as ApiStep, aggregatedData);

				// Check for fallback conditions
				const shouldFallback =
					!result.success && fallbackOnError && sessionId;

				const statusFallback =
					result.error &&
					fallbackOnStatusCodes.some((code) =>
						result.error?.includes(String(code)),
					);

				if (
					(shouldFallback || statusFallback) &&
					input.mode !== "api-only" &&
					sessionId
				) {
					console.log(
						`[HybridWorkflow] API step "${step.name}" failed, attempting browser fallback`,
					);
					// Create equivalent browser step for fallback
					const fallbackResult = await executeBrowserCall(
						{
							type: "browser",
							name: `${step.name} (fallback)`,
							url: (step as ApiStep).url,
							extractors: [
								{
									name: "body",
									selector: "body",
									multiple: false,
									transform: "text",
								},
							],
						},
						aggregatedData,
						sessionId,
					);
					fallbackResult.fallback = true;
					result = fallbackResult;
				}
			} else {
				// Execute browser step
				if (!sessionId) {
					result = {
						stepName: step.name,
						stepType: "browser",
						success: false,
						error: "No browser session available",
						duration: 0,
					};
				} else {
					result = await executeBrowserCall(
						step as BrowserStep,
						aggregatedData,
						sessionId,
					);
				}
			}

			results.push(result);

			// Aggregate data from successful steps
			if (result.success && result.data) {
				const outputMapping = step.outputMapping;
				if (outputMapping) {
					for (const [sourceKey, targetKey] of Object.entries(
						outputMapping,
					)) {
						const data = result.data as Record<string, unknown>;
						if (sourceKey in data) {
							aggregatedData[targetKey] = data[sourceKey];
						}
					}
				} else {
					// Default: merge all data
					Object.assign(aggregatedData, result.data);
				}
			}

			// Stop on failure unless in parallel mode
			if (!result.success && input.mode !== "parallel") {
				throw new Error(`Step "${step.name}" failed: ${result.error}`);
			}
		}

		// Close browser session
		if (sessionId) {
			await closeBrowserSession({ sessionId });
		}

		return {
			taskId: input.taskId,
			success: true,
			mode: input.mode,
			results,
			aggregatedData,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		// Cleanup browser session on error
		if (sessionId) {
			try {
				await closeBrowserSession({ sessionId });
			} catch {
				// Ignore cleanup errors
			}
		}

		const errorMessage =
			error instanceof Error ? error.message : "Hybrid execution failed";
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"HYBRID_EXECUTION_FAILED",
		);
	}
}

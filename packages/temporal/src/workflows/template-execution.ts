/**
 * Template Execution Workflow
 *
 * Executes an automation template with user-provided parameters.
 * Handles parameter resolution, step execution, and usage tracking.
 */

import {
	ApplicationFailure,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import type * as templateActivities from "../activities/automation-template/activities";
import type { TemplateStep } from "../activities/automation-template/types";
import type * as browserActivities from "../activities/browser-automation/activities";
import type {
	BrowserAction,
	ContentExtractor,
} from "../activities/browser-automation/types";
import { safeEvaluateExpression } from "../activities/lib/safe-expression-evaluator";
import type * as preflightActivities from "../activities/preflight-validation";

// Proxy activities
const {
	createBrowserSession,
	navigateToUrl,
	executeAction,
	extractContent,
	takeScreenshot,
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

const { getTemplate, recordTemplateUsage } = proxyActivities<
	typeof templateActivities
>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "30 seconds",
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

/**
 * Resolve template parameters by replacing {{paramName}} placeholders
 * Note: This is a pure function that runs in the workflow, not an activity
 */
function resolveTemplateParameters(
	workflowSteps: TemplateStep[],
	parameterValues: Record<string, unknown>,
): TemplateStep[] {
	const resolved = JSON.stringify(workflowSteps);

	// Replace all {{paramName}} placeholders
	const resolvedSteps = resolved.replace(/\{\{(\w+)\}\}/g, (_, paramName) => {
		const value = parameterValues[paramName];
		if (value === undefined) {
			throw new Error(`Missing required parameter: ${paramName}`);
		}
		return typeof value === "string" ? value : JSON.stringify(value);
	});

	return JSON.parse(resolvedSteps) as TemplateStep[];
}

// =============================================================================
// Types
// =============================================================================

export interface TemplateExecutionInput {
	templateId: string;
	taskId: string;
	userId: string;
	organizationId?: string;
	parameterValues: Record<string, unknown>;
	takeScreenshots?: boolean;
	// Pre-flight validation options
	skipPreflightValidation?: boolean;
	requireApprovalForHighRisk?: boolean;
	approvalThreshold?: number;
}

export interface StepExecutionResult {
	stepId: string;
	stepName?: string;
	success: boolean;
	output?: unknown;
	error?: string;
	screenshotUrl?: string;
	duration: number;
}

export interface TemplateExecutionResult {
	taskId: string;
	templateId: string;
	success: boolean;
	stepResults: StepExecutionResult[];
	aggregatedOutput: Record<string, unknown>;
	error?: string;
	duration: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

async function executeTemplateStep(
	step: TemplateStep,
	sessionId: string,
	variables: Record<string, unknown>,
): Promise<{ success: boolean; output?: unknown; error?: string }> {
	const config = step.config as Record<string, unknown>;

	switch (step.type) {
		case "navigate": {
			await navigateToUrl({
				sessionId,
				url: config.url as string,
				waitForSelector: config.waitForSelector as string | undefined,
				timeout: config.timeout as number | undefined,
			});
			return { success: true };
		}

		case "action": {
			await executeAction({
				sessionId,
				action: config as unknown as BrowserAction,
			});
			return { success: true };
		}

		case "extract": {
			const extractors = config.extractors as ContentExtractor[];
			const output = await extractContent({ sessionId, extractors });
			return { success: true, output };
		}

		case "screenshot": {
			const result = await takeScreenshot({
				sessionId,
				taskId: config.taskId as string,
				fullPage: config.fullPage as boolean | undefined,
				name: config.name as string | undefined,
			});
			return { success: true, output: { screenshotUrl: result.url } };
		}

		case "wait": {
			const duration = (config.duration as number) ?? 1000;
			await sleep(duration);
			return { success: true };
		}

		case "condition": {
			// Evaluate condition against variables
			const conditionExpr = config.expression as string;
			const result = evaluateCondition(conditionExpr, variables);
			return { success: true, output: { result } };
		}

		default:
			return { success: false, error: `Unknown step type: ${step.type}` };
	}
}

function evaluateCondition(
	expression: string,
	variables: Record<string, unknown>,
): boolean {
	return safeEvaluateExpression(expression, variables);
}

// =============================================================================
// Main Workflow
// =============================================================================

/**
 * Template Execution Workflow
 *
 * Executes an automation template with user-provided parameters.
 */
export async function templateExecutionWorkflow(
	input: TemplateExecutionInput,
): Promise<TemplateExecutionResult> {
	const startTime = Date.now();
	const stepResults: StepExecutionResult[] = [];
	const aggregatedOutput: Record<string, unknown> = {
		...input.parameterValues,
	};
	let sessionId: string | null = null;

	try {
		// 1. Fetch template
		const template = await getTemplate({
			templateId: input.templateId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (!template) {
			throw new Error(
				`Template ${input.templateId} not found or access denied`,
			);
		}

		// 2. Resolve parameters in workflow steps
		const resolvedSteps = resolveTemplateParameters(
			template.workflowSteps,
			input.parameterValues,
		);

		// 3. Create browser session
		const session = await createBrowserSession({
			taskId: input.taskId,
			userId: input.userId,
			organizationId: input.organizationId,
		});
		sessionId = session.sessionId;

		// 4. Execute each step
		for (const step of resolvedSteps) {
			const stepStartTime = Date.now();

			// === STEP-LEVEL PRE-FLIGHT VALIDATION ===
			if (!input.skipPreflightValidation) {
				const stepType =
					step.type === "navigate" ? "browser-automation" : step.type;
				const stepValidation = await preflightValidation({
					executionId: input.taskId,
					stepId: step.id,
					stepType,
					stepConfig: step.config as Record<string, unknown>,
					userId: input.userId,
					organizationId: input.organizationId,
					requireApprovalForHighRisk:
						input.requireApprovalForHighRisk ?? false,
					approvalThreshold: input.approvalThreshold ?? 70,
				});

				if (!stepValidation.valid) {
					const errors = stepValidation.issues
						.map((i) => i.message)
						.join(", ");
					if (step.onError === "stop") {
						throw new Error(
							`Validation failed for step "${step.name}": ${errors}`,
						);
					}
					// Skip step if onError is "skip"
					stepResults.push({
						stepId: step.id,
						stepName: step.name,
						success: false,
						error: `Validation failed: ${errors}`,
						duration: Date.now() - stepStartTime,
					});
					continue;
				}

				// Handle approval requirement for high-risk steps
				if (
					stepValidation.requiresApproval &&
					stepValidation.riskAssessment
				) {
					const approvalId = await createApprovalRequest({
						executionId: input.taskId,
						stepId: step.id,
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
						if (step.onError === "stop") {
							throw new Error(
								`Step "${step.name}" was not approved: ${approvalResult.message}`,
							);
						}
						stepResults.push({
							stepId: step.id,
							stepName: step.name,
							success: false,
							error: `Not approved: ${approvalResult.message}`,
							duration: Date.now() - stepStartTime,
						});
						continue;
					}
				}
			}

			// Check condition if present
			if (step.condition) {
				const shouldExecute = evaluateCondition(
					step.condition,
					aggregatedOutput,
				);
				if (!shouldExecute) {
					stepResults.push({
						stepId: step.id,
						stepName: step.name,
						success: true,
						output: { skipped: true, reason: "Condition not met" },
						duration: Date.now() - stepStartTime,
					});
					continue;
				}
			}

			// Execute with retry logic
			let lastError: string | undefined;
			let result: {
				success: boolean;
				output?: unknown;
				error?: string;
			} | null = null;
			const maxRetries = step.maxRetries ?? 3;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					result = await executeTemplateStep(
						step,
						sessionId,
						aggregatedOutput,
					);
					if (result.success) {
						break;
					}
					lastError = result.error;
				} catch (error) {
					lastError =
						error instanceof Error
							? error.message
							: "Step execution failed";
				}

				if (attempt < maxRetries) {
					await sleep(1000 * (attempt + 1)); // Exponential backoff
				}
			}

			const stepResult: StepExecutionResult = {
				stepId: step.id,
				stepName: step.name,
				success: result?.success ?? false,
				output: result?.output,
				error: result?.success ? undefined : lastError,
				duration: Date.now() - stepStartTime,
			};

			// Take screenshot if enabled
			if (input.takeScreenshots && sessionId) {
				try {
					const screenshot = await takeScreenshot({
						sessionId,
						taskId: input.taskId,
						name: `step-${step.id}`,
					});
					if (screenshot.url) {
						stepResult.screenshotUrl = screenshot.url;
					}
				} catch {
					// Ignore screenshot errors
				}
			}

			stepResults.push(stepResult);

			// Aggregate output
			if (result?.output && typeof result.output === "object") {
				Object.assign(aggregatedOutput, result.output);
			}

			// Handle step failure
			if (!stepResult.success) {
				if (step.onError === "stop") {
					throw new Error(`Step "${step.name}" failed: ${lastError}`);
				}
				// "skip" mode: continue to next step
			}
		}

		// 5. Record template usage
		await recordTemplateUsage({ templateId: input.templateId });

		// 6. Cleanup
		if (sessionId) {
			await closeBrowserSession({ sessionId });
		}

		return {
			taskId: input.taskId,
			templateId: input.templateId,
			success: true,
			stepResults,
			aggregatedOutput,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		// Cleanup on error
		if (sessionId) {
			try {
				await closeBrowserSession({ sessionId });
			} catch {
				// Ignore cleanup errors
			}
		}

		const errorMessage =
			error instanceof Error
				? error.message
				: "Template execution failed";
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"TEMPLATE_EXECUTION_FAILED",
		);
	}
}

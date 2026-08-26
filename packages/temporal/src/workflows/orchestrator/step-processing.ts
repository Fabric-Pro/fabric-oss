/**
 * Step Processing — Shared Utilities for Execution Phases
 *
 * Extracts duplicated step result processing, verification, and recovery
 * logic from execution.ts into reusable functions.
 *
 * Issue #1:  DRY up execution.ts (parallel + sequential paths were duplicated)
 * Issue #10: Extract verification logic into shared function
 */

import {
	log,
	proxyActivities,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";

// ---------------------------------------------------------------------------
// Temporal-deterministic time helpers
// ---------------------------------------------------------------------------
// Inside a Temporal workflow, `Date.now()` and `new Date()` are patched by the
// SDK to return the workflow task time (pinned per task, consistent across
// replays). They are the documented replay-safe time APIs.
//
// `workflowInfo().unsafe.now()` is wall-clock time from the host context and
// is explicitly NON-deterministic — do not use it here. Using it also breaks
// under reuseV8Context in @temporalio/worker 1.16+ because the host-side Date
// reference cannot be dispatched across the reused V8 isolate boundary.
// ---------------------------------------------------------------------------

/** Deterministic millisecond timestamp safe for Temporal replay. */
export function safeNowMs(): number {
	return Date.now();
}

/** Deterministic ISO string timestamp safe for Temporal replay. */
export function safeNowISO(): string {
	return new Date().toISOString();
}

import type * as orchestratorActivities from "../../activities/orchestrator";
import {
	getCircuitState,
	isCircuitOpen,
	recordFailure,
	recordSuccess,
	transitionToHalfOpen,
} from "./circuit-breaker";
import {
	buildStepContext,
	formatContextForPrompt,
	getContextSummary,
	mergeStepVariables,
	updateVariablesFromStep,
} from "./context-manager";
import { CIRCUIT_BREAKER, CONTEXT, WORKFLOW } from "./orchestrator-config";
import { isBulkOperation, isDestructiveStep } from "./risk-assessment";
import type {
	AgentVariable,
	ALTKConfig,
	ExecutionModeConfig,
	OrchestratorStepResult,
	OrchestratorWorkflowInput,
	RecoveryResult,
	TaskPlan,
	TaskStep,
	WorkflowState,
} from "./types";

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "15 minutes", // Weave shuttle steps can take 10+ min (CodingRun bridge)
	heartbeatTimeout: "5 minutes", // Agent delegation (A2A) can block for minutes during LLM calls
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// =============================================================================
// Step Execution Result (internal interface)
// =============================================================================

export interface StepExecutionResult {
	success: boolean;
	result?: {
		outputs: Record<string, unknown>;
		variables?: Record<string, unknown>;
		toolCalls?: OrchestratorStepResult["toolCalls"];
		response?: string;
		artifacts?: OrchestratorStepResult["artifacts"];
	};
	error?: string;
	authRequired?: {
		configId: string;
		serverName: string;
	};
}

// =============================================================================
// Process Step Result — Unified success/failure/auth handling
// =============================================================================

/**
 * Process the result of an executed step — handles success, failure, auth,
 * circuit breaker updates, variable merging, tool call tracking, trajectory
 * recording, and verification.
 *
 * Returns a chunk of response text to append to finalResponse, and a flag
 * indicating whether the workflow should abort.
 */
export async function processStepResult(params: {
	state: WorkflowState;
	input: OrchestratorWorkflowInput;
	step: TaskStep;
	stepResult: StepExecutionResult;
	stepStartTime: number;
	modeConfig: ExecutionModeConfig;
	altkConfig: ALTKConfig;
	taskPlan: TaskPlan;
	/** Mutable wave queue — retry steps are inserted here */
	waveQueue?: TaskStep[][];
	updateProgress: (phase: string, message: string, step?: TaskStep) => void;
}): Promise<{
	responseChunk: string;
	shouldAbort: boolean;
	abortError?: string;
	authRequired?: { configId: string; serverName: string };
}> {
	const {
		state,
		input,
		step,
		stepResult,
		stepStartTime,
		modeConfig,
		altkConfig,
		taskPlan,
		waveQueue,
		updateProgress,
	} = params;

	const agentId = step.executor || "unknown";

	// =========================================================================
	// AUTH REQUIRED
	// =========================================================================
	if (stepResult.authRequired) {
		log.warn("Step blocked on OAuth authorization", {
			stepId: step.id,
			configId: stepResult.authRequired.configId,
			serverName: stepResult.authRequired.serverName,
		});

		step.status = "error";
		step.error = `OAuth authorization required for ${stepResult.authRequired.serverName}`;
		step.completedAt = safeNowISO();
		step.durationMs = safeNowMs() - stepStartTime;

		state.stepResults.push({
			stepId: step.id,
			stepDescription: step.description,
			status: "error",
			response: stepResult.error,
			toolCalls: [],
			durationMs: step.durationMs,
			error: step.error,
		});

		updateProgress(
			"awaiting_auth" as string,
			`Waiting for authorization: ${stepResult.authRequired.serverName}`,
			step,
		);

		return {
			responseChunk: "",
			shouldAbort: true,
			authRequired: stepResult.authRequired,
		};
	}

	// =========================================================================
	// SUCCESS
	// =========================================================================
	if (stepResult.success && stepResult.result) {
		state.agentCircuitBreakers = recordSuccess(
			state.agentCircuitBreakers,
			agentId,
		);

		step.status = "complete";
		step.completedAt = safeNowISO();
		step.durationMs = safeNowMs() - stepStartTime;
		step.outputs = stepResult.result.outputs;

		// Merge variables
		if (stepResult.result.variables) {
			mergeStepVariables(
				state,
				stepResult.result.variables as Record<string, AgentVariable>,
			);
		}

		state.variables = updateVariablesFromStep(
			state.variables,
			step.id,
			stepResult.result.outputs,
			stepResult.result.response,
		);

		// Track tool calls
		if (stepResult.result.toolCalls) {
			state.toolCalls.push(...stepResult.result.toolCalls);
			const uniqueToolNames = [
				...new Set(stepResult.result.toolCalls.map((tc) => tc.name)),
			];
			step.actualToolsUsed = uniqueToolNames;
			if (uniqueToolNames.length > 0) {
				step.app = uniqueToolNames[0];
			}
		}

		// Record step result
		const stepResultRecord: OrchestratorStepResult = {
			stepId: step.id,
			stepDescription: step.description,
			status: "complete",
			response: stepResult.result.response,
			toolCalls: stepResult.result.toolCalls || [],
			durationMs: step.durationMs,
			artifacts: stepResult.result.artifacts,
		};
		state.stepResults.push(stepResultRecord);

		// Trajectory
		state.trajectorySteps.push({
			stepId: step.id,
			agentId,
			toolName: stepResult.result.toolCalls?.[0]?.name,
			input: step.inputs,
			output: stepResult.result.outputs,
			durationMs: step.durationMs,
			success: true,
			timestamp: step.completedAt,
		});

		// Reflect if enabled
		if (modeConfig.reflection && altkConfig.reflection.afterEachStep) {
			await performReflection(
				step.description,
				stepResult.result.outputs,
				altkConfig,
				step.expectedOutput,
			);
		}

		// Verification
		let responseChunk = stepResult.result.response || "";
		responseChunk = await verifyAndHandleRetry({
			state,
			input,
			step,
			stepResultRecord,
			originalResponse: responseChunk,
			taskPlan,
			waveQueue,
			updateProgress,
		});

		log.info("Step completed", {
			stepId: step.id,
			durationMs: step.durationMs,
		});

		return {
			responseChunk: responseChunk ? `${responseChunk}\n\n` : "",
			shouldAbort: false,
		};
	}

	// =========================================================================
	// FAILURE — attempt recovery
	// =========================================================================
	const error = stepResult.error || "Unknown error";

	const recoveryResult = await attemptStepRecovery(
		state,
		input,
		step,
		error,
		stepStartTime,
		modeConfig,
		altkConfig,
	);

	if (recoveryResult.recovered) {
		state.agentCircuitBreakers = recordSuccess(
			state.agentCircuitBreakers,
			agentId,
		);

		step.status = "complete";
		step.completedAt = safeNowISO();
		step.durationMs = safeNowMs() - stepStartTime;

		log.info("Step recovered successfully", {
			stepId: step.id,
			strategy: recoveryResult.strategyUsed,
		});

		return {
			responseChunk: recoveryResult.response
				? `${recoveryResult.response}\n\n`
				: "",
			shouldAbort: false,
		};
	}

	// Recovery failed — update circuit breaker
	const nowMs = safeNowMs();
	state.agentCircuitBreakers = recordFailure(
		state.agentCircuitBreakers,
		agentId,
		nowMs,
	);

	const circuitState = getCircuitState(state.agentCircuitBreakers, agentId);
	if (circuitState.state === "OPEN") {
		log.warn("Circuit opened for agent — waiting before allowing retry", {
			agentId,
			consecutiveFailures: circuitState.consecutiveFailures,
			cooldownMs: CIRCUIT_BREAKER.cooldownMs,
		});
		await sleep(CIRCUIT_BREAKER.cooldownMs);
		state.agentCircuitBreakers = transitionToHalfOpen(
			state.agentCircuitBreakers,
			agentId,
		);
	}

	step.status = "error";
	step.error = recoveryResult.finalError;
	step.completedAt = safeNowISO();
	step.durationMs = safeNowMs() - stepStartTime;

	state.stepResults.push({
		stepId: step.id,
		stepDescription: step.description,
		status: "error",
		toolCalls: [],
		durationMs: step.durationMs,
		error: step.error,
	});

	state.trajectorySteps.push({
		stepId: step.id,
		agentId,
		input: step.inputs,
		output: { error: step.error },
		durationMs: step.durationMs,
		success: false,
		timestamp: step.completedAt,
	});

	log.error("Step failed after recovery attempts", {
		stepId: step.id,
		error: step.error,
		recoveryAttempts: recoveryResult.attemptsMade,
	});

	// Critical steps abort the workflow
	if (step.riskLevel === "critical") {
		return {
			responseChunk: "",
			shouldAbort: true,
			abortError: step.error,
		};
	}

	return {
		responseChunk: "",
		shouldAbort: false,
	};
}

// =============================================================================
// Circuit Breaker Skip Check
// =============================================================================

/**
 * Check if a step should be skipped due to an open circuit breaker.
 * Returns true if skipped (and updates state accordingly).
 */
export function skipIfCircuitOpen(
	state: WorkflowState,
	step: TaskStep,
	updateProgress: (phase: string, message: string, step?: TaskStep) => void,
): boolean {
	const agentId = step.executor || "unknown";
	if (!isCircuitOpen(state.agentCircuitBreakers, agentId)) {
		return false;
	}

	log.warn("Circuit open for agent — skipping step", {
		agentId,
		stepId: step.id,
		stepDescription: step.description,
	});

	step.status = "error";
	step.error = `Agent '${agentId}' is temporarily unavailable (circuit breaker open). Skipping step.`;
	step.completedAt = safeNowISO();
	step.durationMs = 0;

	state.stepResults.push({
		stepId: step.id,
		stepDescription: step.description,
		status: "error",
		toolCalls: [],
		durationMs: 0,
		error: step.error,
	});

	state.trajectorySteps.push({
		stepId: step.id,
		agentId,
		input: step.inputs,
		output: { error: step.error },
		durationMs: 0,
		success: false,
		timestamp: step.completedAt,
	});

	updateProgress(
		"executing",
		`Skipped step (circuit open for agent '${agentId}'): ${step.description}`,
		step,
	);

	return true;
}

// =============================================================================
// Step Execution with Context
// =============================================================================

/**
 * Execute a single step with full context propagation.
 * Shared between parallel and sequential execution paths.
 */
export async function executeStepWithContext(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	step: TaskStep,
	stepIndex: number,
	_modeConfig: ExecutionModeConfig,
	_altkConfig: ALTKConfig,
): Promise<StepExecutionResult> {
	const { taskPlan } = state;

	if (!taskPlan) {
		return { success: false, error: "No task plan" };
	}

	try {
		// Build comprehensive context for this step
		const stepContext = buildStepContext(state, stepIndex, {
			message: input.message,
			history: input.history,
		});

		// Format context for the prompt
		const contextPrompt = formatContextForPrompt(stepContext);

		// Log context summary for debugging
		const contextSummary = getContextSummary(state);
		log.info("Step execution context", {
			stepId: step.id,
			stepIndex,
			...contextSummary,
			contextPromptLength: contextPrompt.length,
		});

		// Build previous step results for the activity
		const previousStepResults = state.stepResults.map((sr) => ({
			stepId: sr.stepId,
			stepDescription: sr.stepDescription,
			response: sr.response,
			keyOutputs: sr.toolCalls?.reduce(
				(acc, tc) => {
					if (tc.status === "success" && tc.result) {
						acc[tc.name] = tc.result;
					}
					return acc;
				},
				{} as Record<string, unknown>,
			),
		}));

		// Execute the step
		const result = await activities.executeStep({
			step,
			message: state.enrichedMessage,
			systemPrompt: `${state.enrichedSystemPrompt}\n\n${contextPrompt}`,
			variables: state.variables,
			userId: input.userId,
			organizationId: input.organizationId,
			executionId: state.executionId,
			conversationId: input.conversationId,
			enabledMcpConfigIds: input.enabledMcpConfigIds,
			enabledAgentIds: input.enabledAgentIds,
			executionMode: input.executionMode,
			workspaceIds: input.workspaceIds,
			projectId: input.projectId,
			altkConfig: _altkConfig,
			totalSteps: taskPlan.steps.length,
			stepIndex: stepIndex + 1,
			previousStepResults,
			lettaAgentId: state.lettaAgentId,
			conversationHistory: input.history,
			preloadedTools: state.preloadedResources?.toolMap
				? { toolMap: state.preloadedResources.toolMap }
				: undefined,
			matchedMcpTools: state.routingDecision?.matchedMcpTools,
			matchedIntegrations: state.routingDecision?.matchedIntegrations,
			attachedImageUrls: input.attachedImageUrls,
		});

		// Check if OAuth authorization is required
		if (result.status === "auth_required" && result.authRequired) {
			log.warn("Step requires OAuth authorization", {
				stepId: step.id,
				configId: result.authRequired.configId,
				serverName: result.authRequired.serverName,
			});
			return {
				success: false,
				error: result.response || "OAuth authorization required",
				authRequired: result.authRequired,
			};
		}

		return {
			success: true,
			result: {
				outputs: result.outputs || {},
				variables: result.variables,
				toolCalls: result.toolCalls,
				response: result.response,
				artifacts: result.artifacts,
			},
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		return { success: false, error: errorMessage };
	}
}

// =============================================================================
// Verification & Retry
// =============================================================================

/**
 * Verify a completed step and optionally create retry steps.
 * Returns the (potentially modified) response string.
 *
 * Issue #10: Extracted from duplicated blocks in execution.ts
 */
async function verifyAndHandleRetry(params: {
	state: WorkflowState;
	input: OrchestratorWorkflowInput;
	step: TaskStep;
	stepResultRecord: OrchestratorStepResult;
	originalResponse: string;
	taskPlan: TaskPlan;
	waveQueue?: TaskStep[][];
	updateProgress: (phase: string, message: string, step?: TaskStep) => void;
}): Promise<string> {
	const {
		state,
		input,
		step,
		stepResultRecord,
		originalResponse,
		taskPlan,
		waveQueue,
		updateProgress,
	} = params;

	log.info("Running operation verification", {
		stepId: step.id,
		description: step.description,
	});
	updateProgress("executing", `Verifying step: ${step.description}`, step);

	try {
		const verificationResult = await activities.verifyOperation({
			step,
			stepResult: stepResultRecord,
			previousResults: state.stepResults,
			userId: input.userId,
			organizationId: input.organizationId,
			executionId: state.executionId,
			enabledMcpConfigIds: input.enabledMcpConfigIds ?? undefined,
		});

		step.verificationResult = {
			verified: verificationResult.verified,
			operationType: verificationResult.operationType,
			message: verificationResult.verificationMessage,
			details: verificationResult.details,
		};

		if (!verificationResult.verified) {
			log.warn("Operation verification failed", {
				stepId: step.id,
				operationType: verificationResult.operationType,
				message: verificationResult.verificationMessage,
				issues: verificationResult.details.issues,
				notFoundCount:
					verificationResult.details.notFoundOrRemaining.length,
			});

			let modifiedResponse = originalResponse;
			const verificationNote = `\n\n**⚠️ Verification Result:** ${verificationResult.verificationMessage}`;

			if (verificationResult.details.notFoundOrRemaining.length > 0) {
				const notFoundList =
					verificationResult.details.notFoundOrRemaining
						.map(
							(item) =>
								`- ${item.name || item.type}: ${item.reason}`,
						)
						.join("\n");
				modifiedResponse += `${verificationNote}\n\nItems not found or remaining:\n${notFoundList}`;
			} else {
				modifiedResponse += verificationNote;
			}

			// Create retry step if needed
			if (
				verificationResult.shouldRetry &&
				verificationResult.details.notFoundOrRemaining.length > 0 &&
				isDestructiveStep(step.description) &&
				isBulkOperation(step.description)
			) {
				const retryStep = createRetryStep(step, {
					remainingItems:
						verificationResult.details.notFoundOrRemaining.map(
							(item) => ({
								id: item.id || "unknown",
								name: item.name || item.type,
								type: item.type,
							}),
						),
				});

				// Insert into plan
				const stepIdx = taskPlan.steps.indexOf(step);
				if (stepIdx !== -1) {
					taskPlan.steps.splice(stepIdx + 1, 0, retryStep);
				}

				// Enqueue for execution if wave queue is available
				if (waveQueue) {
					waveQueue.unshift([retryStep]);
				}

				log.info("Created retry step for remaining items", {
					originalStepId: step.id,
					retryStepId: retryStep.id,
					remainingItems:
						verificationResult.details.notFoundOrRemaining.length,
				});
			}

			return modifiedResponse;
		}

		log.info("Operation verified successfully", {
			stepId: step.id,
			operationType: verificationResult.operationType,
			message: verificationResult.verificationMessage,
		});

		return originalResponse;
	} catch (verifyError) {
		log.warn("Verification activity failed", {
			stepId: step.id,
			error:
				verifyError instanceof Error
					? verifyError.message
					: String(verifyError),
		});
		return originalResponse;
	}
}

// =============================================================================
// Recovery
// =============================================================================

/**
 * Attempt to recover from step failure via retry or skip strategies.
 */
export async function attemptStepRecovery(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	step: TaskStep,
	error: string,
	_stepStartTime: number,
	modeConfig: ExecutionModeConfig,
	altkConfig: ALTKConfig,
): Promise<RecoveryResult> {
	const maxRetries = WORKFLOW.maxRecoveryRetries;

	const classification = await activities.classifyFailureActivity(
		error,
		step,
	);
	log.info("Attempting recovery", {
		stepId: step.id,
		failureType: classification.type,
		isRetryable: classification.isRetryable,
	});

	// Strategy 1: Retry with backoff
	if (classification.isRetryable) {
		for (
			let attemptNumber = 1;
			attemptNumber <= maxRetries;
			attemptNumber++
		) {
			const delay = await activities.getRetryDelayActivity(
				error,
				step,
				attemptNumber,
			);
			log.info("Retry strategy selected", { delay, attemptNumber });

			await sleep(Math.min(delay, WORKFLOW.maxRetryDelayMs));

			const stepIndex = state.taskPlan?.steps.indexOf(step) ?? 0;
			const retryResult = await executeStepWithContext(
				state,
				input,
				step,
				stepIndex,
				modeConfig,
				altkConfig,
			);

			if (retryResult.success && retryResult.result) {
				return {
					recovered: true,
					response: retryResult.result.response,
					strategyUsed: `retry_attempt_${attemptNumber}`,
					attemptsMade: attemptNumber,
				};
			}
		}
	}

	// Strategy 2: Skip non-critical steps
	if (step.riskLevel !== "critical" && !step.requiresApproval) {
		log.info("Skip strategy - non-critical step failed", {
			stepId: step.id,
		});
		return {
			recovered: false,
			strategyUsed: "skip_non_critical",
			attemptsMade: maxRetries,
			finalError: `Step skipped after failure: ${error}`,
		};
	}

	return {
		recovered: false,
		attemptsMade: maxRetries,
		finalError: error,
	};
}

// =============================================================================
// Reflection
// =============================================================================

/**
 * Perform reflection on step output.
 */
export async function performReflection(
	stepDescription: string,
	outputs: Record<string, unknown>,
	altkConfig: ALTKConfig,
	expectedOutput?: string,
): Promise<void> {
	try {
		const reflection = await activities.reflectOnOutput({
			stepDescription,
			output: outputs,
			expectedOutcome: expectedOutput || stepDescription,
		});

		if (!reflection.satisfactory && altkConfig.reflection.autoCorrect) {
			log.warn("Reflection flagged issue", {
				reason: reflection.reason,
			});
		}
	} catch (error) {
		log.warn("Reflection failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
}

// =============================================================================
// Context Summarization
// =============================================================================

/**
 * Summarize context for long-running executions (every N steps).
 */
export async function summarizeContextIfNeeded(
	state: WorkflowState,
	taskPlan: { steps: TaskStep[] },
): Promise<void> {
	if (
		state.trajectorySteps.length === 0 ||
		state.trajectorySteps.length % CONTEXT.summarizeEveryNSteps !== 0
	) {
		return;
	}

	try {
		const summaryResult = await activities.summarizeContextActivity(
			state.trajectorySteps.map((ts) => ({
				stepId: ts.stepId,
				description:
					taskPlan.steps.find((s) => s.id === ts.stepId)
						?.description || "",
				status: ts.success ? "complete" : "failed",
				startTime: ts.timestamp ? new Date(ts.timestamp) : undefined,
				output: ts.output,
				tokenCount: 0,
				hasArtifacts: false,
				importance: ts.success ? "medium" : "high",
			})),
		);

		if (!workflowInfo().unsafe.isReplaying) {
			log.debug("Context summarized for long execution", {
				stepCount: state.trajectorySteps.length,
				compressionRatio: summaryResult.compressionRatio.toFixed(2),
				keyFacts: summaryResult.keyFacts.length,
			});
		}
	} catch (error) {
		if (!workflowInfo().unsafe.isReplaying) {
			log.warn("Context summarization failed", {
				error: error instanceof Error ? error.message : "Unknown error",
				stepCount: state.trajectorySteps.length,
			});
		}
	}
}

// =============================================================================
// Retry Step Creation
// =============================================================================

/**
 * Creates a follow-up step to complete a partially failed destructive operation.
 */
function createRetryStep(
	originalStep: TaskStep,
	verificationResult: {
		remainingItems: Array<{ id: string; name: string; type: string }>;
	},
): TaskStep {
	const description = originalStep.description.toLowerCase();
	const entityPatterns = [
		{ pattern: /board/i, type: "board" },
		{ pattern: /card/i, type: "card" },
		{ pattern: /task/i, type: "task" },
		{ pattern: /file/i, type: "file" },
		{ pattern: /item/i, type: "item" },
	];
	let entityType = "item";
	for (const { pattern, type } of entityPatterns) {
		if (pattern.test(description)) {
			entityType = type;
			break;
		}
	}

	return {
		id: `${originalStep.id}_retry`,
		type: originalStep.type,
		description: `Retry: Delete remaining ${verificationResult.remainingItems.length} ${entityType}(s) that were not deleted in the previous attempt`,
		order: originalStep.order + 0.5,
		inputs: {
			remainingItemIds: verificationResult.remainingItems.map(
				(item) => item.id,
			),
			originalStepId: originalStep.id,
		},
		outputs: {},
		status: "pending",
		riskLevel: originalStep.riskLevel,
		requiresApproval: originalStep.requiresApproval,
		app: originalStep.app,
		executor: originalStep.executor,
		capability: originalStep.capability,
		toolsToUse: originalStep.toolsToUse,
	};
}

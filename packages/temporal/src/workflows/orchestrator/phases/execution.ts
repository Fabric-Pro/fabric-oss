/**
 * Execution Phase
 *
 * Handles step-by-step execution of the task plan including:
 * - Step approval handling
 * - Step execution with full context
 * - Recovery management
 * - Context propagation between steps
 * - Context summarization for long-running executions
 *
 * Issue #1:  Refactored to use shared processStepResult() — eliminated ~800 lines of duplication
 * Issue #10: Verification logic extracted to step-processing.ts
 */

import {
	continueAsNew,
	log,
	patched,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import type * as orchestratorActivities from "../../../activities/orchestrator";
import type * as weaveActivities from "../../../activities/weave";
import { computeExecutionWaves } from "../execution-waves";
import { WORKFLOW } from "../orchestrator-config";
import {
	executeStepWithContext,
	processStepResult,
	type StepExecutionResult,
	safeNowISO,
	safeNowMs,
	skipIfCircuitOpen,
	summarizeContextIfNeeded,
} from "../step-processing";
import type {
	ALTKConfig,
	ApprovalSignalData,
	ExecutionModeConfig,
	OrchestratorWorkflowInput,
	PhaseResult,
	TaskStep,
	WorkflowState,
} from "../types";

const {
	createOrchestratorApprovalRequest,
	updateApprovalTaskStatus,
	checkStepAuthorityActivity,
	approveAuthoritySessionActivity,
	denyAuthoritySessionActivity,
} = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

const { updateWeaveExecutionActivity, loomRoutingActivity } = proxyActivities<
	typeof weaveActivities
>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

// Shuttle-specific proxies for Background Agent interaction
const { sendShuttlePromptActivity } = proxyActivities<typeof weaveActivities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { pollShuttleStatusActivity } = proxyActivities<typeof weaveActivities>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

const { delegateWeaveImplementationActivity } = proxyActivities<
	typeof weaveActivities
>({
	startToCloseTimeout: "120 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

// Shuttle poll interval and max duration
const SHUTTLE_POLL_INTERVAL_SECONDS = 30;
const SHUTTLE_MAX_POLL_ITERATIONS = 180; // 90 minutes at 30s intervals
const SHUTTLE_MAX_DURATION_MS =
	SHUTTLE_POLL_INTERVAL_SECONDS * SHUTTLE_MAX_POLL_ITERATIONS * 1000;

/** Check if a step should be executed via the Background Agent (Shuttle) */
function isShuttleStep(step: TaskStep): boolean {
	return step.executor === "weave_shuttle" || step.app === "weave_shuttle";
}

function getWeaveImplementationProvider(
	input: OrchestratorWorkflowInput,
): "BACKGROUND_AGENTS" | "KANBAN_LOCAL" {
	return input.weaveImplementationProvider ?? "BACKGROUND_AGENTS";
}

function shouldUseBackgroundShuttle(input: OrchestratorWorkflowInput): boolean {
	return getWeaveImplementationProvider(input) === "BACKGROUND_AGENTS";
}

function getGeneralizedWeaveImplementationProvider(
	input: OrchestratorWorkflowInput,
): "KANBAN_LOCAL" | null {
	const provider = getWeaveImplementationProvider(input);
	if (provider === "BACKGROUND_AGENTS") {
		return null;
	}
	return provider;
}

/**
 * Execute all steps in the task plan
 */
export async function executeExecutionPhase(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	modeConfig: ExecutionModeConfig,
	altkConfig: ALTKConfig,
	updateProgress: (phase: string, message: string, step?: TaskStep) => void,
	waitForApproval: () => Promise<ApprovalSignalData | null>,
	isCancelled: () => boolean,
): Promise<
	PhaseResult<{
		finalResponse: string;
		authRequired?: { configId: string; serverName: string };
	}>
> {
	const { taskPlan } = state;

	if (!taskPlan) {
		return {
			success: false,
			error: "No task plan available",
			shouldContinue: false,
		};
	}

	log.info("Starting execution phase", {
		executionId: state.executionId,
		stepCount: taskPlan.steps.length,
	});

	updateProgress("executing", "Executing task plan...");

	let finalResponse = "";

	// Filter out already-completed/skipped steps (relevant after continueAsNew resumes
	// with persisted taskPlan state — without this, completed steps would be re-executed).
	const pendingSteps = taskPlan.steps.filter(
		(s) =>
			s.status !== "complete" &&
			s.status !== "skipped" &&
			s.status !== "error",
	);

	// Wave-based execution: group steps into parallel waves using DAG / parallelGroup.
	const waveQueue: TaskStep[][] = computeExecutionWaves(pendingSteps);

	log.info("Execution waves computed", {
		executionId: state.executionId,
		totalSteps: taskPlan.steps.length,
		waveCount: waveQueue.length,
		waveSizes: waveQueue.map((w) => w.length),
	});

	while (waveQueue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const wave = waveQueue.shift()!;
		if (isCancelled()) {
			return {
				success: false,
				error: "Execution cancelled",
				shouldContinue: false,
			};
		}

		// Separate approval/critical steps (must run sequentially) from
		// safe-to-parallelize steps.
		const approvalSteps = wave.filter(
			(s) => s.requiresApproval || s.riskLevel === "critical",
		);
		const parallelSteps = wave.filter(
			(s) => !s.requiresApproval && s.riskLevel !== "critical",
		);

		// =====================================================================
		// Run safe-to-parallelize steps concurrently
		// =====================================================================
		if (parallelSteps.length > 0) {
			const result = await executeParallelSteps({
				state,
				input,
				steps: parallelSteps,
				taskPlan,
				modeConfig,
				altkConfig,
				waveQueue,
				updateProgress,
			});

			finalResponse += result.responseChunk;

			if (result.shouldAbort) {
				if (result.authRequired) {
					return {
						success: false,
						error: "OAuth authorization required",
						shouldContinue: false,
						data: {
							finalResponse: `I need access to ${result.authRequired.serverName} to continue. Please connect this service in Settings and try again.`,
							authRequired: result.authRequired,
						},
					};
				}
				return {
					success: false,
					error: result.abortError || "Step failed",
					shouldContinue: false,
				};
			}
		}

		// =====================================================================
		// Run approval-required and critical-risk steps sequentially
		// =====================================================================
		for (const step of approvalSteps) {
			if (isCancelled()) {
				return {
					success: false,
					error: "Execution cancelled",
					shouldContinue: false,
				};
			}

			const result = await executeSequentialStep({
				state,
				input,
				step,
				taskPlan,
				modeConfig,
				altkConfig,
				waveQueue,
				updateProgress,
				waitForApproval,
				isCancelled,
			});

			finalResponse += result.responseChunk;

			if (result.shouldAbort) {
				if (result.rejected) {
					return {
						success: true,
						data: { finalResponse: result.responseChunk },
						shouldContinue: false,
					};
				}
				if (result.authRequired) {
					return {
						success: false,
						error: "OAuth authorization required",
						shouldContinue: false,
						data: {
							finalResponse: `I need access to ${result.authRequired.serverName} to continue. Please connect this service in Settings and try again.`,
							authRequired: result.authRequired,
						},
					};
				}
				return {
					success: false,
					error: result.abortError || "Step failed",
					shouldContinue: false,
				};
			}

			await summarizeContextIfNeeded(state, taskPlan);
		}

		// =================================================================
		// Weave Mode: Abort if any step in the wave failed
		// In weave mode the pipeline is linear (research → implement → review)
		// so a failed upstream step means downstream steps lack required context.
		// =================================================================
		if (input.executionMode === "weave") {
			const failedWaveSteps = wave.filter(
				(s) => s.status === "error" || s.status === "skipped",
			);
			if (failedWaveSteps.length > 0) {
				const failedDescriptions = failedWaveSteps
					.map(
						(s) =>
							`- ${s.executor || s.app || "unknown"}: ${s.description} (${s.error || s.status})`,
					)
					.join("\n");

				log.error(
					"Weave execution aborted — step(s) failed in current wave",
					{
						executionId: state.executionId,
						failedCount: failedWaveSteps.length,
						totalInWave: wave.length,
						failedStepIds: failedWaveSteps.map((s) => s.id),
					},
				);

				// Mark remaining steps in future waves as skipped
				for (const futureWave of waveQueue) {
					for (const s of futureWave) {
						s.status = "skipped";
						s.error = "Skipped — upstream step(s) failed";
						state.stepResults.push({
							stepId: s.id,
							stepDescription: s.description,
							status: "skipped",
							toolCalls: [],
							durationMs: 0,
							error: s.error,
						});
					}
				}

				return {
					success: false,
					error: `Weave execution aborted — ${failedWaveSteps.length} step(s) failed:\n${failedDescriptions}`,
					shouldContinue: false,
				};
			}
		}

		// =================================================================
		// Weave: skip review waves if Shuttle produced no PR
		// =================================================================
		if (input.executionMode === "weave" && waveQueue.length > 0) {
			const shuttleRan = wave.some((s) => isShuttleStep(s));
			const hasPR = !!state.variables["shuttle.pullRequestUrl"]?.value;

			if (shuttleRan && !hasPR) {
				log.warn(
					"Shuttle completed without creating a PR — skipping remaining review waves",
				);

				for (const futureWave of waveQueue) {
					for (const s of futureWave) {
						s.status = "skipped";
						s.error = "Skipped — no PR was created by Shuttle";
						state.stepResults.push({
							stepId: s.id,
							stepDescription: s.description,
							status: "skipped",
							toolCalls: [],
							durationMs: 0,
							error: s.error,
						});
					}
				}

				// Shuttle succeeded but produced no PR — skip reviews but don't
				// mark the overall execution as failed.
				return {
					success: true,
					error: "Shuttle completed without a pull request. Review steps skipped.",
					shouldContinue: false,
				};
			}
		}

		// continueAsNew: prevent workflow history from growing too large
		const completedCount = state.stepResults.filter(
			(sr) => sr.status === "complete",
		).length;

		// =================================================================
		// Loom Routing: dynamic agent reassignment between waves (weave only)
		// =================================================================
		if (input.executionMode === "weave" && waveQueue.length > 0) {
			try {
				const completedStepSummaries = taskPlan.steps
					.filter(
						(s) => s.status === "complete" || s.status === "error",
					)
					.map((s) => ({
						id: s.id,
						description: s.description,
						executor: s.executor || s.app || "unknown",
						status: s.status,
						output: s.outputs?.result
							? String(s.outputs.result).slice(0, 300)
							: undefined,
					}));

				const nextWave = waveQueue[0];
				const upcomingSteps = nextWave.map((s) => ({
					id: s.id,
					description: s.description,
					executor: s.executor || s.app || "unknown",
				}));

				const routing = await loomRoutingActivity({
					completedSteps: completedStepSummaries,
					upcomingSteps,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				// Apply reassignments
				for (const reassign of routing.reassignments) {
					const step = nextWave.find((s) => s.id === reassign.stepId);
					if (step) {
						log.info("Loom routing: reassigning step", {
							stepId: step.id,
							from: step.executor,
							to: reassign.newAgent,
							reason: reassign.reason,
						});
						step.executor = reassign.newAgent;
						step.app = reassign.newAgent;
					}
				}

				// Skip steps Loom deems redundant
				for (const skipId of routing.skipSteps) {
					const idx = nextWave.findIndex((s) => s.id === skipId);
					if (idx !== -1) {
						log.info("Loom routing: skipping step", {
							stepId: skipId,
						});
						nextWave[idx].status = "skipped";
						nextWave.splice(idx, 1);
					}
				}

				// Add steps Loom identifies as needed
				for (const add of routing.addSteps) {
					state.loomAddedSeq += 1;
					const newStep: TaskStep = {
						id: `loom-added-${state.loomAddedSeq}`,
						description: add.description,
						type: "agent",
						status: "pending",
						order: taskPlan.steps.length,
						executor: add.agent,
						capability: "agent",
						app: add.agent,
						riskLevel: "low",
						inputs: {},
					};
					nextWave.push(newStep);
					taskPlan.steps.push(newStep);
					log.info("Loom routing: added step", {
						stepId: newStep.id,
						agent: add.agent,
						description: add.description,
					});
				}

				if (routing.reasoning) {
					updateProgress(
						"executing",
						`Loom routing: ${routing.reasoning}`,
					);
				}
			} catch (error) {
				log.warn("Loom routing failed — continuing with plan as-is", {
					error: String(error),
				});
			}
		}

		// =================================================================
		// Tapestry Context Propagation: feed prior results to next wave
		// =================================================================
		if (input.executionMode === "weave" && waveQueue.length > 0) {
			const completedOutputs = taskPlan.steps
				.filter(
					(s) =>
						s.status === "complete" &&
						(s.outputs?.response || s.outputs?.result),
				)
				.map(
					(s) =>
						`[${s.executor || s.app}] ${s.description}:\n${String(s.outputs?.response || s.outputs?.result).slice(0, 500)}`,
				)
				.join("\n\n");

			if (completedOutputs) {
				const nextWave = waveQueue[0];
				for (const step of nextWave) {
					if (!step.inputs) {
						step.inputs = {};
					}
					step.inputs.priorContext = completedOutputs;
				}
			}
		}

		if (
			completedCount > 0 &&
			completedCount % WORKFLOW.continueAsNewStepThreshold === 0
		) {
			const hasTransientApprovalState =
				state.pendingApproval !== null ||
				state.approvalDecision !== null ||
				state.pendingToolApproval !== null;

			if (hasTransientApprovalState) {
				log.warn(
					"Skipping continueAsNew because transient approval state is still present",
					{
						executionId: state.executionId,
						completedSteps: completedCount,
						hasPendingApproval: state.pendingApproval !== null,
						hasApprovalDecision: state.approvalDecision !== null,
						hasPendingToolApproval:
							state.pendingToolApproval !== null,
					},
				);
			} else {
				log.info(
					"Issuing continueAsNew to prevent workflow history growth",
					{
						completedSteps: completedCount,
						threshold: WORKFLOW.continueAsNewStepThreshold,
						executionId: state.executionId,
					},
				);

				// Carry forward the durable workflow state only.
				await continueAsNew<
					(input: OrchestratorWorkflowInput) => Promise<unknown>
				>({
					...input,
					resumeState: {
						startTime: state.startTime,
						taskPlan: state.taskPlan,
						stepResults: state.stepResults,
						variables: state.variables,
						trajectorySteps: state.trajectorySteps,
						toolCalls: state.toolCalls,
						approvalHistory: state.approvalHistory,
						planningAudit: state.planningAudit,
						followUpMessages: state.followUpMessages,
						pendingModification: state.pendingModification,
						currentProgress: state.currentProgress,
						routingDecision: state.routingDecision,
						// Fields previously missing (Issue #6)
						preloadedResources: state.preloadedResources,
						enrichedMessage: state.enrichedMessage,
						enrichedSystemPrompt: state.enrichedSystemPrompt,
						lettaAgentId: state.lettaAgentId,
						workspaceContext: state.workspaceContext,
						journeyState: state.journeyState,
						agentCircuitBreakers: state.agentCircuitBreakers,
						degradedCapabilities: state.degradedCapabilities,
						toolSearchMetrics: state.toolSearchMetrics,
						iterativeConversationHistory:
							state.iterativeConversationHistory,
						currentIteration: state.currentIteration,
						iterationCosts: state.iterationCosts,
						loomAddedSeq: state.loomAddedSeq,
					},
				});
			}
		}
	}

	// A cancel signal observed during the FINAL wave (e.g. a Shuttle poll
	// loop that broke on cancellation, or any step that finished while the
	// run was being cancelled) must still route to the cancelled exit so the
	// execution and plan are reconciled. The per-wave isCancelled() check at
	// the top of the loop is skipped once the queue drains, so without this
	// the workflow would return success, run the completion phase
	// (exitReason "success"), and leave the plan wedged in RUNNING. Gated by
	// patched() so pre-patch histories — which exited "success" here —
	// replay deterministically. Patch id is workflow-scoped: never reuse or
	// rename.
	if (
		isCancelled() &&
		patched("weave-execution-cancel-after-final-wave-v1")
	) {
		log.info("Execution cancelled after final wave — routing to cancel", {
			executionId: state.executionId,
		});
		return {
			success: false,
			error: "Execution cancelled",
			shouldContinue: false,
		};
	}

	return {
		success: true,
		data: { finalResponse: finalResponse.trim() },
		shouldContinue: true,
	};
}

// =============================================================================
// Parallel Step Execution
// =============================================================================

async function executeParallelSteps(params: {
	state: WorkflowState;
	input: OrchestratorWorkflowInput;
	steps: TaskStep[];
	taskPlan: { steps: TaskStep[] };
	modeConfig: ExecutionModeConfig;
	altkConfig: ALTKConfig;
	waveQueue: TaskStep[][];
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
		steps,
		taskPlan,
		modeConfig,
		altkConfig,
		waveQueue,
		updateProgress,
	} = params;

	// Mark all parallel steps as in_progress
	for (const step of steps) {
		step.status = "in_progress";
		step.startedAt = safeNowISO();
	}
	updateProgress(
		"executing",
		steps.length > 1
			? `Executing ${steps.length} steps in parallel (wave)`
			: `Executing step: ${steps[0].description}`,
		steps[0],
	);

	// ── Authority pre-check for parallel steps ──
	const authorityCheckedSteps: TaskStep[] = [];
	for (const step of steps) {
		try {
			const authorityCheck = await checkStepAuthorityActivity({
				userId: input.userId,
				organizationId: input.organizationId,
				executionId: state.executionId,
				step: {
					id: step.id,
					description: step.description,
					type: step.type,
					status: step.status,
					order: step.order,
					riskLevel: step.riskLevel,
					requiresApproval: step.requiresApproval,
					approvalId: step.approvalId,
					capability: step.capability,
					executor: step.executor,
					app: step.app,
					toolsToUse: step.toolsToUse,
				},
			});

			if (
				!authorityCheck.allowed &&
				authorityCheck.blockedBy === "authority_missing"
			) {
				// Mark step as needing authority — it will be retried after approval
				step.status = "error";
				const providerKey =
					authorityCheck.blockedDetails?.providerKey ?? "unknown";
				step.error = `Runtime authority required for ${providerKey}. Approve in Fabric UI to retry.`;
				log.warn("Parallel step blocked by authority", {
					stepId: step.id,
					providerKey,
					authoritySessionId: authorityCheck.authoritySessionId,
				});
			} else {
				authorityCheckedSteps.push(step);
			}
		} catch (error) {
			// Fail closed — authority check errors block the step
			step.status = "error";
			step.error = `Authority check failed: ${String(error)}`;
			log.error("Parallel step authority check failed", {
				stepId: step.id,
				error: String(error),
			});
		}
	}

	// Circuit-breaker pre-check: skip steps whose agent circuit is open
	const executableSteps: TaskStep[] = [];
	for (const step of authorityCheckedSteps) {
		const skipped = skipIfCircuitOpen(state, step, updateProgress);
		if (skipped && step.riskLevel === "critical") {
			return {
				responseChunk: "",
				shouldAbort: true,
				abortError: step.error,
			};
		}
		if (!skipped) {
			executableSteps.push(step);
		}
	}

	if (executableSteps.length === 0) {
		return { responseChunk: "", shouldAbort: false };
	}

	// Partition shuttle steps (batched) from non-shuttle steps (individual)
	const weaveShuttleSteps =
		input.executionMode === "weave"
			? executableSteps.filter((s) => isShuttleStep(s))
			: [];
	const nonShuttleSteps =
		input.executionMode === "weave"
			? executableSteps.filter((s) => !isShuttleStep(s))
			: executableSteps;

	// Build promise array: non-shuttle steps run individually, shuttle steps batched
	const promises: Promise<StepExecutionResult>[] = [];
	// Track which executableSteps map to which promise index
	const promiseToSteps: TaskStep[][] = [];

	for (const step of nonShuttleSteps) {
		const idx = taskPlan.steps.indexOf(step);
		promises.push(
			executeStepWithContext(
				state,
				input,
				step,
				idx,
				modeConfig,
				altkConfig,
			),
		);
		promiseToSteps.push([step]);
	}

	if (weaveShuttleSteps.length === 1) {
		// Single shuttle step — use existing individual function
		promises.push(
			executeShuttleStep(
				state,
				input,
				weaveShuttleSteps[0],
				updateProgress,
			),
		);
		promiseToSteps.push([weaveShuttleSteps[0]]);
	} else if (weaveShuttleSteps.length > 1) {
		// Multiple shuttle steps — batch into one prompt
		promises.push(
			executeBatchedShuttleSteps(
				state,
				input,
				weaveShuttleSteps,
				updateProgress,
			),
		);
		promiseToSteps.push(weaveShuttleSteps);
	}

	const batchStartTime = safeNowMs();
	const results = await Promise.allSettled(promises);

	// Merge results — for batched shuttle, apply the same result to each step
	let responseChunk = "";

	for (let pi = 0; pi < promises.length; pi++) {
		const result = results[pi];
		const stepsForResult = promiseToSteps[pi];

		// Unwrap Promise.allSettled result
		const stepResult =
			result.status === "fulfilled"
				? result.value
				: {
						success: false,
						error:
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason),
					};

		// Process each step that maps to this promise result
		for (const step of stepsForResult) {
			const processed = await processStepResult({
				state,
				input,
				step,
				stepResult,
				stepStartTime: batchStartTime,
				modeConfig,
				altkConfig,
				taskPlan: taskPlan as any,
				waveQueue,
				updateProgress,
			});

			responseChunk += processed.responseChunk;

			if (processed.shouldAbort) {
				return {
					responseChunk,
					shouldAbort: true,
					abortError: processed.abortError,
					authRequired: processed.authRequired,
				};
			}

			updateProgress(
				"executing",
				`Completed step: ${step.description}`,
				step,
			);

			await summarizeContextIfNeeded(state, taskPlan);
		}
	}

	return { responseChunk, shouldAbort: false };
}

// =============================================================================
// Sequential Step Execution (with approval)
// =============================================================================

async function executeSequentialStep(params: {
	state: WorkflowState;
	input: OrchestratorWorkflowInput;
	step: TaskStep;
	taskPlan: { steps: TaskStep[] };
	modeConfig: ExecutionModeConfig;
	altkConfig: ALTKConfig;
	waveQueue: TaskStep[][];
	updateProgress: (phase: string, message: string, step?: TaskStep) => void;
	waitForApproval: () => Promise<ApprovalSignalData | null>;
	isCancelled: () => boolean;
}): Promise<{
	responseChunk: string;
	shouldAbort: boolean;
	rejected?: boolean;
	abortError?: string;
	authRequired?: { configId: string; serverName: string };
}> {
	const {
		state,
		input,
		step,
		taskPlan,
		modeConfig,
		altkConfig,
		waveQueue,
		updateProgress,
		waitForApproval,
		isCancelled,
	} = params;

	const stepIndex = taskPlan.steps.indexOf(step);

	// Mark step as in progress
	step.status = "in_progress";
	step.startedAt = safeNowISO();
	updateProgress(
		"executing",
		`Executing step ${stepIndex + 1}: ${step.description}`,
		step,
	);

	// ── Authority gate: check runtime authority before execution ──
	// This is the orchestrator-side enforcement of Pipes-style authorization.
	// Steps requiring external providers are blocked unless authority is granted.
	try {
		const authorityCheck = await checkStepAuthorityActivity({
			userId: input.userId,
			organizationId: input.organizationId,
			executionId: state.executionId,
			step: {
				id: step.id,
				description: step.description,
				type: step.type,
				status: step.status,
				order: step.order,
				riskLevel: step.riskLevel,
				requiresApproval: step.requiresApproval,
				approvalId: step.approvalId,
				capability: step.capability,
				executor: step.executor,
				app: step.app,
				toolsToUse: step.toolsToUse,
			},
		});

		if (!authorityCheck.allowed) {
			log.warn("Step blocked by authority policy", {
				stepId: step.id,
				blockedBy: authorityCheck.blockedBy,
				details: authorityCheck.blockedDetails,
			});

			// If blocked by authority, surface as an approval request and wait
			if (authorityCheck.blockedBy === "authority_missing") {
				const providerKey =
					authorityCheck.blockedDetails?.providerKey ?? "unknown";
				const accessLevel =
					authorityCheck.blockedDetails?.requiredAccessLevel ??
					"WRITE";

				log.info("Step blocked on authority, pausing for approval", {
					stepId: step.id,
					providerKey,
					accessLevel,
					authoritySessionId: authorityCheck.authoritySessionId,
				});

				// Surface the authority requirement as a step approval request
				// so the user sees it in the orchestrator UI with Approve/Reject
				step.requiresApproval = true;
				step.riskLevel = "high";

				// Override the description to make it clear this is about authority
				const originalDescription = step.description;
				step.description = `🔐 Runtime authority needed: grant ${accessLevel} access to ${providerKey} to proceed with "${originalDescription}"`;

				// Store the authority session ID so the approval handler can activate it
				step.outputs = {
					...step.outputs,
					_authoritySessionId: authorityCheck.authoritySessionId,
					_authorityProvider: providerKey,
				};

				// Fall through to the existing handleStepApproval flow below
				// which will show the approval UI and wait for user response
			}
			// For step_approval_required, also fall through to existing approval flow
		}
	} catch (error) {
		// Fail closed — authority check errors block the step
		log.error("Authority check failed, blocking step execution", {
			stepId: step.id,
			error: String(error),
		});
		step.status = "error";
		step.error = `Authority check failed: ${String(error)}`;
		return {
			responseChunk: "",
			shouldAbort: false,
			abortError: step.error,
		};
	}

	// Handle step approval if required
	if (step.requiresApproval && !step.approvalId) {
		const approvalResult = await handleStepApproval(
			state,
			input,
			step,
			stepIndex,
			taskPlan.steps.length,
			updateProgress,
			waitForApproval,
			isCancelled,
		);

		if (!approvalResult.success) {
			if (approvalResult.rejected) {
				return {
					responseChunk: approvalResult.summary || "",
					shouldAbort: true,
					rejected: true,
				};
			}
			return {
				responseChunk: "",
				shouldAbort: true,
				abortError: approvalResult.error,
			};
		}
	}

	// Circuit breaker check
	if (skipIfCircuitOpen(state, step, updateProgress)) {
		if (step.riskLevel === "critical") {
			return {
				responseChunk: "",
				shouldAbort: true,
				abortError: step.error,
			};
		}
		return { responseChunk: "", shouldAbort: false };
	}

	// Execute the step (Shuttle steps use Background Agent)
	const stepStartTime = safeNowMs();
	const stepResult =
		isShuttleStep(step) && input.executionMode === "weave"
			? await executeShuttleStep(state, input, step, updateProgress)
			: await executeStepWithContext(
					state,
					input,
					step,
					stepIndex,
					modeConfig,
					altkConfig,
				);

	const processed = await processStepResult({
		state,
		input,
		step,
		stepResult,
		stepStartTime,
		modeConfig,
		altkConfig,
		taskPlan: taskPlan as any,
		waveQueue,
		updateProgress,
	});

	updateProgress(
		"executing",
		`Completed step ${stepIndex + 1} of ${taskPlan.steps.length}`,
		step,
	);

	return {
		responseChunk: processed.responseChunk,
		shouldAbort: processed.shouldAbort,
		abortError: processed.abortError,
		authRequired: processed.authRequired,
	};
}

// =============================================================================
// Step Approval
// =============================================================================

async function handleStepApproval(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	step: TaskStep,
	stepIndex: number,
	_totalSteps: number,
	updateProgress: (phase: string, message: string, step?: TaskStep) => void,
	waitForApproval: () => Promise<ApprovalSignalData | null>,
	isCancelled: () => boolean,
): Promise<{
	success: boolean;
	rejected?: boolean;
	summary?: string;
	error?: string;
}> {
	updateProgress(
		"awaiting_approval",
		`Step requires approval: ${step.description}`,
	);
	state.status = "awaiting_approval";
	step.status = "awaiting_approval";

	const riskScoreMap: Record<string, number> = {
		low: 25,
		medium: 50,
		high: 75,
		critical: 95,
	};
	const calculatedRiskScore = riskScoreMap[step.riskLevel || "medium"] ?? 50;

	// Extract affected items for bulk operations
	const affectedItems = extractAffectedItemsFromContext(state, step);

	if (affectedItems.length > 0) {
		log.info("Extracted affected items for approval", {
			stepId: step.id,
			itemCount: affectedItems.length,
		});
	}

	const stepApproval = await createOrchestratorApprovalRequest({
		executionId: state.executionId,
		stepId: step.id,
		stepDescription: step.description,
		stepType: step.type,
		userId: input.userId,
		organizationId: input.organizationId,
		riskScore: calculatedRiskScore,
		riskLevel: step.riskLevel || "medium",
		affectedItems: affectedItems.length > 0 ? affectedItems : undefined,
		weaveExecutionId: input.weaveExecutionId,
		weavePlanId: input.weavePlanId,
		weaveContext:
			input.executionMode === "weave"
				? {
						checkboxText: step.description,
						agent: step.executor || step.app,
						reviewType:
							(typeof step.inputs?.reviewType === "string"
								? step.inputs.reviewType
								: undefined) ||
							(step.executor?.includes("weft")
								? "work"
								: step.executor?.includes("warp")
									? "security"
									: undefined),
					}
				: undefined,
	});

	step.approvalId = stepApproval.approvalId;
	state.pendingApproval = {
		approvalId: stepApproval.approvalId,
		stepId: step.id,
		reason: `${step.riskLevel?.toUpperCase() || "MEDIUM"} RISK: ${step.description}`,
		checkboxText: step.description,
		agent: step.executor || step.app,
		reviewType:
			(typeof step.inputs?.reviewType === "string"
				? step.inputs.reviewType
				: undefined) ||
			(step.executor?.includes("weft")
				? "work"
				: step.executor?.includes("warp")
					? "security"
					: undefined),
	};

	if (input.weaveExecutionId) {
		await updateWeaveExecutionActivity({
			executionId: input.weaveExecutionId,
			userId: input.userId,
			organizationId: input.organizationId,
			status: "CHECKPOINT",
			currentStep: stepIndex,
		});
	}

	const stepApprovalEntry = {
		approvalId: stepApproval.approvalId,
		stepId: step.id,
		stepDescription: step.description,
		riskLevel: step.riskLevel || "medium",
		requestedAt: safeNowISO(),
		decidedAt: undefined as string | undefined,
		approved: false,
		feedback: undefined as string | undefined,
	};
	state.approvalHistory.push(stepApprovalEntry);

	const decision = await waitForApproval();

	stepApprovalEntry.decidedAt = safeNowISO();
	stepApprovalEntry.approved = decision?.approved || false;
	stepApprovalEntry.feedback = decision?.feedback;

	try {
		await updateApprovalTaskStatus({
			approvalId: stepApproval.approvalId,
			approved: decision?.approved || false,
			feedback: decision?.feedback,
		});
	} catch (error) {
		log.warn("Failed to update approval task status", {
			approvalId: stepApproval.approvalId,
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	// If the step was blocked on authority, approve/deny the authority session
	const authoritySessionId = (step.outputs as Record<string, unknown>)
		?._authoritySessionId as string | undefined;
	if (authoritySessionId) {
		if (decision?.approved) {
			await approveAuthoritySessionActivity({
				authoritySessionId,
				userId: input.userId,
				organizationId: input.organizationId,
				instructions: decision.feedback,
			});
			log.info("Authority session approved via step approval", {
				authoritySessionId,
				stepId: step.id,
			});
		} else {
			await denyAuthoritySessionActivity({
				authoritySessionId,
				userId: input.userId,
				organizationId: input.organizationId,
				reason: decision?.feedback || "User declined authority",
			});
			log.info("Authority session denied via step approval", {
				authoritySessionId,
				stepId: step.id,
			});
		}
	}

	if (isCancelled() || !decision?.approved) {
		step.status = "skipped";
		step.error = decision?.feedback || "Step declined by user";

		state.stepResults.push({
			stepId: step.id,
			stepDescription: step.description,
			status: "skipped",
			toolCalls: [],
			durationMs: 0,
			error: step.error,
		});

		// Mark remaining steps as skipped
		const { taskPlan } = state;
		if (taskPlan) {
			for (let j = stepIndex + 1; j < taskPlan.steps.length; j++) {
				taskPlan.steps[j].status = "skipped";
				taskPlan.steps[j].error = "Previous step was declined";
				state.stepResults.push({
					stepId: taskPlan.steps[j].id,
					stepDescription: taskPlan.steps[j].description,
					status: "skipped",
					toolCalls: [],
					durationMs: 0,
					error: "Previous step was declined",
				});
			}
		}

		const completedCount = state.stepResults.filter(
			(sr) => sr.status === "complete",
		).length;

		const declineReason = decision?.feedback
			? `\n\n**Reason:** ${decision.feedback}`
			: "";

		const summary =
			completedCount > 0
				? `## Action Declined\n\nI stopped the workflow because the step **"${step.description}"** was declined.${declineReason}\n\n**Progress:** Completed ${completedCount} step(s) before this point.\n\nIf you'd like to proceed differently or have questions, please let me know.`
				: `## Action Declined\n\nI stopped the workflow because the step **"${step.description}"** was declined by you.${declineReason}\n\nNo actions were taken. If you'd like to proceed differently or have questions, please let me know.`;

		log.info("Step rejected, stopping workflow", {
			rejectedStep: step.id,
			completedSteps: completedCount,
			feedback: decision?.feedback,
		});

		updateProgress(
			"complete",
			`Workflow stopped: ${step.description} was rejected`,
			step,
		);

		state.approvalDecision = null;
		state.pendingApproval = null;
		state.status = "completed";

		if (input.weaveExecutionId) {
			await updateWeaveExecutionActivity({
				executionId: input.weaveExecutionId,
				userId: input.userId,
				organizationId: input.organizationId,
				status: "CANCELLED",
				currentStep: stepIndex,
				completedAt: new Date(safeNowMs()),
				error: step.error,
			});
		}

		return { success: false, rejected: true, summary };
	}

	// Approval granted
	state.approvalDecision = null;
	state.pendingApproval = null;
	state.status = "running";
	step.status = "in_progress";

	if (input.weaveExecutionId) {
		await updateWeaveExecutionActivity({
			executionId: input.weaveExecutionId,
			userId: input.userId,
			organizationId: input.organizationId,
			status: "RUNNING",
			currentStep: stepIndex,
		});
	}

	updateProgress(
		"executing",
		`Approval granted - resuming step ${stepIndex + 1}: ${step.description}`,
		step,
	);

	return { success: true };
}

// =============================================================================
// Shuttle Step Execution (via Background Agent)
// =============================================================================

/**
 * Execute a Shuttle step by sending the implementation prompt to the
 * Background Agent session and polling until it completes or creates a PR.
 *
 * The prompt includes prior research context from Thread/Spindle steps
 * via Tapestry context propagation (step.inputs.priorContext).
 *
 * Returns a result compatible with processStepResult().
 */
function buildShuttlePrompt(stepDescriptions: string[], priorContext?: string) {
	const promptParts: string[] = [];

	if (priorContext) {
		promptParts.push(
			"## Research Context\n\nThe following research was gathered by specialized agents:\n",
			priorContext,
			"\n---\n",
		);
	}

	if (stepDescriptions.length === 1) {
		promptParts.push(`## Implementation Task\n\n${stepDescriptions[0]}`);
	} else {
		promptParts.push(
			"## Implementation Tasks\n\nYou have the following implementation tasks to complete. Please implement ALL of them in a single session and create one pull request with all changes.\n",
		);
		for (let i = 0; i < stepDescriptions.length; i++) {
			promptParts.push(`${i + 1}. ${stepDescriptions[i]}`);
		}
	}

	return promptParts.join("\n");
}

function getShuttleRoutingMetadata(shuttleSteps: TaskStep[]) {
	const categories = Array.from(
		new Set(
			shuttleSteps
				.map((step) => step.inputs?.category)
				.filter((value): value is string => typeof value === "string"),
		),
	);
	const modelOverrides = Array.from(
		new Set(
			shuttleSteps
				.map((step) => step.inputs?.modelOverride)
				.filter((value): value is string => typeof value === "string"),
		),
	);

	return {
		category:
			categories.length === 1
				? categories[0]
				: categories.length > 1
					? "mixed"
					: "backend",
		modelOverride:
			modelOverrides.length === 1 ? modelOverrides[0] : undefined,
	};
}

function mapWeaveBridgeResultToStepExecutionResult(input: {
	result: Awaited<ReturnType<typeof delegateWeaveImplementationActivity>>;
	provider: "KANBAN_LOCAL";
}): StepExecutionResult {
	const responseLines = [input.result.summary];
	if (input.result.pullRequestUrl) {
		responseLines.push(
			`Pull request created: ${input.result.pullRequestUrl}`,
		);
	}
	if (input.result.externalUrl) {
		responseLines.push(`Runtime URL: ${input.result.externalUrl}`);
	}
	if (input.result.providerSessionId) {
		responseLines.push(
			`Provider session: ${input.result.providerSessionId}`,
		);
	}
	if (input.result.codingRunId) {
		responseLines.push(
			`Implementation session: ${input.result.codingRunId}`,
		);
	}
	responseLines.push(`Delegation status: ${input.result.status}`);

	const response = responseLines.join("\n");
	const isSuccess =
		input.result.status === "completed" ||
		Boolean(input.result.pullRequestUrl);

	return {
		success: isSuccess,
		result: {
			response,
			outputs: {
				result: response,
				pullRequestUrl: input.result.pullRequestUrl ?? null,
				externalUrl: input.result.externalUrl ?? null,
				codingRunId: input.result.codingRunId,
				providerSessionId: input.result.providerSessionId,
				executionKind: input.result.executionKind,
				provider: input.provider,
			},
			variables: input.result.pullRequestUrl
				? {
						"shuttle.pullRequestUrl": {
							name: "shuttle.pullRequestUrl",
							value: input.result.pullRequestUrl,
							setBy: "weave_shuttle",
							setAt: safeNowISO(),
							scope: "workflow",
						},
					}
				: undefined,
		},
		error: isSuccess
			? undefined
			: `Weave implementation delegation ended with status: ${input.result.status}`,
	};
}

async function executeShuttleStep(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	step: TaskStep,
	updateProgress: (phase: string, message: string, step?: TaskStep) => void,
): Promise<StepExecutionResult> {
	const priorContext =
		(step.inputs?.priorContext as string | undefined) || "";
	const prompt = buildShuttlePrompt([step.description], priorContext);

	if (!shouldUseBackgroundShuttle(input)) {
		const generalizedProvider =
			getGeneralizedWeaveImplementationProvider(input);
		if (!generalizedProvider) {
			throw new Error("Expected a local or workspace Weave provider");
		}

		log.info(
			"Shuttle: delegating implementation through generalized bridge",
			{
				provider: generalizedProvider,
				stepId: step.id,
				weaveExecutionId: input.weaveExecutionId,
			},
		);

		updateProgress(
			"executing",
			"Shuttle: delegating implementation via Fabric Kanban...",
			step,
		);

		try {
			const result = await delegateWeaveImplementationActivity({
				planId:
					input.weavePlanId ?? String(step.inputs?.weavePlanId ?? ""),
				prompt,
				category:
					typeof step.inputs?.category === "string"
						? step.inputs.category
						: "backend",
				modelOverride:
					typeof step.inputs?.modelOverride === "string"
						? step.inputs.modelOverride
						: undefined,
				executionProvider: generalizedProvider,
				userId: input.userId,
				organizationId: input.organizationId,
				weaveExecutionId: input.weaveExecutionId,
				timeoutMs: SHUTTLE_MAX_DURATION_MS,
			});

			return mapWeaveBridgeResultToStepExecutionResult({
				result,
				provider: generalizedProvider,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			log.error("Shuttle: generalized delegation failed", {
				provider: generalizedProvider,
				error: msg,
				stepId: step.id,
			});
			return {
				success: false,
				result: { outputs: {} },
				error: `Failed to delegate implementation: ${msg}`,
			};
		}
	}

	const sandboxVar = state.variables["weave.sandboxSessionId"];
	const sessionId =
		typeof sandboxVar?.value === "string" ? sandboxVar.value : null;

	if (!sessionId) {
		log.warn(
			"Shuttle step skipped — no Background Agent session available",
		);
		return {
			success: false,
			result: { outputs: {} },
			error: "No Background Agent session available. Check that BACKGROUND_AGENTS_URL is configured and the project has a repository URL.",
		};
	}

	// Send the prompt to the Background Agent session
	log.info("Shuttle: sending implementation prompt to Background Agent", {
		sessionId,
		promptLength: prompt.length,
		stepId: step.id,
	});

	updateProgress(
		"executing",
		"Shuttle: sending implementation request to Background Agent...",
		step,
	);

	try {
		await sendShuttlePromptActivity({
			sessionId,
			prompt,
			userId: input.userId,
			organizationId: input.organizationId,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log.error("Shuttle: failed to send prompt", { error: msg });
		return {
			success: false,
			result: { outputs: {} },
			error: `Failed to send prompt: ${msg}`,
		};
	}

	// Poll for completion
	log.info("Shuttle: polling Background Agent for completion", {
		sessionId,
		maxPollMinutes:
			(SHUTTLE_POLL_INTERVAL_SECONDS * SHUTTLE_MAX_POLL_ITERATIONS) / 60,
	});

	let pullRequestUrl: string | null = null;
	let branchName: string | null = null;
	let finalStatus = "active";

	for (let i = 0; i < SHUTTLE_MAX_POLL_ITERATIONS; i++) {
		await sleep(`${SHUTTLE_POLL_INTERVAL_SECONDS} seconds`);

		// Stop polling promptly once the run is cancelled. Cancellation
		// arrives as a signal (`state.cancelled`), NOT Temporal workflow
		// cancellation, so the `sleep` above never throws — without this
		// check the Background Agent keeps running until its session ends on
		// its own and the parent plan stays wedged in RUNNING until the
		// workflow's finally block. Breaking here lets the workflow exit
		// through its cancelled path, which reconciles the execution +
		// restores the plan and tears the session down via the cleanup
		// activity. Gated by `patched()` so pre-patch histories (which
		// polled to completion) still replay deterministically. Patch id is
		// workflow-scoped: never reuse or rename.
		if (state.cancelled && patched("weave-shuttle-cancel-check-v1")) {
			log.info("Shuttle: cancellation observed — stopping poll loop", {
				sessionId,
				pollCount: i + 1,
			});
			finalStatus = "cancelled";
			break;
		}

		try {
			const pollResult = await pollShuttleStatusActivity({ sessionId });
			finalStatus = pollResult.status;

			if (pollResult.pullRequestUrl) {
				pullRequestUrl = pollResult.pullRequestUrl;
				branchName = pollResult.branchName;
				updateProgress(
					"executing",
					`Shuttle: PR created — ${pullRequestUrl}`,
					step,
				);
			}

			if (i % 4 === 0) {
				// Log progress every ~60 seconds
				updateProgress(
					"executing",
					`Shuttle: Background Agent ${pollResult.status}...${pullRequestUrl ? ` (PR: ${pullRequestUrl})` : ""} (${Math.round((i * SHUTTLE_POLL_INTERVAL_SECONDS) / 60)}m)`,
					step,
				);
			}

			if (pollResult.done) {
				log.info("Shuttle: Background Agent session completed", {
					sessionId,
					status: pollResult.status,
					pullRequestUrl,
					pollCount: i + 1,
				});
				break;
			}
		} catch (error) {
			log.warn("Shuttle: poll failed, will retry", {
				error: error instanceof Error ? error.message : String(error),
				pollCount: i + 1,
			});
			// Continue polling — transient failures are expected
		}
	}

	// Build result
	const isSuccess = finalStatus === "completed" || pullRequestUrl !== null;
	const responseLines: string[] = [];

	if (pullRequestUrl) {
		responseLines.push(`Pull request created: ${pullRequestUrl}`);
	}
	if (branchName) {
		responseLines.push(`Branch: ${branchName}`);
	}
	responseLines.push(`Background Agent session status: ${finalStatus}`);

	const response = responseLines.join("\n");

	return {
		success: isSuccess,
		result: {
			response,
			outputs: {
				result: response,
				pullRequestUrl,
				branchName,
				sessionId,
			},
			variables: pullRequestUrl
				? {
						"shuttle.pullRequestUrl": {
							name: "shuttle.pullRequestUrl",
							value: pullRequestUrl,
							setBy: step.id,
							setAt: safeNowISO(),
							scope: "workflow",
						},
						"shuttle.branchName": {
							name: "shuttle.branchName",
							value: branchName || "",
							setBy: step.id,
							setAt: safeNowISO(),
							scope: "workflow",
						},
					}
				: undefined,
		},
		error: isSuccess
			? undefined
			: `Background Agent session ended with status: ${finalStatus}`,
	};
}

// =============================================================================
// Batched Shuttle Execution — send all shuttle steps as one combined prompt
// =============================================================================

/**
 * Combine multiple shuttle steps into a single Background Agent prompt.
 * Instead of sending N separate prompts and polling N times, this sends one
 * combined prompt so the agent has full context and produces one PR.
 */
async function executeBatchedShuttleSteps(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	shuttleSteps: TaskStep[],
	updateProgress: (phase: string, message: string, step?: TaskStep) => void,
): Promise<StepExecutionResult> {
	const priorContext =
		(shuttleSteps[0].inputs?.priorContext as string | undefined) || "";
	const prompt = buildShuttlePrompt(
		shuttleSteps.map((step) => step.description),
		priorContext,
	);

	if (!shouldUseBackgroundShuttle(input)) {
		const generalizedProvider =
			getGeneralizedWeaveImplementationProvider(input);
		if (!generalizedProvider) {
			throw new Error("Expected a local or workspace Weave provider");
		}
		const routing = getShuttleRoutingMetadata(shuttleSteps);

		log.info(
			"Shuttle: delegating batched implementation through generalized bridge",
			{
				provider: generalizedProvider,
				stepIds: shuttleSteps.map((step) => step.id),
				weaveExecutionId: input.weaveExecutionId,
				routing,
			},
		);

		updateProgress(
			"executing",
			`Shuttle: delegating ${shuttleSteps.length} implementation task(s) via Fabric Kanban...`,
			shuttleSteps[0],
		);

		try {
			const result = await delegateWeaveImplementationActivity({
				planId:
					input.weavePlanId ??
					String(shuttleSteps[0].inputs?.weavePlanId ?? ""),
				prompt,
				category: routing.category,
				modelOverride: routing.modelOverride,
				executionProvider: generalizedProvider,
				userId: input.userId,
				organizationId: input.organizationId,
				weaveExecutionId: input.weaveExecutionId,
				timeoutMs: SHUTTLE_MAX_DURATION_MS,
			});

			return mapWeaveBridgeResultToStepExecutionResult({
				result,
				provider: generalizedProvider,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			log.error("Shuttle: generalized batched delegation failed", {
				provider: generalizedProvider,
				error: msg,
				stepIds: shuttleSteps.map((step) => step.id),
			});
			return {
				success: false,
				result: { outputs: {} },
				error: `Failed to delegate implementation: ${msg}`,
			};
		}
	}

	const sandboxVar = state.variables["weave.sandboxSessionId"];
	const sessionId =
		typeof sandboxVar?.value === "string" ? sandboxVar.value : null;

	if (!sessionId) {
		log.warn(
			"Batched shuttle steps skipped — no Background Agent session available",
		);
		return {
			success: false,
			result: { outputs: {} },
			error: "No Background Agent session available. Check that BACKGROUND_AGENTS_URL is configured and the project has a repository URL.",
		};
	}

	log.info(
		"Shuttle: sending batched implementation prompt to Background Agent",
		{
			sessionId,
			promptLength: prompt.length,
			stepCount: shuttleSteps.length,
			stepIds: shuttleSteps.map((s) => s.id),
		},
	);

	updateProgress(
		"executing",
		`Shuttle: sending batched implementation request (${shuttleSteps.length} tasks) to Background Agent...`,
		shuttleSteps[0],
	);

	try {
		await sendShuttlePromptActivity({
			sessionId,
			prompt,
			userId: input.userId,
			organizationId: input.organizationId,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log.error("Shuttle: failed to send batched prompt", { error: msg });
		return {
			success: false,
			result: { outputs: {} },
			error: `Failed to send prompt: ${msg}`,
		};
	}

	// Poll for completion — single polling loop for all tasks
	log.info("Shuttle: polling Background Agent for completion (batched)", {
		sessionId,
		taskCount: shuttleSteps.length,
		maxPollMinutes:
			(SHUTTLE_POLL_INTERVAL_SECONDS * SHUTTLE_MAX_POLL_ITERATIONS) / 60,
	});

	let pullRequestUrl: string | null = null;
	let branchName: string | null = null;
	let finalStatus = "active";

	for (let i = 0; i < SHUTTLE_MAX_POLL_ITERATIONS; i++) {
		await sleep(`${SHUTTLE_POLL_INTERVAL_SECONDS} seconds`);

		// Stop polling promptly once the run is cancelled. Cancellation
		// arrives as a signal (`state.cancelled`), NOT Temporal workflow
		// cancellation, so the `sleep` above never throws — without this
		// check the Background Agent keeps running until its session ends on
		// its own and the parent plan stays wedged in RUNNING until the
		// workflow's finally block. Breaking here lets the workflow exit
		// through its cancelled path, which reconciles the execution +
		// restores the plan and tears the session down via the cleanup
		// activity. Gated by `patched()` so pre-patch histories (which
		// polled to completion) still replay deterministically. Patch id is
		// workflow-scoped: never reuse or rename.
		if (state.cancelled && patched("weave-shuttle-cancel-check-v1")) {
			log.info("Shuttle: cancellation observed — stopping poll loop", {
				sessionId,
				pollCount: i + 1,
			});
			finalStatus = "cancelled";
			break;
		}

		try {
			const pollResult = await pollShuttleStatusActivity({ sessionId });
			finalStatus = pollResult.status;

			if (pollResult.pullRequestUrl) {
				pullRequestUrl = pollResult.pullRequestUrl;
				branchName = pollResult.branchName;
				updateProgress(
					"executing",
					`Shuttle: PR created for ${shuttleSteps.length} tasks — ${pullRequestUrl}`,
					shuttleSteps[0],
				);
			}

			if (i % 4 === 0) {
				updateProgress(
					"executing",
					`Shuttle: Background Agent working on ${shuttleSteps.length} tasks...${pullRequestUrl ? ` (PR: ${pullRequestUrl})` : ""} (${Math.round((i * SHUTTLE_POLL_INTERVAL_SECONDS) / 60)}m)`,
					shuttleSteps[0],
				);
			}

			if (pollResult.done) {
				log.info(
					"Shuttle: Background Agent session completed (batched)",
					{
						sessionId,
						status: pollResult.status,
						pullRequestUrl,
						taskCount: shuttleSteps.length,
						pollCount: i + 1,
					},
				);
				break;
			}
		} catch (error) {
			log.warn("Shuttle: poll failed, will retry", {
				error: error instanceof Error ? error.message : String(error),
				pollCount: i + 1,
			});
		}
	}

	// Build result — shared across all shuttle steps
	const isSuccess = finalStatus === "completed" || pullRequestUrl !== null;
	const responseLines: string[] = [];

	if (pullRequestUrl) {
		responseLines.push(`Pull request created: ${pullRequestUrl}`);
	}
	if (branchName) {
		responseLines.push(`Branch: ${branchName}`);
	}
	responseLines.push(
		`Background Agent session status: ${finalStatus} (${shuttleSteps.length} tasks batched)`,
	);

	const response = responseLines.join("\n");

	return {
		success: isSuccess,
		result: {
			response,
			outputs: {
				result: response,
				pullRequestUrl,
				branchName,
				sessionId,
			},
			variables: pullRequestUrl
				? {
						"shuttle.pullRequestUrl": {
							name: "shuttle.pullRequestUrl",
							value: pullRequestUrl,
							setBy: shuttleSteps[0].id,
							setAt: safeNowISO(),
							scope: "workflow",
						},
						"shuttle.branchName": {
							name: "shuttle.branchName",
							value: branchName || "",
							setBy: shuttleSteps[0].id,
							setAt: safeNowISO(),
							scope: "workflow",
						},
					}
				: undefined,
		},
		error: isSuccess
			? undefined
			: `Background Agent session ended with status: ${finalStatus}`,
	};
}

// =============================================================================
// Affected Items Extraction (for approval UI)
// =============================================================================

function extractAffectedItemsFromContext(
	state: WorkflowState,
	currentStep: TaskStep,
): Array<{
	id: string;
	name: string;
	type: string;
	metadata?: Record<string, unknown>;
}> {
	const affectedItems: Array<{
		id: string;
		name: string;
		type: string;
		metadata?: Record<string, unknown>;
	}> = [];

	const destructiveKeywords = ["delete", "remove", "archive", "clear"];
	const isDestructive = destructiveKeywords.some((kw) =>
		currentStep.description.toLowerCase().includes(kw),
	);

	if (!isDestructive) {
		return affectedItems;
	}

	const previousResults = state.stepResults;
	if (previousResults.length === 0) {
		return affectedItems;
	}

	for (
		let i = previousResults.length - 1;
		i >= Math.max(0, previousResults.length - 3);
		i--
	) {
		const result = previousResults[i];

		for (const toolCall of result.toolCalls || []) {
			if (toolCall.status !== "success" || !toolCall.result) {
				continue;
			}

			const items = extractItemsFromResult(
				toolCall.result,
				toolCall.name,
			);
			if (items.length > 0) {
				affectedItems.push(...items);
			}
		}

		if (affectedItems.length > 0) {
			break;
		}
	}

	return affectedItems;
}

function extractItemsFromResult(
	result: unknown,
	toolName: string,
): Array<{
	id: string;
	name: string;
	type: string;
	metadata?: Record<string, unknown>;
}> {
	const items: Array<{
		id: string;
		name: string;
		type: string;
		metadata?: Record<string, unknown>;
	}> = [];

	let itemType = "item";
	const typePatterns = [
		{ pattern: /board/i, type: "board" },
		{ pattern: /card/i, type: "card" },
		{ pattern: /task/i, type: "task" },
		{ pattern: /file/i, type: "file" },
		{ pattern: /document/i, type: "document" },
		{ pattern: /project/i, type: "project" },
		{ pattern: /issue/i, type: "issue" },
		{ pattern: /ticket/i, type: "ticket" },
		{ pattern: /record/i, type: "record" },
	];

	for (const { pattern, type } of typePatterns) {
		if (pattern.test(toolName)) {
			itemType = type;
			break;
		}
	}

	if (Array.isArray(result)) {
		for (const item of result) {
			if (typeof item === "object" && item !== null) {
				const extracted = extractSingleItem(
					item as Record<string, unknown>,
					itemType,
				);
				if (extracted) {
					items.push(extracted);
				}
			}
		}
		return items;
	}

	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		const listProperties = [
			"boards",
			"cards",
			"tasks",
			"files",
			"items",
			"data",
			"results",
			"records",
			"list",
		];
		for (const prop of listProperties) {
			if (Array.isArray(obj[prop])) {
				for (const item of obj[prop] as unknown[]) {
					if (typeof item === "object" && item !== null) {
						const extracted = extractSingleItem(
							item as Record<string, unknown>,
							itemType,
						);
						if (extracted) {
							items.push(extracted);
						}
					}
				}
				if (items.length > 0) {
					return items;
				}
			}
		}
	}

	return items;
}

function extractSingleItem(
	obj: Record<string, unknown>,
	itemType: string,
): {
	id: string;
	name: string;
	type: string;
	metadata?: Record<string, unknown>;
} | null {
	const idFields = [
		"id",
		"_id",
		"uuid",
		"key",
		"boardId",
		"cardId",
		"taskId",
		"fileId",
		"documentId",
		"projectId",
		"workspaceId",
		"channelId",
		"issueId",
	];
	const nameFields = [
		"name",
		"title",
		"displayName",
		"label",
		"subject",
		"filename",
		"boardName",
		"cardName",
		"taskName",
		"projectName",
		"heading",
	];

	let id: string | undefined;
	let name: string | undefined;

	for (const field of idFields) {
		if (obj[field] !== undefined && obj[field] !== null) {
			id = String(obj[field]);
			break;
		}
	}

	for (const field of nameFields) {
		if (obj[field] !== undefined && obj[field] !== null) {
			name = String(obj[field]);
			break;
		}
	}

	if (!name && id) {
		name = `${itemType} ${id}`;
	}

	if (!id) {
		return null;
	}

	const metadata: Record<string, unknown> = {};

	const coreFields = [
		"status",
		"state",
		"priority",
		"severity",
		"createdAt",
		"updatedAt",
		"dueDate",
		"completedAt",
	];
	for (const field of coreFields) {
		if (obj[field] !== undefined && obj[field] !== null) {
			metadata[field] = obj[field];
		}
	}

	const descriptionFields = [
		"description",
		"body",
		"content",
		"summary",
		"notes",
	];
	for (const field of descriptionFields) {
		if (
			typeof obj[field] === "string" &&
			(obj[field] as string).length > 0
		) {
			const desc = obj[field] as string;
			metadata.description =
				desc.length > 200 ? `${desc.slice(0, 200)}...` : desc;
			break;
		}
	}

	const urlFields = ["url", "link", "href", "webUrl", "htmlUrl"];
	for (const field of urlFields) {
		if (
			typeof obj[field] === "string" &&
			(obj[field] as string).length > 0
		) {
			metadata.url = obj[field];
			break;
		}
	}

	const ownerFields = ["owner", "assignee", "creator", "author", "user"];
	for (const field of ownerFields) {
		const value = obj[field];
		if (value !== undefined && value !== null) {
			if (typeof value === "object" && value !== null) {
				const ownerObj = value as Record<string, unknown>;
				if (ownerObj.name || ownerObj.displayName || ownerObj.email) {
					metadata.owner =
						ownerObj.name || ownerObj.displayName || ownerObj.email;
					break;
				}
			}
			if (typeof value === "string") {
				metadata.owner = value;
				break;
			}
		}
	}

	const tagFields = ["tags", "labels", "categories"];
	for (const field of tagFields) {
		if (Array.isArray(obj[field]) && (obj[field] as unknown[]).length > 0) {
			const tags = (obj[field] as unknown[]).map((tag) => {
				if (typeof tag === "string") {
					return tag;
				}
				if (typeof tag === "object" && tag !== null) {
					const tagObj = tag as Record<string, unknown>;
					return (
						tagObj.name ||
						tagObj.label ||
						tagObj.title ||
						String(tag)
					);
				}
				return String(tag);
			});
			metadata.tags = tags.slice(0, 5);
			break;
		}
	}

	const countFields = [
		"cardCount",
		"taskCount",
		"itemCount",
		"count",
		"total",
	];
	for (const field of countFields) {
		if (typeof obj[field] === "number") {
			metadata.childCount = obj[field];
			break;
		}
	}

	return {
		id,
		name: name || `${itemType} ${id}`,
		type: itemType,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

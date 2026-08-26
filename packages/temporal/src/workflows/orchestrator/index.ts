/**
 * Orchestrator Workflow - Modular Implementation
 *
 * A durable, extensible multi-agent orchestration workflow that provides:
 * - Task decomposition and planning
 * - Multi-agent routing and execution
 * - HITL approval for high-risk operations
 * - Cross-agent variable management
 * - Full context propagation between steps
 * - Trajectory capture for reuse
 * - Policy enforcement
 *
 * This is the refactored modular version that splits the monolithic
 * workflow into phases for better maintainability and code organization.
 */

import {
	CancellationScope,
	condition,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";

import type * as allActivities from "../../activities";
import type * as orchestratorActivities from "../../activities/orchestrator";
import {
	buildWorkflowOutput,
	executeCompletionPhase,
	executeExecutionPhase,
	executeInitializationPhase,
	executeIterativePhase,
	executePlanningPhase,
} from "./phases";
import {
	type AgentVariable,
	type ApprovalSignalData,
	type ClarificationDecision,
	createInitialState,
	DEFAULT_ALTK_CONFIG,
	EXECUTION_MODE_CONFIGS,
	type OrchestratorWorkflowInput,
	type OrchestratorWorkflowOutput,
	type PendingApprovalInfo,
	type PendingClarificationInfo,
	type PendingModification,
	type TaskPlan,
	type WorkflowState,
} from "./types";

// =============================================================================
// Signals
// =============================================================================

export const approvalSignal = defineSignal<[ApprovalSignalData]>("approval");
export const autoApproveAllSignal = defineSignal("autoApproveAll");
export const revokeAutoApproveSignal = defineSignal("revokeAutoApprove");
export const retryFromStepSignal =
	defineSignal<[{ stepId: string }]>("retryFromStep");
export const cancelSignal = defineSignal("cancel");
export const updateVariableSignal =
	defineSignal<[{ name: string; value: unknown }]>("updateVariable");
export const followUpSignal =
	defineSignal<
		[
			{
				message: string;
				isModification: boolean;
			},
		]
	>("followUp");
/** The user's answer to a pending clarifying question (HITL sibling of approval). */
export const clarificationSignal =
	defineSignal<[ClarificationDecision]>("clarification");

// =============================================================================
// Queries
// =============================================================================

export const progressQuery =
	defineQuery<WorkflowState["currentProgress"]>("progress");
export const planQuery = defineQuery<TaskPlan | null>("plan");
export const variablesQuery =
	defineQuery<Record<string, AgentVariable>>("variables");
export const statusQuery = defineQuery<WorkflowState["status"]>("status");
export const pendingApprovalQuery = defineQuery<PendingApprovalInfo | null>(
	"pendingApproval",
);
export const pendingClarificationQuery =
	defineQuery<PendingClarificationInfo | null>("pendingClarification");
export const journeyStateQuery = defineQuery<{
	journeyId: string;
	phase: string;
	turnCount: number;
	decisions: Array<{ category: string; decision: string; reasoning: string }>;
	assumptions: Array<{ description: string; isValid?: boolean }>;
	blockers: Array<{ description: string; resolved: boolean }>;
	modifications: Array<{
		type: string;
		description: string;
		timestamp: string;
	}>;
} | null>("journeyState");
export const pendingModificationQuery = defineQuery<PendingModification | null>(
	"pendingModification",
);

// =============================================================================
// Long-Running Activities (for trajectory replay)
// =============================================================================

const longRunningActivities = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "30s",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

// Quick LLM intent-clarity check (HITL clarifying question before planning).
// Short timeout + few retries — it is fail-safe (returns "no clarification" on
// error), so it must never stall the orchestration.
const { analyzeIntentClarityActivity } = proxyActivities<
	typeof orchestratorActivities
>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "10s",
		maximumAttempts: 2,
	},
});

// Session lifecycle cleanup. Runs from the workflow's finally block
// inside `CancellationScope.nonCancellable` so it fires on every exit
// path — including cancel, timeout, and exception.
const { cleanupWeaveResourcesActivity } = proxyActivities<typeof allActivities>(
	{
		startToCloseTimeout: "2 minutes",
		retry: {
			initialInterval: "1s",
			backoffCoefficient: 2,
			maximumInterval: "10s",
			maximumAttempts: 3,
		},
	},
);

// =============================================================================
// Workflow Implementation
// =============================================================================

/**
 * Orchestrator Execution Workflow
 *
 * This workflow orchestrates multi-agent task execution with full context
 * propagation between steps, following industry best practices.
 *
 * Refactored into modular phases for better maintainability:
 * - Initialization: Memory setup, workspace context
 * - Planning: Routing, plan creation, validation, approval
 * - Execution: Step execution with full context propagation
 * - Completion: Trajectory saving, memory recording
 */
export async function orchestratorExecutionWorkflow(
	input: OrchestratorWorkflowInput,
): Promise<OrchestratorWorkflowOutput> {
	// Initialize workflow state — restore from continueAsNew carry-forward if present
	const state = createInitialState(input);
	const isResuming = !!input.resumeState;
	if (input.resumeState) {
		// Issue #6: Restore the full set of state fields from continueAsNew
		Object.assign(state, input.resumeState);
		log.info("Resumed from continueAsNew — skipping initialization", {
			executionId: state.executionId,
			hasPreloadedResources: !!state.preloadedResources,
			hasEnrichedPrompt: !!state.enrichedSystemPrompt,
			circuitBreakerAgents: Object.keys(state.agentCircuitBreakers)
				.length,
		});
	}
	const { executionId } = state;

	// Get execution mode config
	const modeConfig =
		EXECUTION_MODE_CONFIGS[input.executionMode] ||
		EXECUTION_MODE_CONFIGS.balanced;
	const altkConfig = input.altkConfig || DEFAULT_ALTK_CONFIG;

	// ==========================================================================
	// Signal Handlers
	// ==========================================================================

	setHandler(approvalSignal, (data) => {
		log.info("Received approval signal", {
			approved: data.approved,
			feedback: data.feedback,
		});
		state.approvalDecision = data;
	});

	setHandler(autoApproveAllSignal, () => {
		log.info(
			"Received auto-approve-all signal — all future checkpoints will be auto-approved",
		);
		state.autoApproveAll = true;
		// Also approve the current pending checkpoint if any
		if (state.pendingApproval && !state.approvalDecision) {
			state.approvalDecision = {
				approved: true,
				feedback: "Auto-approved (approve all)",
			};
		}
	});

	setHandler(revokeAutoApproveSignal, () => {
		log.info(
			"Received revoke-auto-approve signal — future checkpoints will require human review again",
		);
		state.autoApproveAll = false;
	});

	setHandler(retryFromStepSignal, (data) => {
		log.info("Received retry-from-step signal", { stepId: data.stepId });
		if (state.taskPlan) {
			const target = state.taskPlan.steps.find(
				(s) => s.id === data.stepId,
			);
			if (target) {
				// Reset the failed step and all subsequent steps to pending
				let found = false;
				for (const step of state.taskPlan.steps) {
					if (step.id === data.stepId) {
						found = true;
					}
					if (
						found &&
						(step.status === "error" || step.status === "skipped")
					) {
						step.status = "pending";
					}
				}
				// Remove step results for re-executed steps
				state.stepResults = state.stepResults.filter((r) => {
					const step = state.taskPlan?.steps.find(
						(s) => s.id === r.stepId,
					);
					return step?.status !== "pending";
				});
			}
		}
	});

	setHandler(cancelSignal, () => {
		log.info("Received cancel signal");
		state.cancelled = true;
	});

	setHandler(updateVariableSignal, (data) => {
		log.info("Received variable update", {
			name: data.name,
			value: data.value,
		});
		if (!data.name.startsWith("sys.")) {
			state.variables[data.name] = {
				name: data.name,
				value: data.value,
				setBy: "signal",
				setAt: new Date().toISOString(),
				scope: "workflow",
			};
		}
	});

	setHandler(followUpSignal, (data) => {
		log.info("Received follow-up signal", {
			message: data.message.slice(0, 100),
			isModification: data.isModification,
		});

		state.followUpMessages.push({
			message: data.message,
			isModification: data.isModification,
			receivedAt: new Date().toISOString(),
		});

		state.journeyState.conversationHistory.push({
			role: "user",
			content: data.message,
			timestamp: new Date().toISOString(),
		});
		state.journeyState.turnCount++;
	});

	setHandler(clarificationSignal, (data) => {
		log.info("Received clarification signal", {
			answerPreview: data.answer?.slice(0, 100),
			dismissed: !!data.dismissed,
		});
		state.clarificationDecision = data;
	});

	// ==========================================================================
	// Query Handlers
	// ==========================================================================

	setHandler(progressQuery, () => state.currentProgress);
	setHandler(planQuery, () => state.taskPlan);
	setHandler(variablesQuery, () => state.variables);
	setHandler(statusQuery, () => state.status);
	setHandler(pendingApprovalQuery, () => state.pendingApproval);
	setHandler(pendingClarificationQuery, () => state.pendingClarification);
	setHandler(journeyStateQuery, () => ({
		journeyId: state.journeyState.journeyId,
		phase: state.journeyState.phase,
		turnCount: state.journeyState.turnCount,
		decisions: state.journeyState.decisions,
		assumptions: state.journeyState.assumptions,
		blockers: state.journeyState.blockers,
		modifications: state.journeyState.modifications,
	}));
	setHandler(pendingModificationQuery, () => state.pendingModification);

	// ==========================================================================
	// Helper Functions
	// ==========================================================================

	function updateProgress(
		phase: string,
		message: string,
		currentStep?: unknown,
	) {
		state.currentProgress = {
			executionId,
			currentStep: currentStep as any,
			completedSteps:
				state.taskPlan?.steps.filter((s) => s.status === "complete")
					.length || 0,
			totalSteps: state.taskPlan?.steps.length || 0,
			phase: phase as any,
			message,
			timestamp: new Date().toISOString(),
			stepResults: [...state.stepResults],
		};
		state.journeyState.phase = phase;
	}

	async function waitForApproval(): Promise<ApprovalSignalData | null> {
		// Skip approval entirely when auto-approve-all is active
		if (state.autoApproveAll) {
			log.info("Auto-approving checkpoint (approve-all active)");
			return { approved: true, feedback: "Auto-approved (approve all)" };
		}

		await condition(
			() => state.approvalDecision !== null || state.cancelled,
			modeConfig.workflowTimeoutMs,
		);

		if (state.cancelled) {
			return null;
		}

		const decision = state.approvalDecision;
		state.approvalDecision = null;
		return decision;
	}

	/**
	 * Block until the user answers the pending clarifying question (via the
	 * `clarification` signal) or the workflow is cancelled. HITL sibling of
	 * waitForApproval. The caller sets `state.pendingClarification` before
	 * calling and clears it afterward.
	 */
	async function waitForClarification(): Promise<ClarificationDecision | null> {
		await condition(
			() => state.clarificationDecision !== null || state.cancelled,
			modeConfig.workflowTimeoutMs,
		);

		if (state.cancelled) {
			return null;
		}

		const decision = state.clarificationDecision;
		state.clarificationDecision = null;
		return decision;
	}

	function isCancelled(): boolean {
		return state.cancelled;
	}

	// ==========================================================================
	// Main Execution Flow
	// ==========================================================================

	// `Date.now()` is replay-safe under SDK 1.16 + reuseV8Context (no
	// `unsafe.now()` allowed). Captured once at top so every exit path
	// (including the finally) reports the same total duration.
	const workflowStartedAtMs = Date.now();
	// Set to the actual exit reason at each early-return site below; if
	// nothing assigns it the body threw and the catch / finally fall back
	// to "exception".
	let exitReason:
		| "success"
		| "failure"
		| "cancelled"
		| "timeout"
		| "exception"
		| "oauth_blocked" = "exception";
	// Captured alongside exitReason at each failure site (plain local
	// assignment — deterministic, replay-safe) so the cleanup activity in
	// the finally block can persist the failure message onto the
	// WeaveExecution row.
	let exitErrorMessage: string | undefined;

	try {
		log.info("Starting orchestrator workflow", {
			executionId,
			userId: input.userId,
			mode: input.executionMode,
		});

		// Issue #2182 defense-in-depth: the web routes now union
		// prioritized MCP config ids into the enabled set, but older
		// clients can still send a prioritized id absent from a non-null
		// enabled list — the planner is then biased toward a server whose
		// tools the ToolIndex excludes as "config not enabled".
		if (
			Array.isArray(input.enabledMcpConfigIds) &&
			Array.isArray(input.prioritizedMcpConfigIds)
		) {
			const enabledSet = new Set(input.enabledMcpConfigIds);
			const inertPrioritizedIds = input.prioritizedMcpConfigIds.filter(
				(id) => !enabledSet.has(id),
			);
			if (inertPrioritizedIds.length > 0) {
				log.warn(
					"Prioritized MCP configs missing from enabled set — their tools will be excluded from the tool index",
					{ inertPrioritizedIds },
				);
			}
		}

		// Check for cancellation
		if (state.cancelled) {
			state.status = "cancelled";
			exitReason = "cancelled";
			return buildWorkflowOutput(
				state,
				"cancelled",
				"Execution cancelled by user",
			);
		}

		// ======================================================================
		// Phase 1: Initialization (skipped on continueAsNew resume — Issue #6)
		// ======================================================================
		if (!isResuming) {
			const initResult = await executeInitializationPhase(
				state,
				input,
				updateProgress,
			);

			if (!initResult.success || !initResult.shouldContinue) {
				state.status = "failed";
				exitReason = "failure";
				exitErrorMessage = initResult.error;
				return buildWorkflowOutput(state, "failed", initResult.error);
			}

			// Update state with initialization results
			// biome-ignore lint/style/noNonNullAssertion: initResult.success guarantees data is defined
			state.workspaceContext = initResult.data!.workspaceContext;
			// biome-ignore lint/style/noNonNullAssertion: initResult.success guarantees data is defined
			state.lettaAgentId = initResult.data!.lettaAgentId;
			// biome-ignore lint/style/noNonNullAssertion: initResult.success guarantees data is defined
			state.enrichedMessage = initResult.data!.enrichedMessage;
			// biome-ignore lint/style/noNonNullAssertion: initResult.success guarantees data is defined
			state.enrichedSystemPrompt = initResult.data!.enrichedSystemPrompt;
		}

		// ======================================================================
		// Up-front intent clarification (HITL). Before committing to an
		// (expensive) multi-agent plan, ask ONE clarifying question when the
		// request is materially ambiguous. Fail-safe (the activity never throws)
		// and replay-safe (the pause mirrors waitForApproval; the synthetic id is
		// derived from the stable executionId). The answer is folded into the
		// enriched message so planning uses it. Skipped on continueAsNew resume.
		//
		// Scoped to the standalone Loom Orchestrator chat
		// (`surface === "loom-orchestrator"`) — a SINGLE-execution surface that
		// renders the clarifying card. It must NOT fire on Nexus, which runs one
		// orchestrator execution PER selected agent (`useMultiAgentStream`):
		// per-agent clarification would surface N competing cards and, without a
		// card renderer there, would hang the run. `input.surface` is immutable
		// per execution, so gating on it stays deterministic across replays.
		//
		// `patched()` is REQUIRED: this block adds a new activity call + a
		// `condition()` pause to the workflow's command stream. In-flight
		// executions started under the prior worker never recorded those
		// commands, so replaying them on the new code without the gate throws a
		// non-determinism error. The marker makes old histories skip the block
		// (false) while new executions run it (true). Called FIRST (before the
		// surface check) so the marker is recorded identically on every run
		// regardless of surface (matches the `pm-flag-missing-producer-v1`
		// convention).
		// ======================================================================
		const upfrontClarificationEnabled =
			patched("orchestrator-upfront-clarification-v1") &&
			input.surface === "loom-orchestrator";
		if (upfrontClarificationEnabled && !isResuming && !state.cancelled) {
			const clarity = await analyzeIntentClarityActivity({
				message: state.enrichedMessage || input.message,
				userId: input.userId,
				organizationId: input.organizationId,
			});
			if (
				clarity.needsClarification &&
				clarity.question &&
				!state.cancelled
			) {
				log.info("Up-front clarifying question raised", {
					executionId,
					optionCount: clarity.options?.length || 0,
				});
				state.pendingClarification = {
					clarificationId: `clarify-upfront-${executionId}`,
					question: clarity.question,
					options: clarity.options,
				};
				updateProgress(
					"planning",
					"Waiting for your answer to a clarifying question…",
				);
				const decision = await waitForClarification();
				state.pendingClarification = null;
				if (decision && !decision.dismissed && decision.answer) {
					const note = `\n\n[User clarification — ${clarity.question} → ${decision.answer}]`;
					state.enrichedMessage =
						(state.enrichedMessage || input.message) + note;
					state.journeyState.conversationHistory.push({
						role: "user",
						content: `Clarification — ${clarity.question}: ${decision.answer}`,
						timestamp: new Date().toISOString(),
					});
					state.journeyState.turnCount++;
				}
			}
		}

		// ======================================================================
		// ITERATIVE EXECUTION: Use agent loop for most modes.
		// save_reuse requires upfront planning for trajectory replay.
		// weave requires upfront planning to load WeavePlan checkboxes,
		// execute steps in waves with Loom routing, and propagate Tapestry context.
		// ======================================================================
		const useIterativeExecution =
			input.executionMode !== "save_reuse" &&
			input.executionMode !== "weave";

		if (useIterativeExecution) {
			log.info("Using iterative execution mode", {
				executionId,
				requestedMode: input.executionMode,
				maxIterations: modeConfig.maxIterations || 15,
				maxTotalTokens: modeConfig.maxTotalTokens || 100000,
			});

			const iterativeResult = await executeIterativePhase(
				state,
				input,
				modeConfig,
				altkConfig,
				updateProgress,
				waitForApproval,
				isCancelled,
			);

			if (!iterativeResult.success) {
				if (state.cancelled) {
					state.status = "cancelled";
					exitReason = "cancelled";
					return buildWorkflowOutput(
						state,
						"cancelled",
						"Execution cancelled",
					);
				}
				state.status = "failed";
				exitReason = "failure";
				exitErrorMessage = iterativeResult.error;
				return buildWorkflowOutput(
					state,
					"failed",
					iterativeResult.error,
				);
			}

			const finalResponse = iterativeResult.data?.finalResponse || "";

			// Run completion phase for iterative mode (fire-and-forget child workflow)
			await executeCompletionPhase(
				state,
				input,
				modeConfig,
				altkConfig,
				finalResponse,
				updateProgress,
			);

			state.status = "completed";
			updateProgress("complete", "Execution completed successfully");
			exitReason = "success";

			return buildWorkflowOutput(
				state,
				"completed",
				undefined,
				finalResponse,
			);
		}

		// ======================================================================
		// UPFRONT MODE: Phase 2 - Planning (skipped on continueAsNew resume)
		// ======================================================================
		if (!isResuming) {
			const planResult = await executePlanningPhase(
				state,
				input,
				modeConfig,
				updateProgress,
				waitForApproval,
			);

			if (!planResult.success) {
				state.status = "failed";
				exitReason = "failure";
				exitErrorMessage = planResult.error;
				return buildWorkflowOutput(state, "failed", planResult.error);
			}

			// Check for trajectory replay
			if (
				planResult.data?.replayTrajectory &&
				!planResult.shouldContinue
			) {
				exitReason = "success";
				return await replayTrajectory(
					state,
					input,
					planResult.data.replayTrajectory,
				);
			}

			// Update state with planning results
			// biome-ignore lint/style/noNonNullAssertion: planResult.success guarantees data is defined
			state.taskPlan = planResult.data!.taskPlan;
			// biome-ignore lint/style/noNonNullAssertion: planResult.success guarantees data is defined
			state.routingDecision = planResult.data!.routingDecision;
		} else {
			log.info("Resumed from continueAsNew — skipping planning phase", {
				executionId: state.executionId,
				taskPlanSteps: state.taskPlan?.steps?.length ?? 0,
				completedSteps: state.stepResults?.length ?? 0,
			});
		}

		// ======================================================================
		// UPFRONT MODE: Per-step intent clarification (HITL). After planning,
		// before execution, ask ONE clarifying question for each plan step whose
		// intent is materially ambiguous — the answer is folded into that step's
		// instruction so it executes correctly. Sibling of the up-front (pre-planning)
		// clarification: same fail-safe activity, same pause machinery, same card
		// (stepId-scoped; the frontend already renders pendingClarification with a
		// stepId). Only the upfront-planning modes (save_reuse / weave) reach here
		// — iterative modes returned above, where the agent asks inline instead.
		//
		// Replay/cost notes:
		//   • `patched()` REQUIRED (adds activity calls + condition() pauses to the
		//     command stream) — called FIRST so the marker records uniformly even
		//     when the surface check is false. In-flight pre-patch executions skip
		//     the whole block and replay deterministically.
		//   • Scoped to the Loom surface; skipped on continueAsNew resume (steps
		//     were already clarified on the first run, with answers carried in the
		//     plan).
		//   • Clarity checks run in PARALLEL (each independently fail-safe, never
		//     throws/blocks) so latency is one round-trip, not N; only genuinely
		//     ambiguous steps then pause serially. Each check sees the up-front
		//     answer via `enrichedMessage`, so it won't re-ask what was settled.
		// ======================================================================
		const perStepClarificationEnabled =
			patched("orchestrator-per-step-clarification-v1") &&
			input.surface === "loom-orchestrator";
		if (
			perStepClarificationEnabled &&
			!isResuming &&
			!state.cancelled &&
			state.taskPlan?.steps &&
			state.taskPlan.steps.length > 0
		) {
			const steps = state.taskPlan.steps;
			const clarities = await Promise.all(
				steps.map(async (step) => {
					try {
						return await analyzeIntentClarityActivity({
							message: step.description,
							conversationSummary:
								state.enrichedMessage || input.message,
							userId: input.userId,
							organizationId: input.organizationId,
						});
					} catch {
						// Fail-open: a clarity-check failure must never block or
						// fail the run. (The activity is already fail-safe; this
						// also catches a proxy-level activity timeout.)
						return { needsClarification: false as const };
					}
				}),
			);
			for (let i = 0; i < steps.length; i++) {
				if (state.cancelled) {
					break;
				}
				const clarity = clarities[i];
				const step = steps[i];
				if (!clarity?.needsClarification || !clarity.question) {
					continue;
				}
				log.info("Per-step clarifying question raised", {
					executionId,
					stepId: step.id,
					optionCount: clarity.options?.length || 0,
				});
				state.pendingClarification = {
					clarificationId: `clarify-step-${step.id}`,
					stepId: step.id,
					question: clarity.question,
					options: clarity.options,
				};
				updateProgress(
					"planning",
					`Waiting for your answer about: ${step.description}`,
				);
				const decision = await waitForClarification();
				state.pendingClarification = null;
				if (decision && !decision.dismissed && decision.answer) {
					// Record in the journey transcript first (with the original
					// step text), then fold the answer into the step's
					// instruction so its executor acts on it. Appending to
					// `description` is the channel every handler type tolerates:
					// agent handlers build their prompt from it; tool/MCP
					// handlers act on `inputs` and simply ignore the extra note
					// (no spurious tool args). Low pollution risk — the
					// description is an instruction, not a literal output.
					state.journeyState.conversationHistory.push({
						role: "user",
						content: `Clarification for step "${step.description}" — ${clarity.question}: ${decision.answer}`,
						timestamp: new Date().toISOString(),
					});
					state.journeyState.turnCount++;
					step.description = `${step.description}\n\nUser clarification — ${clarity.question}: ${decision.answer}`;
				}
			}
		}

		// ======================================================================
		// UPFRONT MODE: Phase 3 - Execution
		// ======================================================================
		const execResult = await executeExecutionPhase(
			state,
			input,
			modeConfig,
			altkConfig,
			updateProgress,
			waitForApproval,
			isCancelled,
		);

		// Handle auth required case - workflow pauses waiting for user authorization
		const execData = execResult.data as
			| {
					finalResponse: string;
					authRequired?: { configId: string; serverName: string };
			  }
			| undefined;

		if (execData?.authRequired) {
			log.info("Workflow paused - OAuth authorization required", {
				configId: execData.authRequired.configId,
				serverName: execData.authRequired.serverName,
			});
			state.status = "awaiting_approval"; // Use existing status for consistency
			exitReason = "oauth_blocked";

			return {
				executionId: state.executionId,
				status: "awaiting_auth",
				response: execData.finalResponse,
				taskPlan: state.taskPlan ?? undefined,
				routingDecision: state.routingDecision ?? undefined,
				toolCalls: state.toolCalls,
				variables: state.variables,
				totalDurationMs: Date.now() - state.startTime,
				stepResults: state.stepResults,
				blockedOnAuth: {
					configId: execData.authRequired.configId,
					serverName: execData.authRequired.serverName,
					stepId: state.currentProgress?.currentStep?.id,
				},
			};
		}

		if (!execResult.success && !execData) {
			if (state.cancelled) {
				state.status = "cancelled";
				exitReason = "cancelled";
				return buildWorkflowOutput(
					state,
					"cancelled",
					"Execution cancelled",
				);
			}
			state.status = "failed";
			exitReason = "failure";
			exitErrorMessage = execResult.error;
			return buildWorkflowOutput(state, "failed", execResult.error);
		}

		const finalResponse = execData?.finalResponse || "";

		// ======================================================================
		// Phase 4: Completion
		// ======================================================================
		// Run completion phase (fire-and-forget child workflow)
		await executeCompletionPhase(
			state,
			input,
			modeConfig,
			altkConfig,
			finalResponse,
			updateProgress,
		);

		// ======================================================================
		// Build Final Output
		// ======================================================================
		state.status = "completed";
		updateProgress("complete", "Execution completed successfully");
		exitReason = "success";

		return buildWorkflowOutput(
			state,
			"completed",
			undefined,
			finalResponse,
		);
	} catch (error) {
		state.status = "failed";
		// `exitReason` stays `"exception"` (its default) for unhandled
		// throws — gives operators a visible signal in the audit log
		// distinct from the deliberate `"failure"` returns.
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		exitErrorMessage = errorMessage;
		log.error("Orchestrator workflow failed", { error: errorMessage });
		return buildWorkflowOutput(state, "failed", errorMessage);
	} finally {
		// Only Weave-mode runs create a Background Agent sandbox — every
		// other executionMode (direct-chat, code-gen, retrieval, etc.)
		// would just emit an empty `terminated_on_exit` audit row, which
		// is pure noise at scale. Gate the cleanup activity on the mode
		// that actually owns a session.
		// `patched()` is required because the cleanup activity was added in
		// PR #1243 — pre-#1243 histories don't have the ActivityTaskScheduled
		// event in this position, so replaying them under post-#1243 code
		// produces a nondeterminism error
		// ("Activity machine does not handle this event:
		// HistoryEvent(id: N, WorkflowExecutionCompleted)"). The patch
		// marker is recorded in NEW histories only — pre-#1243 histories
		// replay deterministically by skipping the cleanup branch, while
		// new runs always execute it. Patch id is intentionally workflow-
		// scoped: never reuse or rename.
		if (
			input.executionMode === "weave" &&
			patched("weave-cleanup-on-exit-v1")
		) {
			// Always tear down the Weave control-plane session. Wrapped in
			// `CancellationScope.nonCancellable` so the activity still
			// runs when the workflow itself was cancelled — Temporal
			// otherwise rejects new activity calls in a cancelled scope.
			const sandboxSessionId =
				(state.variables["weave.sandboxSessionId"]?.value as
					| string
					| null
					| undefined) ?? null;
			await CancellationScope.nonCancellable(async () => {
				await cleanupWeaveResourcesActivity({
					sessionId: sandboxSessionId,
					provider:
						input.weaveImplementationProvider ??
						"BACKGROUND_AGENTS",
					userId: input.userId,
					organizationId: input.organizationId ?? null,
					weaveExecutionId: input.weaveExecutionId ?? null,
					exitReason,
					errorMessage: exitErrorMessage ?? null,
					workflowId: workflowInfo().workflowId,
					runDurationMs: Date.now() - workflowStartedAtMs,
				});
			});
		}
	}
}

/**
 * Replay a saved trajectory
 */
async function replayTrajectory(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	trajectory: any,
): Promise<OrchestratorWorkflowOutput> {
	log.info("Replaying trajectory", { trajectoryId: trajectory.id });

	const replayToolCalls: OrchestratorWorkflowOutput["toolCalls"] = [];
	let replayResponse = "";

	for (const step of trajectory.steps) {
		if (state.cancelled) {
			return buildWorkflowOutput(
				state,
				"cancelled",
				"Execution cancelled",
			);
		}

		try {
			const result = await longRunningActivities.executeMcpTool({
				toolName: step.toolName || "unknown",
				args: step.input as Record<string, unknown>,
				userId: input.userId,
				organizationId: input.organizationId,
				projectId: input.projectId,
			});

			replayToolCalls.push({
				id: `replay-${step.stepId}`,
				name: step.toolName || "unknown",
				args: step.input,
				result: result.output,
				status: "success",
				durationMs: result.durationMs,
			});

			if (typeof result.output === "string") {
				replayResponse += `${result.output}\n`;
			}
		} catch (error) {
			log.warn("Trajectory replay step failed, continuing", {
				stepId: step.stepId,
				error: error instanceof Error ? error.message : "Unknown",
			});
		}
	}

	return {
		executionId: state.executionId,
		status: "completed",
		response: replayResponse.trim() || "Trajectory replayed successfully",
		toolCalls: replayToolCalls,
		variables: state.variables,
		trajectory,
		totalDurationMs: Date.now() - state.startTime,
	};
}

export * from "./context-manager";
export * from "./orchestrator-config";
export * from "./risk-assessment";
// Re-export types and utilities
export * from "./types";

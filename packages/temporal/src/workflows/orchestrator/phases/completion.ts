/**
 * Completion Phase
 *
 * Handles workflow completion including:
 * - Final reflection
 * - Recording execution patterns in Letta memory
 * - Storing execution in Qdrant semantic memory
 * - Saving trajectory for reuse
 * - Building final output
 */

import {
	CancellationScope,
	log,
	ParentClosePolicy,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as orchestratorActivities from "../../../activities/orchestrator";
import type * as orchestratorMemoryActivities from "../../../activities/orchestrator-memory";
import type * as postOperationResultModule from "../../../activities/post-operation-result";
import type * as weaveActivities from "../../../activities/weave";

const { destroySandboxActivity, updateWeaveExecutionActivity } =
	proxyActivities<typeof weaveActivities>({
		startToCloseTimeout: "1 minute",
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "1s",
			backoffCoefficient: 2,
			maximumAttempts: 3,
		},
	});

import { BUDGET, OUTPUT } from "../orchestrator-config";
import type {
	ALTKConfig,
	ExecutionModeConfig,
	IterativeMessage,
	OrchestratorStepResult,
	OrchestratorWorkflowInput,
	OrchestratorWorkflowOutput,
	PhaseResult,
	TrajectoryStep,
	WorkflowState,
} from "../types";

// =============================================================================
// Completion Child Workflow Input
// =============================================================================

/**
 * Serializable input for the completion child workflow.
 * Contains only the data the completion activities need, extracted from
 * WorkflowState + OrchestratorWorkflowInput.
 */
export interface CompletionWorkflowInput {
	executionId: string;
	userId: string;
	organizationId?: string;
	message: string;
	finalResponse: string;
	executionMode: string;
	conversationId?: string;
	projectId?: string;
	workspaceIds?: string[];
	startTime: number;
	lettaAgentId: string | null;
	// Serialized execution data
	taskPlanSteps: Array<{
		id: string;
		description: string;
		status: string;
		executor?: string;
	}>;
	trajectorySteps: TrajectoryStep[];
	toolCalls: OrchestratorWorkflowOutput["toolCalls"];
	stepResults: OrchestratorStepResult[];
	// Config
	reflectionEnabled: boolean;
	reflectionOnFinalOutput: boolean;
	// Iterative mode data (for pattern learning)
	iterativeConversationHistory?: IterativeMessage[];
	enrichedMessage?: string;
	journeyConversationHistory?: Array<{ role: string; content: string }>;
	// Issue #11: Search quality metrics for pattern learning
	toolSearchMetrics?: {
		totalSearches: number;
		zeroResultSearches: number;
		confidenceSum: number;
		toolsDiscovered: string[];
	};
}

const {
	reflectOnOutput,
	recordExecution,
	embedAndStoreTrajectory,
	saveTrajectory,
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

const { createEpisodeFromExecutionActivity, extractAndLearnPatternsActivity } =
	proxyActivities<typeof orchestratorMemoryActivities>({
		startToCloseTimeout: "2 minutes",
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "500ms",
			backoffCoefficient: 2,
			maximumInterval: "10s",
			maximumAttempts: 2,
		},
	});

// Proxy for the persistent operation-result activity.
//
// Timeout strategy (Codex review fix #2):
//   - `startToCloseTimeout` bounds a SINGLE attempt once it starts running.
//   - `scheduleToCloseTimeout` bounds the WHOLE schedule including queue
//     wait. Without it, a worker outage (task scheduled, no worker picks
//     it up) leaves `startToClose` un-armed and the awaiting workflow
//     branch hangs inside `CancellationScope.nonCancellable` for the
//     proxy's default schedule lifetime. Bound it to roughly 2.5× the
//     single-attempt timeout × max attempts so retries fit but we never
//     wait indefinitely for a worker.
// Retry strategy:
//   - The activity itself catches all errors and returns
//     `{ posted: false, reason }`, so retrying is only for transient
//     temporal-platform failures (e.g. activity worker disconnect mid-
//     execution). The activity uses `appendConversationMessage`'s
//     `operationKey` dedup, so a retry that lands a second attempt won't
//     duplicate the chat row.
const { postOperationResultActivity } = proxyActivities<
	typeof postOperationResultModule
>({
	startToCloseTimeout: "30 seconds",
	scheduleToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "5s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Completion Child Workflow
// =============================================================================

/**
 * Fire-and-forget child workflow that runs all completion activities.
 *
 * This workflow is started with ParentClosePolicy.ABANDON so it continues
 * running even after the parent orchestrator workflow completes and returns
 * the response to the user. This eliminates the 5-30s completion latency.
 *
 * All 5 activities are independent and errors are non-fatal.
 */
export async function orchestratorCompletionWorkflow(
	input: CompletionWorkflowInput,
): Promise<void> {
	const {
		executionId,
		userId,
		organizationId,
		message,
		finalResponse,
		executionMode,
		conversationId,
		projectId,
		workspaceIds,
		startTime,
		lettaAgentId,
		taskPlanSteps,
		trajectorySteps,
		toolCalls,
		stepResults,
		reflectionEnabled,
		reflectionOnFinalOutput,
	} = input;

	const isIterativeMode =
		taskPlanSteps.length > 0 &&
		taskPlanSteps[0]?.id?.startsWith("iterative-");

	log.info("Starting completion child workflow", {
		executionId,
		isIterativeMode,
		stepCount: taskPlanSteps.length,
	});

	// Step 1: Final Reflection (if enabled)
	try {
		if (reflectionEnabled && reflectionOnFinalOutput) {
			const finalReflection = await reflectOnOutput({
				stepDescription: message,
				output: finalResponse,
				expectedOutcome: "Complete the user's request successfully",
			});

			if (!finalReflection.satisfactory) {
				log.warn("Final reflection flagged issues", {
					reason: finalReflection.reason,
				});
			}
		}
	} catch (error) {
		if (!workflowInfo().unsafe.isReplaying) {
			log.warn("Final reflection failed", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// Step 2: Record Execution Pattern in Letta
	try {
		if (lettaAgentId) {
			await recordExecution({
				lettaAgentId,
				executionId,
				task: message,
				steps: taskPlanSteps.map((step) => ({
					stepId: step.id,
					description: step.description,
					status:
						step.status === "complete"
							? "complete"
							: step.status === "error"
								? "error"
								: "skipped",
					agentId: step.executor,
					toolCalls: stepResults
						.find((sr) => sr.stepId === step.id)
						?.toolCalls?.map((tc) => ({
							name: tc.name,
							success: tc.status === "success",
						})),
				})),
				success: taskPlanSteps.every((s) => s.status === "complete"),
				durationMs: Date.now() - startTime,
			});

			if (!workflowInfo().unsafe.isReplaying) {
				log.info("Execution pattern recorded in Letta", {
					executionId,
					success: taskPlanSteps.every(
						(s) => s.status === "complete",
					),
					stepCount: taskPlanSteps.length,
				});
			}
		}
	} catch (error) {
		if (!workflowInfo().unsafe.isReplaying) {
			log.warn("Failed to record execution pattern in Letta", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// Step 3: Store Execution in Qdrant Semantic Memory
	try {
		const outcome = taskPlanSteps.every((s) => s.status === "complete")
			? "success"
			: taskPlanSteps.some((s) => s.status === "complete")
				? "partial"
				: "failure";

		await embedAndStoreTrajectory({
			executionId,
			taskDescription: message,
			// Cast: activity only reads id/description/status from steps
			steps: taskPlanSteps as Parameters<
				typeof embedAndStoreTrajectory
			>[0]["steps"],
			outcome,
			durationMs: Date.now() - startTime,
			userId,
			organizationId,
		});

		if (!workflowInfo().unsafe.isReplaying) {
			log.info("Execution stored in Qdrant semantic memory", {
				executionId,
				outcome,
				stepCount: taskPlanSteps.length,
			});
		}
	} catch (error) {
		if (!workflowInfo().unsafe.isReplaying) {
			log.warn("Failed to store execution in Qdrant", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// Step 4: Create Episodic Memory (conversation summary) + Pattern Learning
	try {
		const outcome = taskPlanSteps.every((s) => s.status === "complete")
			? "success"
			: taskPlanSteps.some((s) => s.status === "complete")
				? "partial"
				: "failure";

		const toolsUsed = [
			...new Set(
				toolCalls
					.filter((tc) => tc.status === "success")
					.map((tc) => tc.name),
			),
		];

		const agentsUsed = [
			...new Set(
				taskPlanSteps
					.filter((s) => s.executor)
					.map((s) => s.executor as string),
			),
		];

		const effectiveConversationId = conversationId || executionId;

		await createEpisodeFromExecutionActivity({
			userId,
			organizationId,
			projectId,
			workspaceId: workspaceIds?.[0],
			conversationId: effectiveConversationId,
			executionId,
			taskDescription: message,
			steps: taskPlanSteps.map((s) => ({
				id: s.id,
				description: s.description,
				status: s.status,
			})),
			toolsUsed,
			agentsUsed,
			outcome,
			conversationStartedAt: new Date(startTime),
			conversationEndedAt: new Date(),
		});

		if (!workflowInfo().unsafe.isReplaying) {
			log.info("Episodic memory created", {
				executionId,
				conversationId: effectiveConversationId,
				outcome,
				isIterativeMode,
			});
		}

		// Extract and learn patterns
		const messages = isIterativeMode
			? buildMessagesFromCompletionInput(input)
			: [
					{ role: "user", content: message },
					...taskPlanSteps.map((s) => ({
						role: "assistant" as const,
						content: s.description,
					})),
				];

		const patternResult = await extractAndLearnPatternsActivity({
			userId,
			organizationId,
			messages,
		});

		if (patternResult.count > 0 && !workflowInfo().unsafe.isReplaying) {
			log.info("Learned patterns from conversation", {
				count: patternResult.count,
				patterns: patternResult.patternsLearned,
				isIterativeMode,
			});
		}
	} catch (error) {
		if (!workflowInfo().unsafe.isReplaying) {
			log.warn("Failed to create episodic memory", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// Step 5: Save Trajectory (if save_reuse mode)
	try {
		if (executionMode === "save_reuse") {
			const outcome = taskPlanSteps.every((s) => s.status === "complete")
				? "success"
				: taskPlanSteps.some((s) => s.status === "complete")
					? "partial"
					: "failure";

			await saveTrajectory({
				taskDescription: message,
				steps: trajectorySteps,
				outcome,
				totalDurationMs: Date.now() - startTime,
				userId,
				organizationId,
			});

			if (!workflowInfo().unsafe.isReplaying) {
				log.info("Trajectory saved for reuse", { executionId });
			}
		}
	} catch (error) {
		if (!workflowInfo().unsafe.isReplaying) {
			log.warn("Failed to save trajectory", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// Step 6: Persistent operation-result system message.
	//
	// This is the LAST side-effect step of the completion child workflow and
	// is the only one with user-visible product impact.
	//
	// Cancellation guarantees (Codex review fix #3 — explicit boundary doc):
	//   - The PARENT orchestrator starts this child with
	//     `ParentClosePolicy.ABANDON` (see L597-606 of this file). Once the
	//     child workflow has STARTED, it survives the parent's cancellation
	//     independently of any scope wrapping inside it.
	//   - `CancellationScope.nonCancellable` then protects the activity
	//     call itself from any local Cancel that arrives between the
	//     child's start and Step 6 reaching its `await`. Without it, a
	//     Cancel arriving mid-Step-1-through-5 would propagate to Step 6
	//     and a `CancelledFailure` would skip the persistence call.
	//   - There is NO protection against the parent being cancelled
	//     BEFORE the completion child is started. That window is the
	//     orchestrator workflow body itself; AC-3 coverage for that case
	//     would require the parent to start the completion child even on
	//     its own cancel path. That work is out of PR2 scope (the
	//     mainline orchestrator already starts completion as the final
	//     step of a successful or failed run).
	//
	// Cancellation outcome semantics (Codex review fix #4 — follow-up):
	//   - We derive `outcome` purely from `taskPlanSteps`. If the parent
	//     was cancelled but several steps had already completed, the
	//     resulting message reads "success" / "partial" — describing the
	//     work that ACTUALLY HAPPENED, not the user's cancel intent.
	//   - The activity's `OperationOutcome` literal includes
	//     `"cancelled"`, but using it requires the completion child to
	//     know the parent was cancelled (e.g. via a signal or via parent
	//     passing an explicit cancellation flag into `CompletionWorkflowInput`).
	//     That belongs to a follow-up product decision tracked in the
	//     1412 plan: "what does AC-3 mean when steps DID complete before
	//     the user clicked cancel?". For PR2 the "what got done"
	//     semantic is the conservative ship-it choice.
	//
	// Skip conditions:
	//   - No `conversationId` — the caller surface doesn't have an
	//     `AgentConversation` backing this run (notably Nexus / CopilotPage
	//     today). Persisting against a synthesized ID would create
	//     orphaned rows; emitting nothing matches today's behaviour.
	//
	// Idempotency:
	//   - `operationKey = ${executionId}-result` is stable across workflow
	//     retries. `appendConversationMessage` returns
	//     `deduplicated: true` on the second hit so the chat thread sees
	//     exactly one message per executionId.
	//
	// Errors:
	//   - `postOperationResultActivity` catches everything and returns
	//     `{ posted: false, reason }`. The outer try/catch here is
	//     belt-and-braces against (a) the activity unexpectedly throwing
	//     and (b) the proxy itself failing (e.g. retry limit exceeded).
	//     Either case is logged at warn and the workflow completes
	//     normally — Step 6 must not regress the orchestrator's primary
	//     completion path.
	if (conversationId) {
		try {
			await CancellationScope.nonCancellable(async () => {
				const outcome: "success" | "partial" | "failure" =
					taskPlanSteps.every((s) => s.status === "complete")
						? "success"
						: taskPlanSteps.some((s) => s.status === "complete")
							? "partial"
							: "failure";

				// User-facing summary: the orchestrator's final response is
				// the cleanest signal we have today. The pure formatter
				// (`buildOperationResultMessage`) truncates to 2 000 chars
				// and masks any stack-trace shape on the failure path, so
				// we can pass the raw `finalResponse` even when the model
				// surfaced a long error narrative.
				const summary = finalResponse || message;

				// `operationLabel` shows in the editorial "SYSTEM" eyebrow
				// region of `<SystemMessage>` and in audit logs. Keep it
				// human-readable and short.
				const operationLabel =
					isIterativeMode || executionMode === "save_reuse"
						? `Orchestrator (${executionMode})`
						: "Orchestrator";

				const result = await postOperationResultActivity({
					conversationId,
					userId,
					organizationId: organizationId ?? null,
					operationKey: `${executionId}-result`,
					outcome,
					operationLabel,
					summary,
				});

				if (!workflowInfo().unsafe.isReplaying) {
					log.info("Step 6 — operation-result message processed", {
						executionId,
						conversationId,
						outcome,
						posted: result.posted,
						deduplicated: result.deduplicated,
						reason: result.reason,
					});
				}
			});
		} catch (error) {
			if (!workflowInfo().unsafe.isReplaying) {
				log.warn(
					"Step 6 — operation-result message failed (non-fatal)",
					{
						executionId,
						conversationId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
	}

	// Issue #11: Log search quality metrics for observability
	if (input.toolSearchMetrics && input.toolSearchMetrics.totalSearches > 0) {
		const avgConfidence =
			input.toolSearchMetrics.totalSearches >
			input.toolSearchMetrics.zeroResultSearches
				? input.toolSearchMetrics.confidenceSum /
					(input.toolSearchMetrics.totalSearches -
						input.toolSearchMetrics.zeroResultSearches)
				: 0;
		log.info("Tool search quality metrics", {
			executionId,
			totalSearches: input.toolSearchMetrics.totalSearches,
			zeroResultSearches: input.toolSearchMetrics.zeroResultSearches,
			zeroResultRate: `${(
				(input.toolSearchMetrics.zeroResultSearches /
					input.toolSearchMetrics.totalSearches) *
					100
			).toFixed(1)}%`,
			avgTopConfidence: avgConfidence.toFixed(3),
			uniqueToolsDiscovered:
				input.toolSearchMetrics.toolsDiscovered.length,
		});
	}

	log.info("Completion child workflow finished", { executionId });
}

/**
 * Build messages array from completion input for pattern learning (iterative mode).
 * Preserves actual conversation flow for better preference detection.
 *
 * IMPORTANT: Only includes user-authored content, not policy-enriched messages.
 */
function buildMessagesFromCompletionInput(
	input: CompletionWorkflowInput,
): Array<{ role: string; content: string }> {
	const messages: Array<{ role: string; content: string }> = [];

	messages.push({ role: "user", content: input.message });

	const addedUserMessages = new Set<string>([input.message]);

	if (input.enrichedMessage) {
		addedUserMessages.add(input.enrichedMessage);
	}

	if (input.iterativeConversationHistory) {
		for (const msg of input.iterativeConversationHistory) {
			if (msg.role === "user" && !addedUserMessages.has(msg.content)) {
				messages.push({ role: "user", content: msg.content });
				addedUserMessages.add(msg.content);
			} else if (msg.role === "assistant" && msg.content) {
				messages.push({ role: "assistant", content: msg.content });
			}
		}
	}

	if (input.journeyConversationHistory) {
		for (const msg of input.journeyConversationHistory) {
			if (msg.role === "user" && !addedUserMessages.has(msg.content)) {
				messages.push({ role: "user", content: msg.content });
				addedUserMessages.add(msg.content);
			}
		}
	}

	return messages;
}

// =============================================================================
// Execute Completion Phase (Fire-and-Forget)
// =============================================================================

/**
 * Execute completion phase
 *
 * Starts a fire-and-forget child workflow to handle all completion activities
 * (reflection, Letta recording, Qdrant embedding, episodic memory, pattern
 * learning, trajectory saving) without blocking the parent workflow from
 * returning the response to the user.
 *
 * The child workflow uses ParentClosePolicy.ABANDON so it continues running
 * even after the parent completes.
 */
export async function executeCompletionPhase(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	modeConfig: ExecutionModeConfig,
	altkConfig: ALTKConfig,
	finalResponse: string,
	_updateProgress: (phase: string, message: string) => void,
): Promise<PhaseResult> {
	const { taskPlan, lettaAgentId, trajectorySteps, stepResults } = state;

	// Determine if we're in iterative mode (no task plan but have conversation history)
	const isIterativeMode =
		!taskPlan &&
		(state.iterativeConversationHistory?.length > 0 ||
			state.toolCalls?.length > 0);

	// For upfront planning mode, we need a task plan
	if (!taskPlan && !isIterativeMode) {
		return {
			success: false,
			error: "No task plan available and no iterative execution data",
			shouldContinue: false,
		};
	}

	// Build synthetic task plan for iterative mode if needed
	const effectiveTaskPlan = taskPlan || buildIterativeTaskPlan(state);

	log.info("Starting completion phase (fire-and-forget child workflow)", {
		executionId: state.executionId,
		isIterativeMode,
		stepCount: effectiveTaskPlan.steps.length,
	});

	// ======================================================================
	// Weave Mode: Persist final execution state + destroy sandbox session
	// ======================================================================
	if (input.weaveExecutionId) {
		try {
			await updateWeaveExecutionActivity({
				executionId: input.weaveExecutionId,
				userId: input.userId,
				organizationId: input.organizationId,
				status: "COMPLETED",
				completedAt: new Date(),
				artifacts: stepResults.flatMap(
					(result) => result.artifacts ?? [],
				),
				checkboxes:
					taskPlan?.steps.map((step) => ({
						id: step.id,
						text: step.description,
						agent: step.app || step.executor,
						status: step.status,
						approvalId: step.approvalId,
						error: step.error,
					})) ?? undefined,
			});
		} catch (error) {
			log.warn("Failed to update weave execution completion state", {
				error: error instanceof Error ? error.message : String(error),
				executionId: input.weaveExecutionId,
			});
		}
	}
	const sandboxVar = state.variables["weave.sandboxSessionId"];
	if (sandboxVar && typeof sandboxVar.value === "string") {
		try {
			await destroySandboxActivity({
				sessionId: sandboxVar.value,
				userId: input.userId,
				organizationId: input.organizationId,
			});
			log.info("Weave sandbox destroyed", {
				sessionId: sandboxVar.value,
			});
		} catch (error) {
			log.warn("Failed to destroy weave sandbox", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	try {
		// Build serializable input for the child workflow
		const completionInput: CompletionWorkflowInput = {
			executionId: state.executionId,
			userId: input.userId,
			organizationId: input.organizationId,
			message: input.message,
			finalResponse,
			executionMode: input.executionMode,
			conversationId: input.conversationId,
			projectId: input.projectId,
			workspaceIds: input.workspaceIds,
			startTime: state.startTime,
			lettaAgentId,
			taskPlanSteps: effectiveTaskPlan.steps.map((s) => ({
				id: s.id,
				description: s.description,
				status: s.status,
				executor: s.executor,
			})),
			trajectorySteps,
			toolCalls: state.toolCalls,
			stepResults,
			reflectionEnabled: modeConfig.reflection,
			reflectionOnFinalOutput: altkConfig.reflection.onFinalOutput,
			iterativeConversationHistory: isIterativeMode
				? state.iterativeConversationHistory
				: undefined,
			enrichedMessage: state.enrichedMessage || undefined,
			journeyConversationHistory:
				state.journeyState?.conversationHistory?.map((h) => ({
					role: h.role,
					content: h.content,
				})),
			// Issue #11: Pass search quality metrics for observability
			toolSearchMetrics: state.toolSearchMetrics,
		};

		// Fire-and-forget: start child workflow but don't await it
		// ABANDON policy means the child continues even if parent completes
		await startChild(orchestratorCompletionWorkflow, {
			workflowId: `${state.executionId}-completion`,
			parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
			args: [completionInput],
		});

		log.info("Completion child workflow started (fire-and-forget)", {
			executionId: state.executionId,
			childWorkflowId: `${state.executionId}-completion`,
		});

		return {
			success: true,
			shouldContinue: true,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		log.error("Failed to start completion child workflow", {
			error: errorMessage,
		});
		// Completion phase errors are non-fatal
		return {
			success: true,
			shouldContinue: true,
		};
	}
}

/**
 * Build a synthetic task plan from iterative execution state
 * This allows memory recording to work for iterative mode executions
 */
function buildIterativeTaskPlan(state: WorkflowState): {
	steps: Array<{
		id: string;
		description: string;
		status: string;
		executor?: string;
	}>;
} {
	// Convert tool calls into synthetic steps
	const steps = state.toolCalls.map((tc, index) => ({
		id: `iterative-step-${index + 1}`,
		description: `Execute tool: ${tc.name}`,
		status: tc.status === "success" ? "complete" : "error",
		executor: undefined, // Iterative mode doesn't use executor agents
	}));

	// If no tool calls, create a single step from the conversation
	if (steps.length === 0 && state.iterativeConversationHistory?.length > 0) {
		steps.push({
			id: "iterative-step-1",
			description: "Process user request via iterative execution",
			status: "complete",
			executor: undefined,
		});
	}

	return { steps };
}

// Output truncation constants from centralized config (Issue #7)
const {
	maxResultSize: MAX_RESULT_SIZE,
	maxArtifactSize: MAX_ARTIFACT_SIZE,
	maxToolCalls: MAX_TOOL_CALLS,
	maxStepResults: MAX_STEP_RESULTS,
	maxArtifacts: MAX_ARTIFACTS,
	maxResponseLength: MAX_RESPONSE_LENGTH,
} = OUTPUT;

/**
 * Per-tool-call cap for tool calls that drive an interactive MCP App UI
 * (Excalidraw `create_view`, future MCP-UI tools). The default 5KB cap
 * was clobbering Excalidraw's `elements` array (typically 6-100KB) with
 * the truncation sentinel, which then overwrote the live-streamed args
 * on the frontend and left the inline iframe with an empty canvas.
 *
 * 500KB covers the largest hand-drawn diagrams we observe in practice
 * (a 200-shape diagram is ~150KB) while leaving room for several MCP
 * App tool calls per turn under the global budget below.
 */
const MCP_APP_RESULT_SIZE_CAP = 500_000;

/**
 * Total per-workflow-output budget across ALL MCP App tool call payloads
 * (args + result combined, summed across the flat `toolCalls` list).
 * Bounds worst-case workflow output so a turn that produced many large
 * diagrams cannot blow past Temporal's 2MB payload limit (see
 * `OUTPUT.maxToolCalls = 50`). When the budget is exhausted, additional
 * MCP App tool calls fall back to the default 5KB cap and the inline
 * iframe degrades to the dedicated panel (which re-fetches via
 * `read_checkpoint`).
 *
 * 1.5MB leaves ~500KB headroom for everything else in the output
 * (response text, artifacts, plan, variables) under the 2MB limit.
 */
const MCP_APP_TOTAL_BUDGET = 1_500_000;

/**
 * Stateful budget tracker for MCP App tool call payloads. The same tool
 * call may appear in both `state.toolCalls` and inside
 * `state.stepResults[].toolCalls`, so we dedup by id to avoid
 * double-charging the budget — the args/result are identical in both
 * lists and we want the same truncation decision in both places.
 */
function createMcpAppBudget(): {
	consume: (id: string, sizeBytes: number) => boolean;
} {
	let remaining = MCP_APP_TOTAL_BUDGET;
	const charged = new Map<string, boolean>();
	return {
		consume(id, sizeBytes) {
			const already = charged.get(id);
			if (already !== undefined) {
				return already;
			}
			const fits = sizeBytes <= remaining;
			if (fits) {
				remaining -= sizeBytes;
			}
			charged.set(id, fits);
			return fits;
		},
	};
}

/**
 * Approximate the workflow-output footprint of a tool call payload.
 * `JSON.stringify` on `undefined` / `null` returns a short literal —
 * good enough for budget accounting. Cost is bounded: this runs at most
 * `MAX_TOOL_CALLS + nested-step-results` times per workflow output (≤70
 * calls), and only on tool calls that already passed the
 * `mcpAppResourceUri` gate, so it doesn't run on the hot path of plain
 * tool calls.
 */
function approximatePayloadSize(args: unknown, result: unknown): number {
	let size = 0;
	try {
		size += JSON.stringify(args ?? null).length;
	} catch {
		size += 0;
	}
	try {
		size += JSON.stringify(result ?? null).length;
	} catch {
		size += 0;
	}
	return size;
}

/**
 * Pick the truncation cap for a tool call. Tool calls with an MCP App
 * resource URI carry interactive UI render data that the inline iframe
 * needs to mount; they get the higher cap as long as the workflow's
 * shared budget allows. Plain tool calls keep the default cap.
 */
function resultCapForToolCall(
	tc: {
		id: string;
		args: unknown;
		result: unknown;
		mcpAppResourceUri?: string;
	},
	budget: ReturnType<typeof createMcpAppBudget>,
): number {
	if (!tc.mcpAppResourceUri) {
		return MAX_RESULT_SIZE;
	}
	const size = approximatePayloadSize(tc.args, tc.result);
	return budget.consume(tc.id, size)
		? MCP_APP_RESULT_SIZE_CAP
		: MAX_RESULT_SIZE;
}

/**
 * Truncate a value to stay within size limits
 */
function truncateResult(
	value: unknown,
	maxSize: number = MAX_RESULT_SIZE,
): unknown {
	if (value === undefined || value === null) {
		return value;
	}

	if (typeof value === "string") {
		if (value.length > maxSize) {
			return (
				value.slice(0, maxSize) +
				`... [truncated, ${value.length - maxSize} chars omitted]`
			);
		}
		return value;
	}

	if (typeof value === "object") {
		const str = JSON.stringify(value);
		if (str.length > maxSize) {
			return `[Object truncated, ${str.length} bytes - too large for workflow output]`;
		}
		return value;
	}

	return value;
}

/**
 * Build the final workflow output
 */
export function buildWorkflowOutput(
	state: WorkflowState,
	finalStatus: OrchestratorWorkflowOutput["status"],
	error?: string,
	response?: string,
): OrchestratorWorkflowOutput {
	const {
		executionId,
		taskPlan,
		routingDecision,
		toolCalls,
		variables,
		stepResults,
		approvalHistory,
		planningAudit,
		startTime,
	} = state;

	// Truncate tool calls results to avoid exceeding Temporal's size limit.
	// Tool calls with `mcpAppResourceUri` get a higher cap so the inline
	// iframe (e.g. Excalidraw `create_view`) keeps the elements payload
	// the widget needs to render. The shared `mcpAppBudget` enforces a
	// per-workflow-output cap across the flat `toolCalls` list AND the
	// nested `stepResults[].toolCalls` lists so the same tool call gets
	// the same truncation decision in both places (deduped by id) and
	// the total payload stays bounded.
	const mcpAppBudget = createMcpAppBudget();

	const truncatedToolCalls = toolCalls.slice(0, MAX_TOOL_CALLS).map((tc) => {
		const cap = resultCapForToolCall(tc, mcpAppBudget);
		return {
			...tc,
			result: truncateResult(tc.result, cap),
			args: truncateResult(tc.args, cap),
		};
	});

	// Truncate step results and their nested tool calls
	const truncatedStepResults = stepResults
		.slice(0, MAX_STEP_RESULTS)
		.map((sr) => ({
			...sr,
			response:
				typeof sr.response === "string" &&
				sr.response.length > MAX_RESULT_SIZE
					? `${sr.response.slice(0, MAX_RESULT_SIZE)}... [truncated]`
					: sr.response,
			toolCalls: sr.toolCalls.slice(0, 20).map((tc) => {
				const cap = resultCapForToolCall(tc, mcpAppBudget);
				return {
					...tc,
					result: truncateResult(tc.result, cap),
					args: truncateResult(tc.args, cap),
				};
			}),
			artifacts: sr.artifacts?.slice(0, 10).map((a) => ({
				...a,
				content:
					typeof a.content === "string" &&
					a.content.length > MAX_ARTIFACT_SIZE
						? a.content.slice(0, MAX_ARTIFACT_SIZE) +
							"... [truncated]"
						: a.content,
			})),
		}));

	// Build artifacts from step results (limited)
	const allArtifacts = truncatedStepResults
		.flatMap((sr) =>
			(sr.artifacts || []).map((a) => ({
				...a,
				stepId: sr.stepId,
				createdAt: new Date().toISOString(),
			})),
		)
		.slice(0, MAX_ARTIFACTS);

	// Create artifacts from tool calls with significant outputs (limited)
	const toolArtifacts = truncatedToolCalls
		.filter((tc) => tc.status === "success" && tc.result)
		.slice(0, MAX_ARTIFACTS - allArtifacts.length)
		.map((tc) => {
			const result = tc.result;
			const resultStr =
				typeof result === "string" ? result : JSON.stringify(result);

			let type:
				| "document"
				| "code"
				| "data"
				| "tool_result"
				| "file"
				| "error" = "tool_result";
			if (
				tc.name.includes("write") ||
				tc.name.includes("create") ||
				tc.name.includes("generate")
			) {
				if (tc.name.includes("code") || tc.name.includes("file")) {
					type = "code";
				} else {
					type = "document";
				}
			}

			return {
				id: `artifact-${tc.id}`,
				type,
				name: `Result from ${tc.name}`,
				content:
					resultStr.length > MAX_ARTIFACT_SIZE
						? resultStr.slice(0, MAX_ARTIFACT_SIZE) +
							"... [truncated]"
						: resultStr,
				stepId: "tool-execution",
				createdAt: new Date().toISOString(),
				metadata: {
					toolName: tc.name,
					durationMs: tc.durationMs,
				},
			};
		});

	// Build planning audit summary (Issue #9: include degraded capabilities)
	const planningAuditSummary = buildPlanningAuditSummary(
		planningAudit,
		state.degradedCapabilities,
	);

	// Compute a final token-budget snapshot from iterationCosts so
	// the UI can render TokenBudgetCard even on successful runs, and include any
	// accumulated LimitSignals (provider or internal) for banner/toast rendering.
	const tokenBudget = buildFinalTokenBudget(state);
	const limitSignals =
		state.limitSignals.length > 0 ? state.limitSignals : undefined;

	return {
		executionId,
		status: finalStatus,
		response:
			typeof response === "string" &&
			response.length > MAX_RESPONSE_LENGTH
				? `${response.slice(0, MAX_RESPONSE_LENGTH)}... [truncated]`
				: response,
		taskPlan: taskPlan || undefined,
		routingDecision: routingDecision || undefined,
		toolCalls: truncatedToolCalls,
		variables,
		error,
		totalDurationMs: Date.now() - startTime,
		pendingApproval: state.pendingApproval || undefined,
		approvalHistory:
			approvalHistory.length > 0 ? approvalHistory : undefined,
		planningAudit: planningAuditSummary,
		stepResults:
			truncatedStepResults.length > 0 ? truncatedStepResults : undefined,
		artifacts:
			[...allArtifacts, ...toolArtifacts].length > 0
				? [...allArtifacts, ...toolArtifacts]
				: undefined,
		limitSignals,
		tokenBudget,
		// Set when the iterative phase fired its budget-exhaustion synthesis.
		// Frontend uses it to render a "Continue in a new chat" CTA above the
		// input box, seeded with `summary` as the new conversation's
		// carried-over context.
		handoffRecommended: state.pendingHandoff || undefined,
	};
}

/**
 * Final token-budget snapshot for the workflow output. Based solely on
 * iteration costs (which iterative-execution maintains). For non-iterative
 * runs `iterationCosts` is empty and we return undefined — no card to show.
 */
function buildFinalTokenBudget(
	state: WorkflowState,
): OrchestratorWorkflowOutput["tokenBudget"] {
	if (state.iterationCosts.length === 0) {
		return undefined;
	}
	const used = state.iterationCosts.reduce(
		(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
		0,
	);
	const total = BUDGET.defaultMaxTotalTokens;
	// usagePercentage is a decimal in [0, 1] to match the TokenBudgetCard
	// convention (which multiplies by 100 for display).
	const usagePercentage = total > 0 ? Math.min(used / total, 1) : 0;
	return { used, total, usagePercentage };
}

/**
 * Build planning audit summary for output
 */
function buildPlanningAuditSummary(
	planningAudit: {
		planningStartedAt: Date;
		planningCompletedAt: Date | null;
		contextSources: Array<{
			type: string;
			description: string;
			confidence?: number;
			used: boolean;
			usageReason?: string;
		}>;
		decisions: Array<{
			category: string;
			decision: string;
			reasoning: string;
			confidence: number;
		}>;
	},
	degradedCapabilities?: {
		memory: boolean;
		rag: boolean;
		patterns: boolean;
		policies: boolean;
		orchestratorMemory: boolean;
		instanceMemory: boolean;
	},
): OrchestratorWorkflowOutput["planningAudit"] {
	if (planningAudit.contextSources.length === 0) {
		return undefined;
	}

	const usedSources = planningAudit.contextSources.filter((s) => s.used);
	const sourcesUsed = [
		...new Set(usedSources.map((s) => formatSourceType(s.type))),
	];

	const usedMemory = usedSources.some(
		(s) =>
			s.type === "semantic_memory" ||
			s.type === "letta_memory" ||
			s.type === "trajectory_reuse",
	);
	const usedResearch = usedSources.some((s) => s.type === "web_research");

	// Generate headline
	let headline = "Created from analysis";
	if (usedSources.some((s) => s.type === "trajectory_reuse")) {
		headline = "Reusing similar past execution";
	} else if (usedResearch) {
		headline = "Created with fresh web research";
	} else if (usedMemory) {
		headline = "Created using past experience";
	} else if (usedSources.some((s) => s.type === "workspace_rag")) {
		headline = "Created using workspace knowledge";
	}

	// Add additional context
	const additionalContexts: string[] = [];
	if (usedSources.some((s) => s.type === "mcp_tool_discovery")) {
		additionalContexts.push("available tools");
	}
	if (usedSources.some((s) => s.type === "negative_memory")) {
		additionalContexts.push("avoiding past failures");
	}
	if (additionalContexts.length > 0) {
		headline += ` with ${additionalContexts.join(", ")}`;
	}

	const keyFactors = planningAudit.decisions
		.filter((d) => d.confidence >= 0.6)
		.map((d) => d.decision)
		.slice(0, 5);

	// Issue #9: Surface degraded capabilities
	const degradedList = degradedCapabilities
		? Object.entries(degradedCapabilities)
				.filter(([, degraded]) => degraded)
				.map(([cap]) => cap)
		: [];

	if (degradedList.length > 0) {
		headline += ` (degraded: ${degradedList.join(", ")})`;
	}

	return {
		headline,
		keyFactors,
		sourcesUsed,
		usedMemory,
		usedResearch,
		totalSourcesConsulted: planningAudit.contextSources.length,
		totalDecisions: planningAudit.decisions.length,
		planningDurationMs: planningAudit.planningCompletedAt
			? planningAudit.planningCompletedAt.getTime() -
				planningAudit.planningStartedAt.getTime()
			: undefined,
	};
}

/**
 * Format source type for display
 */
function formatSourceType(type: string): string {
	const labels: Record<string, string> = {
		user_input: "User Input",
		workspace_rag: "Workspace Documents",
		semantic_memory: "Past Executions",
		letta_memory: "Keyword Memory",
		trajectory_reuse: "Similar Trajectory",
		negative_memory: "Failure Avoidance",
		web_research: "Web Research",
		mcp_tool_discovery: "Available Tools",
		agent_capabilities: "Agent Capabilities",
		policy_enrichment: "System Policies",
	};
	return labels[type] || type;
}

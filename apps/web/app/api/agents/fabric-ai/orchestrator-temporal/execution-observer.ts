/**
 * How one response follows an Orchestrator run: the Redis events it forwards
 * (text, tool calls, limit signals) and the Temporal poll it diffs into
 * progress events (phase, routing, plan, steps, approvals, clarifications,
 * and the terminal `completed` or `error`).
 *
 * Shared by the stream route (`stream/route.ts`), which writes the events as
 * SSE, and the agent runtime's Orchestrator engine, which translates them to
 * AG-UI. Each response builds its own observer, so its diff state starts
 * empty and a reconnect replays the run's current state.
 */
import { metricsTracker } from "@repo/observability";
import type {
	ChatExecutionEvent,
	ChatExecutionToolCall,
	getTemporalClient,
	OrchestratorProgressUpdate,
	OrchestratorStepResult,
	OrchestratorWorkflowOutput,
	PendingApprovalInfo,
	PendingClarificationInfo,
	TaskPlan,
} from "@repo/temporal";
import type { AssertAssignable } from "@saas/agents/lib/chat-stream-protocol";
import {
	type OrchestratorStreamInput,
	parseOrchestratorStreamEvent,
} from "@saas/agents/lib/orchestrator-stream-protocol";
import { buildWorkflowErrorEvent } from "../stream/turn-events";

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

/** The run handle a response polls (the newest run of the execution). */
export type OrchestratorRunHandle = ReturnType<
	TemporalClient["workflow"]["getHandle"]
>;

/** Where an observer sends each event, already in the stream's shape. */
export type OrchestratorEventSink = (event: OrchestratorStreamInput) => void;

/** One poll's outcome: the run ended (an event says how), and the handle to poll next. */
export interface OrchestratorPollResult {
	complete: boolean;
	handle: OrchestratorRunHandle;
}

const stableSerialize = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
};

/**
 * One response's view of a run. `reattach` pins the newest run after a
 * continue-as-new, with the same authorization as the first attach.
 */
export function createOrchestratorExecutionObserver({
	emit,
	reattach,
	beforeState,
	fatalPollError,
}: {
	emit: OrchestratorEventSink;
	reattach: () => Promise<OrchestratorRunHandle>;
	/** Drain committed output after observing status, before emitting state or completion. */
	beforeState?: (terminal: boolean) => Promise<void>;
	fatalPollError?: (error: unknown) => boolean;
}) {
	const sendEvent = <T extends OrchestratorStreamInput>(
		payload: T & AssertAssignable<T, OrchestratorStreamInput>,
	) => emit(payload);

	const forwardEvent = (value: OrchestratorStreamInput) => {
		const event = parseOrchestratorStreamEvent(value);
		if (event) {
			emit(event);
		}
	};

	const lastToolSnapshots = new Map<
		string,
		{
			args: string;
			result: string;
			status: string;
			started: boolean;
		}
	>();

	const emitToolCallDelta = (toolCall: ChatExecutionToolCall) => {
		const previous = lastToolSnapshots.get(toolCall.id);
		const nextArgs = stableSerialize(toolCall.args ?? null);
		const nextResult = stableSerialize(toolCall.result ?? null);

		if (!previous?.started) {
			sendEvent({
				type: "tool_start" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				serverName: toolCall.serverName,
				args: toolCall.args,
				status: toolCall.status,
				mcpAppResourceUri: toolCall.mcpAppResourceUri,
				mcpAppConfigId: toolCall.mcpAppConfigId,
			});
		}

		if (previous === undefined || nextArgs !== previous.args) {
			sendEvent({
				type: "tool_input" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				serverName: toolCall.serverName,
				args: toolCall.args,
				status: toolCall.status,
				mcpAppResourceUri: toolCall.mcpAppResourceUri,
				mcpAppConfigId: toolCall.mcpAppConfigId,
			});
		}

		if (
			(toolCall.status === "success" ||
				toolCall.status === "complete" ||
				toolCall.status === "error") &&
			(previous === undefined ||
				previous.status !== toolCall.status ||
				nextResult !== previous.result)
		) {
			sendEvent({
				type: "tool_result" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				serverName: toolCall.serverName,
				result: toolCall.result,
				status: toolCall.status,
				durationMs: toolCall.durationMs,
				error: toolCall.error,
				mcpAppResourceUri: toolCall.mcpAppResourceUri,
				mcpAppConfigId: toolCall.mcpAppConfigId,
			});
		}

		lastToolSnapshots.set(toolCall.id, {
			args: nextArgs,
			result: nextResult,
			status: toolCall.status,
			started: true,
		});
	};

	const emitToolCalls = (toolCalls: ChatExecutionToolCall[] | undefined) => {
		for (const toolCall of toolCalls || []) {
			if (toolCall?.id && toolCall.name) {
				emitToolCallDelta(toolCall);
			}
		}
	};

	/** A live event from the run's Redis channel. */
	const onExecutionEvent = (event: ChatExecutionEvent) => {
		switch (event.event) {
			case "execution.text_delta":
				forwardEvent({
					type: "text_delta" as const,
					content: event.data?.text || "",
				});
				return;
			case "execution.iteration_start":
				forwardEvent({
					type: "text_start" as const,
					iteration: event.data?.iteration,
				});
				return;
			case "execution.tool_start":
			case "execution.tool_input":
			case "execution.tool_complete": {
				const toolCall = event.data?.toolCall as
					| ChatExecutionToolCall
					| undefined;
				if (toolCall?.id && toolCall.name) {
					emitToolCallDelta(toolCall);
				}
				return;
			}
			case "execution.limit_signal": {
				// Forward token-budget / provider-limit signals so the UI can
				// show a banner + toast while the run continues.
				forwardEvent({
					type: "limit_signal" as const,
					signal: event.data,
				});
				const signalData = event.data as
					| {
							kind?: string;
							provider?: string;
					  }
					| undefined;
				if (signalData?.kind) {
					metricsTracker.trackAiLimitSignal(
						signalData.kind,
						signalData.provider,
					);
				}
				return;
			}
			case "execution.context_compacted":
				forwardEvent({
					type: "context_compacted" as const,
					...event.data,
				});
				return;
			case "execution.mcp_default_tool_invoked":
				// The managed-default MCP success signal; the consumer hook
				// passes the payload as the second arg to
				// `useAnalytics.trackEvent`.
				forwardEvent({
					type: "mcp_default_tool_invoked" as const,
					payload: event.data,
				});
				return;
			case "execution.mcp_default_tool_failed":
				// Failure counterpart of the above. The `errorMessage` field
				// has already been run through `sanitizeMcpErrorMessage` at
				// the emission site, so no further redaction is needed.
				forwardEvent({
					type: "mcp_default_tool_failed" as const,
					payload: event.data,
				});
				return;
			default:
				return;
		}
	};

	// Track state for change detection
	let lastProgress: OrchestratorProgressUpdate | null = null;
	let lastPlan: TaskPlan | null = null;
	let lastStepResultsCount = 0;
	let lastPhase = "";
	let lastPendingApproval: {
		approvalId: string;
		stepId: string;
		reason: string;
	} | null = null;
	let lastPendingClarification: {
		clarificationId: string;
		question: string;
		options?: string[];
	} | null = null;

	const emitStepCompletions = (stepResults: OrchestratorStepResult[]) => {
		if (stepResults.length <= lastStepResultsCount) {
			return;
		}
		for (let i = lastStepResultsCount; i < stepResults.length; i++) {
			const stepResult = stepResults[i];
			emitToolCalls(stepResult.toolCalls);
			// Send step_complete with full data including tool calls
			sendEvent({
				type: "step_complete" as const,
				stepId: stepResult.stepId,
				stepDescription: stepResult.stepDescription,
				status: stepResult.status,
				response: stepResult.response,
				toolCalls: stepResult.toolCalls || [],
				durationMs: stepResult.durationMs,
			});
		}
		lastStepResultsCount = stepResults.length;
	};

	/** The run finished in Temporal: its result as `completed` or `error`. */
	const emitCompletion = async (handle: OrchestratorRunHandle) => {
		// Get final result
		const result: OrchestratorWorkflowOutput = await handle.result();

		// Query progress one more time to get proper per-step results
		let workflowStepResults: OrchestratorStepResult[] = [];
		try {
			const finalProgress: OrchestratorProgressUpdate =
				await handle.query("progress");
			if (
				finalProgress?.stepResults &&
				finalProgress.stepResults.length > 0
			) {
				workflowStepResults =
					finalProgress.stepResults as OrchestratorStepResult[];
			}
		} catch {
			// Query might fail if workflow ended too quickly
		}

		// Send step_complete events for any steps not yet sent
		emitStepCompletions(workflowStepResults);

		// Use workflow's per-step results if available, otherwise fallback to flat tool calls
		const stepResults: OrchestratorStepResult[] =
			workflowStepResults.length > 0
				? workflowStepResults
				: result.toolCalls?.length > 0
					? [
							{
								stepId: "execution",
								stepDescription: "Task execution",
								status: "complete" as const,
								response: result.response,
								toolCalls: result.toolCalls,
								durationMs: result.totalDurationMs || 0,
							},
						]
					: [];

		if (workflowStepResults.length === 0) {
			emitToolCalls(result.toolCalls);
		}

		// The workflow can soft-fail while Temporal still reports COMPLETED
		// (result.status === "failed", e.g. the orchestrator's dropped
		// tool-call guard exhausting its retry and returning a persistent
		// stream_error). Forwarding that as a "completed" SSE event renders
		// the run as successful client-side and can leave a partial stub as
		// the final response — this is exactly how staging orch-9294c339
		// stayed silent. Surface it as `error` instead; `cancelled` (and any
		// other non-"failed" status) still flows through the normal
		// `completed` emit below, unchanged.
		if (result.status === "failed") {
			sendEvent({
				...buildWorkflowErrorEvent(
					result.error ?? "Workflow execution failed",
					result.usageLimit,
				),
				approvalHistory: result.approvalHistory,
				// The turn row's stored stop, as the workflow returned it.
				budgetStop: result.budgetStop,
			});
			return;
		}
		// Send completed event with final response. `status` is the run's
		// DOMAIN status — a stopped turn completes in Temporal with status
		// "cancelled" — and the client must render it as such, not as a
		// completed answer.
		const cancelled = result.status === "cancelled";
		sendEvent({
			type: "completed" as const,
			approvalHistory: result.approvalHistory,
			status: result.status,
			response: result.response,
			plan: result.taskPlan
				? {
						...result.taskPlan,
						steps: result.taskPlan.steps.map((step) => ({
							...step,
						})),
					}
				: undefined,
			variables: result.variables,
			stepResults,
			toolCalls: result.toolCalls || [],
			planningAudit: result.planningAudit,
			artifacts: result.artifacts,
			// A stopped turn offers no "continue in new chat".
			handoffRecommended: cancelled
				? undefined
				: result.handoffRecommended,
			limitSignals: result.limitSignals,
			tokenBudget: result.tokenBudget,
			// A token-allowance stop exactly as the turn row stores it (the
			// workflow returns the stored value), whatever the status. The
			// chat decides from the status whether to show it: a stopped turn
			// shows no budget card.
			budgetStop: result.budgetStop,
			// The answer stopped at the output ceiling (review F25).
			truncated: result.truncated,
			model: result.model,
			// Every ChatGPT plan ran out mid-turn and API billing finished it
			// (Fizzy #3048).
			apiBilling: result.apiBilling,
		});
	};

	/** The run failed in Temporal: the best error its result can name. */
	const emitFailure = async (handle: OrchestratorRunHandle) => {
		// Try to get the actual error from the workflow result
		let errorMessage = "Workflow execution failed";
		let failure: unknown = errorMessage;
		let usageLimit: Parameters<typeof buildWorkflowErrorEvent>[1];
		try {
			const result: OrchestratorWorkflowOutput = await handle.result();
			errorMessage = result?.error || errorMessage;
			failure = errorMessage;
			usageLimit = result?.usageLimit;
		} catch (resultError: unknown) {
			failure = resultError;
			if (resultError instanceof Error) {
				errorMessage = resultError.message;
			}
		}
		const event = buildWorkflowErrorEvent(failure, usageLimit);
		if (!("code" in event)) {
			event.message = errorMessage;
		}
		emit(event);
	};

	/** The running run's queries, diffed against what this response sent. */
	const emitRunningState = async (handle: OrchestratorRunHandle) => {
		const progress: OrchestratorProgressUpdate =
			await handle.query("progress");
		const plan: TaskPlan | null = await handle.query("plan");
		const pendingApproval: PendingApprovalInfo | null =
			await handle.query("pendingApproval");

		const pendingClarification: PendingClarificationInfo | null =
			await handle.query("pendingClarification");

		const routingDecision = progress?.routingDecision;

		// Check for phase change
		if (progress?.phase && progress.phase !== lastPhase) {
			lastPhase = progress.phase;
			sendEvent({
				type: "phase" as const,
				phase: progress.phase,
				message: progress.message,
			});

			// Send routing decision when available
			if (progress.phase === "planning" && routingDecision) {
				sendEvent({
					type: "routing" as const,
					primaryAgent: routingDecision.primaryAgent,
					agentName: routingDecision.primaryAgent, // Use primaryAgent as name
					confidence: routingDecision.confidence,
					riskLevel: routingDecision.riskLevel,
					requiredConnections: routingDecision.requiredConnections,
					missingIntegrations: routingDecision.missingIntegrations,
					blockedOnConnections: routingDecision.blockedOnConnections,
				});
			}
		}

		// Check for new plan
		if (plan && !lastPlan) {
			lastPlan = plan;
			sendEvent({
				type: "planning" as const,
				plan: {
					id: plan.id,
					description: plan.description,
					riskLevel: plan.riskLevel,
					steps: plan.steps.map((s) => ({
						id: s.id,
						description: s.description,
						order: s.order,
						status: s.status,
						riskLevel: s.riskLevel,
						requiresApproval: s.requiresApproval,
					})),
				},
			});
		}

		// Check for step progress: new step results with their tool calls
		if (progress?.stepResults) {
			emitStepCompletions(
				progress.stepResults as OrchestratorStepResult[],
			);
		}

		// Check for current step
		if (progress?.currentStep && lastPlan) {
			const currentStepId = progress.currentStep.id;
			const planStep = lastPlan.steps.find((s) => s.id === currentStepId);
			if (planStep && planStep.status === "in_progress") {
				sendEvent({
					type: "step_start" as const,
					stepId: currentStepId,
					description: progress.currentStep.description,
					order: planStep.order,
				});
			}
		}

		// Check for pending approval changes
		// Handle three cases:
		// 1. New approval (no previous pending)
		// 2. Different approval (previous resolved, new one created)
		// 3. Approval resolved (previous pending, now none)
		if (pendingApproval) {
			// Check if this is a new or different approval
			const isNewApproval = !lastPendingApproval;
			const isDifferentApproval =
				lastPendingApproval &&
				lastPendingApproval.approvalId !== pendingApproval.approvalId;

			if (isNewApproval || isDifferentApproval) {
				// If there was a previous approval that's now different, it was resolved
				if (isDifferentApproval && lastPendingApproval) {
					sendEvent({
						type: "approval_resolved" as const,
						approvalId: lastPendingApproval.approvalId,
						stepId: lastPendingApproval.stepId,
						message: "Approval resolved",
					});
				}
				// Now send the new approval requirement
				lastPendingApproval = pendingApproval;
				sendEvent({
					type: "approval_required" as const,
					approvalId: pendingApproval.approvalId,
					stepId: pendingApproval.stepId,
					reason: pendingApproval.reason,
				});
			}
		} else if (lastPendingApproval) {
			// Approval was resolved with no new approval pending
			const resolvedApproval = lastPendingApproval;
			lastPendingApproval = null;
			sendEvent({
				type: "approval_resolved" as const,
				approvalId: resolvedApproval.approvalId,
				stepId: resolvedApproval.stepId,
				message: "Approval resolved",
			});
		}

		// Clarifying-question HITL — sibling of approval above.
		if (pendingClarification) {
			const isNewClarification = !lastPendingClarification;
			const isDifferentClarification =
				lastPendingClarification &&
				lastPendingClarification.clarificationId !==
					pendingClarification.clarificationId;
			if (isNewClarification || isDifferentClarification) {
				if (isDifferentClarification && lastPendingClarification) {
					sendEvent({
						type: "clarifying_resolved" as const,
						clarificationId:
							lastPendingClarification.clarificationId,
					});
				}
				lastPendingClarification = pendingClarification;
				sendEvent({
					type: "clarifying_question" as const,
					clarificationId: pendingClarification.clarificationId,
					stepId: pendingClarification.stepId,
					question: pendingClarification.question,
					options: pendingClarification.options,
				});
			}
		} else if (lastPendingClarification) {
			const resolvedClarification = lastPendingClarification;
			lastPendingClarification = null;
			sendEvent({
				type: "clarifying_resolved" as const,
				clarificationId: resolvedClarification.clarificationId,
			});
		}

		// Send progress update
		if (
			progress &&
			(progress.completedSteps !== lastProgress?.completedSteps ||
				progress.totalSteps !== lastProgress?.totalSteps ||
				progress.message !== lastProgress?.message)
		) {
			lastProgress = progress;
			sendEvent({
				type: "progress" as const,
				completedSteps: progress.completedSteps,
				totalSteps: progress.totalSteps,
				message: progress.message,
				phase: progress.phase,
			});
		}
	};

	/**
	 * One poll of the run. A poll error is logged and the run polled again;
	 * it never ends the response.
	 */
	const poll = async (
		handle: OrchestratorRunHandle,
	): Promise<OrchestratorPollResult> => {
		try {
			const description = await handle.describe();
			await beforeState?.(
				[
					"COMPLETED",
					"FAILED",
					"CANCELLED",
					"TERMINATED",
					"TIMED_OUT",
				].includes(description.status.name),
			);
			switch (description.status.name) {
				case "CONTINUED_AS_NEW":
					return { complete: false, handle: await reattach() };
				case "COMPLETED":
					await emitCompletion(handle);
					return { complete: true, handle };
				case "FAILED":
					await emitFailure(handle);
					return { complete: true, handle };
				case "CANCELLED":
					// A run cancelled in Temporal itself (a legacy run, or one
					// cancelled outside this app) is a cancelled turn, not a
					// failed one.
					sendEvent({
						type: "completed" as const,
						status: "cancelled",
						toolCalls: [],
						stepResults: [],
					});
					return { complete: true, handle };
				case "TERMINATED":
					// An operator/API terminate is as final as FAILED, but
					// reports its own status name. Left unhandled the loop
					// would spin to the deadline and the client would spend
					// resume windows re-attaching to a workflow that can never
					// progress (issue #2269).
					sendEvent({
						type: "error" as const,
						message: "Workflow was terminated",
					});
					return { complete: true, handle };
				case "TIMED_OUT":
					// Temporal's own execution/run timeout — same reasoning as
					// TERMINATED above.
					sendEvent({
						type: "error" as const,
						message: "Workflow timed out on the server",
					});
					return { complete: true, handle };
				default:
					// Query current state
					try {
						await emitRunningState(handle);
					} catch {
						// Queries might fail if workflow just started - this is normal, don't log
					}
					return { complete: false, handle };
			}
		} catch (pollError) {
			if (fatalPollError?.(pollError)) {
				throw pollError;
			}
			console.error("[Orchestrator Stream] Poll error:", pollError);
			return { complete: false, handle };
		}
	};

	return { onExecutionEvent, poll };
}

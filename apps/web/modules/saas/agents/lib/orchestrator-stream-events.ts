/**
 * How one Orchestrator stream event changes the chat: the reducer both
 * transports feed (the stream route's SSE events, and the agent runtime's
 * AG-UI events mapped back to them). The hook state it writes is passed in
 * as a context, so the event handling lives in one place.
 */
import type { TaskStep } from "@repo/temporal";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
} from "@saas/payments/lib/ai-usage-limit-toast";
import type { Dispatch, SetStateAction } from "react";
import { parseTurnTruncation } from "./chat-turn-truncation";
import { parseChatGptPlanApiBilling } from "./chatgpt-plan-api-billing";
import { readPersistedModel } from "./direct-chat-history";
import { settleUnfinishedToolCalls } from "./direct-chat-turns";
import {
	type OrchestratorStreamEvent,
	toTaskPlan,
} from "./orchestrator-stream-protocol";
import {
	type ContextCompactionEvent,
	type LimitSignalSummary,
	mergeStreamingToolCall,
	type OrchestratorStreamMessage,
	type OrchestratorStreamState,
	type StreamingStepResult,
	safeToolField,
	type ToolCallState,
} from "./orchestrator-stream-types";
import { parseTurnBudgetStop } from "./turn-budget-stop";

/** A mutable ref, as `useRef` returns it. */
interface Ref<T> {
	current: T;
}

/** The turn state an event writes (see `useOrchestratorTurnState`). */
export interface OrchestratorStreamEventContext {
	setState: Dispatch<SetStateAction<OrchestratorStreamState>>;
	setMessages: Dispatch<SetStateAction<OrchestratorStreamMessage[]>>;
	setIsLoading: Dispatch<SetStateAction<boolean>>;
	setStepResults: Dispatch<SetStateAction<StreamingStepResult[]>>;
	setCurrentPhase: Dispatch<SetStateAction<string>>;
	setProgressMessage: Dispatch<SetStateAction<string>>;
	setCurrentStep: Dispatch<SetStateAction<TaskStep | null>>;
	setCompletedSteps: Dispatch<SetStateAction<number>>;
	setTotalSteps: Dispatch<SetStateAction<number>>;
	setStreamingToolCalls: Dispatch<SetStateAction<ToolCallState[]>>;
	cancelledMessageIdsRef: Ref<Set<string>>;
	executionIdRef: Ref<string | null>;
	shouldClearOnNextDeltaRef: Ref<boolean>;
	needsTextSeparatorRef: Ref<boolean>;
	prevToolCallsRef: Ref<string>;
	completedStepIdsRef: Ref<Set<string>>;
	hasTurnOutputRef: Ref<boolean>;
	isTransitioningFromApprovalRef: Ref<boolean>;
	latestApprovalIdRef: Ref<string | null>;
	showAiUsageLimitToastRef: Ref<
		(payload: AiUsageLimitExceededPayload) => void
	>;
	notifyPartykitStepStart: (stepId: string) => void;
}

/** Apply one stream event to the turn whose assistant message is `assistantMessageId`. */
export function applyOrchestratorStreamEvent(
	data: OrchestratorStreamEvent,
	assistantMessageId: string,
	ctx: OrchestratorStreamEventContext,
): void {
	const {
		setState,
		setMessages,
		setIsLoading,
		setStepResults,
		setCurrentPhase,
		setProgressMessage,
		setCurrentStep,
		setCompletedSteps,
		setTotalSteps,
		setStreamingToolCalls,
		cancelledMessageIdsRef,
		executionIdRef,
		shouldClearOnNextDeltaRef,
		needsTextSeparatorRef,
		prevToolCallsRef,
		completedStepIdsRef,
		hasTurnOutputRef,
		isTransitioningFromApprovalRef,
		latestApprovalIdRef,
		showAiUsageLimitToastRef,
		notifyPartykitStepStart,
	} = ctx;
	// Freeze gate (decision 12 /): once the user has clicked
	// Stop on this turn, every subsequent SSE event for it is
	// dropped client-side so the `Stopped` caption is honoured
	// even while the workflow finishes its tear-down.
	if (cancelledMessageIdsRef.current.has(assistantMessageId)) {
		return;
	}

	switch (data.type) {
		case "started":
			setState((prev) => ({
				...prev,
				executionId: data.executionId,
				turnId:
					typeof data.turnId === "string" ? data.turnId : prev.turnId,
				turnGeneration:
					typeof data.turnGeneration === "number"
						? data.turnGeneration
						: prev.turnGeneration,
			}));
			// The resume loop in `sendMessage` can't read
			// `state.executionId` — see `executionIdRef`.
			executionIdRef.current = data.executionId;
			if (data.resumed) {
				// Reconnected mid-run: the text deltas that were in
				// flight when the previous window closed are gone for
				// good (Redis pub/sub doesn't replay). Appending the
				// post-resume deltas onto what survived would splice
				// two halves together across a silent hole, and
				// `completed`'s `data.response || m.content` fallback
				// would then preserve the gapped text. So the body has
				// to be replaced rather than extended (issue #2269).
				//
				// Defer that replacement instead of clearing here: the
				// server sends this handshake before it polls, so a
				// transport that dies just after it is the very shape
				// the retry loop exists for — and an immediate clear
				// would have already destroyed the only copy of the
				// prior windows' output, leaving the exhaustion path to
				// freeze an empty message. Reusing the hook's
				// defer-clear flag means the first post-resume delta
				// replaces the whole body (still no splice), a
				// `completed.response` replaces it wholesale, and if
				// neither ever arrives the old content survives.
				shouldClearOnNextDeltaRef.current = true;
				needsTextSeparatorRef.current = false;
			}
			break;

		case "phase":
			setCurrentPhase(data.phase);
			break;

		case "routing":
			setState((prev) => ({
				...prev,
				result: {
					...prev.result,
					routingDecision: {
						primaryAgent: data.primaryAgent,
						agentName: data.agentName,
						confidence: data.confidence,
						riskLevel: data.riskLevel,
						requiredConnections: data.requiredConnections,
						missingIntegrations: data.missingIntegrations,
						blockedOnConnections: data.blockedOnConnections,
					},
				},
			}));
			break;

		case "planning":
			if (data.plan) {
				const plan = toTaskPlan(data.plan);
				setState((prev) => ({
					...prev,
					plan,
				}));
				setTotalSteps(plan.steps.length);
			}
			setCurrentPhase("planning");
			break;

		case "step_start":
			setCurrentPhase("executing");
			// Reset streaming tool calls for new step
			setStreamingToolCalls([]);
			// Reset the comparison ref so new tool calls are properly detected
			prevToolCallsRef.current = "";
			// Notify PartyKit of step change to synchronize state and prevent tool call bleeding
			// This clears PartyKit tool calls from the previous step
			notifyPartykitStepStart(data.stepId);
			setCurrentStep({
				id: data.stepId,
				description: data.description,
				type: "agent",
				order: data.order,
				status: "in_progress",
			});
			// Update plan step status to in_progress
			setState((prev) => {
				if (!prev.plan) {
					return prev;
				}
				const updatedSteps = prev.plan.steps.map((s) =>
					s.id === data.stepId
						? { ...s, status: "in_progress" as const }
						: s,
				);
				return {
					...prev,
					plan: { ...prev.plan, steps: updatedSteps },
				};
			});
			break;

		case "step_complete": {
			if (data.response || data.toolCalls?.length) {
				hasTurnOutputRef.current = true;
			}
			// Add the completed step with its tool calls AND response
			const stepStatus = (data.status || "complete") as
				| "complete"
				| "error"
				| "skipped";
			const completedStep: StreamingStepResult = {
				stepId: data.stepId,
				stepDescription: data.stepDescription,
				status: stepStatus,
				response: data.response,
				toolCalls: (data.toolCalls || []).map((tc, idx) => ({
					id: tc.id || `tc-${data.stepId}-${idx}`,
					name: tc.name,
					// Reject the truncation sentinel here so a
					// fallback path in route.ts (when progress
					// query fails / returns empty) can't clobber
					// MCP App args with garbage. See
					// `safeToolField` doc.
					args: safeToolField(tc.args),
					result: safeToolField(tc.result) ?? null,
					status: (tc.status || "success") as "success" | "error",
					durationMs: tc.durationMs ?? 0,
					mcpAppResourceUri: tc.mcpAppResourceUri,
					mcpAppConfigId: tc.mcpAppConfigId,
				})),
				durationMs: data.durationMs ?? 0,
			};

			setStepResults((prev) => {
				// Replace any existing step with same ID, or add new
				const filtered = prev.filter((s) => s.stepId !== data.stepId);
				return [...filtered, completedStep];
			});

			// Clear streaming tool calls — BUT preserve any with MCP App UIs
			// so the McpAppFrame iframe stays mounted (avoids blank flash
			// while the completed step's McpAppFrame re-initializes).
			// The completed step section renders its own McpAppFrame,
			// but keeping the streaming one prevents an unmount/remount cycle.
			setStreamingToolCalls((prev) => {
				const mcpAppCalls = prev.filter(
					(tc) => tc.mcpAppResourceUri && tc.mcpAppConfigId,
				);
				return mcpAppCalls.length > 0 ? mcpAppCalls : [];
			});
			// `setStepResults` above replaces by stepId, so a replayed
			// step is harmless there — a bare increment is not. Count
			// each stepId once so a resumed stream, which re-emits
			// every completed step, doesn't inflate the progress
			// readout (issue #2269).
			if (!completedStepIdsRef.current.has(data.stepId)) {
				completedStepIdsRef.current.add(data.stepId);
				setCompletedSteps((prev) => prev + 1);
			}
			setCurrentStep(null);

			// Update plan step status to complete/error/skipped
			setState((prev) => {
				if (!prev.plan) {
					return prev;
				}
				const updatedSteps = prev.plan.steps.map((s) =>
					s.id === data.stepId ? { ...s, status: stepStatus } : s,
				);
				return {
					...prev,
					plan: { ...prev.plan, steps: updatedSteps },
				};
			});
			break;
		}

		case "text_start": {
			// New iteration starting - defer clearing until first text_delta arrives
			// This prevents a blank flash between iterations while tool calls execute
			shouldClearOnNextDeltaRef.current = true;
			break;
		}

		case "text_delta": {
			// Append streaming text delta to the assistant message content
			if (data.content) {
				// If a new iteration started (text_start received), clear old content
				// on the first delta so there's no blank flash between iterations
				const shouldReplace = shouldClearOnNextDeltaRef.current;
				if (shouldReplace) {
					shouldClearOnNextDeltaRef.current = false;
					// A replacement starts a fresh text run, so a
					// pending tool-boundary separator refers to content
					// that is being discarded. Left set, it would splice
					// a `\n\n` into the middle of this run on the very
					// next delta.
					needsTextSeparatorRef.current = false;
				}
				// When a tool event interrupted the previous text run,
				// prepend a paragraph break so the post-tool text
				// doesn't merge into the pre-tool text. Only applies
				// when there's existing content AND the boundary
				// isn't already whitespace on either side.
				const needsSeparator =
					needsTextSeparatorRef.current && !shouldReplace;
				if (needsSeparator) {
					needsTextSeparatorRef.current = false;
				}
				setMessages((prev) =>
					prev.map((m) => {
						if (m.id !== assistantMessageId) {
							return m;
						}
						if (shouldReplace) {
							return { ...m, content: data.content };
						}
						const existing = m.content || "";
						const incoming = data.content;
						const separator =
							needsSeparator &&
							existing.length > 0 &&
							!/\s$/.test(existing) &&
							!/^\s/.test(incoming)
								? "\n\n"
								: "";
						return {
							...m,
							content: existing + separator + incoming,
						};
					}),
				);
			}
			break;
		}

		case "tool_start": {
			const toolName = data.toolName ?? data.name;
			if (!toolName) {
				break;
			}

			// Mark a text-segment boundary so the next text_delta
			// arriving on this assistant message gets a paragraph
			// break before it (avoids "pattern.Onion" sentence
			// merges across pre-tool / post-tool runs).
			needsTextSeparatorRef.current = true;

			const newToolCall: ToolCallState = {
				id: data.toolCallId || `tc-${Date.now()}-${toolName}`,
				name: toolName,
				args: data.args,
				status: data.status || "running",
				mcpAppResourceUri: data.mcpAppResourceUri,
				mcpAppConfigId: data.mcpAppConfigId,
			};

			setStreamingToolCalls((prev) =>
				mergeStreamingToolCall(prev, newToolCall),
			);
			break;
		}

		case "tool_input": {
			const toolName = data.toolName ?? data.name;
			if (!toolName) {
				break;
			}

			const newToolCall: ToolCallState = {
				id: data.toolCallId || `tc-${Date.now()}-${toolName}`,
				name: toolName,
				args: data.args,
				status: data.status || "pending",
				mcpAppResourceUri: data.mcpAppResourceUri,
				mcpAppConfigId: data.mcpAppConfigId,
			};

			setStreamingToolCalls((prev) =>
				mergeStreamingToolCall(prev, newToolCall),
			);
			break;
		}

		case "tool_result": {
			const status = data.status === "error" ? "error" : "complete";
			const toolName = data.toolName ?? data.name;
			if (!toolName) {
				break;
			}

			hasTurnOutputRef.current = true;

			const newToolCall: ToolCallState = {
				id: data.toolCallId || `tc-${Date.now()}-${toolName}`,
				name: toolName,
				args: data.args,
				result: data.result,
				status,
				durationMs: data.durationMs,
				mcpAppResourceUri: data.mcpAppResourceUri,
				mcpAppConfigId: data.mcpAppConfigId,
			};
			setStreamingToolCalls((prev) =>
				mergeStreamingToolCall(prev, newToolCall),
			);
			break;
		}

		case "limit_signal": {
			// Record a provider or internal budget signal so
			// the dashboard can render a LimitBanner + TokenBudgetCard.
			const signal = data.signal as LimitSignalSummary | undefined;
			if (!signal || !signal.kind) {
				break;
			}
			setState((prev) => ({
				...prev,
				limitSignals: [...prev.limitSignals, signal],
				tokenBudget:
					signal.kind === "internal_budget" && signal.budget
						? signal.budget
						: prev.tokenBudget,
			}));
			break;
		}

		case "context_compacted": {
			const event: ContextCompactionEvent = {
				iteration: Number(data.iteration ?? 0),
				compactedTurns: Number(data.compactedTurns ?? 0),
				summaryChars: Number(data.summaryChars ?? 0),
				historyLengthBefore: Number(data.historyLengthBefore ?? 0),
				timestamp: new Date().toISOString(),
			};
			setState((prev) => ({
				...prev,
				contextCompactions: [...prev.contextCompactions, event],
			}));
			break;
		}

		case "progress":
			setCompletedSteps(data.completedSteps || 0);
			setTotalSteps(data.totalSteps || 0);
			if (data.message) {
				setProgressMessage(data.message);
			}
			if (data.phase) {
				// Prevent race condition: when transitioning from approval, ignore
				// progress events that would reset us back to awaiting_approval
				// until we receive a non-approval phase from the server
				if (isTransitioningFromApprovalRef.current) {
					if (data.phase !== "awaiting_approval") {
						// Server has acknowledged the approval - clear the flag
						isTransitioningFromApprovalRef.current = false;
						setCurrentPhase(data.phase);
					}
					// Skip setting phase if still awaiting_approval during transition
				} else {
					setCurrentPhase(data.phase);
				}
			}
			break;

		case "approval_required":
			// Reset transition flag - we're waiting for approval again
			isTransitioningFromApprovalRef.current = false;
			latestApprovalIdRef.current = data.approvalId ?? null;
			setCurrentPhase("awaiting_approval");
			setState((prev) => ({
				...prev,
				status: "awaiting_approval",
				pendingApproval: {
					approvalId: data.approvalId,
					stepId: data.stepId,
					reason: data.reason,
				},
			}));
			break;

		case "approval_resolved":
			// Approval was granted - execution is resuming
			// Clear the transition flag since server has confirmed
			isTransitioningFromApprovalRef.current = false;
			setCurrentPhase("executing");
			setState((prev) => ({
				...prev,
				status: "running",
				pendingApproval: null,
			}));
			break;

		case "clarifying_question":
			// Orchestrator is paused waiting for the user to answer a
			// clarifying question (HITL sibling of approval).
			setCurrentPhase("awaiting_approval");
			setState((prev) => ({
				...prev,
				status: "awaiting_approval",
				pendingClarification: {
					clarificationId:
						typeof data.clarificationId === "string"
							? data.clarificationId
							: "",
					stepId:
						typeof data.stepId === "string"
							? data.stepId
							: undefined,
					question:
						typeof data.question === "string"
							? data.question
							: "Could you clarify how you'd like me to proceed?",
					options: Array.isArray(data.options)
						? (data.options.filter(
								(o: unknown) => typeof o === "string",
							) as string[])
						: undefined,
				},
			}));
			break;

		case "clarifying_resolved":
			setCurrentPhase("executing");
			setState((prev) => ({
				...prev,
				status: "running",
				pendingClarification: null,
			}));
			break;

		case "completed": {
			// `data.status` is the run's DOMAIN status: a stopped turn
			// completes in Temporal with status "cancelled" and must be
			// shown as cancelled, not as a finished answer.
			const domainStatus: "completed" | "cancelled" | "failed" =
				data.status === "cancelled"
					? "cancelled"
					: data.status === "failed"
						? "failed"
						: "completed";
			const turnCancelled = domainStatus === "cancelled";
			setCurrentPhase("complete");
			setState((prev) => ({
				...prev,
				approvalHistory: data.approvalHistory,
				status: domainStatus,
				result: {
					...prev.result,
					response: data.response,
					status: data.status,
					truncated: parseTurnTruncation(data.truncated),
				},
				plan: data.plan ? toTaskPlan(data.plan) : prev.plan,
				variables: data.variables || {},
				pendingApproval: null,
				planningAudit: data.planningAudit || null,
				artifacts: data.artifacts || [],
				// Final workflow output may carry the accumulated
				// limitSignals (replaces the live SSE-seeded list if present)
				// and the final tokenBudget snapshot for the dashboard.
				limitSignals:
					(data.limitSignals as LimitSignalSummary[]) ??
					prev.limitSignals,
				tokenBudget:
					(data.tokenBudget as typeof prev.tokenBudget) ??
					prev.tokenBudget,
				// "Continue in new chat" handoff signal — frontend renders
				// a CTA above the input box when set. A cancelled turn
				// offers none.
				handoffRecommended: turnCancelled
					? undefined
					: ((data.handoffRecommended as typeof prev.handoffRecommended) ??
						prev.handoffRecommended),
				// The structured token-allowance stop, live or restored
				// from the turn record on a reconnect, kept whatever the
				// status: it is the row's record of what the turn used.
				// Whether a card shows it is decided by the status (a
				// only terminal turns offer continuation; see `budgetStopToShow`).
				budgetStop:
					parseTurnBudgetStop(data.budgetStop) ?? prev.budgetStop,
				// Every plan ran out mid-turn and API billing finished
				// it; the turn's first response could not say so
				// (Fizzy #3048).
				model: readPersistedModel(data),
				apiBilling:
					parseChatGptPlanApiBilling(data.apiBilling) ??
					prev.apiBilling,
			}));

			// Mark assistant message as done streaming and set content
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
						? {
								...m,
								// Set message content from response
								content: data.response || m.content || "",
								streamStatus: "completed",
								isStreaming: false,
								...(turnCancelled
									? {
											streamStatus: "cancelled" as const,
											cancelledAt:
												m.cancelledAt ??
												new Date().toISOString(),
										}
									: {}),
							}
						: m,
				),
			);

			// If we have step results from server that we haven't received via step_complete events,
			// add them (this handles workflows that don't emit per-step events)
			setStepResults((prev) => {
				// If we already have step results with tool calls, keep them
				if (
					prev.length > 0 &&
					prev.some((s) => s.toolCalls?.length > 0 || s.response)
				) {
					return prev;
				}
				// If server sent stepResults, use them
				if (data.stepResults && data.stepResults.length > 0) {
					return data.stepResults.map(
						(sr): StreamingStepResult => ({
							stepId: sr.stepId,
							stepDescription: sr.stepDescription,
							status: (sr.status || "complete") as
								| "complete"
								| "error"
								| "skipped",
							response: sr.response,
							toolCalls: (sr.toolCalls || []).map((tc, idx) => ({
								id: tc.id || `tc-${sr.stepId}-${idx}`,
								name: tc.name,
								// Reject sentinel — see
								// `safeToolField` doc.
								args: safeToolField(tc.args),
								result: safeToolField(tc.result) ?? null,
								status: (tc.status || "success") as
									| "success"
									| "error",
								durationMs: tc.durationMs ?? 0,
								mcpAppResourceUri: tc.mcpAppResourceUri,
								mcpAppConfigId: tc.mcpAppConfigId,
							})),
							durationMs: sr.durationMs ?? 0,
						}),
					);
				}
				// Fallback: build a single step from all tool calls
				if (data.toolCalls && data.toolCalls.length > 0) {
					return [
						{
							stepId: "execution",
							stepDescription: "Task execution",
							status: "complete" as const,
							response: data.response,
							toolCalls: data.toolCalls.map((tc, idx) => ({
								id: tc.id || `tc-final-${idx}`,
								name: tc.name,
								// Reject sentinel — this fallback
								// fires when no progress query
								// data was available, so the
								// `data.toolCalls` here is the
								// truncated workflow output.
								args: safeToolField(tc.args),
								result: safeToolField(tc.result) ?? null,
								status: (tc.status || "success") as
									| "success"
									| "error",
								durationMs: tc.durationMs ?? 0,
								mcpAppResourceUri: tc.mcpAppResourceUri,
								mcpAppConfigId: tc.mcpAppConfigId,
							})),
							durationMs: data.totalDurationMs || 0,
						},
					];
				}
				return prev;
			});

			// Clear streaming state
			setStreamingToolCalls([]);
			setCurrentStep(null);
			setIsLoading(false);
			break;
		}

		case "error": {
			if (data.approvalHistory) {
				setState((prev) => ({
					...prev,
					approvalHistory: data.approvalHistory,
				}));
			}
			// AI usage-limit short-circuit. When the chokepoint blocks mid-stream
			// the route emits a structured SSE error event with
			// `code: "AI_USAGE_LIMIT_EXCEEDED"`. Render the
			// shared destructive toast and clear the streaming
			// placeholder so the user is not left with a
			// generic "Error:" stub.
			if (data.code === "AI_USAGE_LIMIT_EXCEEDED") {
				const payload = isAiUsageLimitExceededPayload(data?.data)
					? data.data
					: isAiUsageLimitExceededPayload(data)
						? data
						: null;
				if (payload) {
					showAiUsageLimitToastRef.current(payload);
				}
				setCurrentPhase("idle");
				setProgressMessage("");
				setCurrentStep(null);
				setStreamingToolCalls(
					(prev) => settleUnfinishedToolCalls(prev) ?? prev,
				);
				const hadTurnOutput = hasTurnOutputRef.current;
				setMessages((prev) =>
					prev.flatMap((message) => {
						if (message.id !== assistantMessageId) {
							return [message];
						}
						// Keep earlier work; only the empty streaming placeholder is removed.
						if (
							!message.content.trim() &&
							!message.toolCalls?.length &&
							!hadTurnOutput
						) {
							return [];
						}
						return [
							{
								...message,
								isStreaming: false,
								isError: true,
								streamStatus: "error" as const,
								toolCalls: settleUnfinishedToolCalls(
									message.toolCalls,
								),
							},
						];
					}),
				);
				setIsLoading(false);
				setState((prev) => ({
					...prev,
					status: "idle",
					budgetStop:
						parseTurnBudgetStop(data.budgetStop) ?? prev.budgetStop,
				}));
				break;
			}
			setCurrentPhase("error");
			// A failed run cannot finish the calls it left open; leave
			// them spinning and they read as still working (F11).
			setStreamingToolCalls(
				(prev) => settleUnfinishedToolCalls(prev) ?? prev,
			);
			// Handle both `error` and `message` field names for compatibility
			const errorMessage = data.error || data.message || "Unknown error";
			setState((prev) => ({
				...prev,
				status: "failed",
				result: {
					...prev.result,
					error: errorMessage,
				},
				// The turn row's stored token-allowance stop, which the
				// route sends on a failed turn's `error` event, live and
				// on a reconnect, exactly as on a `completed` one. Kept
				// as the record of what the turn used; a failed turn
				// uses terminal status for its card (`budgetStopToShow`).
				budgetStop:
					parseTurnBudgetStop(data.budgetStop) ?? prev.budgetStop,
			}));

			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
						? {
								...m,
								content: m.content || `Error: ${errorMessage}`,
								streamStatus: "error",
								isError: true,
								isStreaming: false,
							}
						: m,
				),
			);

			setIsLoading(false);
			break;
		}
	}
}

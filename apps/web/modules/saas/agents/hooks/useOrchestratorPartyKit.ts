"use client";

/**
 * useOrchestratorPartyKit
 *
 * React hook for real-time orchestrator updates via PartyKit WebSocket.
 * Provides instant tool execution updates without polling.
 *
 * Usage:
 * ```tsx
 * const { toolCalls, currentPhase, isConnected } = useOrchestratorPartyKit({
 *   executionId: "orch-xxx-xxx",
 *   enabled: isExecuting,
 * });
 * ```
 */

import { useSession } from "@saas/auth/hooks/use-session";
import { useScopedPartyKitConnection } from "@saas/shared/hooks/use-scoped-partykit-connection";
import { useCallback, useRef, useState } from "react";

interface PartykitToolCall {
	id: string;
	name: string;
	serverName?: string;
	args?: unknown;
	result?: unknown;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	error?: string;
	mcpAppResourceUri?: string;
	mcpAppConfigId?: string;
}

interface StepProgress {
	stepId: string;
	stepDescription: string;
	phase: "starting" | "loading_tools" | "executing" | "processing_results";
	toolCalls: PartykitToolCall[];
	partialResponse?: string;
	stepIndex?: number;
	totalSteps?: number;
	message?: string;
}

interface OrchestratorMessage {
	type:
		| "tool_start"
		| "tool_input"
		| "tool_complete"
		| "step_progress"
		| "step_complete"
		| "phase_change"
		| "heartbeat"
		| "error"
		| "completed";
	executionId: string;
	timestamp: number;
	data: Record<string, unknown>;
}

export interface UseOrchestratorPartyKitOptions {
	executionId: string | null;
	enabled?: boolean;
	onToolStart?: (stepId: string, tool: PartykitToolCall) => void;
	onToolComplete?: (stepId: string, tool: PartykitToolCall) => void;
	onStepProgress?: (progress: StepProgress) => void;
	onPhaseChange?: (phase: string, message?: string) => void;
}

export interface UseOrchestratorPartyKitResult {
	isConnected: boolean;
	currentStepId: string | null;
	currentPhase: string | null;
	stepProgress: StepProgress | null;
	toolCalls: PartykitToolCall[];
	messages: OrchestratorMessage[];
	reset: () => void;
	/** Notify PartyKit of step change from SSE to synchronize state and prevent tool call bleeding */
	notifyStepStart: (stepId: string) => void;
}

const LOG_TAG = "OrchestratorPartyKit";

/** The orchestrator token route names the room `executionId`. */
function buildTokenBody(roomId: string): Record<string, unknown> {
	return { executionId: roomId };
}

/**
 * 401/403 are decisions, not glitches. 404 joins them here: the executionId
 * always comes from a workflow that already started, so a missing workflow is
 * terminal (unlike the task-agent plan row, which Temporal writes
 * asynchronously).
 */
function isTerminalTokenStatus(status: number): boolean {
	return status === 401 || status === 403 || status === 404;
}

function stableStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function statusRank(status: PartykitToolCall["status"]): number {
	switch (status) {
		case "pending":
			return 0;
		case "running":
			return 1;
		case "complete":
		case "error":
			return 2;
	}
}

/**
 * The orchestrator's `buildWorkflowOutput` truncates oversized non-MCP-App
 * tool call args/results to a sentinel string. Although PartyKit publishes
 * mid-execution from `state.toolCalls` (full data, before the workflow
 * output is truncated), some publish paths can echo a payload that has
 * already passed through the truncation. Rejecting the sentinel here is
 * cheap defense-in-depth — it lets MCP App iframes (Excalidraw) keep the
 * live full args even if the truncated value ever shows up downstream.
 */
function isTruncatedSentinel(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("[Object truncated,");
}

function mergeToolCall(
	existing: PartykitToolCall,
	incoming: PartykitToolCall,
): PartykitToolCall {
	const existingArgsString = stableStringify(existing.args);
	const incomingArgsString = stableStringify(incoming.args);
	const useIncomingArgs =
		incoming.args !== undefined &&
		!isTruncatedSentinel(incoming.args) &&
		incompleteArgsString(incomingArgsString, existingArgsString);

	const useIncomingResult =
		incoming.result !== undefined && !isTruncatedSentinel(incoming.result);

	const existingStatusRank = statusRank(existing.status);
	const incomingStatusRank = statusRank(incoming.status);

	return {
		...existing,
		...incoming,
		args: useIncomingArgs ? incoming.args : existing.args,
		result: useIncomingResult ? incoming.result : existing.result,
		status:
			incomingStatusRank >= existingStatusRank
				? incoming.status
				: existing.status,
	};
}

function incompleteArgsString(incoming: string, existing: string): boolean {
	if (incoming === "" || incoming === "{}" || incoming === "[]") {
		return existing === "" || existing === "{}" || existing === "[]";
	}
	return true;
}

function mergeToolCallLists(
	current: PartykitToolCall[],
	incoming: PartykitToolCall[],
): PartykitToolCall[] {
	if (incoming.length === 0) {
		return current;
	}

	const currentById = new Map(current.map((tool) => [tool.id, tool]));
	const mergedFromIncoming = incoming.map((tool) => {
		const existing = currentById.get(tool.id);
		return existing ? mergeToolCall(existing, tool) : tool;
	});

	const incomingIds = new Set(incoming.map((tool) => tool.id));
	const carryForward = current.filter((tool) => !incomingIds.has(tool.id));

	return [...mergedFromIncoming, ...carryForward];
}

export function useOrchestratorPartyKit(
	options: UseOrchestratorPartyKitOptions,
): UseOrchestratorPartyKitResult {
	const {
		executionId,
		enabled = true,
		onToolStart,
		onToolComplete,
		onStepProgress,
		onPhaseChange,
	} = options;

	const { user } = useSession();
	const [currentStepId, setCurrentStepId] = useState<string | null>(null);
	const [currentPhase, setCurrentPhase] = useState<string | null>(null);
	const [stepProgress, setStepProgress] = useState<StepProgress | null>(null);
	const [toolCalls, setToolCalls] = useState<PartykitToolCall[]>([]);
	const [messages, setMessages] = useState<OrchestratorMessage[]>([]);

	// Track previous step ID to detect step changes and reset tool calls
	const prevStepIdRef = useRef<string | null>(null);

	// Store callbacks in refs to prevent handleMessage from changing when
	// parent re-renders with new inline callback references. This prevents
	// the WebSocket effect from reconnecting on every render cycle.
	const onToolStartRef = useRef(onToolStart);
	const onToolCompleteRef = useRef(onToolComplete);
	const onStepProgressRef = useRef(onStepProgress);
	const onPhaseChangeRef = useRef(onPhaseChange);
	onToolStartRef.current = onToolStart;
	onToolCompleteRef.current = onToolComplete;
	onStepProgressRef.current = onStepProgress;
	onPhaseChangeRef.current = onPhaseChange;

	const reset = useCallback(() => {
		setCurrentStepId(null);
		setCurrentPhase(null);
		setStepProgress(null);
		setToolCalls([]);
		setMessages([]);
		prevStepIdRef.current = null;
	}, []);

	// Allow external code to notify of a step change (e.g., from SSE events)
	// This helps synchronize PartyKit state with SSE state to prevent tool call bleeding
	const notifyStepStart = useCallback((stepId: string) => {
		// If this is a new step, clear tool calls from previous step
		if (
			prevStepIdRef.current !== null &&
			prevStepIdRef.current !== stepId
		) {
			setToolCalls([]);
		}
		prevStepIdRef.current = stepId;
		setCurrentStepId(stepId);
	}, []);

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const message = JSON.parse(event.data) as OrchestratorMessage;
				setMessages((prev) => [...prev.slice(-99), message]); // Keep last 100 messages

				switch (message.type) {
					case "tool_start": {
						const { stepId, toolCall } = message.data as {
							stepId: string;
							toolCall: PartykitToolCall;
						};
						// Reset tool calls when step changes to prevent accumulation across steps
						const isNewStep =
							prevStepIdRef.current !== null &&
							prevStepIdRef.current !== stepId;
						if (isNewStep) {
							setToolCalls([toolCall]);
						} else {
							// Don't add duplicates - step_progress will provide the
							// authoritative list. tool_start is just for quick UI updates.
							// Check by ID first, then by operation (name + args) to handle retries
							setToolCalls((prev) => {
								// First check by ID
								const existingById = prev.find(
									(t) => t.id === toolCall.id,
								);
								if (existingById) {
									return prev.map((t) =>
										t.id === toolCall.id
											? { ...t, ...toolCall }
											: t,
									);
								}
								// Then check by operation (name + args) to avoid duplicates from retries
								const argsKey = toolCall.args
									? JSON.stringify(toolCall.args)
									: "";
								const existingByOp = prev.find((t) => {
									const tArgsKey = t.args
										? JSON.stringify(t.args)
										: "";
									return (
										t.name === toolCall.name &&
										tArgsKey === argsKey
									);
								});
								if (existingByOp) {
									// Update existing with newer data if status is more complete
									return prev.map((t) => {
										const tArgsKey = t.args
											? JSON.stringify(t.args)
											: "";
										if (
											t.name === toolCall.name &&
											tArgsKey === argsKey
										) {
											return { ...t, ...toolCall };
										}
										return t;
									});
								}
								return [...prev, toolCall];
							});
						}
						prevStepIdRef.current = stepId;
						setCurrentStepId(stepId);
						onToolStartRef.current?.(stepId, toolCall);
						break;
					}

					case "tool_input": {
						const { stepId, toolCall } = message.data as {
							stepId: string;
							toolCall: PartykitToolCall;
						};
						setToolCalls((prev) => {
							const existing = prev.find(
								(t) => t.id === toolCall.id,
							);
							if (!existing) {
								return [...prev, toolCall];
							}
							return prev.map((t) =>
								t.id === toolCall.id
									? mergeToolCall(t, toolCall)
									: t,
							);
						});
						prevStepIdRef.current = stepId;
						setCurrentStepId(stepId);
						break;
					}

					case "tool_complete": {
						const { stepId, toolCall } = message.data as {
							stepId: string;
							toolCall: PartykitToolCall;
						};
						setToolCalls((prev) => {
							const existing = prev.find(
								(t) => t.id === toolCall.id,
							);
							if (!existing) {
								return [...prev, toolCall];
							}
							return prev.map((t) =>
								t.id === toolCall.id
									? mergeToolCall(t, toolCall)
									: t,
							);
						});
						onToolCompleteRef.current?.(stepId, toolCall);
						break;
					}

					case "step_progress": {
						const data = message.data as {
							stepId: string;
							stepDescription: string;
							phase:
								| "starting"
								| "loading_tools"
								| "executing"
								| "processing_results";
							toolCalls?: PartykitToolCall[];
							partialResponse?: string;
							stepIndex?: number;
							totalSteps?: number;
							message?: string;
						};
						const progress: StepProgress = {
							stepId: data.stepId,
							stepDescription: data.stepDescription,
							phase: data.phase,
							toolCalls: data.toolCalls || [],
							partialResponse: data.partialResponse,
							stepIndex: data.stepIndex,
							totalSteps: data.totalSteps,
							message: data.message,
						};

						// Check if this is a new step - reset tool calls to only this step's tools
						const isNewStep =
							prevStepIdRef.current !== null &&
							prevStepIdRef.current !== data.stepId;
						prevStepIdRef.current = data.stepId;

						setCurrentStepId(progress.stepId);
						setStepProgress(progress);
						setCurrentPhase(progress.phase);

						// Update tool calls from progress.
						// Merge with local state so newer tool_input deltas are not
						// overwritten by an older heartbeat snapshot.
						if (
							progress.toolCalls &&
							progress.toolCalls.length > 0
						) {
							setToolCalls((prev) =>
								isNewStep
									? progress.toolCalls
									: mergeToolCallLists(
											prev,
											progress.toolCalls || [],
										),
							);
						} else if (isNewStep) {
							// New step with no tool calls - clear previous step's tool calls
							setToolCalls([]);
						}
						onStepProgressRef.current?.(progress);
						break;
					}

					case "step_complete": {
						setCurrentStepId(null);
						setStepProgress(null);
						// Don't reset toolCalls - they're part of the completed step
						break;
					}

					case "phase_change": {
						const { phase, message: phaseMessage } =
							message.data as {
								phase: string;
								message?: string;
							};
						setCurrentPhase(phase);
						onPhaseChangeRef.current?.(phase, phaseMessage);
						break;
					}

					case "completed":
					case "error":
						// Execution finished - keep tool calls for display
						setCurrentStepId(null);
						setStepProgress(null);
						break;
				}
			} catch (error) {
				console.warn(`[${LOG_TAG}] Failed to parse message:`, error);
			}
		},
		// No deps needed - callbacks are read from stable refs
		[],
	);

	const { isConnected } = useScopedPartyKitConnection({
		roomId: executionId,
		userId: user?.id,
		enabled,
		party: "orchestrator",
		tokenEndpoint: "/api/orchestrator/token",
		buildTokenBody,
		isTerminalTokenStatus,
		logTag: LOG_TAG,
		onMessage: handleMessage,
	});

	return {
		isConnected,
		currentStepId,
		currentPhase,
		stepProgress,
		toolCalls,
		messages,
		reset,
		notifyStepStart,
	};
}

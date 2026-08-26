"use client";

/**
 * useTaskAgentPartyKit
 *
 * React hook for real-time task agent updates via PartyKit WebSocket.
 * Provides instant step execution updates without polling.
 */

import { useSession } from "@saas/auth/hooks/use-session";
import { useScopedPartyKitConnection } from "@saas/shared/hooks/use-scoped-partykit-connection";
import { useCallback, useRef, useState } from "react";

interface AgentStep {
	id: string;
	name: string;
	type: "agent" | "tool" | "approval" | "tool_call" | "tool_result";
	status:
		| "pending"
		| "running"
		| "completed"
		| "failed"
		| "awaiting_approval";
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	error?: string;
	toolName?: string;
	toolArgs?: unknown;
	result?: { url?: string; [key: string]: unknown };
	thinking?: string;
	serverName?: string;
}

interface CheckpointData {
	stepId: string;
	tool: string;
	action: string;
	data: Record<string, unknown>;
}

interface TaskAgentMessage {
	type:
		| "agent_started"
		| "step_added"
		| "step_updated"
		| "tool_start"
		| "tool_complete"
		| "checkpoint"
		| "checkpoint_resolved"
		| "agent_thinking"
		| "agent_response"
		| "agent_completed"
		| "agent_failed"
		| "agent_cancelled";
	planId: string;
	timestamp: number;
	data: Record<string, unknown>;
}

export interface UseTaskAgentPartyKitOptions {
	planId: string | null;
	enabled?: boolean;
	onStepAdded?: (step: AgentStep) => void;
	onStepUpdated?: (stepId: string, updates: Partial<AgentStep>) => void;
	onCheckpoint?: (checkpoint: CheckpointData) => void;
	onThinking?: (turnIndex: number, partialText: string) => void;
	onCompleted?: (result: { success: boolean; summary?: string }) => void;
	onFailed?: (error: string) => void;
}

export interface UseTaskAgentPartyKitResult {
	isConnected: boolean;
	steps: AgentStep[];
	currentCheckpoint: CheckpointData | null;
	thinkingText: string;
	status:
		| "idle"
		| "running"
		| "checkpoint"
		| "completed"
		| "failed"
		| "cancelled";
	messages: TaskAgentMessage[];
	reset: () => void;
}

const LOG_TAG = "TaskAgentPartyKit";

/** The task-agent token route names the room `planId`. */
function buildTokenBody(roomId: string): Record<string, unknown> {
	return { planId: roomId };
}

/**
 * 401/403 are decisions, not glitches — never retry them.
 *
 * 404 is deliberately not terminal here: the TaskWorkflowPlan row is written by
 * a Temporal activity after start-agent returns the planId, so a miss right
 * after start is a race worth retrying. It is NOT a transport failure though —
 * the server answered — so it can never end in a token-less connect.
 */
function isTerminalTokenStatus(status: number): boolean {
	return status === 401 || status === 403;
}

export function useTaskAgentPartyKit(
	options: UseTaskAgentPartyKitOptions,
): UseTaskAgentPartyKitResult {
	const {
		planId,
		enabled = true,
		onStepAdded,
		onStepUpdated,
		onCheckpoint,
		onThinking,
		onCompleted,
		onFailed,
	} = options;

	const { user } = useSession();
	const [steps, setSteps] = useState<AgentStep[]>([]);
	const [currentCheckpoint, setCurrentCheckpoint] =
		useState<CheckpointData | null>(null);
	const [thinkingText, setThinkingText] = useState("");
	const [status, setStatus] =
		useState<UseTaskAgentPartyKitResult["status"]>("idle");
	const [messages, setMessages] = useState<TaskAgentMessage[]>([]);

	// Store callbacks in refs so handleMessage stays stable. Consumers
	// (TaskAgentButton, TaskModal) pass inline closures, so depending on them
	// directly would tear down and rebuild the socket — replaying every stored
	// message — on each parent render.
	const onStepAddedRef = useRef(onStepAdded);
	const onStepUpdatedRef = useRef(onStepUpdated);
	const onCheckpointRef = useRef(onCheckpoint);
	const onThinkingRef = useRef(onThinking);
	const onCompletedRef = useRef(onCompleted);
	const onFailedRef = useRef(onFailed);
	onStepAddedRef.current = onStepAdded;
	onStepUpdatedRef.current = onStepUpdated;
	onCheckpointRef.current = onCheckpoint;
	onThinkingRef.current = onThinking;
	onCompletedRef.current = onCompleted;
	onFailedRef.current = onFailed;

	const reset = useCallback(() => {
		setSteps([]);
		setCurrentCheckpoint(null);
		setThinkingText("");
		setStatus("idle");
		setMessages([]);
	}, []);

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const message = JSON.parse(event.data) as TaskAgentMessage;
				setMessages((prev) => [...prev.slice(-199), message]);

				switch (message.type) {
					case "agent_started": {
						setStatus("running");
						setSteps([]);
						setCurrentCheckpoint(null);
						setThinkingText("");
						break;
					}

					case "step_added": {
						const { step } = message.data as { step: AgentStep };
						setSteps((prev) => [...prev, step]);
						onStepAddedRef.current?.(step);
						break;
					}

					case "step_updated": {
						const { stepId, updates } = message.data as {
							stepId: string;
							updates: Partial<AgentStep>;
						};
						setSteps((prev) =>
							prev.map((s) =>
								s.id === stepId ? { ...s, ...updates } : s,
							),
						);
						onStepUpdatedRef.current?.(stepId, updates);
						break;
					}

					case "tool_start": {
						const { stepId, tool: _tool } = message.data as {
							stepId: string;
							tool: { id: string; name: string };
						};
						setSteps((prev) =>
							prev.map((s) =>
								s.id === stepId
									? { ...s, status: "running" }
									: s,
							),
						);
						break;
					}

					case "tool_complete": {
						const { stepId, tool } = message.data as {
							stepId: string;
							tool: {
								status: "completed" | "failed";
								error?: string;
							};
						};
						setSteps((prev) =>
							prev.map((s) =>
								s.id === stepId
									? {
											...s,
											status:
												tool.status === "completed"
													? "completed"
													: "failed",
											error: tool.error,
										}
									: s,
							),
						);
						break;
					}

					case "checkpoint": {
						const { checkpoint } = message.data as {
							checkpoint: CheckpointData;
						};
						setCurrentCheckpoint(checkpoint);
						setStatus("checkpoint");
						onCheckpointRef.current?.(checkpoint);
						break;
					}

					case "checkpoint_resolved": {
						setCurrentCheckpoint(null);
						setStatus("running");
						break;
					}

					case "agent_thinking": {
						const { turnIndex, partialText } = message.data as {
							turnIndex: number;
							partialText: string;
						};
						setThinkingText(partialText);
						onThinkingRef.current?.(turnIndex, partialText);
						break;
					}

					case "agent_response": {
						setThinkingText("");
						break;
					}

					case "agent_completed": {
						const { result } = message.data as {
							result: { success: boolean; summary?: string };
						};
						setStatus("completed");
						setCurrentCheckpoint(null);
						onCompletedRef.current?.(result);
						break;
					}

					case "agent_failed": {
						const { error } = message.data as { error: string };
						setStatus("failed");
						setCurrentCheckpoint(null);
						onFailedRef.current?.(error);
						break;
					}

					case "agent_cancelled": {
						setStatus("cancelled");
						setCurrentCheckpoint(null);
						break;
					}
				}
			} catch (error) {
				console.warn(`[${LOG_TAG}] Failed to parse message:`, error);
			}
		},
		// No deps needed - callbacks are read from stable refs
		[],
	);

	const { isConnected } = useScopedPartyKitConnection({
		roomId: planId,
		userId: user?.id,
		enabled,
		party: "task-agent",
		tokenEndpoint: "/api/task-agent/token",
		buildTokenBody,
		isTerminalTokenStatus,
		logTag: LOG_TAG,
		onMessage: handleMessage,
	});

	return {
		isConnected,
		steps,
		currentCheckpoint,
		thinkingText,
		status,
		messages,
		reset,
	};
}

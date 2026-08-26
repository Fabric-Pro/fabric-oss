"use client";

/**
 * useWorkflowTemplateStream
 * React hook for streaming workflow template executions (like Deep Researcher).
 * Uses SSE to receive real-time progress updates from Temporal workflows.
 * Features:
 * - SSE streaming for real-time updates
 * - Sub-agent progress tracking
 * - Iteration tracking for goal-oriented execution
 * - Graceful cancellation
 */

import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";

// Types matching the Deep Researcher workflow
export interface SubAgentResult {
	subTaskId: string;
	title: string;
	status: "completed" | "failed" | "timeout";
	findings: string;
	sources: string[];
	confidence: number;
	duration: number;
	error?: string;
}

export interface KeyFinding {
	theme: string;
	findings: string[];
	confidence: number;
}

interface ResearchCitation {
	source: string;
	sourceType: "rag" | "web" | "sub-agent";
	relevance?: number;
}

interface ResearchReportSection {
	heading: string;
	content: string;
	citations: ResearchCitation[];
}

export interface StructuredResearchReport {
	title: string;
	executiveSummary: string;
	sections: ResearchReportSection[];
	methodology: string;
	citedSources: ResearchCitation[];
}

export type WorkflowPhase =
	| "idle"
	| "initializing"
	| "analyzing_complexity"
	| "awaiting_clarification"
	| "decomposing"
	| "executing_subagents"
	| "aggregating"
	| "evaluating"
	| "iterating"
	| "completed"
	| "failed"
	| "cancelled";

export interface WorkflowTemplateState {
	executionId: string | null;
	status: "idle" | "running" | "completed" | "failed" | "cancelled";
	phase: WorkflowPhase;
	message: string;
	complexity: "simple" | "medium" | "complex" | null;
	progress: {
		subAgentsTotal: number;
		subAgentsCompleted: number;
		subAgentsFailed: number;
		clarificationPrompt?: string;
		subTaskTitles?: string[];
	};
	iteration: {
		current: number;
		max: number;
	};
	subAgentResults: SubAgentResult[];
	result: {
		text: string | null;
		summary: string | null;
		keyFindings: KeyFinding[];
		sources: string[];
		iterations: number;
		goalAchieved: boolean;
		duration: number;
		structuredReport?: StructuredResearchReport | null;
	} | null;
	error: string | null;
}

export interface UseWorkflowTemplateStreamOptions {
	templateSlug: string;
	instanceId?: string;
	organizationId?: string | null;
	maxSubAgents?: number;
	maxIterations?: number;
	successCriteria?: string;
	reasoningEffort?: "none" | "light" | "medium" | "high";
}

const initialState: WorkflowTemplateState = {
	executionId: null,
	status: "idle",
	phase: "idle",
	message: "",
	complexity: null,
	progress: {
		subAgentsTotal: 0,
		subAgentsCompleted: 0,
		subAgentsFailed: 0,
	},
	iteration: {
		current: 0,
		max: 3,
	},
	subAgentResults: [],
	result: null,
	error: null,
};

export function useWorkflowTemplateStream(
	options: UseWorkflowTemplateStreamOptions,
) {
	const {
		templateSlug,
		instanceId,
		organizationId,
		maxSubAgents,
		maxIterations,
		successCriteria,
		reasoningEffort,
	} = options;

	// State
	const [state, setState] = useState<WorkflowTemplateState>(initialState);
	const [isLoading, setIsLoading] = useState(false);
	const [query, setQuery] = useState("");

	// Refs
	const abortControllerRef = useRef<AbortController | null>(null);
	const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(
		null,
	);
	const executionIdRef = useRef<string | null>(null);

	// Shared destructive toast for the AI_USAGE_LIMIT_EXCEEDED error
	// code. Captured in a ref so the
	// memoised callbacks below don't have to recreate when the
	// translator identity changes.
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	showAiUsageLimitToastRef.current = showAiUsageLimitToast;

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			abortControllerRef.current?.abort();
			readerRef.current?.cancel();
		};
	}, []);

	/**
	 * Send a query to start the workflow
	 */
	const sendQuery = useCallback(
		async (queryText: string, context?: string) => {
			if (!queryText.trim() || isLoading) {
				return null;
			}

			// Cancel any existing stream
			abortControllerRef.current?.abort();
			readerRef.current?.cancel();

			abortControllerRef.current = new AbortController();

			// Clear executionIdRef to avoid returning stale values
			executionIdRef.current = null;

			setQuery(queryText);
			setIsLoading(true);
			setState((_prev) => ({
				...initialState,
				status: "running",
				phase: "initializing",
				message: "Starting workflow...",
			}));

			try {
				const response = await fetch(
					"/api/agents/workflow-templates/stream",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							templateSlug,
							instanceId,
							query: queryText.trim(),
							context,
							organizationId,
							maxSubAgents,
							maxIterations,
							successCriteria,
							reasoningEffort,
						}),
						signal: abortControllerRef.current.signal,
					},
				);

				if (!response.ok) {
					const error = await response.json();
					// AI usage-limit short-circuit. The workflow-template route does NOT
					// pre-check `getAIModelWithMetadata` itself — the
					// chokepoint runs inside the workflow's activities,
					// so the only AI-usage-limit signal that can reach
					// here is via the generic error-event path. We still
					// detect it on the JSON envelope as a defence-in-
					// depth in case a future change adds the pre-check.
					if (error?.code === "AI_USAGE_LIMIT_EXCEEDED") {
						const payload = isAiUsageLimitExceededPayload(
							error?.data,
						)
							? error.data
							: isAiUsageLimitExceededPayload(error)
								? error
								: null;
						if (payload) {
							showAiUsageLimitToastRef.current(payload);
						}
						setIsLoading(false);
						setState((prev) => ({
							...prev,
							status: "idle",
							phase: "idle",
						}));
						return;
					}
					throw new Error(error.error || "Failed to start workflow");
				}

				// Read SSE stream
				const reader = response.body?.getReader();
				if (!reader) {
					throw new Error("No response body");
				}

				readerRef.current = reader;
				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						break;
					}

					buffer += decoder.decode(value, { stream: true });

					// Process complete SSE events
					const lines = buffer.split("\n");
					buffer = lines.pop() || ""; // Keep incomplete line in buffer

					for (const line of lines) {
						if (line.startsWith("data: ")) {
							try {
								const event = JSON.parse(line.slice(6));
								processEvent(event);
							} catch {
								// Ignore parse errors
							}
						}
					}
				}

				// Return executionId from ref (updated synchronously during SSE processing)
				return executionIdRef.current;
			} catch (error) {
				if ((error as Error).name === "AbortError") {
					return null;
				}

				const errorMessage =
					error instanceof Error
						? error.message
						: "An error occurred";

				setState((prev) => ({
					...prev,
					status: "failed",
					phase: "failed",
					error: errorMessage,
				}));

				setIsLoading(false);
				return null;
			}
		},
		[
			isLoading,
			templateSlug,
			instanceId,
			organizationId,
			maxSubAgents,
			maxIterations,
			successCriteria,
			reasoningEffort,
		],
	);

	/**
	 * Process an SSE event
	 */
	const processEvent = useCallback(
		(event: { type: string; [key: string]: unknown }) => {
			switch (event.type) {
				case "started":
					// Store in ref for immediate access by sendQuery return value
					executionIdRef.current = event.executionId as string;
					setState((prev) => ({
						...prev,
						executionId: event.executionId as string,
						status: "running",
					}));
					break;

				case "phase":
					setState((prev) => ({
						...prev,
						phase: event.phase as WorkflowPhase,
						message: (event.message as string) || prev.message,
						complexity:
							(event.complexity as
								| "simple"
								| "medium"
								| "complex") || prev.complexity,
						progress: {
							...prev.progress,
							clarificationPrompt:
								(event.clarificationPrompt as string) ??
								prev.progress.clarificationPrompt,
							subTaskTitles:
								(event.subTaskTitles as string[]) ??
								prev.progress.subTaskTitles,
						},
					}));
					break;

				case "progress":
					setState((prev) => ({
						...prev,
						phase: (event.phase as WorkflowPhase) ?? prev.phase,
						message: (event.message as string) ?? prev.message,
						progress: {
							subAgentsTotal:
								(event.subAgentsTotal as number) ??
								prev.progress.subAgentsTotal,
							subAgentsCompleted:
								(event.subAgentsCompleted as number) ??
								prev.progress.subAgentsCompleted,
							subAgentsFailed:
								(event.subAgentsFailed as number) ??
								prev.progress.subAgentsFailed,
							clarificationPrompt:
								(event.clarificationPrompt as string) ??
								prev.progress.clarificationPrompt,
							subTaskTitles:
								(event.subTaskTitles as string[]) ??
								prev.progress.subTaskTitles,
						},
						iteration: {
							current:
								(event.currentIteration as number) ??
								prev.iteration.current,
							max:
								(event.maxIterations as number) ??
								prev.iteration.max,
						},
					}));
					break;

				case "iteration":
					setState((prev) => ({
						...prev,
						iteration: {
							current:
								typeof event.current === "number"
									? event.current
									: prev.iteration.current,
							max:
								typeof event.max === "number"
									? event.max
									: prev.iteration.max,
						},
					}));
					break;

				case "sub_agent_complete":
					setState((prev) => {
						const newResult: SubAgentResult = {
							subTaskId: event.subTaskId as string,
							title: event.title as string,
							status: event.status as
								| "completed"
								| "failed"
								| "timeout",
							findings: event.findings as string,
							sources: (event.sources as string[]) || [],
							confidence: (event.confidence as number) || 0,
							duration: (event.duration as number) || 0,
						};

						// Check if we already have this result
						const exists = prev.subAgentResults.some(
							(r) => r.subTaskId === newResult.subTaskId,
						);

						return {
							...prev,
							subAgentResults: exists
								? prev.subAgentResults.map((r) =>
										r.subTaskId === newResult.subTaskId
											? newResult
											: r,
									)
								: [...prev.subAgentResults, newResult],
						};
					});
					break;

				case "completed":
					setState((prev) => ({
						...prev,
						status: "completed",
						phase: "completed",
						result: {
							text: (event.result as string) || null,
							summary: (event.summary as string) || null,
							keyFindings:
								(event.keyFindings as KeyFinding[]) || [],
							sources: (event.sources as string[]) || [],
							iterations: (event.iterations as number) || 0,
							goalAchieved:
								(event.goalAchieved as boolean) || false,
							duration: (event.duration as number) || 0,
							structuredReport:
								(event.structuredReport as StructuredResearchReport) ||
								null,
						},
						subAgentResults:
							(event.subAgentResults as SubAgentResult[]) ||
							prev.subAgentResults,
					}));
					setIsLoading(false);
					break;

				case "error": {
					// AI usage-limit short-circuit. When the chokepoint blocks during a
					// workflow-template execution, the route may emit a
					// structured SSE error event with the rich payload;
					// render the shared destructive toast and return to
					// idle so the user is not left with a generic
					// "failed" card.
					if (event?.code === "AI_USAGE_LIMIT_EXCEEDED") {
						const data = event?.data;
						const payload = isAiUsageLimitExceededPayload(data)
							? data
							: isAiUsageLimitExceededPayload(event)
								? (event as unknown as Parameters<
										typeof showAiUsageLimitToastRef.current
									>[0])
								: null;
						if (payload) {
							showAiUsageLimitToastRef.current(payload);
						}
						setState((prev) => ({
							...prev,
							status: "idle",
							phase: "idle",
							error: null,
						}));
						setIsLoading(false);
						break;
					}
					setState((prev) => ({
						...prev,
						status: "failed",
						phase: "failed",
						error: (event.message as string) || "Unknown error",
					}));
					setIsLoading(false);
					break;
				}

				case "cancelled":
					setState((prev) => ({
						...prev,
						status: "cancelled",
						phase: "cancelled",
						error: (event.message as string) || "Cancelled",
					}));
					setIsLoading(false);
					break;
			}
		},
		[],
	);

	/**
	 * Cancel the current workflow
	 */
	const cancel = useCallback(async () => {
		// Abort the stream
		abortControllerRef.current?.abort();
		readerRef.current?.cancel();

		// If we have an execution ID, cancel the workflow
		if (state.executionId) {
			try {
				await fetch(
					`/api/agents/workflow-templates/${state.executionId}/cancel`,
					{
						method: "POST",
					},
				);
			} catch {
				// Ignore cancel errors
			}
		}

		setState((prev) => ({
			...prev,
			status: "cancelled",
			phase: "cancelled",
		}));
		setIsLoading(false);
	}, [state.executionId]);

	const sendClarificationResponse = useCallback(
		async (response: string) => {
			if (!state.executionId || !response.trim()) {
				return false;
			}

			const res = await fetch(
				`/api/agents/workflow-templates/${state.executionId}/clarification`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ response: response.trim() }),
				},
			);

			if (!res.ok) {
				const error = await res.json().catch(() => null);
				throw new Error(
					error?.error || "Failed to send clarification response",
				);
			}

			setState((prev) => ({
				...prev,
				message: "Clarification received. Continuing research...",
				progress: {
					...prev.progress,
					clarificationPrompt: undefined,
				},
			}));
			return true;
		},
		[state.executionId],
	);

	/**
	 * Reset all state
	 */
	const reset = useCallback(() => {
		abortControllerRef.current?.abort();
		readerRef.current?.cancel();

		// Clear executionIdRef to avoid returning stale values
		executionIdRef.current = null;

		setState(initialState);
		setIsLoading(false);
		setQuery("");
	}, []);

	/**
	 * Poll for status (fallback when SSE is not working)
	 */
	const pollStatus = useCallback(async () => {
		if (!state.executionId) {
			return null;
		}

		try {
			const response = await fetch(
				`/api/agents/workflow-templates/${state.executionId}`,
			);

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to get status");
			}

			const data = await response.json();

			if (data.status === "completed" && data.result) {
				setState((prev) => ({
					...prev,
					status: "completed",
					phase: "completed",
					result: {
						text: data.result.result || null,
						summary: data.result.summary || null,
						keyFindings: data.result.keyFindings || [],
						sources: data.result.sources || [],
						iterations: data.result.iterations || 0,
						goalAchieved: data.result.goalAchieved || false,
						duration: data.result.duration || 0,
						structuredReport: data.result.structuredReport || null,
					},
					subAgentResults:
						data.result.subAgentResults || prev.subAgentResults,
				}));
				setIsLoading(false);
			} else if (data.status === "failed") {
				setState((prev) => ({
					...prev,
					status: "failed",
					phase: "failed",
					error: data.error || "Workflow failed",
				}));
				setIsLoading(false);
			} else if (data.progress) {
				setState((prev) => ({
					...prev,
					phase: data.progress.phase ?? prev.phase,
					message: data.progress.message ?? prev.message,
					progress: {
						subAgentsTotal:
							typeof data.progress.subAgentsTotal === "number"
								? data.progress.subAgentsTotal
								: prev.progress.subAgentsTotal,
						subAgentsCompleted:
							typeof data.progress.subAgentsCompleted === "number"
								? data.progress.subAgentsCompleted
								: prev.progress.subAgentsCompleted,
						subAgentsFailed:
							typeof data.progress.subAgentsFailed === "number"
								? data.progress.subAgentsFailed
								: prev.progress.subAgentsFailed,
						clarificationPrompt:
							typeof data.progress.clarificationPrompt ===
							"string"
								? data.progress.clarificationPrompt
								: prev.progress.clarificationPrompt,
						subTaskTitles: Array.isArray(
							data.progress.subTaskTitles,
						)
							? data.progress.subTaskTitles
							: prev.progress.subTaskTitles,
					},
					subAgentResults:
						data.subAgentResults ?? prev.subAgentResults,
				}));
			}

			return data;
		} catch (error) {
			console.error("[WorkflowTemplateStream] Poll error:", error);
			return null;
		}
	}, [state.executionId]);

	return {
		// State
		state,
		query,
		isLoading,

		// Actions
		sendQuery,
		cancel,
		reset,
		pollStatus,
		sendClarificationResponse,

		// Computed
		isRunning: state.status === "running",
		isComplete:
			state.status === "completed" ||
			state.status === "failed" ||
			state.status === "cancelled",
		hasResults:
			state.result !== null &&
			(state.result.text !== null ||
				state.result.summary !== null ||
				state.result.keyFindings.length > 0 ||
				state.result.structuredReport !== null),
		progress: {
			...state.progress,
			percentage:
				state.progress.subAgentsTotal > 0
					? Math.round(
							(state.progress.subAgentsCompleted /
								state.progress.subAgentsTotal) *
								100,
						)
					: 0,
		},
	};
}

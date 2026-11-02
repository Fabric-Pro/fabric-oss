import { type AGUIEvent, contentToText, EventType } from "@ag-ui/client";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { z } from "zod";
import type {
	SubAgentResult,
	WorkflowTemplateState,
} from "../hooks/useWorkflowTemplateStream";
import {
	RESEARCH_RUN_EVENT,
	researchProgressSchema,
	researchResultView,
	researchRunRecordSchema,
	researchRunResultSchema,
	subAgentResultSchema,
} from "./research-runtime-protocol";
import { INITIAL_WORKFLOW_TEMPLATE_STATE } from "./workflow-template-state";

/**
 * Deep Research's runtime events as the chat's state: the same
 * `WorkflowTemplateState` the stream route's chat keeps, so the page renders
 * both transports alike. Pure; what the hook must do besides is an effect.
 */

/** What an event asks of the hook beyond the new state. */
type ResearchRuntimeEffect =
	/** A response of a run started (a send, a resume or a reattach). */
	| { kind: "started"; threadId: string; runId: string }
	| { kind: "execution"; executionId: string }
	/** The run asks its clarifying question; the response has ended. */
	| {
			kind: "interrupt";
			interruptId: string;
			message: string;
			expiresAt: string | null;
	  }
	| { kind: "clarificationAccepted" }
	/** The response's window ended; the run did not. */
	| { kind: "reconnect" }
	/** The run ended: completed or cancelled. */
	| { kind: "finished" }
	| { kind: "usageLimit"; payload: AiUsageLimitExceededPayload | null }
	| { kind: "error"; code: string | null; message: string }
	/** A finished run's saved answer was adopted from the thread. */
	| { kind: "restored" };

export interface ResearchRuntimeUpdate {
	state: WorkflowTemplateState;
	/** The run's question, when the event names it. */
	query?: string;
	effect?: ResearchRuntimeEffect;
}

const snapshotSchema = z.object({
	executionId: z.string().optional(),
	progress: researchProgressSchema.nullable().optional(),
});

const executionSchema = z.object({ executionId: z.string() });

const savedMessageSchema = z.object({
	metadata: z
		.object({
			fabric: z
				.object({ metadata: z.object({ research: z.unknown() }) })
				.optional(),
		})
		.optional(),
});

const subAgentErrorSchema = z.object({
	fabric: z.object({ result: subAgentResultSchema }),
});

const usageLimitSchema = z.object({
	fabric: z.object({ data: z.unknown() }),
});

function upsertSubAgent(
	results: readonly SubAgentResult[],
	next: SubAgentResult,
): SubAgentResult[] {
	return results.some((result) => result.subTaskId === next.subTaskId)
		? results.map((result) =>
				result.subTaskId === next.subTaskId ? next : result,
			)
		: [...results, next];
}

/** The state a saved run's record shows, from the thread's saved messages. */
function restoredRun(
	event: Extract<AGUIEvent, { type: EventType.MESSAGES_SNAPSHOT }>,
): ResearchRuntimeUpdate | null {
	const messages = event.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		const saved = savedMessageSchema.safeParse(message);
		const record = researchRunRecordSchema.safeParse(
			saved.success
				? saved.data.metadata?.fabric?.metadata.research
				: undefined,
		);
		if (!record.success) {
			continue;
		}
		const question = messages
			.slice(0, index)
			.reverse()
			.find((candidate) => candidate.role === "user");
		const query = question ? contentToText(question.content) : "";
		const { status, executionId, result, error } = record.data;
		const base = { ...INITIAL_WORKFLOW_TEMPLATE_STATE, executionId };
		switch (status) {
			case "completed":
				return {
					state: {
						...base,
						status: "completed",
						phase: "completed",
						result: result ? researchResultView(result) : null,
						subAgentResults: result?.subAgentResults ?? [],
					},
					query,
					effect: { kind: "restored" },
				};
			case "failed":
				return {
					state: {
						...base,
						status: "failed",
						phase: "failed",
						error: error ?? "Research failed",
					},
					query,
					effect: { kind: "restored" },
				};
			case "cancelled":
				return {
					state: { ...base, status: "cancelled", phase: "cancelled" },
					query,
					effect: { kind: "restored" },
				};
			default: {
				const unhandled: never = status;
				throw new Error(`Unhandled research record: ${unhandled}`);
			}
		}
	}
	return null;
}

function applyRunFinished(
	state: WorkflowTemplateState,
	event: Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>,
): ResearchRuntimeUpdate {
	const outcome = event.outcome;
	if (outcome?.type === "interrupt") {
		const interrupt = outcome.interrupts[0];
		return interrupt
			? {
					state,
					effect: {
						kind: "interrupt",
						interruptId: interrupt.id,
						message: interrupt.message ?? "",
						expiresAt: interrupt.expiresAt ?? null,
					},
				}
			: { state };
	}
	if (outcome?.type === "cancelled") {
		// A run the person stopped here is already shown as stopped.
		return {
			state:
				state.status === "cancelled"
					? state
					: {
							...state,
							status: "cancelled",
							phase: "cancelled",
							error: "Workflow was cancelled",
						},
			effect: { kind: "finished" },
		};
	}
	const result = researchRunResultSchema.safeParse(event.result);
	return {
		state: {
			...state,
			status: "completed",
			phase: "completed",
			result: result.success ? researchResultView(result.data) : null,
			subAgentResults:
				(result.success ? result.data.subAgentResults : undefined) ??
				state.subAgentResults,
		},
		effect: { kind: "finished" },
	};
}

/** Apply one runtime event of a research run to the chat's state. */
export function applyResearchRuntimeEvent(
	state: WorkflowTemplateState,
	event: AGUIEvent,
): ResearchRuntimeUpdate {
	switch (event.type) {
		case EventType.RUN_STARTED: {
			const asked = event.input?.messages[0];
			return {
				state: {
					...state,
					status: "running",
					phase:
						state.phase === "idle" ? "initializing" : state.phase,
				},
				...(asked?.role === "user"
					? { query: contentToText(asked.content) }
					: {}),
				effect: {
					kind: "started",
					threadId: event.threadId,
					runId: event.runId,
				},
			};
		}
		case EventType.STATE_SNAPSHOT: {
			const snapshot = snapshotSchema.safeParse(event.snapshot);
			if (!snapshot.success) {
				return { state };
			}
			const { executionId, progress } = snapshot.data;
			if (!progress) {
				return {
					state: {
						...state,
						executionId: executionId ?? state.executionId,
					},
				};
			}
			return {
				state: {
					...state,
					executionId: executionId ?? state.executionId,
					phase: progress.phase,
					message: progress.message,
					complexity: progress.complexity ?? state.complexity,
					progress: {
						subAgentsTotal: progress.subAgentsTotal,
						subAgentsCompleted: progress.subAgentsCompleted,
						subAgentsFailed: progress.subAgentsFailed,
						clarificationPrompt: progress.clarificationPrompt,
						subTaskTitles: progress.subTaskTitles,
					},
					iteration: {
						current: progress.currentIteration,
						max: progress.maxIterations,
					},
				},
			};
		}
		case EventType.CUSTOM: {
			if (event.name === RESEARCH_RUN_EVENT.execution) {
				const execution = executionSchema.safeParse(event.value);
				return execution.success
					? {
							state: {
								...state,
								executionId: execution.data.executionId,
							},
							effect: {
								kind: "execution",
								executionId: execution.data.executionId,
							},
						}
					: { state };
			}
			if (event.name === RESEARCH_RUN_EVENT.clarificationAccepted) {
				return {
					state: {
						...state,
						message:
							"Clarification received. Continuing research...",
						progress: {
							...state.progress,
							clarificationPrompt: undefined,
						},
					},
					effect: { kind: "clarificationAccepted" },
				};
			}
			if (event.name === RESEARCH_RUN_EVENT.reconnect) {
				return { state, effect: { kind: "reconnect" } };
			}
			return { state };
		}
		case EventType.SUBAGENT_FINISHED: {
			const result = subAgentResultSchema.safeParse(event.result);
			return result.success
				? {
						state: {
							...state,
							subAgentResults: upsertSubAgent(
								state.subAgentResults,
								result.data,
							),
						},
					}
				: { state };
		}
		case EventType.SUBAGENT_ERROR: {
			const failed = subAgentErrorSchema.safeParse(event.metadata);
			return failed.success
				? {
						state: {
							...state,
							subAgentResults: upsertSubAgent(
								state.subAgentResults,
								failed.data.fabric.result,
							),
						},
					}
				: { state };
		}
		case EventType.RUN_FINISHED:
			return applyRunFinished(state, event);
		case EventType.RUN_ERROR: {
			if (event.code === "AI_USAGE_LIMIT_EXCEEDED") {
				const limit = usageLimitSchema.safeParse(event.metadata);
				const data = limit.success ? limit.data.fabric.data : null;
				return {
					state: {
						...state,
						status: "idle",
						phase: "idle",
						error: null,
					},
					effect: {
						kind: "usageLimit",
						payload: isAiUsageLimitExceededPayload(data)
							? data
							: null,
					},
				};
			}
			return {
				state: {
					...state,
					status: "failed",
					phase: "failed",
					error: event.message,
				},
				effect: {
					kind: "error",
					code: event.code ?? null,
					message: event.message,
				},
			};
		}
		case EventType.MESSAGES_SNAPSHOT:
			return restoredRun(event) ?? { state };
		default:
			// Sub-agent starts and text (the findings and the report, which
			// the result carries whole) change nothing shown.
			return { state };
	}
}

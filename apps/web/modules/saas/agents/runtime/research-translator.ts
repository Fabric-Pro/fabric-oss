import { EventType } from "@ag-ui/client";
import type {
	DeepResearcherOutput,
	DeepResearcherPhase,
	DeepResearcherProgress,
	SubAgentResult,
} from "@repo/temporal";
import { researchReportMarkdown } from "@saas/agents/lib/research-report-markdown";
import {
	RESEARCH_CLARIFICATION_WINDOW_MS,
	RESEARCH_INTERRUPT_REASON,
	RESEARCH_RUN_EVENT,
	researchInterruptId,
	researchResultView,
	researchRunResultOf,
	researchTurnMessageIds,
} from "@saas/agents/lib/research-runtime-protocol";
import {
	buildWorkflowErrorEvent,
	type WorkflowErrorEvent,
} from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import type { ResearchRunEnding } from "./research-run-record";
import type { Emit } from "./turn-translator";

/**
 * Where each field of the deep-researcher workflow's output reaches the
 * client. Keyed by the output type, so a new field fails type-check here
 * until it is mapped; the translator's test checks every entry.
 */
export const RESEARCH_RESULT_MAPPING = {
	executionId: `CUSTOM ${RESEARCH_RUN_EVENT.execution} and STATE_SNAPSHOT executionId`,
	status: "RUN_FINISHED (success or cancelled) / RUN_ERROR, and result.status",
	result: "RUN_FINISHED result.result; TEXT_MESSAGE_* (<key>:assistant)",
	summary: "RUN_FINISHED result.summary; TEXT_MESSAGE_* (<key>:assistant)",
	keyFindings:
		"RUN_FINISHED result.keyFindings; TEXT_MESSAGE_* (<key>:assistant)",
	sources: "RUN_FINISHED result.sources; TEXT_MESSAGE_* (<key>:assistant)",
	subAgentResults:
		"SUBAGENT_STARTED / FINISHED / ERROR per sub-task; RUN_FINISHED result.subAgentResults",
	iterations: "RUN_FINISHED result.iterations",
	goalAchieved: "RUN_FINISHED result.goalAchieved",
	duration: "RUN_FINISHED result.duration",
	error: "RUN_ERROR message (RESEARCH_FAILED or AI_USAGE_LIMIT_EXCEEDED)",
	structuredReport:
		"RUN_FINISHED result.structuredReport; TEXT_MESSAGE_* (<key>:assistant)",
	model: "RUN_FINISHED result.model; metadata.research.result.model",
	summaryModel:
		"RUN_FINISHED result.summaryModel; metadata.research.result.summaryModel",
	reportModel:
		"RUN_FINISHED result.reportModel; metadata.research.result.reportModel",
} as const satisfies Record<keyof DeepResearcherOutput, string>;

/**
 * Where each field of the workflow's progress reaches the client: all of it
 * in the run's `state.progress` (STATE_SNAPSHOT), the clarifying question
 * also as the interrupt that ends the response.
 */
export const RESEARCH_PROGRESS_MAPPING = {
	executionId: "state.progress.executionId",
	phase: "state.progress.phase",
	message: "state.progress.message",
	complexity: "state.progress.complexity",
	currentIteration: "state.progress.currentIteration",
	maxIterations: "state.progress.maxIterations",
	subAgentsTotal: "state.progress.subAgentsTotal",
	subAgentsCompleted: "state.progress.subAgentsCompleted",
	subAgentsFailed: "state.progress.subAgentsFailed",
	goalAchieved: "state.progress.goalAchieved",
	timestamp:
		"state.progress.timestamp (not compared); the interrupt's expiresAt",
	clarificationPrompt:
		"state.progress.clarificationPrompt; RUN_FINISHED outcome interrupt message",
	subTaskTitles: "state.progress.subTaskTitles",
} as const satisfies Record<keyof DeepResearcherProgress, string>;

/** Every phase the workflow reports, each carried as the run's `state.progress`. */
export const RESEARCH_PHASES = {
	initializing: "state.progress",
	analyzing_complexity: "state.progress",
	awaiting_clarification: "state.progress",
	decomposing: "state.progress",
	executing_subagents: "state.progress",
	aggregating: "state.progress",
	evaluating: "state.progress",
	iterating: "state.progress",
	completed: "state.progress",
	failed: "state.progress",
	cancelled: "state.progress",
} as const satisfies Record<DeepResearcherPhase, "state.progress">;

/** What the clarifying question's answer must carry. */
const CLARIFICATION_RESPONSE_SCHEMA = {
	type: "object",
	properties: { response: { type: "string", minLength: 1 } },
	required: ["response"],
};

/**
 * One response's AG-UI events for a research run, from the workflow's
 * progress, sub-agent results and output. The workflow reports cumulative
 * state, so a translator sends each sub-agent once and a progress snapshot
 * only when something but its timestamp changed.
 */
export class ResearchRunTranslator {
	private lastProgress: string | null = null;
	private readonly sentSubAgents = new Set<string>();
	private readonly answered: ReadonlySet<string>;

	constructor(
		private readonly run: {
			threadId: string;
			runId: string;
			/** The run's turn key (its first run id). */
			key: string;
			executionId: string;
			emit: Emit;
			/** Interrupts this response's run already answered. */
			answered?: ReadonlySet<string>;
		},
	) {
		this.answered = run.answered ?? new Set();
	}

	/**
	 * A progress poll: a snapshot when it changed, and the clarifying
	 * question as an interrupt that ends the response ("interrupted").
	 */
	progress(progress: DeepResearcherProgress): "interrupted" | "following" {
		const interruptId = researchInterruptId(this.run.key);
		const awaiting = progress.phase === "awaiting_clarification";
		if (awaiting && this.answered.has(interruptId)) {
			// Answered: the phase moves on once the workflow takes it.
			return "following";
		}
		const { timestamp: _timestamp, ...compared } = progress;
		const signature = JSON.stringify(compared);
		if (signature !== this.lastProgress) {
			this.lastProgress = signature;
			this.run.emit({
				type: EventType.STATE_SNAPSHOT,
				snapshot: { executionId: this.run.executionId, progress },
			});
		}
		const prompt = progress.clarificationPrompt;
		if (!awaiting || !prompt) {
			// Without a question to show, the workflow waits out its window
			// and goes on, as the stream route's chat does.
			return "following";
		}
		this.run.emit({
			type: EventType.RUN_FINISHED,
			threadId: this.run.threadId,
			runId: this.run.runId,
			outcome: {
				type: "interrupt",
				interrupts: [
					{
						id: interruptId,
						reason: RESEARCH_INTERRUPT_REASON,
						message: prompt,
						expiresAt: new Date(
							Date.parse(progress.timestamp) +
								RESEARCH_CLARIFICATION_WINDOW_MS,
						).toISOString(),
						responseSchema: CLARIFICATION_RESPONSE_SCHEMA,
					},
				],
			},
		});
		return "interrupted";
	}

	/** Sub-agents that finished since the last call, each as one subagent run. */
	subAgents(results: readonly SubAgentResult[]): void {
		for (const result of results) {
			if (this.sentSubAgents.has(result.subTaskId)) {
				continue;
			}
			this.sentSubAgents.add(result.subTaskId);
			const subagentRunId = `${this.run.executionId}:${result.subTaskId}`;
			this.run.emit({
				type: EventType.SUBAGENT_STARTED,
				subagentRunId,
				name: result.title,
				metadata: { fabric: { subTaskId: result.subTaskId } },
			});
			if (result.findings) {
				const messageId = `${subagentRunId}:findings`;
				this.run.emit({
					type: EventType.TEXT_MESSAGE_START,
					messageId,
					role: "assistant",
					subagentRunId,
				});
				this.run.emit({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId,
					delta: result.findings,
					subagentRunId,
				});
				this.run.emit({
					type: EventType.TEXT_MESSAGE_END,
					messageId,
					subagentRunId,
				});
			}
			if (result.status === "completed") {
				this.run.emit({
					type: EventType.SUBAGENT_FINISHED,
					subagentRunId,
					result,
					outcome: { type: "success" },
				});
			} else {
				this.run.emit({
					type: EventType.SUBAGENT_ERROR,
					subagentRunId,
					message: result.error ?? `Sub-agent ${result.status}`,
					code:
						result.status === "timeout"
							? "SUBAGENT_TIMEOUT"
							: "SUBAGENT_FAILED",
					metadata: { fabric: { result } },
				});
			}
		}
	}

	/** The run's end, once it is saved. */
	finish(ending: ResearchRunEnding): void {
		switch (ending.kind) {
			case "completed": {
				const result = researchRunResultOf(ending.output);
				const messageId = researchTurnMessageIds(
					this.run.key,
				).assistant;
				this.run.emit({
					type: EventType.TEXT_MESSAGE_START,
					messageId,
					role: "assistant",
				});
				this.run.emit({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId,
					delta: researchReportMarkdown(researchResultView(result)),
				});
				this.run.emit({ type: EventType.TEXT_MESSAGE_END, messageId });
				this.run.emit({
					type: EventType.RUN_FINISHED,
					threadId: this.run.threadId,
					runId: this.run.runId,
					outcome: { type: "success" },
					result,
				});
				return;
			}
			case "cancelled":
				this.run.emit({
					type: EventType.RUN_FINISHED,
					threadId: this.run.threadId,
					runId: this.run.runId,
					outcome: { type: "cancelled" },
				});
				return;
			case "failed":
				this.fail(buildWorkflowErrorEvent(ending.message));
				return;
			default: {
				const unhandled: never = ending;
				throw new Error(
					`Unhandled research ending: ${JSON.stringify(unhandled)}`,
				);
			}
		}
	}

	/** A run that failed, as the stream route's error mapping words it. */
	fail(event: WorkflowErrorEvent): void {
		this.run.emit({
			type: EventType.RUN_ERROR,
			message: event.message,
			code: "code" in event ? event.code : "RESEARCH_FAILED",
			metadata: { fabric: event },
		});
	}
}

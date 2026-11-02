/**
 * Deep Research over the agent runtime: the names and shapes its server
 * engine (`modules/saas/agents/runtime/research-*.ts`) and its browser
 * transport (`useResearchRuntimeStream`) agree on. Pure: no client transport
 * and no server module, so either side imports it.
 *
 * | Stream route event or route                      | Agent runtime `deep-researcher`                                         |
 * |--------------------------------------------------|-------------------------------------------------------------------------|
 * | 400/403/404 JSON before streaming                | RUN_ERROR with the body's `code` (`NO_WORKFLOW`, `FORBIDDEN`) or `HTTP_<status>`; `metadata.fabric` = `{status, ...body}`. An `instanceId` is refused earlier as `INVALID_REQUEST` |
 * | `started`                                        | RUN_STARTED (input.messages = the question `<key>:user`); STATE_SNAPSHOT `{executionId, progress: null}`; CUSTOM `fabric.deep-researcher.execution` `{executionId, templateSlug}` |
 * | `phase`, `progress`, `iteration`                 | STATE_SNAPSHOT `{executionId, progress}` whenever anything but `timestamp` changed |
 * | `sub_agent_complete`                             | SUBAGENT_STARTED; scoped TEXT_MESSAGE_* (findings); SUBAGENT_FINISHED `{result}` or SUBAGENT_ERROR `{metadata.fabric.result}`; `subagentRunId` = `<executionId>:<subTaskId>` |
 * | clarify (phase awaiting + prompt; answer = POST `[executionId]/clarification`) | RUN_FINISHED outcome `interrupt` `{id <key>:clarification, reason research_clarification, message, expiresAt, responseSchema}`; the answer is a run with `resume: [{interruptId, status: "resolved", payload: {response}}]` → `signal("clarification")`, acknowledged by CUSTOM `fabric.deep-researcher.clarification-accepted` after RUN_STARTED |
 * | `completed` (COMPLETED, status completed)        | the remaining SUBAGENT_*; TEXT_MESSAGE_* `<key>:assistant` = the report as markdown; RUN_FINISHED `success`, `result` = the `completed` fields |
 * | COMPLETED with status `cancelled`, or not `completed` after a recorded stop; `cancelled` (CANCELLED / TERMINATED) | RUN_FINISHED outcome `cancelled` |
 * | COMPLETED with status `failed` / `timeout` (no stop) | RUN_ERROR `RESEARCH_FAILED`, or `AI_USAGE_LIMIT_EXCEEDED` with `metadata.fabric.data` for a usage-limit message. A deliberate difference: the route sends `completed` |
 * | `error` (FAILED / TIMED_OUT)                     | RUN_ERROR from `buildWorkflowErrorEvent(failure)`                       |
 * | `error` "Execution timed out" (600 s)            | none: the run is followed to its end                                    |
 * | `: ping` heartbeat                               | none: at the window the response sends CUSTOM `fabric.reconnect` `{executionId, runId}` and ends |
 * | POST `[executionId]/cancel`                      | POST `stop/<threadId>` with `{runId}`                                   |
 * | GET `[executionId]` poll                         | `connect` (MESSAGES_SNAPSHOT, then the live tail)                       |
 */
import type {
	DeepResearcherOutput,
	DeepResearcherPhase,
	DeepResearcherProgress,
	SubAgentResult,
} from "@repo/temporal";
import { z } from "zod";
import type { WorkflowTemplateState } from "../hooks/useWorkflowTemplateStream";
import { runtimeCustomEventName } from "./runtime-custom-events";

/** The runtime agent id the research engine serves: the template's slug. */
export const RESEARCH_AGENT_ID = "deep-researcher";

export { RESEARCH_EXECUTION_MODE } from "./conversation-turn-mode";

/** The `CUSTOM` event names a research run carries. */
export const RESEARCH_RUN_EVENT = {
	/** The run's workflow id, as the stream route's `started` event. */
	execution: runtimeCustomEventName(RESEARCH_AGENT_ID, "execution"),
	/** The answer to the clarifying question reached the workflow. */
	clarificationAccepted: runtimeCustomEventName(
		RESEARCH_AGENT_ID,
		"clarification-accepted",
	),
	/** The response's window ended; the run did not. Reconnect with `connect`. */
	reconnect: "fabric.reconnect",
} as const;

/** The reason of the interrupt a clarifying question ends a response with. */
export const RESEARCH_INTERRUPT_REASON = "research_clarification";

/** The interrupt id of a run's clarifying question. */
export function researchInterruptId(turnKey: string): string {
	return `${turnKey}:clarification`;
}

/**
 * How long the workflow waits for the answer before it researches on its
 * best reading of the question: the workflow's
 * `condition(..., "5 minutes")`, deep-researcher.ts.
 */
export const RESEARCH_CLARIFICATION_WINDOW_MS = 5 * 60_000;

/** The ids a run's question and answer are saved under. */
export function researchTurnMessageIds(turnKey: string) {
	return { user: `${turnKey}:user`, assistant: `${turnKey}:assistant` };
}

/**
 * A run's options (`forwardedProps`). The server owns the template, the
 * question and the organization; an agent instance is never named here, so
 * an instance's stored context and workspaces never reach a runtime run.
 */
export const researchRunPropsSchema = z
	.object({
		context: z.string().max(20_000).optional(),
		maxSubAgents: z.number().int().min(1).max(6).optional(),
		maxIterations: z.number().int().min(1).max(3).optional(),
		successCriteria: z.string().max(5_000).optional(),
		reasoningEffort: z.enum(["none", "light", "medium", "high"]).optional(),
		executionMode: z
			.enum(["lite", "balanced", "deep", "planner"])
			.optional(),
	})
	.strict();

/** The `completed` fields of the stream route: a run's RUN_FINISHED `result`. */
export type ResearchRunResult = Pick<
	DeepResearcherOutput,
	| "status"
	| "result"
	| "summary"
	| "keyFindings"
	| "sources"
	| "subAgentResults"
	| "iterations"
	| "goalAchieved"
	| "duration"
	| "structuredReport"
>;

export function researchRunResultOf(
	output: DeepResearcherOutput,
): ResearchRunResult {
	return {
		status: output.status,
		result: output.result,
		summary: output.summary,
		keyFindings: output.keyFindings,
		sources: output.sources,
		subAgentResults: output.subAgentResults,
		iterations: output.iterations,
		goalAchieved: output.goalAchieved,
		duration: output.duration,
		structuredReport: output.structuredReport,
	};
}

type ResearchResultView = NonNullable<WorkflowTemplateState["result"]>;
type ResearchCitation = NonNullable<
	ResearchRunResult["structuredReport"]
>["citedSources"][number];

/** A citation as the result viewer reads it (no relevance rather than null). */
function citationView(citation: ResearchCitation) {
	return { ...citation, relevance: citation.relevance ?? undefined };
}

/**
 * A run's result as the result viewer shows it: the stream route chat's
 * reading of its `completed` event.
 */
export function researchResultView(
	result: ResearchRunResult,
): ResearchResultView {
	const report = result.structuredReport;
	return {
		text: result.result || null,
		summary: result.summary || null,
		keyFindings: result.keyFindings || [],
		sources: result.sources || [],
		iterations: result.iterations || 0,
		goalAchieved: result.goalAchieved || false,
		duration: result.duration || 0,
		structuredReport: report
			? {
					...report,
					sections: report.sections.map((section) => ({
						...section,
						citations: section.citations.map(citationView),
					})),
					citedSources: report.citedSources.map(citationView),
				}
			: null,
	};
}

/** How a run ended, saved with its answer as `metadata.research`. */
export interface ResearchRunRecord {
	status: "completed" | "failed" | "cancelled";
	executionId: string;
	result?: ResearchRunResult;
	error?: string;
}

const subAgentStatusSchema = z.enum(["completed", "failed", "timeout"]);

export const subAgentResultSchema = z.object({
	subTaskId: z.string(),
	title: z.string(),
	status: subAgentStatusSchema,
	findings: z.string(),
	sources: z.array(z.string()),
	confidence: z.number(),
	error: z.string().optional(),
	duration: z.number(),
}) satisfies z.ZodType<SubAgentResult>;

const citationSchema = z.object({
	source: z.string(),
	sourceType: z.enum(["rag", "web", "sub-agent"]),
	sourceNumber: z.number().optional(),
	relevance: z.number().nullable().optional(),
});

export const researchRunResultSchema = z.object({
	status: z.enum(["completed", "failed", "timeout", "cancelled"]),
	result: z.string().optional(),
	summary: z.string().optional(),
	keyFindings: z
		.array(
			z.object({
				theme: z.string(),
				findings: z.array(z.string()),
				confidence: z.number(),
			}),
		)
		.optional(),
	sources: z.array(z.string()).optional(),
	subAgentResults: z.array(subAgentResultSchema).optional(),
	iterations: z.number(),
	goalAchieved: z.boolean(),
	duration: z.number(),
	structuredReport: z
		.object({
			title: z.string(),
			executiveSummary: z.string(),
			sections: z.array(
				z.object({
					heading: z.string(),
					content: z.string(),
					citations: z.array(citationSchema),
				}),
			),
			methodology: z.string(),
			citedSources: z.array(citationSchema),
		})
		.optional(),
}) satisfies z.ZodType<ResearchRunResult>;

export const researchRunRecordSchema = z
	.object({
		status: z.enum(["completed", "failed", "cancelled"]),
		executionId: z.string(),
		result: researchRunResultSchema.optional(),
		error: z.string().optional(),
	})
	.passthrough();

/** Every phase the workflow reports, as the browser reads a progress snapshot. */
const RESEARCH_PHASE_VALUES = [
	"initializing",
	"analyzing_complexity",
	"awaiting_clarification",
	"decomposing",
	"executing_subagents",
	"aggregating",
	"evaluating",
	"iterating",
	"completed",
	"failed",
	"cancelled",
] as const satisfies readonly DeepResearcherPhase[];

export const researchProgressSchema = z.object({
	executionId: z.string(),
	phase: z.enum(RESEARCH_PHASE_VALUES),
	message: z.string(),
	complexity: z.enum(["simple", "medium", "complex"]).optional(),
	currentIteration: z.number(),
	maxIterations: z.number(),
	subAgentsTotal: z.number(),
	subAgentsCompleted: z.number(),
	subAgentsFailed: z.number(),
	goalAchieved: z.boolean(),
	timestamp: z.string(),
	clarificationPrompt: z.string().optional(),
	subTaskTitles: z.array(z.string()).optional(),
}) satisfies z.ZodType<DeepResearcherProgress>;

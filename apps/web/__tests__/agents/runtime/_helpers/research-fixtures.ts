/**
 * Deep Research workflow data for the research engine's tests: a progress
 * poll, sub-agent results and a completed output, shaped as
 * `deepResearcherWorkflow` reports them.
 */
import type {
	DeepResearcherOutput,
	DeepResearcherProgress,
	SubAgentResult,
} from "@repo/temporal";

export const PROGRESS_TIME = "2026-01-05T10:00:00.000Z";

export function researchProgress(
	overrides: Partial<DeepResearcherProgress> = {},
): DeepResearcherProgress {
	return {
		executionId: "wf-user-example-1-deep-researcher-example",
		phase: "executing_subagents",
		message: "Researching",
		complexity: "medium",
		currentIteration: 1,
		maxIterations: 3,
		subAgentsTotal: 2,
		subAgentsCompleted: 0,
		subAgentsFailed: 0,
		goalAchieved: false,
		timestamp: PROGRESS_TIME,
		...overrides,
	};
}

export const CLARIFICATION_PROMPT = "Which market should the research cover?";

/** A run waiting for the answer to its clarifying question. */
export function awaitingClarification(
	overrides: Partial<DeepResearcherProgress> = {},
): DeepResearcherProgress {
	return researchProgress({
		phase: "awaiting_clarification",
		message: "Waiting for your answer",
		clarificationPrompt: CLARIFICATION_PROMPT,
		...overrides,
	});
}

export const SUB_AGENT_DONE: SubAgentResult = {
	subTaskId: "task-1",
	title: "Market size",
	status: "completed",
	findings: "The market grew in the last year.",
	sources: ["https://example.com/market"],
	confidence: 80,
	duration: 1200,
};

export const SUB_AGENT_FAILED: SubAgentResult = {
	subTaskId: "task-2",
	title: "Competitors",
	status: "failed",
	findings: "",
	sources: [],
	confidence: 0,
	error: "The search failed",
	duration: 300,
};

export const SUB_AGENT_TIMED_OUT: SubAgentResult = {
	subTaskId: "task-3",
	title: "Pricing",
	status: "timeout",
	findings: "Partial pricing notes.",
	sources: [],
	confidence: 10,
	duration: 60_000,
};

export function researchOutput(
	overrides: Partial<DeepResearcherOutput> = {},
): DeepResearcherOutput {
	return {
		executionId: "wf-user-example-1-deep-researcher-example",
		status: "completed",
		result: "The full research text.",
		summary: "A short summary.",
		keyFindings: [
			{ theme: "Growth", findings: ["It grew."], confidence: 80 },
		],
		sources: ["https://example.com/market"],
		subAgentResults: [SUB_AGENT_DONE],
		iterations: 1,
		goalAchieved: true,
		duration: 4200,
		structuredReport: {
			title: "Market research",
			executiveSummary: "The market grew.",
			sections: [
				{
					heading: "Growth",
					content: "It grew [1].",
					citations: [
						{
							source: "https://example.com/market",
							sourceType: "web",
							sourceNumber: 1,
							relevance: null,
						},
					],
				},
			],
			methodology: "Two sub-agents searched the web.",
			citedSources: [
				{
					source: "https://example.com/market",
					sourceType: "web",
					sourceNumber: 1,
					relevance: 0.9,
				},
			],
		},
		...overrides,
	};
}

/**
 * The usage-limit refusal of an activity, as the workflow's top-level catch
 * reports it (`deep-researcher-failure-message.test.ts` in the temporal
 * package checks that the workflow produces exactly this text).
 */
export const USAGE_LIMIT_MESSAGE =
	"AI usage limit exceeded: limit-example (TOKENS, DAILY) — used 10 of 5";

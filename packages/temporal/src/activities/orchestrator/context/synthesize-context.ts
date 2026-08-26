/**
 * Context Synthesizer
 *
 * Synthesizes raw research findings and step results into
 * a structured, actionable context for agent consumption.
 */

import { generateText } from "@repo/ai";
import type {
	ResearchResult,
	SynthesizeContextInput,
	SynthesizedContext,
} from "../types";
import { getAiModel } from "../utils";
import { safeParseJson } from "../utils/json-parser";

/**
 * Synthesizes research results and previous step outputs into
 * a structured context ready for agent delegation.
 *
 * This activity:
 * 1. Distills key facts from research
 * 2. Extracts requirements and constraints
 * 3. Provides recommendations based on findings
 * 4. Identifies open questions
 */
export async function synthesizeContext(
	input: SynthesizeContextInput,
): Promise<SynthesizedContext> {
	console.log("[Orchestrator] Synthesizing context from research", {
		researchResultCount: input.researchResults.length,
		previousStepCount: input.previousStepResults.length,
	});

	const model = await getAiModel(input.userId, input.organizationId);

	// Format research for synthesis
	const researchSummary = formatResearchForSynthesis(input.researchResults);
	const previousStepsSummary = formatPreviousSteps(input.previousStepResults);

	const systemPrompt = getSynthesisSystemPrompt();

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt: `Original Task: ${input.originalTask}

## Research Findings
${researchSummary || "No research conducted."}

## Previous Step Results
${previousStepsSummary || "No previous steps."}

Synthesize this information into clear, actionable context.`,
	});

	const content = response.text || "{}";

	// Parse the response
	const parsed = safeParseJson<Partial<SynthesizedContext>>(
		content,
		"object",
	);

	// Build result with defaults
	const result: SynthesizedContext = {
		summary: parsed?.summary || generateFallbackSummary(input),
		keyFacts: normalizeStringArray(parsed?.keyFacts),
		requirements: normalizeStringArray(parsed?.requirements),
		constraints: normalizeStringArray(parsed?.constraints),
		recommendations: normalizeStringArray(parsed?.recommendations),
		openQuestions: normalizeStringArray(parsed?.openQuestions),
	};

	console.log("[Orchestrator] Context synthesized", {
		keyFactsCount: result.keyFacts.length,
		requirementsCount: result.requirements.length,
		hasRecommendations: result.recommendations.length > 0,
	});

	return result;
}

/**
 * Format research results for synthesis prompt.
 */
function formatResearchForSynthesis(results: ResearchResult[]): string {
	if (!results || results.length === 0) {
		return "";
	}

	return results
		.map((r) => {
			const findingsText =
				r.findings.length > 0
					? r.findings
							.slice(0, 5)
							.map(
								(f) =>
									`  - [${f.source}]: ${truncate(f.content, 500)}`,
							)
							.join("\n")
					: "  No findings.";

			const keyFactsText =
				r.keyFacts.length > 0
					? `  Key Facts: ${r.keyFacts.join("; ")}`
					: "";

			return `### Query: "${r.query}"
${r.synthesizedContext ? `Summary: ${truncate(r.synthesizedContext, 300)}` : ""}
Findings:
${findingsText}
${keyFactsText}
Confidence: ${Math.round(r.confidence * 100)}%`;
		})
		.join("\n\n");
}

/**
 * Format previous step results for synthesis prompt.
 */
function formatPreviousSteps(
	steps: SynthesizeContextInput["previousStepResults"],
): string {
	if (!steps || steps.length === 0) {
		return "";
	}

	return steps
		.filter((s) => s.response)
		.map(
			(s) =>
				`**${s.stepDescription}:**\n${truncate(s.response || "", 500)}`,
		)
		.join("\n\n");
}

/**
 * Generate a fallback summary if parsing fails.
 */
function generateFallbackSummary(input: SynthesizeContextInput): string {
	if (input.researchResults.length === 0) {
		return `Task: ${input.originalTask}. No additional context gathered.`;
	}

	const queryTopics = input.researchResults.map((r) => r.query).join(", ");
	return `Research conducted on: ${queryTopics}. See key facts for details.`;
}

/**
 * Normalize a string array from parsed response.
 */
function normalizeStringArray(arr?: unknown): string[] {
	if (!Array.isArray(arr)) {
		return [];
	}
	return arr
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => String(item).trim());
}

/**
 * Truncate text to max length.
 */
function truncate(text: string, maxLength: number): string {
	if (!text || text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}...`;
}

/**
 * System prompt for context synthesis.
 */
function getSynthesisSystemPrompt(): string {
	return `You are a context synthesizer for an AI orchestrator.

Your job is to distill research findings and step results into a clear, actionable context that will be passed to specialized agents.

## Output Format

Return a JSON object with this structure:
{
  "summary": "A 2-3 sentence overview of the key context",
  "keyFacts": [
    "Specific, actionable fact 1",
    "Specific, actionable fact 2"
  ],
  "requirements": [
    "What must be included or achieved",
    "Non-negotiable elements"
  ],
  "constraints": [
    "Limitations to consider",
    "Boundaries that must be respected"
  ],
  "recommendations": [
    "Suggestions based on research",
    "Best practices to follow"
  ],
  "openQuestions": [
    "Things still unclear that may need clarification"
  ]
}

## Guidelines

1. **Summary**: Be concise but capture the essential context
2. **Key Facts**: Extract specific, verifiable information (numbers, names, dates)
3. **Requirements**: What the task MUST include based on research
4. **Constraints**: Limitations discovered (technical, legal, practical)
5. **Recommendations**: Best practices and suggestions from research
6. **Open Questions**: Flag uncertainties for human review

## Quality Standards

- Be SPECIFIC - avoid vague statements
- Be ACTIONABLE - information should guide the next step
- Be CONCISE - remove redundancy
- PRIORITIZE - most important facts first
- CITE sources when possible (e.g., "According to [source]...")

The synthesized context will be passed to agents who need to act on it, so make it immediately useful.`;
}

/**
 * Deep Researcher Aggregation Activities
 *
 * Activities for aggregating sub-agent results and evaluating
 * whether the research goal has been achieved.
 *
 * Uses generateText + manual JSON parsing instead of generateObject to avoid
 * the OpenAI Responses API strict JSON schema validation issue in the
 * Vercel AI Gateway (optional fields break 'required' enforcement).
 */

import { generateText, getAIModelWithMetadata } from "@repo/ai";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import type { SubAgentResult } from "../../workflows/deep-researcher";
import { getAiModel } from "../orchestrator/utils/model-selector";

// =============================================================================
// Heartbeat Helper
// =============================================================================

/**
 * Execute a long-running async operation while sending periodic heartbeats.
 * This prevents Temporal from timing out activities during AI API calls.
 */
async function withHeartbeat<T>(
	operation: Promise<T>,
	intervalMs = 10000,
): Promise<T> {
	const heartbeatInterval = setInterval(() => {
		heartbeat();
	}, intervalMs);

	try {
		return await operation;
	} finally {
		clearInterval(heartbeatInterval);
	}
}

// =============================================================================
// JSON Parsing Helper
// =============================================================================

/**
 * Extract and parse JSON from an LLM text response.
 * Handles markdown code blocks (```json ... ```) and bare JSON objects.
 */
function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = fenced ? fenced[1].trim() : text.trim();
	const start = raw.search(/[{[]/);
	if (start === -1) {
		throw new Error(
			`No JSON object found in response: ${raw.slice(0, 200)}`,
		);
	}
	return JSON.parse(raw.slice(start));
}

// =============================================================================
// Types
// =============================================================================

export interface AggregateResultsInput {
	query: string;
	subAgentResults: SubAgentResult[];
	context?: string;
	userId: string;
	organizationId?: string;
}

export interface AggregateResultsOutput {
	synthesizedResult: string;
	keyThemes: string[];
	overallConfidence: number;
	structuredReport: {
		title: string;
		executiveSummary: string;
		sections: Array<{
			heading: string;
			content: string;
			citations: Array<{
				source: string;
				sourceType: "rag" | "web" | "sub-agent";
				sourceNumber?: number;
				relevance?: number | null;
			}>;
		}>;
		methodology: string;
		citedSources: Array<{
			source: string;
			sourceType: "rag" | "web" | "sub-agent";
			sourceNumber?: number;
			relevance?: number | null;
		}>;
	};
}

export interface EvaluateSuccessInput {
	query: string;
	result: string;
	successCriteria: string;
	userId: string;
	organizationId?: string;
}

export interface EvaluateSuccessOutput {
	goalAchieved: boolean;
	confidence: number;
	feedback: string;
	missingElements?: string[];
}

// =============================================================================
// Schemas (used for validation only — NOT passed to generateObject)
// =============================================================================

const CitationSchema = z.object({
	source: z.string().min(1),
	sourceType: z.enum(["rag", "web", "sub-agent"]),
	sourceNumber: z.number().optional(),
	relevance: z.number().min(0).max(1).nullable().optional(),
});

const StructuredReportSchema = z.object({
	title: z.string().min(1),
	executiveSummary: z.string().min(1),
	sections: z
		.array(
			z.object({
				heading: z.string().min(1),
				content: z.string().min(1),
				citations: z.array(CitationSchema).default([]),
			}),
		)
		.default([]),
	methodology: z.string().min(1),
	citedSources: z.array(CitationSchema).default([]),
});

const EvaluationSchema = z.object({
	goalAchieved: z.boolean(),
	confidence: z.number().min(0).max(100),
	feedback: z.string(),
	missingElements: z.array(z.string()).nullable().optional(),
});

// =============================================================================
// Source Registry
// =============================================================================

interface SourceRegistryEntry {
	number: number;
	source: string;
	sourceType: "web" | "rag";
}

/**
 * Build a deduplicated, numbered source registry from completed sub-agent results.
 * URLs are classified as "web", everything else as "rag" (workspace docs).
 */
function buildSourceRegistry(results: SubAgentResult[]): SourceRegistryEntry[] {
	const seen = new Map<string, SourceRegistryEntry>();
	let counter = 1;
	for (const result of results) {
		if (result.status !== "completed") {
			continue;
		}
		for (const src of result.sources) {
			if (!src || seen.has(src)) {
				continue;
			}
			const isUrl =
				src.startsWith("http://") || src.startsWith("https://");
			seen.set(src, {
				number: counter++,
				source: src,
				sourceType: isUrl ? "web" : "rag",
			});
		}
	}
	return Array.from(seen.values());
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Aggregate and synthesize results from multiple sub-agents.
 *
 * Takes the findings from all sub-agents and creates a coherent,
 * synthesized response that addresses the original research question.
 */
export async function aggregateResults(
	input: AggregateResultsInput,
): Promise<AggregateResultsOutput> {
	console.log("[DeepResearcher] Aggregating results", {
		subAgentCount: input.subAgentResults.length,
		completedCount: input.subAgentResults.filter(
			(r) => r.status === "completed",
		).length,
	});

	// Resolve directly via getAIModelWithMetadata (instead of the getAiModel
	// wrapper, which discards metadata) so the two synthesis generateText calls
	// below can size an explicit output-token budget — a whole synthesized report
	// truncates at Databricks/Anthropic-direct injected defaults without one.
	// Preserves the wrapper's exact behavior: taskType COMPLEX (no tools),
	// complexity "medium", fire-and-forget trackUsage, and the same log line.
	const {
		model,
		metadata: modelMetadata,
		trackUsage,
	} = await getAIModelWithMetadata(
		{
			taskType: "COMPLEX",
			complexity: "medium",
			requiresToolCalling: false,
		},
		{ userId: input.userId, organizationId: input.organizationId },
	);
	console.log(
		`[Orchestrator] Dynamic model selected: ${modelMetadata.modelString} (source: ${modelMetadata.selectionSource}, provider: ${modelMetadata.provider})`,
	);
	trackUsage();

	// Filter to only completed results
	const completedResults = input.subAgentResults.filter(
		(r) => r.status === "completed",
	);

	if (completedResults.length === 0) {
		console.warn("[DeepResearcher] No completed results to aggregate");
		return {
			synthesizedResult:
				"Unable to complete research - all sub-investigations failed.",
			keyThemes: [],
			overallConfidence: 0,
			structuredReport: {
				title: "Research incomplete",
				executiveSummary:
					"All sub-investigations failed, so a reliable report could not be produced.",
				sections: [],
				methodology:
					"The workflow attempted parallel sub-investigations, but none completed successfully.",
				citedSources: [],
			},
		};
	}

	// Build source registry for inline citations
	const sourceRegistry = buildSourceRegistry(completedResults);
	const sourceListText =
		sourceRegistry.length > 0
			? `\n\n## Source Reference List\n${sourceRegistry.map((e) => `[${e.number}] ${e.source}`).join("\n")}\n\nUse [N] inline citation markers in your response when drawing from these sources.`
			: "";

	// Build findings summary with source numbers resolved
	const findingsSummary = completedResults
		.map((r) => {
			const numberedSources = r.sources
				.map((s) => {
					const entry = sourceRegistry.find((e) => e.source === s);
					return entry ? `[${entry.number}] ${s}` : s;
				})
				.join(", ");
			return `## ${r.title}
**Confidence:** ${r.confidence}%
**Sources:** ${numberedSources || "None cited"}

${r.findings}

---`;
		})
		.join("\n\n");

	// Note failed investigations
	const failedResults = input.subAgentResults.filter(
		(r) => r.status !== "completed",
	);
	const failedNote =
		failedResults.length > 0
			? `\n\n**Note:** The following investigations were not completed: ${failedResults.map((r) => r.title).join(", ")}`
			: "";

	const synthesisPrompt = `You are synthesizing findings from multiple parallel research investigations.

## Original Research Question
${input.query}

${input.context ? `## Context\n${input.context}` : ""}
${sourceListText}

## Research Findings from Sub-Investigations

${findingsSummary}
${failedNote}

## Your Task

Synthesize these findings into a comprehensive, well-structured response that:

1. **Addresses the original question directly** - Start with a clear answer
2. **Integrates findings across all investigations** - Don't just concatenate, synthesize
3. **Highlights key themes and patterns** - What are the main takeaways?
4. **Notes areas of agreement and disagreement** - Where do sources align or conflict?
5. **Acknowledges limitations** - What wasn't covered or is uncertain?
6. **Provides actionable conclusions** - What should the reader take away?
${sourceRegistry.length > 0 ? "7. **Cite your sources inline** - Use [N] markers matching the Source Reference List above" : ""}

Structure your response with clear sections and use markdown formatting.`;

	const synthesisSystem = `You are an expert research synthesizer. Your role is to combine findings from multiple research threads into a coherent, comprehensive response.
Be thorough but concise. Use clear structure and formatting.`;
	// Whole synthesized report from short prompts — maximal mode.
	const synthesisMaxOutputTokens = computeMaxOutputTokenBudget(
		modelMetadata,
		{
			promptChars: synthesisSystem.length + synthesisPrompt.length,
		},
	);

	try {
		// Step 1: Generate synthesized prose
		const synthesisResult = await withHeartbeat(
			generateText({
				model,
				system: synthesisSystem,
				prompt: synthesisPrompt,
				...(synthesisMaxOutputTokens !== undefined
					? { maxOutputTokens: synthesisMaxOutputTokens }
					: {}),
			}),
		);

		// Calculate overall confidence (weighted average by findings length)
		const totalWeight = completedResults.reduce(
			(sum, r) => sum + r.findings.length,
			0,
		);
		const weightedConfidence =
			totalWeight > 0
				? completedResults.reduce(
						(sum, r) =>
							sum +
							(r.confidence * r.findings.length) / totalWeight,
						0,
					)
				: 0;

		// Extract key themes from prose
		const keyThemes = extractKeyThemes(synthesisResult.text);

		console.log("[DeepResearcher] Aggregation complete", {
			resultLength: synthesisResult.text.length,
			keyThemesCount: keyThemes.length,
			overallConfidence: Math.round(weightedConfidence),
		});

		// Step 2: Structure the report via generateText + JSON parsing
		const sourceListForReport =
			sourceRegistry.length > 0
				? `\n## Source Reference List\n${sourceRegistry.map((e) => `[${e.number}] ${e.source}`).join("\n")}\n\nIn section content, use [N] inline markers when drawing from the above sources.\n`
				: "";

		const structuredReportPrompt = `You are converting multi-agent research into a structured JSON report.
Only cite sources that appear in the supplied sub-investigation results.
${sourceListForReport}
## Original Question
${input.query}

${input.context ? `## Context\n${input.context}\n\n` : ""}## Synthesized Report
${synthesisResult.text}

## Sub-Agent Findings
${findingsSummary}

Respond ONLY with a JSON object in this exact format (no markdown wrapper, no explanation):
{
  "title": "string — concise report title",
  "executiveSummary": "string — 2-3 sentence summary",
  "sections": [
    {
      "heading": "string",
      "content": "string — markdown formatted, use [N] citation markers inline",
      "citations": [
        { "source": "[1]", "sourceType": "web", "sourceNumber": 1, "relevance": 0.9 }
      ]
    }
  ],
  "methodology": "string — brief description of research approach",
  "citedSources": []
}

Include 2-6 sections. Leave citedSources as an empty array — it will be populated automatically.`;

		// Full structured JSON report from a short prompt — maximal mode.
		const structuredMaxOutputTokens = computeMaxOutputTokenBudget(
			modelMetadata,
			{ promptChars: structuredReportPrompt.length },
		);
		const structuredResult = await withHeartbeat(
			generateText({
				model,
				prompt: structuredReportPrompt,
				...(structuredMaxOutputTokens !== undefined
					? { maxOutputTokens: structuredMaxOutputTokens }
					: {}),
			}),
		);

		const structuredReport = StructuredReportSchema.parse(
			extractJson(structuredResult.text),
		);

		// Override citedSources with the real source registry (don't trust LLM output)
		structuredReport.citedSources = sourceRegistry.map((e) => ({
			source: e.source,
			sourceType: e.sourceType,
			sourceNumber: e.number,
			relevance: undefined,
		}));

		return {
			synthesizedResult: synthesisResult.text,
			keyThemes,
			overallConfidence: Math.round(weightedConfidence),
			structuredReport,
		};
	} catch (error) {
		console.error("[DeepResearcher] Aggregation failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

/**
 * Evaluate whether the research goal has been achieved.
 *
 * Uses an LLM judge to assess if the synthesized result
 * adequately addresses the original research question.
 */
export async function evaluateSuccess(
	input: EvaluateSuccessInput,
): Promise<EvaluateSuccessOutput> {
	console.log("[DeepResearcher] Evaluating success", {
		queryPreview: input.query.slice(0, 100),
		resultLength: input.result.length,
	});

	const model = await getAiModel(input.userId, input.organizationId, false);

	const prompt = `You are evaluating whether a research effort has successfully addressed its goal.

## Research Question
${input.query}

## Success Criteria
${input.successCriteria}

## Research Result
${input.result.slice(0, 8000)}

## Evaluation Guidelines

Assess whether the research result:
1. **Directly addresses the question** - Is the core question answered?
2. **Provides sufficient depth** - Is there enough detail and evidence?
3. **Covers key aspects** - Are all important dimensions addressed?
4. **Is well-sourced** - Are claims supported by evidence or sources?
5. **Is actionable** - Can the reader use this information?

Be strict but fair:
- If the core question is thoroughly answered, consider it achieved
- Minor gaps are acceptable if the main objective is met
- If critical information is missing, it should not be considered achieved

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "goalAchieved": true | false,
  "confidence": number between 0 and 100,
  "feedback": "string — what was good and what could be improved",
  "missingElements": ["string", "..."] | null
}`;

	try {
		const result = await withHeartbeat(
			generateText({
				model,
				prompt,
			}),
		);

		const parsed = EvaluationSchema.parse(extractJson(result.text));

		console.log("[DeepResearcher] Success evaluation complete", {
			goalAchieved: parsed.goalAchieved,
			confidence: parsed.confidence,
		});

		return {
			goalAchieved: parsed.goalAchieved,
			confidence: parsed.confidence,
			feedback: parsed.feedback,
			missingElements: parsed.missingElements ?? undefined,
		};
	} catch (error) {
		console.error("[DeepResearcher] Success evaluation failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract key themes from synthesized text.
 *
 * Looks for section headers and key phrases to identify main themes.
 */
function extractKeyThemes(text: string): string[] {
	const themes = new Set<string>();

	// Extract markdown headers (## and ###)
	const headerPattern = /^#{2,3}\s+(.+)$/gm;
	const headerMatches = text.matchAll(headerPattern);
	for (const match of headerMatches) {
		const header = match[1]?.trim();
		if (
			header &&
			!header.toLowerCase().includes("summary") &&
			!header.toLowerCase().includes("conclusion") &&
			!header.toLowerCase().includes("source") &&
			header.length < 50
		) {
			themes.add(header);
		}
	}

	// Extract key finding bullet points
	const bulletPattern = /^\s*[-*]\s*\*\*([^*]+)\*\*/gm;
	const bulletMatches = text.matchAll(bulletPattern);
	for (const match of bulletMatches) {
		const bullet = match[1]?.trim();
		if (bullet && bullet.length < 50) {
			themes.add(bullet);
		}
	}

	return Array.from(themes).slice(0, 10); // Limit to 10 themes
}

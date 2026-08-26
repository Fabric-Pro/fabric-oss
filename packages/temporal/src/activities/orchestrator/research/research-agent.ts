/**
 * Research Agent
 *
 * An AI SDK V6 powered agent that gathers context before task execution.
 * Uses tool-calling to search the web, query workspaces, and consult agents.
 */

import { generateText, stepCountIs } from "@repo/ai";
import type {
	ExecuteResearchAgentInput,
	ResearchFinding,
	ResearchResult,
} from "../types";
import { getAiModel } from "../utils";
import { buildResearchTools } from "./research-tools";

/**
 * Executes the research agent to gather context for a task.
 *
 * This activity:
 * 1. Builds research tools based on available capabilities
 * 2. Runs AI SDK generateText with tool calling
 * 3. Extracts findings from tool results
 * 4. Synthesizes findings per query
 */
export async function executeResearchAgent(
	input: ExecuteResearchAgentInput,
): Promise<ResearchResult[]> {
	console.log("[Orchestrator] Starting research agent", {
		queryCount: input.researchQueries.length,
		needsCount: input.informationNeeds.length,
		availableToolCount: input.availableTools.length,
		availableAgentCount: input.availableAgents.length,
	});

	// Build research tools
	const researchTools = await buildResearchTools(input);

	if (Object.keys(researchTools).length === 0) {
		console.warn(
			"[Research] No research tools available, returning empty results",
		);
		return input.researchQueries.map((query) => ({
			query,
			findings: [],
			synthesizedContext:
				"No research tools available to gather information.",
			keyFacts: [],
			confidence: 0,
		}));
	}

	const model = await getAiModel(input.userId, input.organizationId, true);
	const maxSteps = input.maxSteps || 10;

	const results: ResearchResult[] = [];

	// Research each query
	for (const query of input.researchQueries) {
		console.log(`[Research] Researching query: "${query}"`);

		try {
			const result = await generateText({
				model,
				system: getResearchAgentSystemPrompt(input),
				prompt: `Research Query: ${query}

This research is for the task: "${input.originalTask}"

Use the available tools to gather comprehensive information. Search the web, scrape relevant pages, and query agents as needed.

After gathering information, provide a summary of your findings.`,
				tools: researchTools as any,
				stopWhen: stepCountIs(maxSteps),
				// Allow multi-tool research workflows (e.g., search → scrape → analyze)
				// stepCountIs(maxSteps) provides the safety limit
			});

			// Extract findings from tool calls
			const findings = extractFindings(result.steps);

			// Build synthesized context from the final response
			const synthesizedContext = result.text || "No synthesis generated.";

			// Extract key facts (simple heuristic: lines starting with - or •)
			const keyFacts = extractKeyFacts(synthesizedContext);

			// Calculate confidence based on findings
			const confidence = calculateConfidence(findings);

			results.push({
				query,
				findings,
				synthesizedContext,
				keyFacts,
				confidence,
			});

			console.log(`[Research] Query complete: ${query}`, {
				findingCount: findings.length,
				keyFactCount: keyFacts.length,
				confidence,
			});
		} catch (error) {
			console.error(`[Research] Query failed: ${query}`, error);

			results.push({
				query,
				findings: [],
				synthesizedContext: `Research failed: ${error instanceof Error ? error.message : String(error)}`,
				keyFacts: [],
				confidence: 0,
			});
		}
	}

	console.log("[Research] Research agent complete", {
		totalResults: results.length,
		totalFindings: results.reduce((sum, r) => sum + r.findings.length, 0),
	});

	return results;
}

/**
 * Extract findings from AI SDK step results.
 */
function extractFindings(steps: unknown[]): ResearchFinding[] {
	const findings: ResearchFinding[] = [];

	for (const step of steps as Array<{
		toolCalls?: Array<{ toolName: string; args: unknown }>;
		toolResults?: Array<{ toolCallId: string; result: unknown }>;
	}>) {
		if (!step.toolResults) {
			continue;
		}

		for (const toolResult of step.toolResults) {
			const result = toolResult.result;

			// Skip error results
			if (isErrorResult(result)) {
				continue;
			}

			// Extract content from the result
			const content = extractContent(result);
			if (!content) {
				continue;
			}

			// Find the matching tool call
			const toolCall = step.toolCalls?.find(
				(tc) =>
					tc.toolName ===
					(toolResult as { toolName?: string }).toolName,
			);
			const toolName =
				(toolResult as { toolName?: string }).toolName ||
				toolCall?.toolName ||
				"unknown";

			findings.push({
				source: toolName,
				content: truncate(content, 2000),
				relevance: 0.8, // Default relevance
				type: determineSourceType(toolName),
			});
		}
	}

	return findings;
}

/**
 * Check if a result is an error.
 */
function isErrorResult(result: unknown): boolean {
	if (!result) {
		return true;
	}
	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		if (obj.error) {
			return true;
		}
		if (typeof obj.success === "boolean" && !obj.success) {
			return true;
		}
	}
	if (typeof result === "string") {
		const lower = result.toLowerCase();
		if (lower.includes("error") && lower.includes("failed")) {
			return true;
		}
	}
	return false;
}

/**
 * Extract string content from various result types.
 */
function extractContent(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (Array.isArray(result)) {
		return result
			.map((item) => extractContent(item))
			.filter(Boolean)
			.join("\n\n");
	}

	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;

		// Try common content fields
		const contentFields = [
			"content",
			"text",
			"markdown",
			"body",
			"data",
			"response",
			"result",
			"output",
			"summary",
		];

		for (const field of contentFields) {
			if (obj[field] && typeof obj[field] === "string") {
				return obj[field] as string;
			}
		}

		// Try nested data
		if (obj.data) {
			return extractContent(obj.data);
		}

		// Fall back to JSON stringification for objects with useful content
		const str = JSON.stringify(result, null, 2);
		if (str.length > 10 && str !== "{}") {
			return str;
		}
	}

	return "";
}

/**
 * Determine source type from tool name.
 */
function determineSourceType(
	toolName: string,
): "web" | "workspace" | "tool" | "agent" {
	const lowerName = toolName.toLowerCase();

	if (
		lowerName.includes("search") ||
		lowerName.includes("firecrawl") ||
		lowerName.includes("scrape") ||
		lowerName.includes("web")
	) {
		return "web";
	}

	if (lowerName.includes("workspace") || lowerName.includes("rag")) {
		return "workspace";
	}

	if (
		lowerName.includes("agent") ||
		lowerName.includes("delegate") ||
		lowerName.includes("query")
	) {
		return "agent";
	}

	return "tool";
}

/**
 * Extract key facts from synthesized text.
 */
function extractKeyFacts(text: string): string[] {
	const facts: string[] = [];
	const lines = text.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();

		// Look for bullet points
		if (
			trimmed.startsWith("-") ||
			trimmed.startsWith("•") ||
			trimmed.startsWith("*")
		) {
			const fact = trimmed.replace(/^[-•*]\s*/, "").trim();
			if (fact.length > 10 && fact.length < 300) {
				facts.push(fact);
			}
		}

		// Look for numbered items
		const numberedMatch = trimmed.match(/^\d+[.)]\s*(.+)/);
		if (numberedMatch?.[1]) {
			const fact = numberedMatch[1].trim();
			if (fact.length > 10 && fact.length < 300) {
				facts.push(fact);
			}
		}
	}

	// Deduplicate and limit
	const unique = [...new Set(facts)];
	return unique.slice(0, 10);
}

/**
 * Calculate confidence based on findings.
 */
function calculateConfidence(findings: ResearchFinding[]): number {
	if (findings.length === 0) {
		return 0;
	}

	// More findings = higher confidence, with diminishing returns
	const findingsScore = Math.min(findings.length / 5, 1) * 0.6;

	// Diverse sources = higher confidence
	const uniqueSources = new Set(findings.map((f) => f.type));
	const diversityScore = (uniqueSources.size / 4) * 0.4;

	return Math.min(findingsScore + diversityScore, 1);
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
 * System prompt for the research agent.
 */
function getResearchAgentSystemPrompt(
	input: ExecuteResearchAgentInput,
): string {
	const informationNeeds = input.informationNeeds
		.map((need) => `- ${need.type}: ${need.description} (${need.priority})`)
		.join("\n");

	return `You are a thorough research agent gathering context for an AI orchestrator.

## Your Goal
Gather comprehensive information for the given research query to help with the task: "${input.originalTask}"

## Information Needs
${informationNeeds || "- General information relevant to the task"}

## Guidelines

1. **Be Thorough**: Use multiple tools when possible to gather diverse information
2. **Be Specific**: Search for specific, actionable information
3. **Verify Quality**: Check if results are relevant before including them
4. **Note Sources**: Keep track of where information comes from
5. **Summarize Well**: After gathering, provide a clear synthesis

## Available Actions
- Use webSearch to find current information, market data, competitor info
- Use webScrape to get detailed content from specific URLs
- Use queryAgent to get expert knowledge from specialized agents

## Output Format
After gathering information, provide:
1. A brief summary of what you found
2. Key facts as bullet points (- or •)
3. Any notable gaps in information

Be concise but comprehensive. Focus on information that will be most useful for the task.`;
}

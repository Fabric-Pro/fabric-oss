/**
 * Deep Researcher Execution Activities
 *
 * Activities for executing sub-agents and direct research.
 * Each sub-agent runs in its own context window for focused investigation.
 */

import { generateText, stepCountIs } from "@repo/ai";
import { db } from "@repo/database";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { heartbeat } from "@temporalio/activity";
import type { SubTask } from "../../workflows/deep-researcher";
import { retrieveWorkspaceDocumentsActivity } from "../direct-chat/rag-retrieval";
import { getAiModel } from "../orchestrator/utils/model-selector";

// =============================================================================
// Heartbeat Helper
// =============================================================================

/**
 * Execute a long-running async operation while sending periodic heartbeats.
 * This prevents Temporal from timing out activities during AI API calls.
 *
 * @param operation - The async operation to execute
 * @param intervalMs - How often to send heartbeats (default: 10 seconds)
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
// Types
// =============================================================================

export interface ExecuteSubAgentInput {
	subTask: SubTask;
	parentQuery: string;
	context?: string;
	userId: string;
	organizationId?: string;
	availableTools?: string[];
	knowledgeSources?: string[];
	workspaceIds?: string[];
	projectId?: string;
	reasoningEffort?: "none" | "light" | "medium" | "high";
	iteration: number;
}

export interface ExecuteSubAgentOutput {
	findings: string;
	sources: string[];
	confidence: number;
}

export interface ExecuteDirectResearchInput {
	query: string;
	context?: string;
	userId: string;
	organizationId?: string;
	availableTools?: string[];
	knowledgeSources?: string[];
	workspaceIds?: string[];
	projectId?: string;
	reasoningEffort?: "none" | "light" | "medium" | "high";
}

export interface ExecuteDirectResearchOutput {
	result: string;
	summary: string;
	sources: string[];
}

// =============================================================================
// RAG Context Helper
// =============================================================================

/**
 * Retrieve relevant documents from attached workspaces using the existing
 * workspace RAG infrastructure. Returns a formatted context string ready
 * for prompt injection, and a list of source references for citation tracking.
 * Returns empty string gracefully if no workspaces are configured or RAG fails.
 */
async function buildRagContext(
	query: string,
	userId: string,
	organizationId?: string,
	workspaceIds?: string[],
): Promise<{
	context: string;
	chunkCount: number;
	sources: Array<{ name: string; type: string; url?: string }>;
}> {
	if (!workspaceIds || workspaceIds.length === 0) {
		return { context: "", chunkCount: 0, sources: [] };
	}

	try {
		const result = await retrieveWorkspaceDocumentsActivity(
			query,
			userId,
			organizationId,
			workspaceIds,
			undefined, // documentIds
			8, // topK — slightly more than default for research depth
			0.3, // minSimilarity — permissive for research
		);

		const sources = (result.sources ?? []).map((s) => ({
			name: s.title ?? "Document",
			type: "workspace",
			url: undefined as string | undefined,
		}));

		return {
			context: result.context,
			chunkCount: result.chunkCount,
			sources,
		};
	} catch (error) {
		console.warn(
			"[DeepResearcher] RAG retrieval failed, proceeding without:",
			error instanceof Error ? error.message : String(error),
		);
		return { context: "", chunkCount: 0, sources: [] };
	}
}

// =============================================================================
// Web Search Tools Helper
// =============================================================================

/**
 * Discover and build web search tools from the user's enabled MCP configs.
 * Looks for Firecrawl, Brave, Tavily, Exa, or any search-capable MCP server.
 * Returns an empty object if none are found (graceful degradation).
 */
async function buildWebSearchTools(
	userId: string,
	organizationId?: string,
): Promise<Record<string, unknown>> {
	const tools: Record<string, unknown> = {};

	try {
		const configs = await db.mCPConfig.findMany({
			where: {
				userId,
				organizationId: organizationId ?? null,
				enabled: true,
			},
			include: { mcpServer: true },
		});

		const searchPatterns = [
			"firecrawl",
			"brave",
			"tavily",
			"exa",
			"serp",
			"search",
		];
		const searchConfigs = configs.filter((config) => {
			const name = (
				config.displayName ||
				config.mcpServer?.name ||
				""
			).toLowerCase();
			return searchPatterns.some((p) => name.includes(p));
		});

		if (searchConfigs.length === 0) {
			return tools;
		}

		// Use first matching search config
		const config = searchConfigs[0];

		const mcpResult = await getCachedMcpClientForConfig({
			configId: config.id,
			userId,
			organizationId,
		});

		if (!mcpResult) {
			return tools;
		}

		// Get AI SDK tools directly from the MCP client (no custom callTool wrapping needed)
		const mcpTools = await mcpResult.client.tools();
		const toolNames = Object.keys(mcpTools);

		// Surface the search tool under a stable "webSearch" key
		const searchToolName = toolNames.find((n) =>
			n.toLowerCase().includes("search"),
		);
		if (searchToolName) {
			tools.webSearch = mcpTools[searchToolName];
		}

		// Surface the scrape/fetch tool under a stable "webFetch" key
		const scrapeToolName = toolNames.find((n) => {
			const l = n.toLowerCase();
			return (
				l.includes("scrape") ||
				l.includes("crawl") ||
				(l.includes("fetch") && !l.includes("search"))
			);
		});
		if (scrapeToolName) {
			tools.webFetch = mcpTools[scrapeToolName];
		}

		console.log(
			`[DeepResearcher] Loaded ${Object.keys(tools).length} web search tools from '${config.displayName}':`,
			Object.keys(tools),
		);
	} catch (e) {
		console.warn(
			"[DeepResearcher] Failed to discover web search tools, proceeding without:",
			e instanceof Error ? e.message : String(e),
		);
	}

	return tools;
}

// =============================================================================
// Constants
// =============================================================================

const RESEARCH_SYSTEM_PROMPT_BASE = `You are a focused research agent. Your task is to investigate a specific aspect of a larger research question.

## Guidelines

1. **Be thorough but focused** - Stay within your assigned scope
2. **Cite sources** - Reference where you found information, including URLs
3. **Assess confidence** - Be honest about uncertainty
4. **Provide actionable findings** - Make your output useful for synthesis

## Output Structure

Provide your findings in clear, structured markdown with:
- Key findings (bullet points)
- Supporting evidence with source URLs
- Confidence level (how certain you are about your findings)
- Sources consulted`;

const RESEARCH_SYSTEM_PROMPT_WITH_SEARCH = `${RESEARCH_SYSTEM_PROMPT_BASE}

## Web Search Instructions

You have access to web search tools. Use them to find CURRENT, up-to-date information:
1. Start with a targeted web search for your focus area
2. If a result looks promising, use webFetch to read the full page
3. Do 2-4 searches to cover different angles of your sub-task
4. Always cite your sources with actual URLs from search results`;

// =============================================================================
// Activities
// =============================================================================

/**
 * Execute a sub-agent for a specific sub-task.
 *
 * Each sub-agent has its own context window and focuses on
 * a specific aspect of the larger research question.
 */
export async function executeSubAgent(
	input: ExecuteSubAgentInput,
): Promise<ExecuteSubAgentOutput> {
	console.log("[DeepResearcher] Executing sub-agent", {
		subTaskId: input.subTask.id,
		title: input.subTask.title,
		iteration: input.iteration,
	});

	const model = await getAiModel(input.userId, input.organizationId, false);

	// Load RAG context and web search tools in parallel
	const [ragResult, searchTools] = await Promise.all([
		buildRagContext(
			`${input.subTask.focusArea}: ${input.subTask.description}`,
			input.userId,
			input.organizationId,
			input.workspaceIds,
		),
		buildWebSearchTools(input.userId, input.organizationId),
	]);

	const hasSearch = Object.keys(searchTools).length > 0;
	const hasRag = ragResult.chunkCount > 0;

	if (hasRag) {
		console.log("[DeepResearcher] RAG context loaded", {
			chunkCount: ragResult.chunkCount,
			workspaceIds: input.workspaceIds,
		});
	}

	// Build the research prompt
	const prompt = `## Your Mission
${input.subTask.description}

## Focus Area
${input.subTask.focusArea}

## Expected Output
${input.subTask.expectedOutput}

## Context
This is part of a larger research effort investigating: "${input.parentQuery}"

${input.context ? `Additional context:\n${input.context}` : ""}

${input.knowledgeSources?.length ? `Available knowledge sources:\n${input.knowledgeSources.map((s) => `- ${s}`).join("\n")}` : ""}
${ragResult.context ? `\n## Internal Knowledge Base\nThe following documents from your organization's knowledge base are relevant to your investigation:\n\n${ragResult.context}` : ""}

## Instructions

1. Investigate thoroughly within your focus area
2. Provide detailed findings with supporting evidence
3. Be explicit about your confidence level (0-100%)
4. List all sources you would consult or reference
5. Stay focused on your specific sub-task

Provide your complete findings now.`;

	try {
		// Wrap the AI call with heartbeats to prevent Temporal timeout
		const result = await withHeartbeat(
			generateText({
				model,
				system: hasSearch
					? RESEARCH_SYSTEM_PROMPT_WITH_SEARCH
					: RESEARCH_SYSTEM_PROMPT_BASE,
				prompt,
				...(hasSearch
					? {
							tools: searchTools as Parameters<
								typeof generateText
							>[0]["tools"],
							stopWhen: stepCountIs(8),
						}
					: {}),
			}),
		);

		// Extract confidence from the response (look for explicit mentions)
		const confidence = extractConfidence(result.text);

		// Extract sources — prefer URLs from tool results if available
		const sources = extractSources(result.text);

		// Merge RAG document sources with web sources extracted from text
		const allSources = [
			...ragResult.sources.map((s) => s.url ?? s.name),
			...sources,
		];

		console.log("[DeepResearcher] Sub-agent completed", {
			subTaskId: input.subTask.id,
			findingsLength: result.text.length,
			confidence,
			sourcesCount: allSources.length,
			usedWebSearch: hasSearch,
			usedRag: hasRag,
			steps: result.steps?.length ?? 0,
		});

		return {
			findings: result.text,
			sources: [...new Set(allSources)],
			confidence,
		};
	} catch (error) {
		console.error("[DeepResearcher] Sub-agent failed", {
			subTaskId: input.subTask.id,
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

/**
 * Execute direct research for simple queries.
 *
 * For simple complexity queries, we don't need to decompose
 * into sub-tasks - we can answer directly.
 */
export async function executeDirectResearch(
	input: ExecuteDirectResearchInput,
): Promise<ExecuteDirectResearchOutput> {
	console.log("[DeepResearcher] Executing direct research", {
		queryPreview: input.query.slice(0, 100),
	});

	const model = await getAiModel(input.userId, input.organizationId, false);

	// Load RAG context and web search tools in parallel
	const [ragResult, searchTools] = await Promise.all([
		buildRagContext(
			input.query,
			input.userId,
			input.organizationId,
			input.workspaceIds,
		),
		buildWebSearchTools(input.userId, input.organizationId),
	]);

	const hasSearch = Object.keys(searchTools).length > 0;
	const hasRag = ragResult.chunkCount > 0;

	if (hasRag) {
		console.log("[DeepResearcher] RAG context loaded for direct research", {
			chunkCount: ragResult.chunkCount,
			workspaceIds: input.workspaceIds,
		});
	}

	const prompt = `## Research Question
${input.query}

${input.context ? `## Context\n${input.context}` : ""}

${input.knowledgeSources?.length ? `## Available Knowledge Sources\n${input.knowledgeSources.map((s) => `- ${s}`).join("\n")}` : ""}
${ragResult.context ? `\n## Internal Knowledge Base\nThe following documents from your organization's knowledge base are relevant to your investigation:\n\n${ragResult.context}` : ""}

## Instructions

This is a relatively straightforward research question. Provide:

1. A comprehensive answer to the question
2. Supporting evidence and reasoning
3. Any caveats or limitations
4. Sources you would consult

Structure your response clearly with sections as appropriate.`;

	try {
		// Wrap the AI call with heartbeats to prevent Temporal timeout
		const result = await withHeartbeat(
			generateText({
				model,
				system: hasSearch
					? RESEARCH_SYSTEM_PROMPT_WITH_SEARCH
					: RESEARCH_SYSTEM_PROMPT_BASE,
				prompt,
				...(hasSearch
					? {
							tools: searchTools as Parameters<
								typeof generateText
							>[0]["tools"],
							stopWhen: stepCountIs(6),
						}
					: {}),
			}),
		);

		// Generate a brief summary (also wrapped with heartbeats)
		const summary = await withHeartbeat(
			generateSummary(model, input.query, result.text),
		);

		// Extract sources and merge with RAG document sources
		const webSources = extractSources(result.text);
		const allSources = [
			...ragResult.sources.map((s) => s.url ?? s.name),
			...webSources,
		];

		console.log("[DeepResearcher] Direct research completed", {
			resultLength: result.text.length,
			summaryLength: summary.length,
			sourcesCount: allSources.length,
			usedRag: hasRag,
		});

		return {
			result: result.text,
			summary,
			sources: [...new Set(allSources)],
		};
	} catch (error) {
		console.error("[DeepResearcher] Direct research failed", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		throw error;
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract confidence level from response text.
 *
 * Looks for explicit confidence mentions like "80% confident" or "confidence: 75%"
 * Defaults to 70 if not found.
 */
function extractConfidence(text: string): number {
	// Look for patterns like "80% confident", "confidence: 75%", "confidence level: 90%"
	const patterns = [
		/(\d{1,3})%\s*confiden/i,
		/confiden[ce|t]+[:\s]+(\d{1,3})%/i,
		/confiden[ce|t]+\s+level[:\s]+(\d{1,3})%/i,
		/certainty[:\s]+(\d{1,3})%/i,
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) {
			const confidence = Number.parseInt(match[1], 10);
			if (confidence >= 0 && confidence <= 100) {
				return confidence;
			}
		}
	}

	// Default confidence if not explicitly stated
	return 70;
}

/**
 * Extract source references from response text.
 *
 * Looks for URLs, citations, and source mentions.
 */
function extractSources(text: string): string[] {
	const sources = new Set<string>();

	// Extract URLs
	const urlPattern = /https?:\/\/[^\s)>\]]+/g;
	const urlMatches = text.match(urlPattern);
	if (urlMatches) {
		for (const url of urlMatches) {
			sources.add(url);
		}
	}

	// Extract source mentions (e.g., "Source: Wikipedia", "According to MDN")
	const sourcePatterns = [
		/Source:\s*([^\n]+)/gi,
		/According to\s+([^\n.,]+)/gi,
		/Referenced from\s+([^\n.,]+)/gi,
		/Based on\s+([^\n.,]+)/gi,
	];

	for (const pattern of sourcePatterns) {
		const matches = text.matchAll(pattern);
		for (const match of matches) {
			if (match[1]?.trim()) {
				sources.add(match[1].trim());
			}
		}
	}

	// Extract markdown link titles
	const linkPattern = /\[([^\]]+)\]\([^)]+\)/g;
	const linkMatches = text.matchAll(linkPattern);
	for (const match of linkMatches) {
		if (match[1]?.trim()) {
			sources.add(match[1].trim());
		}
	}

	return Array.from(sources).slice(0, 20); // Limit to 20 sources
}

/**
 * Generate a brief summary of the research result.
 */
async function generateSummary(
	model: Awaited<ReturnType<typeof getAiModel>>,
	query: string,
	result: string,
): Promise<string> {
	const summaryResult = await generateText({
		model,
		system: "You are a skilled summarizer. Create a concise 2-3 sentence summary.",
		prompt: `Summarize the key findings from this research in 2-3 sentences:

Question: ${query}

Findings:
${result.slice(0, 3000)}

Provide only the summary, no additional commentary.`,
	});

	return summaryResult.text;
}

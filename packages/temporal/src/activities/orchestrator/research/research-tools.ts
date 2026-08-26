/**
 * Research Tools Builder
 *
 * Dynamically builds AI SDK tools for research based on available
 * MCP tools and agents. These tools are used by the research agent
 * to gather context before planning.
 */

import { tool } from "@repo/ai";
import { z } from "zod";
import { delegateToAgent } from "../delegation/delegate-to-agent";
import { executeMcpTool } from "../execution/execute-mcp-tool";
import type { ExecuteResearchAgentInput } from "../types";

/**
 * Builds research tools dynamically based on available capabilities.
 *
 * Creates AI SDK tools for:
 * - Web search (if firecrawl or similar available)
 * - Workspace RAG search (if workspaces configured)
 * - Agent queries (for specialized knowledge)
 */
export async function buildResearchTools(
	input: ExecuteResearchAgentInput,
): Promise<Record<string, unknown>> {
	const tools: Record<string, unknown> = {};

	// Find available search tools
	const searchToolName = getResearchToolName(input.availableTools, "search");
	const scrapeToolName = getResearchToolName(input.availableTools, "scrape");

	// Web search tool
	if (searchToolName) {
		const webSearchSchema = z.object({
			query: z
				.string()
				.describe(
					"Search query - be specific and include relevant keywords",
				),
			maxResults: z
				.number()
				.optional()
				.default(5)
				.describe("Maximum number of results to return"),
		});

		tools.webSearch = tool({
			description:
				"Search the web for information on any topic. Use this to find current information, market data, competitor info, or best practices.",
			inputSchema: webSearchSchema,
			execute: async (params: z.infer<typeof webSearchSchema>) => {
				const { query, maxResults } = params;
				console.log(`[Research] Web search: "${query}"`);
				try {
					const result = await executeMcpTool({
						toolName: searchToolName,
						args: {
							query,
							limit: maxResults,
							num_results: maxResults,
						},
						userId: input.userId,
						organizationId: input.organizationId,
					});

					if (result.success) {
						return result.output;
					}
					return { error: "Search failed", details: result.output };
				} catch (error) {
					console.error("[Research] Web search error:", error);
					return {
						error: "Search failed",
						message:
							error instanceof Error
								? error.message
								: String(error),
					};
				}
			},
		});
	}

	// Web scrape tool
	if (scrapeToolName) {
		const webScrapeSchema = z.object({
			url: z.string().url().describe("URL to scrape"),
			formats: z
				.array(z.enum(["markdown", "text", "html"]))
				.optional()
				.default(["markdown"])
				.describe("Output format"),
		});

		tools.webScrape = tool({
			description:
				"Scrape content from a specific URL. Use this to get detailed information from a webpage.",
			inputSchema: webScrapeSchema,
			execute: async (params: z.infer<typeof webScrapeSchema>) => {
				const { url, formats } = params;
				console.log(`[Research] Scraping URL: ${url}`);
				try {
					const result = await executeMcpTool({
						toolName: scrapeToolName,
						args: { url, formats },
						userId: input.userId,
						organizationId: input.organizationId,
					});

					if (result.success) {
						return result.output;
					}
					return { error: "Scrape failed", details: result.output };
				} catch (error) {
					console.error("[Research] Scrape error:", error);
					return {
						error: "Scrape failed",
						message:
							error instanceof Error
								? error.message
								: String(error),
					};
				}
			},
		});
	}

	// Agent query tool (if agents available)
	if (input.availableAgents.length > 0) {
		const queryAgentSchema = z.object({
			agentId: z
				.string()
				.describe(
					`Agent ID to query. Must be one of: ${input.availableAgents.join(", ")}`,
				),
			question: z
				.string()
				.describe(
					"Question to ask the agent - be specific about what information you need",
				),
		});

		tools.queryAgent = tool({
			description: `Query a specialized agent for domain knowledge. Available agents: ${input.availableAgents.join(", ")}. Use this when you need expert knowledge from a specific agent.`,
			inputSchema: queryAgentSchema,
			execute: async (params: z.infer<typeof queryAgentSchema>) => {
				const { agentId, question } = params;
				if (!input.availableAgents.includes(agentId)) {
					return {
						error: "Agent not available",
						message: `Agent ${agentId} is not in the list of available agents: ${input.availableAgents.join(", ")}`,
					};
				}

				console.log(
					`[Research] Querying agent ${agentId}: "${question}"`,
				);
				try {
					const result = await delegateToAgent({
						agentId,
						message: question,
						delegationMode: "single-step",
						userId: input.userId,
						organizationId: input.organizationId,
						timeout: 60000, // 1 minute for research queries
					});

					if (result.status === "completed") {
						return {
							agentId,
							response: result.response,
							artifacts: result.artifacts,
						};
					}

					return {
						error: "Agent query failed",
						status: result.status,
						response: result.response,
					};
				} catch (error) {
					console.error(
						`[Research] Agent query error (${agentId}):`,
						error,
					);
					return {
						error: "Agent query failed",
						message:
							error instanceof Error
								? error.message
								: String(error),
					};
				}
			},
		});
	}

	// Add any other research-oriented MCP tools
	for (const toolName of input.availableTools) {
		// Skip tools we've already added wrappers for
		if (toolName === searchToolName || toolName === scrapeToolName) {
			continue;
		}

		// Only add tools that look research-oriented
		if (isResearchTool(toolName)) {
			const safeToolName = sanitizeToolName(toolName);

			// Skip if we already have this tool
			if (tools[safeToolName]) {
				continue;
			}

			const mcpToolSchema = z.object({
				args: z
					.record(z.string(), z.unknown())
					.optional()
					.default({})
					.describe("Arguments to pass to the tool"),
			});

			tools[safeToolName] = tool({
				description: `Execute MCP tool: ${toolName}. Use for data gathering and research.`,
				inputSchema: mcpToolSchema,
				execute: async (params: z.infer<typeof mcpToolSchema>) => {
					const { args } = params;
					console.log(`[Research] Executing tool ${toolName}`);
					try {
						const result = await executeMcpTool({
							toolName,
							args: args as Record<string, unknown>,
							userId: input.userId,
							organizationId: input.organizationId,
						});

						return result.success
							? result.output
							: {
									error: "Tool execution failed",
									details: result.output,
								};
					} catch (error) {
						return {
							error: "Tool execution failed",
							message:
								error instanceof Error
									? error.message
									: String(error),
						};
					}
				},
			});
		}
	}

	console.log(
		`[Research] Built ${Object.keys(tools).length} research tools:`,
		Object.keys(tools),
	);

	return tools;
}

/**
 * Checks if a tool name indicates a research-oriented tool.
 */
export function isResearchTool(toolName: string): boolean {
	const researchPatterns = [
		"search",
		"firecrawl",
		"scrape",
		"fetch",
		"get",
		"list",
		"query",
		"find",
		"lookup",
		"browse",
		"crawl",
		"extract",
		"read",
	];

	const lowerName = toolName.toLowerCase();

	// Check for research patterns
	if (researchPatterns.some((pattern) => lowerName.includes(pattern))) {
		return true;
	}

	return false;
}

/**
 * Gets the name of a research tool matching a pattern.
 */
export function getResearchToolName(
	availableTools: string[],
	pattern: "search" | "scrape",
): string | null {
	const priorities: Record<string, string[]> = {
		search: [
			"firecrawl_search",
			"firecrawl-search",
			"web_search",
			"search",
			"google_search",
			"bing_search",
		],
		scrape: [
			"firecrawl_scrape",
			"firecrawl-scrape",
			"firecrawl_scrape_url",
			"scrape_url",
			"scrape",
			"fetch_url",
		],
	};

	const patternPriorities = priorities[pattern] || [];

	// First try to find exact matches in priority order
	for (const name of patternPriorities) {
		if (availableTools.includes(name)) {
			return name;
		}
	}

	// Then try partial matches
	for (const name of patternPriorities) {
		const match = availableTools.find((t) =>
			t.toLowerCase().includes(name.toLowerCase()),
		);
		if (match) {
			return match;
		}
	}

	// Finally try any tool containing the pattern
	const match = availableTools.find((t) => t.toLowerCase().includes(pattern));

	return match || null;
}

/**
 * Sanitizes a tool name for use as a JavaScript identifier.
 */
function sanitizeToolName(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_");
}

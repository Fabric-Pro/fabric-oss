/**
 * Context Requirements Analyzer
 *
 * Analyzes a task to determine what context/research is needed
 * BEFORE planning and execution can begin effectively.
 */

import { generateText } from "@repo/ai";
import type {
	AnalyzeContextRequirementsInput,
	ContextRequirements,
	InformationNeed,
} from "../types";
import { getAiModel } from "../utils";
import { safeParseJson } from "../utils/json-parser";

/**
 * Analyzes a task to determine what context gathering is needed.
 *
 * This activity runs BEFORE routing/planning to identify:
 * - Whether research is needed
 * - What specific queries to run
 * - What information types are required
 * - Which tools/agents can help gather context
 */
export async function analyzeContextRequirements(
	input: AnalyzeContextRequirementsInput,
): Promise<ContextRequirements> {
	console.log("[Orchestrator] Analyzing context requirements for task");

	const model = await getAiModel(input.userId, input.organizationId);

	// Format available capabilities for the prompt
	const capabilityContext = formatCapabilities(
		input.availableAgents,
		input.availableMcpTools,
	);

	const systemPrompt = getContextAnalysisSystemPrompt();

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt: `Task: ${input.message}

Available Capabilities:
${capabilityContext}

${input.workspaceIds && input.workspaceIds.length > 0 ? "Note: User has workspace documents available that can be searched." : ""}

Analyze what context/information is needed BEFORE this task can be properly executed.`,
	});

	const content = response.text || "{}";

	// Parse the response
	const parsed = safeParseJson<Partial<ContextRequirements>>(
		content,
		"object",
	);

	// Build the result with defaults
	const result: ContextRequirements = {
		requiresResearch: parsed?.requiresResearch ?? false,
		researchQueries: parsed?.researchQueries ?? [],
		informationNeeds: normalizeInformationNeeds(parsed?.informationNeeds),
		suggestedTools: parsed?.suggestedTools ?? [],
		suggestedAgents: parsed?.suggestedAgents ?? [],
		estimatedResearchSteps: parsed?.estimatedResearchSteps ?? 0,
	};

	// Apply heuristics for common patterns if AI didn't detect them
	result.requiresResearch =
		result.requiresResearch || shouldRequireResearch(input.message, result);

	console.log("[Orchestrator] Context requirements analyzed", {
		requiresResearch: result.requiresResearch,
		queryCount: result.researchQueries.length,
		needsCount: result.informationNeeds.length,
	});

	return result;
}

/**
 * Heuristic check for tasks that typically need research.
 */
function shouldRequireResearch(
	message: string,
	parsed: ContextRequirements,
): boolean {
	// If already detected, keep it
	if (parsed.requiresResearch) {
		return true;
	}

	const messageLower = message.toLowerCase();

	// Document generation tasks typically need research
	const documentPatterns = [
		"create a prd",
		"write a prd",
		"product requirements",
		"technical spec",
		"market analysis",
		"competitive analysis",
		"research report",
		"business proposal",
		"funding proposal",
		"project proposal",
		"design document",
		"architecture document",
	];

	if (documentPatterns.some((pattern) => messageLower.includes(pattern))) {
		return true;
	}

	// Research-oriented tasks
	const researchPatterns = [
		"research",
		"analyze",
		"compare",
		"evaluate",
		"investigate",
		"find out",
		"learn about",
		"understand",
	];

	if (researchPatterns.some((pattern) => messageLower.includes(pattern))) {
		return true;
	}

	return false;
}

/**
 * Normalize information needs from parsed response.
 */
function normalizeInformationNeeds(
	needs?: Partial<InformationNeed>[],
): InformationNeed[] {
	if (!needs || !Array.isArray(needs)) {
		return [];
	}

	return needs
		.filter((n) => n?.type && n.description)
		.map((n) => ({
			type: n.type as InformationNeed["type"],
			description: n.description || "",
			sources: Array.isArray(n.sources) ? n.sources : ["web"],
			priority: n.priority || "helpful",
		}));
}

/**
 * Format available capabilities for the prompt.
 */
function formatCapabilities(
	agents: Array<{ id: string; name: string; description: string }>,
	tools: string[],
): string {
	const sections: string[] = [];

	if (agents.length > 0) {
		const agentList = agents
			.slice(0, 10)
			.map((a) => `- ${a.name} (${a.id}): ${a.description}`)
			.join("\n");
		sections.push(`**Agents:**\n${agentList}`);
	}

	if (tools.length > 0) {
		// Group tools by likely category
		const searchTools = tools.filter(
			(t) =>
				t.toLowerCase().includes("search") ||
				t.toLowerCase().includes("firecrawl"),
		);
		const otherTools = tools
			.filter((t) => !searchTools.includes(t))
			.slice(0, 15);

		if (searchTools.length > 0) {
			sections.push(
				`**Search/Research Tools:** ${searchTools.join(", ")}`,
			);
		}
		if (otherTools.length > 0) {
			sections.push(`**Other Tools:** ${otherTools.join(", ")}`);
		}
	}

	return sections.join("\n\n") || "No capabilities available";
}

/**
 * System prompt for context analysis.
 */
function getContextAnalysisSystemPrompt(): string {
	return `You are a task preparation analyst for an AI orchestrator.

Your job is to analyze a task and determine what context/information is needed BEFORE the task can be properly executed.

## When Research is Needed

Research IS needed for:
- Creating documents that require domain knowledge (PRDs, specs, proposals)
- Tasks that mention competitors, market, or industry analysis
- Tasks that need best practices or standards
- Tasks that reference external information the user hasn't provided
- Complex technical tasks that need current documentation

Research is NOT needed for:
- Simple CRUD operations (create a Jira issue, list my tasks)
- Tasks where all information is provided in the request
- Direct API calls or tool executions
- Simple conversational responses

## Output Format

Return a JSON object with this structure:
{
  "requiresResearch": boolean,
  "researchQueries": ["specific search query 1", "specific search query 2"],
  "informationNeeds": [
    {
      "type": "market_data" | "competitors" | "best_practices" | "technical_docs" | "user_data" | "domain_knowledge",
      "description": "What specific information is needed",
      "sources": ["web", "workspace", "mcp_tool", "agent"],
      "priority": "required" | "helpful" | "optional"
    }
  ],
  "suggestedTools": ["tool_name_1", "tool_name_2"],
  "suggestedAgents": ["agent_id_1"],
  "estimatedResearchSteps": number
}

## Guidelines

1. Be specific with research queries - they will be used for web search
2. Only mark research as "required" if the task truly cannot proceed without it
3. Suggest tools that can actually help (from the available capabilities)
4. Keep estimatedResearchSteps realistic (usually 1-5)
5. For simple tasks, return requiresResearch: false with empty arrays`;
}

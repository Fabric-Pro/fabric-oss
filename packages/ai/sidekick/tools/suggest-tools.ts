import {
	countPendingSuggestionsByKind,
	createRegisteredAgentSuggestions,
	getRegisteredAgentById,
	markRegisteredAgentSuggestionsOutdated,
} from "@repo/database";
import { tool } from "ai";
import { z } from "zod";
import { MAX_PENDING_TOOLS, NEW_AGENT_ID } from "../constants";
import type { SidekickToolContext } from "../types";

const toolSuggestionSchema = z.object({
	action: z
		.enum(["add", "remove"])
		.describe("Whether to add or remove the tool"),
	toolId: z.string().describe("The ID of the tool"),
	toolName: z.string().describe("Human-readable name of the tool"),
	analysis: z
		.string()
		.optional()
		.describe("Brief explanation of why this tool should be added/removed"),
});

type ToolSuggestionInput = z.infer<typeof toolSuggestionSchema>;

const suggestToolsInputSchema = z.object({
	suggestions: z.array(toolSuggestionSchema).min(1).max(MAX_PENDING_TOOLS),
});

/**
 * Creates the `suggest_tools` AI SDK tool for the Sidekick agent.
 *
 * This tool lets the LLM suggest adding or removing tools from the agent
 * being edited. Each suggestion becomes a `RegisteredAgentSuggestion` row
 * in the database, and the tool returns `:agent_suggestion[]{sId=... kind=tools}`
 * directive strings that the LLM must echo verbatim in its response.
 */
export function createSuggestToolsTool(ctx: SidekickToolContext) {
	return tool({
		description: `Suggest adding or removing tools from the agent being edited. Creates suggestion rows that render as accept/reject cards in the chat. Maximum ${MAX_PENDING_TOOLS} pending tool suggestions allowed. Each suggestion for the same toolId replaces any prior pending suggestion. Returns directive strings that MUST be included verbatim in your response.`,
		inputSchema: suggestToolsInputSchema,
		execute: async ({
			suggestions,
		}: {
			suggestions: ToolSuggestionInput[];
		}) => {
			// For new agents AND instance-backed sessions, return tool
			// suggestions via the auto-apply tag so the frontend writes them
			// into the form. Persisted suggestions are RegisteredAgent-only.
			const useAutoApply =
				ctx.agentId === NEW_AGENT_ID || ctx.entityType !== "registered";
			if (useAutoApply) {
				const toolList = suggestions
					.map(
						(s) =>
							`- **${s.action === "add" ? "Add" : "Remove"} ${s.toolName}** (${s.toolId})${s.analysis ? `: ${s.analysis}` : ""}`,
					)
					.join("\n");
				return `<sidekick_apply_tools>\n${JSON.stringify(suggestions)}\n</sidekick_apply_tools>\n\nSuggested tool changes:\n${toolList}\n\nThese will be noted for when the agent is created.`;
			}

			const agent = await getRegisteredAgentById(ctx.agentId);
			if (!agent) {
				return "Error: Agent not found.";
			}

			// Check pending count
			const pendingCount = await countPendingSuggestionsByKind(
				ctx.agentId,
				"TOOLS",
			);
			if (pendingCount + suggestions.length > MAX_PENDING_TOOLS) {
				return `Error: Cannot create ${suggestions.length} tool suggestion(s) — ${pendingCount} already pending, maximum is ${MAX_PENDING_TOOLS}. Use update_suggestions_state to mark old ones as outdated first.`;
			}

			// Mark duplicate suggestions for the same toolIds as outdated
			const toolIds = suggestions.map((s) => s.toolId);
			const duplicateKeys = toolIds.map((id) => `sidekick:tools:${id}`);
			await markRegisteredAgentSuggestionsOutdated(ctx.agentId, {
				kind: "TOOLS",
				keys: duplicateKeys,
			});

			// Create new suggestion rows
			const rows = suggestions.map((s) => ({
				key: `sidekick:tools:${s.toolId}`,
				kind: "TOOLS" as const,
				title: `${s.action === "add" ? "Add" : "Remove"} tool: ${s.toolName}`,
				description: s.analysis ?? `${s.action} ${s.toolName}`,
				payload: {
					action: s.action,
					toolId: s.toolId,
				},
			}));

			const created = await createRegisteredAgentSuggestions({
				agent,
				conversationId: ctx.conversationId,
				suggestions: rows,
			});

			// Return directive strings for the LLM to echo
			return created
				.map((row) => `:agent_suggestion[]{sId=${row.id} kind=tools}`)
				.join("\n");
		},
	});
}

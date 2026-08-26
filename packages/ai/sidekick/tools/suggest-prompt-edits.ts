import {
	countPendingSuggestionsByKind,
	createRegisteredAgentSuggestions,
	getRegisteredAgentById,
	markRegisteredAgentSuggestionsOutdated,
} from "@repo/database";
import { tool } from "ai";
import { z } from "zod";
import {
	INSTRUCTIONS_ROOT_BLOCK_ID,
	KNOWLEDGE_KEYWORD_MAP,
	MAX_PENDING_INSTRUCTIONS,
	NEW_AGENT_ID,
} from "../constants";
import type { SidekickToolContext } from "../types";

const promptEditSchema = z.object({
	targetBlockId: z
		.string()
		.describe(
			`The data-block-id of the block to replace, or '${INSTRUCTIONS_ROOT_BLOCK_ID}' for a full rewrite`,
		),
	type: z.literal("replace"),
	content: z.string().describe("The new HTML content for the block"),
	analysis: z
		.string()
		.optional()
		.describe("Brief explanation of what changed and why"),
});

type PromptEditInput = z.infer<typeof promptEditSchema>;

const suggestPromptEditsInputSchema = z.object({
	edits: z.array(promptEditSchema).min(1).max(MAX_PENDING_INSTRUCTIONS),
	agentName: z
		.string()
		.optional()
		.describe(
			"A short, clear name for the agent (e.g., 'Notion Search Assistant'). Required when creating a new agent.",
		),
	agentDescription: z
		.string()
		.optional()
		.describe(
			"A one-sentence description of what the agent does. Required when creating a new agent.",
		),
});

/**
 * Creates the `suggest_prompt_edits` AI SDK tool for the Sidekick agent.
 *
 * This tool lets the LLM suggest edits to the agent's system prompt /
 * instructions. Each edit targets a specific block (by `data-block-id`)
 * or the entire document (`instructions-root`). Suggestions become
 * `RegisteredAgentSuggestion` rows with `kind: "INSTRUCTIONS"`.
 *
 * The tool returns `:agent_suggestion[]{sId=... kind=instructions}`
 * directive strings that the LLM must echo verbatim in its response.
 */
export function createSuggestPromptEditsTool(ctx: SidekickToolContext) {
	return tool({
		description: `Suggest edits to the agent's system prompt / instructions. Each edit targets a specific block by its data-block-id attribute, or '${INSTRUCTIONS_ROOT_BLOCK_ID}' for a full rewrite. Creates suggestion rows that render as accept/reject cards in the chat. Maximum ${MAX_PENDING_INSTRUCTIONS} pending instruction suggestions allowed. Each suggestion for the same targetBlockId replaces any prior pending suggestion. Returns directive strings that MUST be included verbatim in your response.`,
		inputSchema: suggestPromptEditsInputSchema,
		execute: async ({
			edits,
			agentName,
			agentDescription,
		}: {
			edits: PromptEditInput[];
			agentName?: string;
			agentDescription?: string;
		}) => {
			// For new agents AND instance-backed sessions, return content
			// directly with a special marker so the frontend can auto-apply
			// it. Persisted suggestions are RegisteredAgent-only today.
			const useAutoApply =
				ctx.agentId === NEW_AGENT_ID || ctx.entityType !== "registered";

			// Instance-backed forms render instructions in a single textarea
			// (no block editor), and auto-apply replaces the entire prompt.
			// If the LLM sent per-block edits, concatenating them would wipe
			// the untouched sections. Force a full rewrite so the LLM
			// reconstructs the whole prompt from <agent_context>. New agents
			// have nothing to preserve, so block/full-rewrite are equivalent.
			if (ctx.entityType === "instance") {
				const isFullRewrite =
					edits.length === 1 &&
					edits[0]?.targetBlockId === INSTRUCTIONS_ROOT_BLOCK_ID;
				if (!isFullRewrite) {
					return `Error: For this agent you must submit a single full-document rewrite — one edit with targetBlockId="${INSTRUCTIONS_ROOT_BLOCK_ID}" whose content is the complete revised instructions. The editor here has no per-block structure, so block-scoped edits would discard untouched sections. Reconstruct the entire prompt (using <agent_context> as the current baseline) and resend as a single edit.`;
				}
			}

			if (useAutoApply) {
				const fullContent = edits.map((e) => e.content).join("\n\n");
				const contentLower = fullContent.toLowerCase();

				// Auto-detect knowledge sources and tools from the instructions content
				const detectedTools: Array<{
					action: "add";
					toolId: string;
					toolName: string;
				}> = [];

				for (const [keyword, toolId] of Object.entries(
					KNOWLEDGE_KEYWORD_MAP,
				)) {
					if (contentLower.includes(keyword)) {
						detectedTools.push({
							action: "add",
							toolId,
							toolName: `${keyword.charAt(0).toUpperCase()}${keyword.slice(1)} integration`,
						});
					}
				}

				if (
					contentLower.includes("web search") ||
					contentLower.includes("browse the web")
				) {
					detectedTools.push({
						action: "add",
						toolId: "web-search-browse",
						toolName: "Web Search & Browse",
					});
				}

				let result = `<sidekick_apply_instructions>\n${fullContent}\n</sidekick_apply_instructions>`;

				if (detectedTools.length > 0) {
					result += `\n<sidekick_apply_tools>\n${JSON.stringify(detectedTools)}\n</sidekick_apply_tools>`;
				}

				if (agentName || agentDescription) {
					result += `\n<sidekick_apply_metadata>\n${JSON.stringify({ name: agentName, description: agentDescription })}\n</sidekick_apply_metadata>`;
				}

				result +=
					"\n\nI've configured the instructions, tools, name, and description.";
				return result;
			}

			const agent = await getRegisteredAgentById(ctx.agentId);
			if (!agent) {
				return "Error: Agent not found.";
			}

			// Validate no duplicate targetBlockId values in the same call
			const blockIds = edits.map((e) => e.targetBlockId);
			const uniqueBlockIds = new Set(blockIds);
			if (uniqueBlockIds.size !== blockIds.length) {
				return "Error: Duplicate targetBlockId values in the same call. Each block can only be targeted once per suggestion batch.";
			}

			// Check pending count
			const pendingCount = await countPendingSuggestionsByKind(
				ctx.agentId,
				"INSTRUCTIONS",
			);
			if (pendingCount + edits.length > MAX_PENDING_INSTRUCTIONS) {
				return `Error: Cannot create ${edits.length} instruction suggestion(s) — ${pendingCount} already pending, maximum is ${MAX_PENDING_INSTRUCTIONS}. Use update_suggestions_state to mark old ones as outdated first.`;
			}

			// Mark any prior pending suggestions with the same targetBlockIds as outdated
			const duplicateKeys = blockIds.map(
				(id) => `sidekick:instructions:${id}`,
			);
			await markRegisteredAgentSuggestionsOutdated(ctx.agentId, {
				kind: "INSTRUCTIONS",
				keys: duplicateKeys,
			});

			// Create new suggestion rows
			const rows = edits.map((edit) => ({
				key: `sidekick:instructions:${edit.targetBlockId}`,
				kind: "INSTRUCTIONS" as const,
				title:
					edit.targetBlockId === INSTRUCTIONS_ROOT_BLOCK_ID
						? "Rewrite instructions"
						: `Edit block ${edit.targetBlockId}`,
				description:
					edit.analysis ??
					`Replace content of block ${edit.targetBlockId}`,
				payload: {
					content: edit.content,
					targetBlockId: edit.targetBlockId,
					type: "replace" as const,
				},
			}));

			const created = await createRegisteredAgentSuggestions({
				agent,
				conversationId: ctx.conversationId,
				suggestions: rows,
			});

			// Return directive strings for the LLM to echo
			return created
				.map(
					(row) =>
						`:agent_suggestion[]{sId=${row.id} kind=instructions}`,
				)
				.join("\n");
		},
	});
}

import { listRegisteredAgentSuggestionsByState } from "@repo/database";
import type { RegisteredAgentSuggestionState } from "@repo/database/prisma/generated/client";
import { tool } from "ai";
import { z } from "zod";
import type { SidekickToolContext } from "../types";

const listSuggestionsInputSchema = z.object({
	states: z
		.array(z.enum(["PENDING", "APPROVED", "REJECTED", "OUTDATED"]))
		.optional()
		.describe(
			'Filter by state(s). Defaults to ["PENDING"] if not specified.',
		),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of suggestions to return"),
});

/**
 * Tool that lets the Sidekick LLM list current suggestions for the agent being edited.
 */
export function createListSuggestionsTool(ctx: SidekickToolContext) {
	return tool({
		description:
			"List current suggestions for the agent being edited, filtered by state and/or kind. Use this to check what suggestions are already pending before creating new ones.",
		inputSchema: listSuggestionsInputSchema,
		execute: async ({
			states,
			limit,
		}: {
			states?: RegisteredAgentSuggestionState[];
			limit?: number;
		}) => {
			// Suggestion persistence is RegisteredAgent-only; instances/new
			// agents never have rows to list.
			if (ctx.entityType !== "registered") {
				return "No suggestions found matching the specified filters.";
			}

			const filterStates = states ?? ["PENDING"];
			const suggestions = await listRegisteredAgentSuggestionsByState(
				ctx.agentId,
				filterStates,
				limit,
			);

			if (suggestions.length === 0) {
				return "No suggestions found matching the specified filters.";
			}

			return JSON.stringify(
				suggestions.map((s) => ({
					sId: s.id,
					kind: s.kind.toLowerCase(),
					title: s.title,
					state: s.state.toLowerCase(),
					key: s.key,
				})),
			);
		},
	});
}

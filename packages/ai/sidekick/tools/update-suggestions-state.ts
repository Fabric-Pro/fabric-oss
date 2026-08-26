import { markRegisteredAgentSuggestionsOutdated } from "@repo/database";
import { tool } from "ai";
import { z } from "zod";
import type { SidekickToolContext } from "../types";

/**
 * Tool that lets the Sidekick LLM mark suggestions as outdated.
 * Used when the LLM needs to clean up stale suggestions before creating new ones.
 */
const updateSuggestionsInputSchema = z.object({
	keys: z
		.array(z.string())
		.min(1)
		.describe(
			"The suggestion keys to mark as outdated (from list_suggestions output)",
		),
});

export function createUpdateSuggestionsStateTool(ctx: SidekickToolContext) {
	return tool({
		description:
			"Mark existing suggestions as outdated. Use this to clean up stale pending suggestions before creating replacement ones, or when the agent configuration has changed in a way that makes previous suggestions irrelevant.",
		inputSchema: updateSuggestionsInputSchema,
		execute: async ({ keys }: { keys: string[] }) => {
			// Suggestion persistence is RegisteredAgent-only; instances/new
			// agents have no rows to outdate.
			if (ctx.entityType !== "registered") {
				return "Marked 0 suggestion(s) as outdated.";
			}

			const count = await markRegisteredAgentSuggestionsOutdated(
				ctx.agentId,
				{ keys },
			);

			return `Marked ${count} suggestion(s) as outdated.`;
		},
	});
}

import type { SidekickToolContext } from "../types";
import { createListSuggestionsTool } from "./list-suggestions";
import { createSuggestPromptEditsTool } from "./suggest-prompt-edits";
import { createSuggestToolsTool } from "./suggest-tools";
import { createUpdateSuggestionsStateTool } from "./update-suggestions-state";

/**
 * Creates the full set of Sidekick AI SDK tools for a given context.
 * Each tool operates on the agent identified by `ctx.agentId`.
 *
 * Additional suggest_* tools (suggest_skills, etc.)
 * will be added here as they're implemented in later build steps.
 */
export function createSidekickTools(ctx: SidekickToolContext) {
	return {
		suggest_tools: createSuggestToolsTool(ctx),
		suggest_prompt_edits: createSuggestPromptEditsTool(ctx),
		list_suggestions: createListSuggestionsTool(ctx),
		update_suggestions_state: createUpdateSuggestionsStateTool(ctx),
	};
}

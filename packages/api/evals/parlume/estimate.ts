/**
 * What a run would send, before anything is sent: the passes of each fixture,
 * an input token estimate from the prompts the passes would carry, output at
 * each pass's cap, and a cost from the AI model catalog's list prices.
 */
import { TURN_BUDGET_ESTIMATE } from "@repo/ai/lib/turn-budget-estimate";
import { MODELS } from "@repo/database/prisma/ai-model-catalog";
import {
	PARLUME_NOTES_MAX_OUTPUT_TOKENS,
	writeAnchoredNotes,
} from "@repo/temporal/parlume-notes-passes";
import {
	PARLUME_SUGGESTION_MAX_OUTPUT_TOKENS,
	parlumeSuggestionPrompt,
} from "../../modules/projects/lib/parlume-suggestions";
import {
	type EvalPrompts,
	suggestionPasses,
	type TokenUsage,
} from "./evaluate";
import { buildEvalTranscript, type ParlumeEvalFixture } from "./fixture";

/**
 * Characters per token, the estimate the turn budget sizes requests with.
 * English prose usually runs nearer four, so this tends to estimate high.
 */
export const EVAL_CHARS_PER_TOKEN = TURN_BUDGET_ESTIMATE.charsPerToken;

export type FixtureEstimate = TokenUsage & {
	fixture: string;
	notesPasses: number;
	suggestionPasses: number;
};

function tokensFor(chars: number): number {
	return Math.ceil(chars / EVAL_CHARS_PER_TOKEN);
}

/**
 * The passes a fixture would make and their tokens. Input is the characters
 * of the instructions and the prompt of every pass over
 * `EVAL_CHARS_PER_TOKEN`. The first notes passes are the real ones; a long
 * meeting's merge pass depends on what they return, and is counted as the
 * instructions plus twice each part's output cap (its notes and the lines
 * they cite). Output is each pass's cap, an upper bound. Earlier suggestions
 * are not counted: a dry run has none.
 */
export async function estimateFixture(
	fixture: ParlumeEvalFixture,
	prompts: EvalPrompts,
): Promise<FixtureEstimate> {
	let notesChars = 0;
	let notesPasses = 0;
	const { parts } = await writeAnchoredNotes({
		content: buildEvalTranscript(fixture).content,
		chatDeliveryFacts: "",
		pass: async (prompt) => {
			notesPasses += 1;
			notesChars += prompts.notes.length + prompt.length;
			return {};
		},
	});
	if (parts > 1) {
		notesPasses += 1;
		notesChars +=
			prompts.notes.length +
			2 * parts * PARLUME_NOTES_MAX_OUTPUT_TOKENS * EVAL_CHARS_PER_TOKEN;
	}
	const passes = suggestionPasses(fixture);
	const suggestionChars = passes.reduce(
		(sum, pass) =>
			sum +
			prompts.suggestion.length +
			parlumeSuggestionPrompt(pass.material).length,
		0,
	);
	return {
		fixture: fixture.id,
		notesPasses,
		suggestionPasses: passes.length,
		inputTokens: tokensFor(notesChars) + tokensFor(suggestionChars),
		outputTokens:
			notesPasses * PARLUME_NOTES_MAX_OUTPUT_TOKENS +
			passes.length * PARLUME_SUGGESTION_MAX_OUTPUT_TOKENS,
	};
}

/** US dollars per million tokens. */
export type ModelPrice = { inputPer1M: number; outputPer1M: number };

/**
 * The model's list price in the AI model catalog: the provider mapping's own
 * when the run knows the provider and the mapping has one, else the model's.
 * None when the catalog has no price for it.
 */
export function catalogPrice(
	canonicalName: string,
	provider?: string,
): ModelPrice | null {
	const model = MODELS.find((entry) => entry.canonicalName === canonicalName);
	if (!model) {
		return null;
	}
	const mapping = provider
		? model.providerMappings.find((entry) => entry.provider === provider)
		: undefined;
	const inputPer1M = mapping?.inputCostPer1M ?? model.inputCostPer1M;
	const outputPer1M = mapping?.outputCostPer1M ?? model.outputCostPer1M;
	return inputPer1M === undefined || outputPer1M === undefined
		? null
		: { inputPer1M, outputPer1M };
}

export function costUsd(price: ModelPrice, usage: TokenUsage): number {
	return (
		(usage.inputTokens * price.inputPer1M +
			usage.outputTokens * price.outputPer1M) /
		1_000_000
	);
}

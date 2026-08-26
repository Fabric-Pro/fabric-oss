import { generateText } from "ai";
import { getAIModelWithMetadata } from "./dynamic-model-selector";

/**
 * Describe, in a few sentences, how a proposed prompt would change an agent's
 * behaviour compared to the one currently bound.
 *
 * Used when someone nominates a prompt as a shared default and an admin has to
 * decide without diffing two bodies by eye.
 *
 * Returns `null` whenever no summary could be produced — no provider, no
 * credit, an upstream error, or a model that answered with nothing. The caller
 * is expected to carry on without it: review must never be blocked on this,
 * so every failure is the same answer rather than an exception to handle.
 */
export async function generatePromptChangeSummary({
	proposedContent,
	currentContent,
	userId,
	organizationId,
}: {
	proposedContent: string;
	/** Null when the action has no prompt bound today. */
	currentContent: string | null;
	userId: string;
	organizationId?: string | null;
}): Promise<string | null> {
	try {
		const { model } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId,
				organizationId: organizationId ?? undefined,
				// Stated rather than omitted, because the guard over this
				// directory is right to demand an answer: a call that quietly
				// drops projectId bills the workspace while the project's Usage
				// tab stays flat. There is genuinely no project here — a prompt
				// is bound at the personal, organization or system tier, and a
				// nomination inherits that. This one is undefined on purpose.
				projectId: undefined,
				featureKey: "prompt-nomination-summary",
			},
		);

		const { text } = await generateText({
			model,
			prompt: [
				"Two versions of an AI agent's instruction prompt are below.",
				"In at most four sentences, say what the proposed one changes about the agent's behaviour.",
				"Describe behaviour, not wording. Do not praise or recommend; a human decides.",
				"If the change is cosmetic, say so plainly.",
				"",
				"### Current default",
				currentContent ?? "(the action has no prompt bound today)",
				"",
				"### Proposed",
				proposedContent,
			].join("\n"),
		});

		// An empty completion resolves successfully and would otherwise be
		// passed on as a summary, indistinguishable from a real one.
		return text?.trim() || null;
	} catch {
		return null;
	}
}

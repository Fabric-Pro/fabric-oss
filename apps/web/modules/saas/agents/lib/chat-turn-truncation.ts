/**
 * An answer that stopped on a limit instead of finishing (review F25,
 * Fizzy #2166). Both chat engines report it the same way: `output_limit`
 * when the output-token ceiling cut the text, `step_limit` when the
 * step/iteration cap ended the turn while the model still wanted tools.
 * Before this, both read as complete answers.
 */
export type ChatTurnTruncation = "output_limit" | "step_limit";

/** Sent by the notice's Continue button. */
export const CONTINUE_PROMPT = "Continue from where you stopped.";

export const TRUNCATION_NOTICE_COPY: Record<ChatTurnTruncation, string> = {
	output_limit:
		"This answer was cut off at the length limit — ask me to continue.",
	step_limit:
		"I ran out of steps — ask me to continue or narrow the question.",
};

/** Reads a truncation value off an SSE event or persisted metadata. */
export function parseTurnTruncation(
	value: unknown,
): ChatTurnTruncation | undefined {
	return value === "output_limit" || value === "step_limit"
		? value
		: undefined;
}

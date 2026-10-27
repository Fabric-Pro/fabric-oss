/** One clarifying question the user answered during a run. */
export interface ClarificationTurn {
	question: string;
	answer: string;
}

/** Model-history wording recognised by the orchestrator clarity prompt. */
export function formatClarificationTurn(turn: ClarificationTurn): string {
	return `Clarification — ${turn.question}: ${turn.answer}`;
}

/** Validate saved data and return only the question and answer strings. */
export function parseClarificationTurn(
	value: unknown,
): ClarificationTurn | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		!("question" in value) ||
		!("answer" in value)
	) {
		return undefined;
	}
	return typeof value.question === "string" &&
		typeof value.answer === "string"
		? { question: value.question, answer: value.answer }
		: undefined;
}

/** Read structured display data without interpreting the message text. */
export function clarificationOf(message: {
	role?: string;
	metadata?: Record<string, unknown>;
}): ClarificationTurn | undefined {
	return message.role === "user"
		? parseClarificationTurn(message.metadata?.clarification)
		: undefined;
}

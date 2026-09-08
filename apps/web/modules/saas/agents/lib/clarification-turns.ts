/**
 * Transcript wording for a clarifying question the user answered.
 *
 * Fizzy #2406: the orchestrator's clarity gate re-asked questions the user had
 * already answered, because the exchange never reached the next turn's history.
 * The fix carries it as a transcript line, and the gate's prompt is told to
 * treat a line in this shape as a closed question — so this wording is a
 * contract between the client and the workflow prompt, not cosmetics.
 *
 * It lives here, outside both the chat component and the stream hook, because
 * three places have to agree on it: the live message pushed when the user
 * answers, the copy persisted with the execution, and the `history` entry
 * rebuilt after a reload. One formatter means they cannot drift.
 */

/** One clarifying question the user answered during a run. */
export interface ClarificationTurn {
	question: string;
	answer: string;
}

/** Render an answered clarification as a single transcript line. */
export function formatClarificationTurn(turn: ClarificationTurn): string {
	return `Clarification — ${turn.question}: ${turn.answer}`;
}

/**
 * Renders recent conversation turns into the bounded plain-text summary the
 * intent-clarity gate reads.
 *
 * Why this exists: every completed turn ends its orchestrator execution, so the
 * next message starts a fresh one. Without the prior turns the up-front clarity
 * gate re-evaluates from a blank slate and re-asks questions the user already
 * answered. `input.history` is already carried on the workflow input (planning
 * and iterative execution both consume it) — this renders it into the shape the
 * clarity activity's `conversationSummary` slot expects.
 *
 * Trimming keeps the NEWEST turns: "did I already ask this?" is answered by the
 * end of the conversation, not its beginning. Pure string work only, so it is
 * safe to call from workflow code.
 */

/** Turns considered "recent". Bounded so a long chat cannot blow the budget. */
const TURN_LIMIT = 12;

/**
 * Total character budget. Matches the activity's own `slice(0, 2000)` so the
 * activity's cap is a safety net rather than a second, surprising trim.
 */
const CHAR_BUDGET = 2000;

/** Per-message cap, so one long paste cannot crowd out every other turn. */
const MESSAGE_CHAR_CAP = 400;

export interface ConversationTurn {
	role: string;
	content: string;
}

function renderTurn(turn: ConversationTurn): string {
	const label = turn.role === "assistant" ? "Assistant" : "User";
	const content = turn.content.trim();
	const body =
		content.length > MESSAGE_CHAR_CAP
			? `${content.slice(0, MESSAGE_CHAR_CAP)}…`
			: content;
	return `${label}: ${body}`;
}

/**
 * Build the `conversationSummary` for the intent-clarity gate.
 *
 * Returns `undefined` when there is nothing usable, so callers can pass the
 * result straight through — the activity treats an absent summary the same as
 * one that was never supported.
 */
export function buildConversationSummary(
	history: ConversationTurn[] | undefined,
): string | undefined {
	if (!history || history.length === 0) {
		return undefined;
	}

	const usable = history.filter(
		(turn) =>
			typeof turn?.content === "string" && turn.content.trim() !== "",
	);
	if (usable.length === 0) {
		return undefined;
	}

	const recent = usable.slice(-TURN_LIMIT).map(renderTurn);

	// Drop from the oldest end until the rendered block fits the budget. A
	// single turn that is still too long on its own is kept and hard-trimmed —
	// returning nothing would be worse than returning the latest exchange.
	let start = 0;
	let rendered = recent.join("\n");
	while (rendered.length > CHAR_BUDGET && start < recent.length - 1) {
		start++;
		rendered = recent.slice(start).join("\n");
	}

	return rendered.length > CHAR_BUDGET
		? rendered.slice(rendered.length - CHAR_BUDGET)
		: rendered;
}

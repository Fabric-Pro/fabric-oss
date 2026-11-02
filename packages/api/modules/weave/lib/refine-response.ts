/**
 * Weave plan refinement's model contract: the instructions it answers to,
 * the parser of its reply, and the part of a reply still being written that
 * the person may already see. Shared by `weave.plans.refine` (the whole reply
 * at once) and the agent runtime's `weave-refine` engine (streamed). Imports
 * nothing, so the browser-facing engine and its tests load it as is.
 */

export const REFINE_SYSTEM_PROMPT = `You are helping a user refine a task description for an AI agent team (Fabric Weave).
The team includes: Thread (code analysis), Spindle (external research), Shuttle (implementation), Weft (quality review), and Warp (security audit).

Your job:
1. Ask clarifying questions about scope, constraints, edge cases, and acceptance criteria
2. After each exchange, produce an improved version of the request
3. When the request is clear enough for the agent team to execute well, say so

Be concise and direct. Focus on what the agents need to know:
- What exactly should change or be built?
- Are there specific files, endpoints, or components involved?
- What are the acceptance criteria?
- Are there security or performance constraints?
- Should any existing behavior be preserved?

Respond in this format:
FEEDBACK: <your clarifying question or confirmation>
UPDATED_MESSAGE: <the improved request incorporating all context so far>
READY: <true if the request is clear enough, false if more detail would help>`;

export interface RefineResult {
	feedback: string;
	updatedMessage: string;
	isReady: boolean;
}

/**
 * A whole reply's parts. A reply that names no feedback is all feedback, and
 * one that names no improved request keeps `currentMessage`.
 */
export function parseRefineResponse(
	text: string,
	currentMessage: string,
): RefineResult {
	const feedbackMatch = text.match(
		/FEEDBACK:\s*([\s\S]*?)(?=\nUPDATED_MESSAGE:|$)/,
	);
	const updatedMessageMatch = text.match(
		/UPDATED_MESSAGE:\s*([\s\S]*?)(?=\nREADY:|$)/,
	);
	const readyMatch = text.match(/READY:\s*(true|false)/i);

	return {
		feedback: feedbackMatch?.[1]?.trim() || text,
		updatedMessage: updatedMessageMatch?.[1]?.trim() || currentMessage,
		isReady: readyMatch?.[1]?.toLowerCase() === "true",
	};
}

const FEEDBACK_MARKER = "FEEDBACK:";
const UPDATED_MESSAGE_MARKER = "\nUPDATED_MESSAGE:";

/** `text` without a trailing start of the next section's marker. */
function withoutMarkerPrefix(text: string): string {
	for (
		let n = Math.min(text.length, UPDATED_MESSAGE_MARKER.length - 1);
		n > 0;
		n--
	) {
		if (UPDATED_MESSAGE_MARKER.startsWith(text.slice(-n))) {
			return text.slice(0, -n);
		}
	}
	return text;
}

/**
 * The feedback of a reply still being written, as far as it is certain:
 * always a prefix of the final `parseRefineResponse(...).feedback`, and it
 * only grows as the reply does. Empty until the reply names its feedback; a
 * reply that never does is all feedback, which only its end can tell.
 */
export function refineFeedbackPreview(partial: string): string {
	const start = partial.indexOf(FEEDBACK_MARKER);
	if (start === -1) {
		return "";
	}
	// The parser's `\s*` after the marker.
	const body = partial.slice(start + FEEDBACK_MARKER.length).trimStart();
	const end = body.indexOf(UPDATED_MESSAGE_MARKER);
	return (end === -1 ? withoutMarkerPrefix(body) : body.slice(0, end)).trim();
}

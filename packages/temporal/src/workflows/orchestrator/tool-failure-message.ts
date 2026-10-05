/**
 * What a chat user is told when the iterative loop stops calling a tool that
 * keeps failing. `formatToolFailureAbort` is the whole failed turn's message
 * on the per-call breaker, which histories recorded before
 * `orch-tool-failure-breaker-per-round-v1` still replay. It used to be the
 * operator's log line — `Tool "code_search" failed 3 times in a row; aborting
 * iteration loop. Last error: …` — shown verbatim in the chat (Fizzy #2578).
 * Workflow-sandbox safe.
 */

const LAST_ERROR_MAX_CHARS = 300;

/**
 * The tool's last error as a parenthesised clause for a user-facing sentence
 * (` (No commit found for the ref main)`), whitespace collapsed, capped at
 * 300 characters, trailing punctuation dropped; empty when there is no text.
 */
function toolFailureReason(lastError: string): string {
	const trimmed = lastError.trim().replace(/\s+/g, " ");
	const error =
		trimmed.length > LAST_ERROR_MAX_CHARS
			? `${trimmed.slice(0, LAST_ERROR_MAX_CHARS - 1)}…`
			: trimmed;
	return error ? ` (${error.replace(/[.\s]+$/, "")})` : "";
}

export function formatToolFailureAbort(
	toolName: string,
	lastError: string,
): string {
	return `I couldn't complete this: \`${toolName}\` kept failing${toolFailureReason(lastError)}. Try again, or ask differently.`;
}

/**
 * The opening line of the deterministic answer written when the per-round
 * breaker stops the turn and the model's own answer was unusable (Fizzy
 * #2922): the user still learns which tool kept failing and why, ahead of
 * the summary of what was gathered.
 */
export function formatToolFailureNote(
	toolName: string,
	lastError: string,
): string {
	return `I couldn't retrieve everything this needed: \`${toolName}\` kept failing${toolFailureReason(lastError)}. Here is what I gathered before it stopped working.`;
}

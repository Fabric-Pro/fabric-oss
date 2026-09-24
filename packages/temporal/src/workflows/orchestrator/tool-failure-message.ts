/**
 * The message a chat user sees when the iterative loop stops because one tool
 * failed three times in a row. It used to be the operator's log line —
 * `Tool "code_search" failed 3 times in a row; aborting iteration loop. Last
 * error: …` — shown verbatim in the chat (Fizzy #2578). Workflow-sandbox safe.
 */

const LAST_ERROR_MAX_CHARS = 300;

export function formatToolFailureAbort(
	toolName: string,
	lastError: string,
): string {
	const trimmed = lastError.trim().replace(/\s+/g, " ");
	const error =
		trimmed.length > LAST_ERROR_MAX_CHARS
			? `${trimmed.slice(0, LAST_ERROR_MAX_CHARS - 1)}…`
			: trimmed;
	const reason = error ? ` (${error.replace(/[.\s]+$/, "")})` : "";
	return `I couldn't complete this: \`${toolName}\` kept failing${reason}. Try again, or ask differently.`;
}

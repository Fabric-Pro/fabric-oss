/**
 * A refusal as the oRPC client hands one over, for the prompt-deletion suites.
 *
 * Both suites that exercise a refused prompt deletion need the same two-part
 * shape — the server's sentence as an `Error`, and the structured `data`
 * payload beside it when the server said more than the sentence — and both
 * refuse through two channels: the impact read's, and the deletion's own. It
 * lived in each file until Fizzy #2403 put an identical copy in the second, at
 * which point the second copy was the thing under test drifting out of one
 * file's sight (`docs/solutions/conventions/the-nth-special-case-means-generalize.md`).
 *
 * Nothing here matches on the message. The marker in `data` is the channel the
 * client reads, precisely so the sentence stays free to improve — a helper that
 * encouraged asserting on wording would undo that.
 */

/**
 * @param message the server's own sentence, verbatim
 * @param data the structured payload — `{ errorCode }` for a refusal that names
 *   its cause, omitted for one that does not
 */
export function refusal(
	message: string,
	data?: Record<string, unknown>,
): Error {
	const error = new Error(message);
	if (data) {
		Object.assign(error, { data });
	}
	return error;
}

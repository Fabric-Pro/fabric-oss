import type { CompletedExecution } from "./types";

/**
 * User messages of the live stream that no completed execution already shows.
 * Matched by message id: two turns asking the same thing are two bubbles.
 */
export function selectLiveUserMessages<
	TMessage extends { id: string; role: string },
>(
	messages: ReadonlyArray<TMessage>,
	completedExecutions: ReadonlyArray<CompletedExecution | null | undefined>,
): TMessage[] {
	const shownIds = new Set<string>();
	for (const execution of completedExecutions) {
		if (execution?.userMessageId) {
			shownIds.add(execution.userMessageId);
		}
	}
	return messages.filter(
		(message) => message.role === "user" && !shownIds.has(message.id),
	);
}

/**
 * Id of the live message that asked the turn now completing: the latest user
 * message carrying the question's text. Clarification answers and follow-ups
 * are user messages too and can arrive after it within the same turn, so the
 * latest user message is only the fallback.
 */
export function turnQuestionMessageId(
	messages: ReadonlyArray<{ id: string; role: string; content: string }>,
	question: string,
): string | undefined {
	const wanted = question.trim();
	let latestUser: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") {
			continue;
		}
		latestUser ??= message.id;
		if (message.content.trim() === wanted) {
			return message.id;
		}
	}
	return latestUser;
}

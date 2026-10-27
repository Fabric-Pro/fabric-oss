import { clarificationOf } from "../../../lib/clarification-turns";
import type { CompletedExecution } from "./types";

/**
 * User messages of the live stream that no completed execution already shows.
 * Matched by message id: two turns asking the same thing are two bubbles.
 */
export function selectLiveUserMessages<
	TMessage extends {
		id: string;
		role: string;
		metadata?: Record<string, unknown>;
	},
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
	let questionId: string | undefined;
	return messages.filter((message) => {
		if (message.role !== "user") {
			return false;
		}
		if (clarificationOf(message)) {
			return !questionId || !shownIds.has(questionId);
		}
		questionId = message.id;
		return !shownIds.has(message.id);
	});
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

/**
 * Stopped assistant messages whose turn is still shown live. A message's turn
 * is the last user message before it: the hook appends each question together
 * with its assistant placeholder (`sendMessage` in `useOrchestratorStream`),
 * and the user messages added mid-turn (clarification answers, follow-ups)
 * come after that placeholder. Once the question's turn has moved into the
 * completed list, that entry shows the stopped answer instead, so it is not
 * repeated under a later question.
 */
export function selectLiveStoppedAssistantMessages<
	TMessage extends { id: string; role: string; streamStatus?: string },
>(
	messages: ReadonlyArray<TMessage>,
	completedExecutions: ReadonlyArray<CompletedExecution | null | undefined>,
): TMessage[] {
	const completedQuestionIds = new Set<string>();
	for (const execution of completedExecutions) {
		if (execution?.userMessageId) {
			completedQuestionIds.add(execution.userMessageId);
		}
	}
	const stopped: TMessage[] = [];
	let questionId: string | undefined;
	for (const message of messages) {
		if (message.role === "user") {
			questionId = message.id;
			continue;
		}
		if (
			message.role === "assistant" &&
			message.streamStatus === "cancelled" &&
			!(questionId && completedQuestionIds.has(questionId))
		) {
			stopped.push(message);
		}
	}
	return stopped;
}

/**
 * The partial answer of a stopped turn: the latest assistant message's text
 * when that message was stopped. Undefined when it was not stopped or had no
 * text yet.
 */
export function stoppedAnswerText(
	messages: ReadonlyArray<{
		role: string;
		content: string;
		streamStatus?: string;
	}>,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") {
			continue;
		}
		return message.streamStatus === "cancelled" && message.content.trim()
			? message.content
			: undefined;
	}
	return undefined;
}

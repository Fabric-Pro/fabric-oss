import type { ConversationTurn, Prisma } from "../generated/client";
import { isTerminalConversationTurnStatus } from "./conversation-turns";

type TurnResult = Pick<
	ConversationTurn,
	| "id"
	| "executionId"
	| "generation"
	| "status"
	| "responseText"
	| "terminalAt"
	| "terminalReason"
	| "createdAt"
	| "limitSignalSummary"
>;

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function executionId(message: unknown): unknown {
	return object(object(message).metadata).executionId;
}

/**
 * Adds missing terminal results to the read response without writing a repair.
 * The turn query selects result fields and omits startup tokens. Existing saved
 * execution details are retained. The turn owns the outcome. Available turn text replaces
 * the primary response, while a matching longer browser answer survives the
 * turn's storage cap. Other distinct saved text responses are carried alongside
 * it. These records cannot reliably identify generated text or transport notices.
 * Questions are recovered only from messages that name this execution, or
 * from the seed of generation one. Later unsaved questions are not durable,
 * so those results deliberately carry no invented question.
 */
export function hydrateConversationTurnResults(
	conversation: { messages: Prisma.JsonValue; metadata: Prisma.JsonValue },
	turns: TurnResult[],
): { messages: Prisma.JsonValue; metadata: Prisma.JsonValue } {
	const originalMessages: unknown[] = Array.isArray(conversation.messages)
		? conversation.messages
		: [];
	const messages = [...originalMessages];
	const metadata = { ...object(conversation.metadata) };
	const executions: unknown[] = Array.isArray(metadata.executions)
		? [...metadata.executions]
		: [];
	const hadExecutions = executions.length > 0;
	const questionIds = new Set<unknown>();
	const anchors = new Map<unknown, unknown>();
	const generations = new Map(
		turns.map((turn) => [turn.executionId, turn.generation]),
	);
	const pendingExecutions = new Set(
		turns
			.filter((turn) => !isTerminalConversationTurnStatus(turn.status))
			.map((turn) => turn.executionId),
	);
	let changed = false;
	for (const turn of turns) {
		const id = turn.executionId;
		if (
			!id ||
			!turn.terminalAt ||
			!isTerminalConversationTurnStatus(turn.status)
		) {
			continue;
		}
		const savedIndex = executions.findIndex(
			(execution) => object(execution).id === id,
		);
		const saved = object(executions[savedIndex]);
		const owned = messages.filter((message) => executionId(message) === id);
		const storedAnswer = owned.find(
			(message) => object(message).role === "assistant",
		);
		const storedQuestion = owned.find(
			(message) => object(message).role === "user",
		);
		const seed =
			turn.generation === 1 &&
			object(messages[0]).role === "user" &&
			executionId(messages[0]) === undefined &&
			!originalMessages.some(
				(message) =>
					object(message).role === "assistant" &&
					executionId(message) === undefined,
			)
				? messages[0]
				: undefined;
		const question = object(storedQuestion ?? seed).content;
		const baseMessageId = `turn-result-${turn.id}`;
		let resultMessageId = baseMessageId;
		let suffix = 1;
		while (
			messages.some((message) => object(message).id === resultMessageId)
		) {
			resultMessageId = `${baseMessageId}-${suffix++}`;
		}
		questionIds.add(object(storedQuestion ?? seed).id);
		anchors.set(
			id,
			object(storedQuestion ?? seed).id ??
				object(storedAnswer).id ??
				resultMessageId,
		);
		const status =
			turn.status === "FAILED"
				? "error"
				: turn.status === "CANCELLED"
					? "cancelled"
					: "complete";
		const browserResponses = [
			saved.finalResponse,
			...(Array.isArray(saved.additionalResponses)
				? saved.additionalResponses
				: []),
			...owned
				.filter((message) => object(message).role === "assistant")
				.map((message) => object(message).content),
		].filter(
			(value): value is string =>
				typeof value === "string" && value.length > 0,
		);
		const durableResponse = turn.responseText ?? "";
		const hasDurableResponse = durableResponse.length > 0;
		// Browser errors include transport failures, and cancellation can win
		// after an answer was saved. Neither status proves the text invalid.
		// With durable text, compare the text itself and keep the longest match.
		// Without it, keep the saved execution answer, falling back to its message.
		// Retain the other distinct representations beside this primary answer.
		const browserResponse = hasDurableResponse
			? browserResponses
					.filter((value) => value.startsWith(durableResponse))
					.reduce<string | undefined>(
						(longest, value) =>
							!longest || value.length > longest.length
								? value
								: longest,
						undefined,
					)
			: browserResponses[0];
		const keptBrowserResponse = browserResponse !== undefined;
		const response = browserResponse ?? durableResponse;
		const additionalResponses = [...new Set(browserResponses)].filter(
			(value) => value !== response,
		);
		const savedDetails = { ...saved };
		delete savedDetails.additionalResponses;
		if (turn.status !== "FAILED") {
			delete savedDetails.error;
		} else if (turn.terminalReason) {
			savedDetails.error = turn.terminalReason;
		}
		const limitSignals = Array.isArray(turn.limitSignalSummary)
			? turn.limitSignalSummary.flatMap((value) => {
					const signal = object(value);
					if (
						typeof signal.kind !== "string" ||
						typeof signal.message !== "string"
					) {
						return [];
					}
					return [
						{
							kind: signal.kind,
							message: signal.message,
							...(typeof signal.provider === "string"
								? { provider: signal.provider }
								: {}),
						},
					];
				})
			: [];
		const result = {
			...savedDetails,
			id,
			userMessage:
				typeof saved.userMessage === "string"
					? saved.userMessage
					: typeof question === "string"
						? question
						: "",
			finalResponse: response,
			...(additionalResponses.length > 0 ? { additionalResponses } : {}),
			status,
			startedAt: turn.createdAt.toISOString(),
			completedAt: turn.terminalAt.toISOString(),
			terminalStatus: turn.status,
			terminalReason: turn.terminalReason,
			limitSignals,
			recoveredFromTurn:
				saved.recoveredFromTurn === true ||
				additionalResponses.length > 0 ||
				savedIndex === -1 ||
				!hasDurableResponse ||
				!keptBrowserResponse ||
				(saved.status !== undefined && saved.status !== status),
		};
		const isLater = (candidate: unknown) => {
			const generation = generations.get(candidate as string);
			return (
				turn.generation !== null &&
				generation != null &&
				generation > turn.generation
			);
		};
		if (!storedAnswer && !(savedIndex !== -1 && keptBrowserResponse)) {
			let lastOwned = -1;
			messages.forEach((message, index) => {
				if (executionId(message) === id) {
					lastOwned = index;
				}
			});
			const later = messages.findIndex((message) =>
				isLater(executionId(message)),
			);
			const position =
				lastOwned !== -1
					? lastOwned + 1
					: later !== -1
						? later
						: messages.length;
			messages.splice(position, 0, {
				id: resultMessageId,
				role: "assistant",
				content: response,
				timestamp: turn.terminalAt.toISOString(),
				streamStatus:
					turn.status === "CANCELLED"
						? "cancelled"
						: turn.status === "FAILED"
							? "error"
							: "completed",
				...(turn.status === "CANCELLED"
					? { cancelledAt: turn.terminalAt.toISOString() }
					: {}),
				metadata: {
					executionId: id,
					terminalStatus: turn.status,
					limitSignals,
				},
			});
		} else if (storedAnswer) {
			const answer = {
				...object(storedAnswer),
				// With no durable text, keep an independently saved message too.
				// A different execution answer is not grounds to erase this content.
				content:
					!hasDurableResponse &&
					typeof object(storedAnswer).content === "string" &&
					object(storedAnswer).content !== ""
						? object(storedAnswer).content
						: response,
				streamStatus:
					turn.status === "CANCELLED"
						? "cancelled"
						: turn.status === "FAILED"
							? "error"
							: "completed",
				metadata: {
					...object(object(storedAnswer).metadata),
					executionId: id,
					terminalStatus: turn.status,
					limitSignals,
				},
			};
			if (turn.status !== "CANCELLED") {
				delete (answer as Record<string, unknown>).cancelledAt;
			}
			if (turn.status !== "FAILED") {
				delete (answer as Record<string, unknown>).isError;
			}
			messages[messages.indexOf(storedAnswer)] = answer;
		}
		if (savedIndex !== -1) {
			executions[savedIndex] = result;
		} else {
			const later = executions.findIndex((execution) =>
				isLater(object(execution).id),
			);
			executions.splice(
				later !== -1 ? later : executions.length,
				0,
				result,
			);
		}
		changed = true;
	}
	if (!changed) {
		return conversation;
	}
	// The UI otherwise falls back to message pairs when there are no execution
	// records. Preserve that history when projection adds the first record.
	if (!hadExecutions) {
		originalMessages.forEach((message, index) => {
			const request = object(message);
			if (
				request.role !== "user" ||
				questionIds.has(request.id) ||
				pendingExecutions.has(executionId(message) as string)
			) {
				return;
			}
			const next = object(originalMessages[index + 1]);
			const id = `message-result-${request.id}`;
			executions.push({
				id,
				userMessage: request.content,
				finalResponse: next.role === "assistant" ? next.content : "",
				startedAt: request.timestamp,
				completedAt: next.timestamp ?? request.timestamp,
			});
			anchors.set(id, request.id);
		});
		const positions = new Map(
			messages.map((message, index) => [object(message).id, index]),
		);
		executions.sort(
			(a, b) =>
				(positions.get(anchors.get(object(a).id)) ?? messages.length) -
				(positions.get(anchors.get(object(b).id)) ?? messages.length),
		);
	}
	metadata.executions = executions;
	return {
		messages: messages as Prisma.JsonValue,
		metadata: metadata as Prisma.JsonValue,
	};
}

"use client";

import { useShowAiUsageLimitToast } from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyDataAnalystEvent,
	type DataAnalystTurn,
	EMPTY_DATA_ANALYST_TURN,
	endDataAnalystTurn,
} from "../lib/data-analyst-runtime-events";
import { DATA_ANALYST_AGENT_ID } from "../lib/data-analyst-runtime-protocol";
import { trimHistoryForRequest } from "../lib/direct-chat-turns";
import { errorMessageOf, isAbortError } from "../lib/direct-runtime-transport";
import { streamRequestReplyRun } from "../lib/request-reply-runtime";

type DataAnalystMessage =
	| { id: string; role: "user"; content: string }
	| { id: string; role: "assistant"; turn: DataAnalystTurn };

export function useDataAnalystChat({
	organizationId,
}: {
	organizationId: string;
}) {
	const [messages, setMessages] = useState<DataAnalystMessage[]>([]);
	const [running, setRunning] = useState(false);
	const history = useRef<DataAnalystMessage[]>([]);
	const threadId = useRef(crypto.randomUUID());
	const controller = useRef<AbortController | null>(null);
	const showUsageLimit = useShowAiUsageLimitToast();
	const publish = useCallback((next: DataAnalystMessage[]) => {
		history.current = next;
		setMessages(next);
	}, []);
	const stop = useCallback(() => controller.current?.abort(), []);
	const reset = useCallback(() => {
		controller.current?.abort();
		controller.current = null;
		threadId.current = crypto.randomUUID();
		publish([]);
		setRunning(false);
	}, [publish]);
	useEffect(
		() => () => {
			controller.current?.abort();
			controller.current = null;
		},
		[],
	);
	const send = useCallback(
		async (text: string) => {
			const content = text.trim();
			if (controller.current || !content) {
				return;
			}
			const abort = new AbortController();
			controller.current = abort;
			setRunning(true);
			const user = {
				id: crypto.randomUUID(),
				role: "user" as const,
				content,
			};
			const assistantId = crypto.randomUUID();
			let turn = EMPTY_DATA_ANALYST_TURN;
			const conversation = [...history.current, user];
			const update = () => {
				if (controller.current !== abort) {
					return;
				}
				publish([
					...conversation,
					{ id: assistantId, role: "assistant", turn },
				]);
			};
			update();
			try {
				await streamRequestReplyRun({
					agentId: DATA_ANALYST_AGENT_ID,
					threadId: threadId.current,
					messages: trimHistoryForRequest(
						conversation.flatMap<{
							role: "user" | "assistant";
							content: string;
						}>((message) =>
							message.role === "user"
								? [
										{
											role: message.role,
											content: message.content,
										},
									]
								: message.turn.text
									? [
											{
												role: message.role,
												content: message.turn.text,
											},
										]
									: [],
						),
					),
					forwardedProps: {},
					organizationId,
					signal: abort.signal,
					onEvent: (event) => {
						if (
							abort.signal.aborted ||
							controller.current !== abort
						) {
							return;
						}
						turn = applyDataAnalystEvent(turn, event);
						update();
					},
				});
				if (abort.signal.aborted) {
					turn = endDataAnalystTurn(turn, "stopped", null);
				} else if (turn.status === "running") {
					turn = endDataAnalystTurn(
						turn,
						"failed",
						"The connection to this analysis was lost. Please ask again.",
					);
				}
			} catch (error) {
				turn =
					isAbortError(error) || abort.signal.aborted
						? endDataAnalystTurn(turn, "stopped", null)
						: endDataAnalystTurn(
								turn,
								"failed",
								errorMessageOf(error),
							);
			} finally {
				if (controller.current === abort) {
					update();
					if (turn.usageLimit) {
						showUsageLimit(turn.usageLimit);
					}
					controller.current = null;
					setRunning(false);
				}
			}
		},
		[organizationId, publish, showUsageLimit],
	);
	return { messages, running, send, stop, reset };
}

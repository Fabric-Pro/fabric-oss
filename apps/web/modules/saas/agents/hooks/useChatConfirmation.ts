"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
	approvalMessage,
	type ChatConfirmationRequest,
	readConfirmationRequest,
} from "../lib/chat-confirmation";
import type { DirectSendOptions } from "./useDirectStream";

/** An approval the chat is asking for, and the message whose card shows it. */
export type PendingConfirmation = ChatConfirmationRequest & {
	messageId: string;
};

interface TranscriptMessage {
	role: "user" | "assistant";
	content: string;
}

interface AssistantMessage {
	id: string;
	toolCalls?: Array<{ result?: unknown }>;
}

interface UseChatConfirmationOptions {
	/** The conversation so far, which the approving turn continues. */
	messages: readonly TranscriptMessage[];
	sendMessage: (
		content: string,
		history: TranscriptMessage[],
		options?: DirectSendOptions,
	) => Promise<unknown>;
}

/**
 * The person's yes or no to a tool that asked for it.
 *
 * Any tool that needs approval answers with `requiresConfirmation`; `offer`
 * reads the finished assistant message for one and the card is drawn from what
 * it carries. Approving goes back through the conversation: the next turn runs
 * exactly the call the card showed, then the model carries on from its result.
 * A card the person already answered is not offered again when the same
 * transcript renders later.
 */
export function useChatConfirmation({
	messages,
	sendMessage,
}: UseChatConfirmationOptions) {
	const [pending, setPending] = useState<PendingConfirmation | null>(null);
	const answeredRef = useRef<Set<string>>(new Set());

	const offer = useCallback((message: AssistantMessage) => {
		if (answeredRef.current.has(message.id)) {
			return;
		}
		for (const toolCall of message.toolCalls ?? []) {
			const request = readConfirmationRequest(toolCall.result);
			if (request) {
				setPending({ ...request, messageId: message.id });
				return;
			}
		}
	}, []);

	const approve = useCallback(async () => {
		if (!pending) {
			return;
		}
		answeredRef.current.add(pending.messageId);
		setPending(null);
		await sendMessage(
			approvalMessage(pending),
			messages.map(({ role, content }) => ({ role, content })),
			{
				approvedToolCall: {
					toolName: pending.toolName,
					args: pending.args,
				},
			},
		);
	}, [pending, sendMessage, messages]);

	const decline = useCallback(() => {
		if (!pending) {
			return;
		}
		answeredRef.current.add(pending.messageId);
		setPending(null);
		toast.info("Cancelled. Nothing was changed.");
	}, [pending]);

	return { pending, offer, approve, decline };
}

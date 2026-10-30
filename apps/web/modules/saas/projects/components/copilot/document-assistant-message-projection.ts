import type { CopilotChatSession } from "@saas/shared/components/copilot/CopilotChatSessionProvider";

const isAction = () => true;
type SourceMessage = {
	id?: string;
	role?: string;
	type?: string;
	name?: string;
	parentMessageId?: string | null;
	toolCallId?: string;
	actionExecutionId?: string;
	content?: unknown;
	toolCalls?: { id?: string; name?: string; function?: { name?: string } }[];
	isActionExecutionMessage?: () => boolean;
	_getType?: () => string;
};

/** Only identities/classifiers read by the editor's outcome, confirm, and meeting-note consumers. */
export function selectDocumentAssistantMessages(session: CopilotChatSession) {
	const wire = session.agent?.messages ?? session.messages;
	const messages = wire?.length ? wire : (session.visibleMessages ?? []);
	return (messages as SourceMessage[]).filter(Boolean).map((message) => ({
		id: message.id,
		role: message.role,
		type: message._getType?.() === "human" ? "human" : message.type,
		name: message.name,
		parentMessageId: message.parentMessageId,
		toolCallId: message.toolCallId,
		actionExecutionId: message.actionExecutionId,
		// Parent-text matching checks string length; meeting-note consumers use only the user id.
		content:
			message.role === "assistant" &&
			typeof message.content === "string" &&
			message.content.length > 0
				? "present"
				: "",
		isActionExecutionMessage: message.isActionExecutionMessage?.()
			? isAction
			: undefined,
		toolCalls: Array.isArray(message.toolCalls)
			? message.toolCalls.map((call) => ({
					id: call?.id,
					name: call?.name,
					function: { name: call?.function?.name },
				}))
			: [],
	}));
}
type Projection = ReturnType<typeof selectDocumentAssistantMessages>;

export function equalDocumentAssistantMessages(
	left: Projection,
	right: Projection,
) {
	return (
		left.length === right.length &&
		left.every((message, index) => {
			const other = right[index];
			return (
				message.id === other.id &&
				message.role === other.role &&
				message.type === other.type &&
				message.name === other.name &&
				message.parentMessageId === other.parentMessageId &&
				message.toolCallId === other.toolCallId &&
				message.actionExecutionId === other.actionExecutionId &&
				message.content === other.content &&
				message.isActionExecutionMessage ===
					other.isActionExecutionMessage &&
				message.toolCalls.length === other.toolCalls.length &&
				message.toolCalls.every((call, callIndex) => {
					const otherCall = other.toolCalls[callIndex];
					return (
						call.id === otherCall.id &&
						call.name === otherCall.name &&
						call.function.name === otherCall.function.name
					);
				})
			);
		})
	);
}

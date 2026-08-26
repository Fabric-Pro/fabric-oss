interface ActionCardMessage {
	role: string;
	content?: string;
	isStreaming?: boolean;
	isError?: boolean;
}

/**
 * Whether to render the "Suggested next actions" cards for a message. Cards are
 * only for completed, non-error assistant answers with a project attached.
 * (#1644: never show cards on an errored message.)
 */
export function shouldShowAssistantActionCards(
	message: ActionCardMessage,
	attachedProjectId: string | undefined | null,
): boolean {
	return (
		message.role === "assistant" &&
		!message.isStreaming &&
		!message.isError &&
		Boolean(message.content) &&
		Boolean(attachedProjectId)
	);
}

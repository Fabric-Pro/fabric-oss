import type { selectDocumentAssistantMessages } from "../components/copilot/document-assistant-message-projection";

export function findDiffProposal(
	messages: ReturnType<typeof selectDocumentAssistantMessages>,
) {
	const DIFF_TOOL_NAMES = ["write_document_local", "confirm_changes"];
	const messagesToWalk = messages;
	if (!messagesToWalk || messagesToWalk.length === 0) {
		return null;
	}
	for (let i = messagesToWalk.length - 1; i >= 0; i--) {
		const m = messagesToWalk[i];
		if (!m) {
			continue;
		}
		const asMaybeAction = m as {
			isActionExecutionMessage?: () => boolean;
			id?: string;
			name?: string;
			parentMessageId?: string | null;
			role?: string;
			content?: unknown;
			toolCalls?: unknown;
		};
		// Path (a): GQL-format ActionExecutionMessage.
		if (
			typeof asMaybeAction.isActionExecutionMessage === "function" &&
			asMaybeAction.isActionExecutionMessage()
		) {
			if (
				typeof asMaybeAction.id === "string" &&
				typeof asMaybeAction.name === "string" &&
				DIFF_TOOL_NAMES.includes(asMaybeAction.name)
			) {
				return {
					messageId:
						asMaybeAction.parentMessageId ?? asMaybeAction.id,
					toolCallId: asMaybeAction.id,
				};
			}
			continue;
		}
		// Path (b): AGUI-format assistant message with tool calls.
		if (
			asMaybeAction.role === "assistant" &&
			Array.isArray(asMaybeAction.toolCalls) &&
			asMaybeAction.toolCalls.length > 0
		) {
			for (const rawTc of asMaybeAction.toolCalls as unknown[]) {
				if (!rawTc || typeof rawTc !== "object") {
					continue;
				}
				const tc = rawTc as {
					id?: unknown;
					name?: unknown;
					function?: { name?: unknown };
				};
				const tcId = typeof tc.id === "string" ? tc.id : null;
				const tcName =
					typeof tc.name === "string"
						? tc.name
						: typeof tc.function?.name === "string"
							? tc.function.name
							: null;
				if (!tcId || !tcName) {
					continue;
				}
				if (!DIFF_TOOL_NAMES.includes(tcName)) {
					continue;
				}
				// Persistence keeps calls on a message with its own text.
				// Only textless siblings search backwards within the turn.
				const hasOwnText =
					typeof asMaybeAction.content === "string" &&
					asMaybeAction.content.length > 0;
				let parentTextId: string | null = null;
				for (let p = i - 1; !hasOwnText && p >= 0; p--) {
					const prev = messagesToWalk[p] as {
						id?: string;
						role?: string;
						content?: unknown;
					};
					if (!prev?.id) {
						continue;
					}
					if (prev.role === "user") {
						break;
					}
					if (
						prev.role === "assistant" &&
						typeof prev.content === "string" &&
						prev.content.length > 0
					) {
						parentTextId = prev.id;
						break;
					}
				}
				return {
					messageId: parentTextId ?? asMaybeAction.id ?? tcId,
					toolCallId: tcId,
				};
			}
		}
	}
	return null;
}

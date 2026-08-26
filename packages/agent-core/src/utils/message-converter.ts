/**
 * Message Converter Utilities
 *
 * This module provides utilities for converting between different message formats
 * used across LangGraph agents and the unified server protocol.
 *
 * WHY THIS EXISTS:
 * LangGraph uses BaseMessage[] internally, but the unified server and A2A protocol
 * expect a simpler { role: string; content: string }[] format. This converter
 * provides type-safe conversion to prevent the type errors we've seen when
 * directly passing BaseMessage[] to interfaces expecting simple message arrays.
 */

/**
 * Simple message format used by unified server and A2A protocol
 */
export interface SimpleMessage {
	role: string;
	content: string;
}

/**
 * Convert LangGraph BaseMessage[] or similar message arrays to simple format.
 *
 * This handles various message formats:
 * - LangGraph BaseMessage objects (with _getType(), role, content)
 * - Simple objects with role/content properties
 * - String messages (converted to assistant role)
 *
 * @param messages - Array of messages in any supported format
 * @returns Array of SimpleMessage objects
 *
 * @example
 * ```typescript
 * // In your LangGraph agent's unified server:
 * const result = await graph.invoke(input);
 * const outputMessages = convertToSimpleMessages(result.messages);
 * ```
 */
export function convertToSimpleMessages(messages: unknown[]): SimpleMessage[] {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages.map((msg): SimpleMessage => {
		// Handle null/undefined
		if (msg === null || msg === undefined) {
			return { role: "assistant", content: "" };
		}

		// Handle string messages
		if (typeof msg === "string") {
			return { role: "assistant", content: msg };
		}

		// Handle object messages
		if (typeof msg === "object") {
			const msgObj = msg as Record<string, unknown>;

			// Extract role - check multiple possible locations
			let role = "assistant";
			if (typeof msgObj.role === "string") {
				role = msgObj.role;
			} else if (typeof msgObj._getType === "function") {
				// LangGraph BaseMessage - infer role from type
				const type = (msgObj._getType as () => string)();
				if (type === "human") {
					role = "user";
				} else if (type === "ai") {
					role = "assistant";
				} else if (type === "system") {
					role = "system";
				} else {
					role = type;
				}
			}

			// Extract content - handle various formats
			let content = "";
			if (typeof msgObj.content === "string") {
				content = msgObj.content;
			} else if (Array.isArray(msgObj.content)) {
				// Some message formats have content as array of parts
				content = msgObj.content
					.map((part) => {
						if (typeof part === "string") {
							return part;
						}
						if (typeof part === "object" && part !== null) {
							return (part as Record<string, unknown>).text || "";
						}
						return "";
					})
					.join("");
			} else if (msgObj.content !== undefined) {
				content = String(msgObj.content);
			}

			return { role, content };
		}

		// Fallback for any other type
		return { role: "assistant", content: String(msg) };
	});
}

/**
 * Extract the last message content from a message array.
 * Useful for getting the final response from a conversation.
 *
 * @param messages - Array of messages
 * @returns The content of the last message, or empty string if none
 */
export function getLastMessageContent(messages: unknown[]): string {
	const simpleMessages = convertToSimpleMessages(messages);
	if (simpleMessages.length === 0) {
		return "";
	}
	return simpleMessages[simpleMessages.length - 1].content;
}

/**
 * Filter messages to only include assistant responses.
 *
 * @param messages - Array of messages
 * @returns Array of SimpleMessage with only assistant messages
 */
export function getAssistantMessages(messages: unknown[]): SimpleMessage[] {
	return convertToSimpleMessages(messages).filter(
		(msg) => msg.role === "assistant",
	);
}

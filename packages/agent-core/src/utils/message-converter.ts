/**
 * Message Converter Utilities
 *
 * This module provides utilities for converting between different message formats
 * used across LangGraph agents and the unified server protocol.
 *
 * WHY THIS EXISTS:
 * LangGraph uses BaseMessage[] internally, but the unified server and A2A protocol
 * expect a simpler { role, content } message format (see SimpleMessage). This converter
 * provides type-safe conversion to prevent the type errors we've seen when
 * directly passing BaseMessage[] to interfaces expecting simple message arrays.
 */

/**
 * Simple message format used by unified server and A2A protocol
 */
export interface SimpleMessage {
	role: string;
	content: string;
	id?: string;
	tool_call_id?: string;
	tool_calls?: unknown[];
}

/**
 * Convert LangGraph BaseMessage[] or similar message arrays to simple format.
 *
 * This handles various message formats:
 * - LangGraph BaseMessage objects: the role comes from _getType()/getType(),
 *   and id, tool_call_id and tool_calls are carried over
 * - Simple objects with role/content properties (used when there is no type method)
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

			// LangChain type methods take precedence over a wire-format role.
			const getType =
				typeof msgObj._getType === "function"
					? msgObj._getType
					: msgObj.getType;
			let role =
				typeof msgObj.role === "string" ? msgObj.role : "assistant";
			if (typeof getType === "function") {
				const type = getType.call(msg);
				if (type === "human") {
					role = "user";
				} else if (type === "ai") {
					role = "assistant";
				} else if (
					type === "generic" &&
					typeof msgObj.role === "string"
				) {
					// ChatMessage carries its custom role on the instance.
					role = msgObj.role;
				} else if (typeof type === "string") {
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

			const result: SimpleMessage = { role, content };
			if (typeof msgObj.id === "string") {
				result.id = msgObj.id;
			}
			if (role === "tool" && typeof msgObj.tool_call_id === "string") {
				result.tool_call_id = msgObj.tool_call_id;
			}
			if (
				role === "assistant" &&
				Array.isArray(msgObj.tool_calls) &&
				msgObj.tool_calls.length > 0
			) {
				result.tool_calls = msgObj.tool_calls;
			}
			return result;
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

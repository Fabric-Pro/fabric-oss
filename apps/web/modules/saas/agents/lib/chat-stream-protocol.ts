import type { z } from "zod";

const CHAT_STREAM_VERSION = 1;

/** Contract failures cannot be recovered by repeatedly reconnecting. */
export class ChatStreamProtocolError extends Error {}

export function parseVersionedChatEvent<T>(
	value: unknown,
	schema: z.ZodType<T> & {
		options: readonly { shape: { type: { value: string } } }[];
	},
): T | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	if ("version" in value && value.version !== CHAT_STREAM_VERSION) {
		throw new ChatStreamProtocolError(
			"This chat stream uses an unsupported version. Refresh and try again.",
		);
	}
	const result = schema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	if (
		"type" in value &&
		schema.options.some((option) => option.shape.type.value === value.type)
	) {
		throw new ChatStreamProtocolError(
			"The chat stream contained an invalid event. Your partial reply has been kept.",
		);
	}
	return null;
}

export function encodeChatStreamEvent(event: { type: string }): string {
	return `data: ${JSON.stringify({ ...event, version: CHAT_STREAM_VERSION })}\n\n`;
}

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

/** Producer-to-parser check; T must be inferred independently of the schema. */
type EventVariant<T, U> = T extends { type: infer K }
	? Extract<U, { type: K }>
	: U;
type DroppedKeys<T, U> = unknown extends U
	? never
	: 0 extends 1 & T
		? "untyped producer field"
		: KnownDroppedKeys<NonNullable<T>, NonNullable<U>>;
type PresentKeys<T> = {
	[K in keyof T]-?: [Exclude<T[K], undefined>] extends [never] ? never : K;
}[keyof T];
type KnownDroppedKeys<T, U> = T extends readonly (infer E)[]
	? U extends readonly (infer F)[]
		? DroppedKeys<E, F>
		: never
	: T extends object
		?
				| Exclude<PresentKeys<T>, keyof U>
				| {
						[K in keyof T & keyof U]-?: DroppedKeys<T[K], U[K]>;
				  }[keyof T & keyof U]
		: never;
// Check nested keys too: structural assignability alone allows Zod to strip them.
export type AssertAssignable<T extends U, U> = T extends unknown
	? [DroppedKeys<T, EventVariant<T, U>>] extends [never]
		? T
		: never
	: never;

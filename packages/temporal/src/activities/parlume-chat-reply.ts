import { postParlumeMeetingChat } from "./parlume-voice";

/** A reply's share of one post: the bridge adds its tag ("[P12] ") to make 4,000. */
export const PARLUME_CHAT_POST_CHARS = 3_990;

/**
 * Cuts a reply into posts, each ending at a paragraph, line, sentence or word
 * break when one falls in its second half, so a post is never cut mid-word
 * unless a single word is longer than a post.
 */
export function chunkParlumeChatReply(
	text: string,
	size = PARLUME_CHAT_POST_CHARS,
): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > size) {
		const window = rest.slice(0, size);
		const breaks = ["\n\n", "\n", ". ", " "].map((mark) =>
			window.lastIndexOf(mark),
		);
		const cut = breaks.find((at) => at >= size / 2);
		const end = cut === undefined ? size : cut + 1;
		chunks.push(rest.slice(0, end).trim());
		rest = rest.slice(end).trim();
	}
	if (rest) {
		chunks.push(rest);
	}
	return chunks;
}

export type ParlumeChatReplyDelivery =
	| { sent: true; tags: string[] }
	| { sent: false; tags: string[]; reason: "chat_unavailable" | "failed" };

/**
 * Sends a whole reply to the meeting chat, a post at a time, stopping at the
 * first post that cannot be sent. The last post is marked final, which tells
 * the bridge a request typed in the chat has been answered.
 */
export async function sendParlumeChatReply(input: {
	sessionId: string;
	turnId: string;
	voiceGeneration: number;
	text: string;
}): Promise<ParlumeChatReplyDelivery> {
	const chunks = chunkParlumeChatReply(input.text);
	const tags: string[] = [];
	for (const [index, message] of chunks.entries()) {
		const result = await postParlumeMeetingChat({
			sessionId: input.sessionId,
			turnId: input.turnId,
			voiceGeneration: input.voiceGeneration,
			final: index === chunks.length - 1,
			message,
		});
		if (!result.sent) {
			return { sent: false, tags, reason: result.reason };
		}
		tags.push(result.tag);
	}
	return tags.length > 0
		? { sent: true, tags }
		: { sent: false, tags, reason: "failed" };
}

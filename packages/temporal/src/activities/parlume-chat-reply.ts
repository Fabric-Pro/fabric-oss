import { postParlumeMeetingChat } from "./parlume-voice";

/**
 * A reply's share of one post. The bridge adds its tag ("[P12] ") to make
 * 1,500, about a screen of the meeting chat, and shortens anything longer
 * with how to ask for the rest.
 */
export const PARLUME_CHAT_POST_CHARS = 1_490;

export type ParlumeChatReplyDelivery =
	| { sent: true; tags: string[] }
	| { sent: false; tags: string[]; reason: "chat_unavailable" | "failed" };

/**
 * Sends a reply to the meeting chat as one post, marked final, which tells the
 * bridge a request typed in the chat has been answered. A reply too long for
 * one post is shortened by the bridge, not split into several.
 */
export async function sendParlumeChatReply(input: {
	sessionId: string;
	turnId: string;
	voiceGeneration: number;
	text: string;
}): Promise<ParlumeChatReplyDelivery> {
	const message = input.text.trim();
	if (!message) {
		return { sent: false, tags: [], reason: "failed" };
	}
	const result = await postParlumeMeetingChat({
		sessionId: input.sessionId,
		turnId: input.turnId,
		voiceGeneration: input.voiceGeneration,
		final: true,
		message,
	});
	return result.sent
		? { sent: true, tags: [result.tag] }
		: { sent: false, tags: [], reason: result.reason };
}

import {
	closeParlumeMeetingChat,
	type ParlumeChatPostHeader,
	type ParlumeChatSendResult,
	postParlumeMeetingChat,
} from "./parlume-voice";

/** Longer than the one sentence a turn says about a proposal it posted. */
const PROPOSAL_NOTE_MAX_CHARS = 240;
/**
 * A second clause or sentence, or a qualification: the reply says more than
 * that the proposal waits, such as which parts of the request it leaves out
 * ("…; syncing it and assigning it are not included").
 */
const MORE_THAN_THE_NOTE =
	/[;:]|[.!?]\s+\S|\b(?:not|no|cannot|unable|but|however|except|although|though|also)\b|n['’]t\b/i;

/**
 * A post's share of the 600 characters the bridge allows one, a few short
 * lines of the meeting chat: the bridge adds its tag ("[P12] ") and shortens
 * anything longer, or longer than eight lines, with how to ask for the rest.
 */
export const PARLUME_CHAT_POST_CHARS = 590;
/**
 * What a chat answer is asked to keep within: the post's share less room for
 * the two header lines the bridge puts above an answer (the label with the
 * asker, and the request quoted up to 120 characters).
 */
export const PARLUME_CHAT_ANSWER_CHARS = 360;

type ParlumeChatNotSentReason = Extract<
	ParlumeChatSendResult,
	{ sent: false }
>["reason"];

export type ParlumeChatReplyDelivery =
	| { sent: true; tags: string[] }
	| { sent: false; tags: string[]; reason: ParlumeChatNotSentReason };

/**
 * What a turn's history says about an answer, or the rest of one, that did
 * not reach the meeting chat. The answer itself is on the Parlume page.
 */
export function parlumeChatNotSentNote(
	reason: ParlumeChatNotSentReason,
	part: "The answer" | "The rest of the answer",
): string {
	switch (reason) {
		case "chat_unavailable":
			return `${part} was not sent: this meeting's chat is unavailable to Parlume.`;
		case "guests_present":
			return `${part} was not sent: Parlume had not confirmed that everyone in the meeting can see this project, so it answered only on the Parlume page.`;
		case "failed":
			return `${part} could not be sent to the meeting chat.`;
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}

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
	header: ParlumeChatPostHeader;
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
		header: input.header,
	});
	return result.sent
		? { sent: true, tags: [result.tag] }
		: { sent: false, tags: [], reason: result.reason };
}

/**
 * Whether a reply only says that a proposal the turn posted waits for a
 * member: one short sentence naming its tag, and nothing more. The proposal
 * post already says that, with its Confirm and Dismiss links. A reply that
 * also says what is not done keeps its post.
 */
export function onlyNotesParlumeProposal(
	text: string,
	proposalTags: readonly string[],
): boolean {
	const reply = text.trim();
	return (
		reply.length <= PROPOSAL_NOTE_MAX_CHARS &&
		!MORE_THAN_THE_NOTE.test(reply) &&
		proposalTags.some((tag) => new RegExp(`\\b${tag}\\b`).test(reply))
	);
}

/**
 * Answers a request typed in the chat. A reply that only repeats what the
 * turn's proposal post says is not posted: the bridge is told the request is
 * answered. Should the bridge not take that, the reply is posted as before.
 */
export async function finishParlumeChatReply(input: {
	sessionId: string;
	turnId: string;
	voiceGeneration: number;
	text: string;
	header: ParlumeChatPostHeader;
	proposalTags: readonly string[];
}): Promise<ParlumeChatReplyDelivery> {
	if (
		onlyNotesParlumeProposal(input.text, input.proposalTags) &&
		(await closeParlumeMeetingChat(input))
	) {
		return { sent: true, tags: [] };
	}
	return sendParlumeChatReply(input);
}

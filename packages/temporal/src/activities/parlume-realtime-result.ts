import {
	onlyNotesParlumeProposal,
	type ParlumeChatReplyDelivery,
	sendParlumeChatReply,
} from "./parlume-chat-reply";
import { containsWebAddress } from "./parlume-spoken-text";
import {
	PARLUME_HEADLINE_SPOKEN_CHARS,
	type ParlumeChatPostHeader,
	postParlumeRealtimeResult,
} from "./parlume-voice";

export interface ParlumeRealtimeResultDelivery {
	/** The realtime voice took the result to speak. */
	spoken: boolean;
	chat: ParlumeChatReplyDelivery | null;
	/** Why the answer did not reach the meeting, for the turn's record. */
	note: string | null;
}

/**
 * Gives a realtime voice job's answer back to the meeting. An answer longer
 * than a spoken headline, one holding a link the voice never reads aloud, or
 * one that says more about a proposal the job posted, such as what it leaves
 * out, is posted to the chat in full first, so the voice can point to it;
 * one the voice can no longer take goes to the chat instead.
 */
export async function deliverParlumeRealtimeResult(input: {
	sessionId: string;
	turnId: string;
	voiceGeneration: number;
	job: string;
	text: string;
	/** Who asked, and what: the first lines of the answer's chat post. */
	asker: string | null;
	request: string;
	proposalTags: readonly string[];
}): Promise<ParlumeRealtimeResultDelivery> {
	const header: ParlumeChatPostHeader = {
		kind: "answer",
		asker: input.asker,
		request: input.request,
	};
	const reply = {
		sessionId: input.sessionId,
		turnId: input.turnId,
		voiceGeneration: input.voiceGeneration,
		text: input.text,
		header,
	};
	let chat =
		input.text.length > PARLUME_HEADLINE_SPOKEN_CHARS ||
		containsWebAddress(input.text) ||
		(input.proposalTags.length > 0 &&
			!onlyNotesParlumeProposal(input.text, input.proposalTags))
			? await sendParlumeChatReply(reply)
			: null;
	const spoken = await postParlumeRealtimeResult({
		sessionId: input.sessionId,
		turnId: input.turnId,
		job: input.job,
		status: "completed",
		text: input.text,
		chatTags: chat?.sent ? chat.tags : [],
	});
	if (!spoken && !chat) {
		chat = await sendParlumeChatReply(reply);
	}
	const reached = spoken || chat?.sent === true;
	return {
		spoken,
		chat,
		note: reached
			? null
			: chat?.sent === false && chat.reason === "chat_unavailable"
				? "The answer was not delivered: the realtime voice had ended and this meeting's chat is unavailable to Parlume."
				: "The answer was not delivered: the realtime voice had ended and the meeting chat could not be reached.",
	};
}

/** Tells the realtime voice its job did not finish, so it can say so. */
export async function failParlumeRealtimeJob(input: {
	sessionId: string;
	job: string;
}): Promise<void> {
	await postParlumeRealtimeResult({
		sessionId: input.sessionId,
		job: input.job,
		status: "failed",
		text: "",
		chatTags: [],
	});
}

import type { ParlumeChatPost } from "./parlume-chat";
import { parseParlumeSpokenReference, parseParlumeWake } from "./parlume-wake";

export type ParlumeReplyChannel = "VOICE" | "CHAT";

/**
 * What a participant's chat message asks of Parlume. Chat has no buttons, so
 * a post's tag is the handle: "say P7" or "read P7" reads post 7 aloud, "go
 * P7" speaks a suggestion (on a proposed change it posts the Confirm link and
 * never makes the change), "more P7" or "more on P7" asks for more on it,
 * "stop" ends the answer Parlume is giving, "continue" reads the next chapter
 * of a long post, "Parlume, help" posts what can be typed, and "Parlume,
 * pause" stops it listening. The post commands are the ones Parlume hears
 * spoken (`parseParlumeSpokenReference`).
 */
export type ParlumeChatCommand =
	| { kind: "stop" }
	| { kind: "pause" }
	| { kind: "continue" }
	| { kind: "help" }
	| { kind: "say"; tag: string }
	| { kind: "go"; tag: string }
	| { kind: "more"; tag: string }
	| { kind: "ask"; text: string; replyChannel: ParlumeReplyChannel };

export type ParlumeTaggedCommand = Extract<ParlumeChatCommand, { tag: string }>;

/** What a tagged command asks for: a post read aloud, or a request to run. */
export type ParlumePostAction =
	| { kind: "speak"; text: string }
	| { kind: "ask"; text: string };

/** A proposal's Confirm link, posted again instead of making the change. */
export interface ParlumeConfirmLink {
	kind: "confirm-link";
	tag: string;
	confirmUrl: string;
}

/**
 * What a tagged command does with a post. `say` reads it aloud. On a
 * proposal, `go` and `more` point to its Confirm link: no chat or spoken
 * command makes a change. On any other post `go` reads it aloud and `more`
 * asks about it.
 */
export function parlumePostReply(
	command: ParlumeTaggedCommand["kind"],
	post: ParlumeChatPost,
): ParlumePostAction | ParlumeConfirmLink {
	switch (command) {
		case "say":
			return { kind: "speak", text: post.text };
		case "go":
			return post.proposal
				? {
						kind: "confirm-link",
						tag: post.tag,
						confirmUrl: post.proposal.confirmUrl,
					}
				: { kind: "speak", text: post.text };
		// The agent took "P1" for a work item it could not find ("There is
		// no P1 identifier"): the tag is only the post's label in the chat.
		case "more":
			return post.proposal
				? {
						kind: "confirm-link",
						tag: post.tag,
						confirmUrl: post.proposal.confirmUrl,
					}
				: {
						kind: "ask",
						text: `More detail on what Parlume posted in the meeting chat as ${post.tag} (the label of that chat message, not a work item ID): ${post.text}`,
					};
		default: {
			const unreachable: never = command;
			return unreachable;
		}
	}
}

// Teams renders an @mention as the bot's display name, with or without the @.
const MENTION = /^\s*@\s*(?:fabric\s+parlume|fabric|parlume)\b[\s,:;.!?–—-]*/i;
const DISPLAY_NAME = /^\s*fabric\s+parlume\b[\s,:;.!?–—-]*/i;
const HELP =
	/^(?:please\s+)?(?:help|commands|what\s+can\s+(?:i|we)\s+(?:type|say|ask)(?:\s+you)?)(?:\s+please)?[\s.!?]*$/i;
// A stop typed as a whole message. Unaddressed, only a plain "stop" counts:
// "wait" or "never mind" in a meeting chat is usually said to people.
const BARE_STOP =
	/^(?:(?:please|ok(?:ay)?)\s+)?stop(?:\s+(?:talking|speaking))?(?:\s+please)?[\s.!]*$/i;
const ADDRESSED_STOP =
	/^(?:(?:please|ok(?:ay)?)\s+)?(?:stop(?:\s+(?:talking|speaking))?|wait|hold\s+on|hang\s+on|never\s*mind|not\s+that|cancel|that[’']?s\s+enough|enough|be\s+quiet|quiet|shut\s+up)(?:\s+please)?[\s.!]*$/i;
const PAUSE =
	/^(?:please\s+)?(?:pause|stop\s+listening)(?:\s+please)?[\s.!]*$/i;
const CONTINUE =
	/^(?:please\s+)?(?:continue|go\s+on|keep\s+(?:going|reading))(?:\s+please)?[\s.!]*$/i;
const ALOUD =
	/^(?:please\s+)?(?:say|announce|tell\s+(?:everyone|everybody|us|the\s+(?:room|team|meeting)))\b|\b(?:out\s+loud|aloud)\b/i;

/** The request in a message addressed to Parlume, or null when it is not addressed. */
function addressedText(text: string, toBot: boolean): string | null {
	const mention = MENTION.exec(text) ?? DISPLAY_NAME.exec(text);
	if (mention) {
		return text.slice(mention[0].length).trim();
	}
	// A typed message has one author and its address up front; a "Parlume,"
	// further on is more likely quoted or pasted than said to Parlume.
	const wake = parseParlumeWake(text, { midTurn: false });
	if (wake !== null) {
		return wake;
	}
	return toBot ? text.trim() : null;
}

/** "pause" or "stop listening": what follows Parlume's name in a pause. */
export function isParlumePauseRequest(request: string): boolean {
	return PAUSE.test(request.trim());
}

/** "continue" or "go on": the next chapter of a post being read aloud. */
export function isParlumeContinueRequest(request: string): boolean {
	return CONTINUE.test(request.trim());
}

/**
 * A post command counts as the whole message, addressed or not, since
 * Parlume's own posts invite the reply "go P7"; so do a plain "stop" and a
 * plain "continue", which only acts while a chapter waits to be read. The
 * other stop phrases ("wait", "cancel", "never mind" …) and anything else, a
 * pause and help included, must be addressed: an @mention, "Fabric, …",
 * "Hey Parlume …", or a private message to the bot. Its answer goes back to
 * the chat unless it asks to be said aloud. A message that opens with a tag
 * is Parlume's own post shown back, and the chat never reads it as a command.
 */
export function parseParlumeChatCommand(
	text: string,
	toBot: boolean,
): ParlumeChatCommand | null {
	const addressed = addressedText(text, toBot);
	const body = addressed ?? text.trim();
	const tagged = parseParlumeSpokenReference(body);
	if (tagged) {
		return tagged;
	}
	if (addressed !== null && isParlumePauseRequest(addressed)) {
		return { kind: "pause" };
	}
	if (addressed !== null && HELP.test(addressed)) {
		return { kind: "help" };
	}
	if ((addressed === null ? BARE_STOP : ADDRESSED_STOP).test(body.trim())) {
		return { kind: "stop" };
	}
	if (isParlumeContinueRequest(body)) {
		return { kind: "continue" };
	}
	if (!addressed) {
		return null;
	}
	return {
		kind: "ask",
		text: addressed,
		replyChannel: ALOUD.test(addressed) ? "VOICE" : "CHAT",
	};
}

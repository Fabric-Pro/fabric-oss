import { normalizeParlumeChatTag } from "./parlume-chat";
import { parseParlumeWake } from "./parlume-wake";

export type ParlumeReplyChannel = "VOICE" | "CHAT";

/**
 * What a participant's chat message asks of Parlume. Chat has no buttons, so
 * a post's tag is the handle: "say P7" reads post 7 aloud, "go P7" speaks a
 * suggestion or makes a change Parlume held back, "more P7" asks for more on
 * it, and "stop" silences Parlume.
 */
export type ParlumeChatCommand =
	| { kind: "stop" }
	| { kind: "say"; tag: string }
	| { kind: "go"; tag: string }
	| { kind: "more"; tag: string }
	| { kind: "ask"; text: string; replyChannel: ParlumeReplyChannel };

export type ParlumeTaggedCommand = Extract<ParlumeChatCommand, { tag: string }>;

// Teams renders an @mention as the bot's display name, with or without the @.
const MENTION = /^\s*@\s*(?:fabric\s+parlume|fabric|parlume)\b[\s,:;.!?–—-]*/i;
const DISPLAY_NAME = /^\s*fabric\s+parlume\b[\s,:;.!?–—-]*/i;
const TAGGED_COMMAND = /^(say|go|more)\s+(\[?p\d{1,6}\]?)[\s.!]*$/i;
const STOP = /^stop[\s.!]*$/i;
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

/**
 * A tagged command or "stop" counts as the whole message, addressed or not,
 * since Parlume's own posts invite the reply "go P7". Anything else must be
 * addressed: an @mention, "Fabric, …", "Hey Parlume …", or a private message
 * to the bot. Its answer goes back to the chat unless it asks to be said aloud.
 */
export function parseParlumeChatCommand(
	text: string,
	toBot: boolean,
): ParlumeChatCommand | null {
	const addressed = addressedText(text, toBot);
	const body = addressed ?? text.trim();
	const tagged = TAGGED_COMMAND.exec(body);
	if (tagged) {
		const tag = normalizeParlumeChatTag(tagged[2]);
		if (tag) {
			const verb = tagged[1].toLowerCase();
			return verb === "more"
				? { kind: "more", tag }
				: verb === "go"
					? { kind: "go", tag }
					: { kind: "say", tag };
		}
	}
	if (STOP.test(body)) {
		return { kind: "stop" };
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

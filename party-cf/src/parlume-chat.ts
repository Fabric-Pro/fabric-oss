import { isRecord } from "./parlume-stream-auth";

// Attendee only queues a chat message: its Teams bot drops one silently when
// the meeting gives a guest no chat box, and reports it sent all the same. So
// every post carries a short tag ("[P7]"), and the post counts as delivered
// only once the meeting chat shows it back to the bridge.

/** The most a post may hold, tag included. */
const PARLUME_CHAT_MAX_CHARS = 4_000;
/**
 * How long a post may take to appear in the meeting chat. Short posts echo
 * back in four to five seconds; a long one has taken over eight.
 */
export const PARLUME_CHAT_CONFIRM_MS = 15_000;
export const PARLUME_CHAT_UNAVAILABLE_LINE =
	"I can't write in this meeting's chat. Guests may not have chat here.";
const MAX_TRACKED_POSTS = 50;
const MAX_SEEN_MESSAGES = 200;
const MAX_MESSAGE_ID_CHARS = 128;
const MAX_INBOUND_CHARS = 20_000;
const MAX_SENDER_CHARS = 256;
const MAX_SPOKEN_SENTENCE_CHARS = 1_500;
const MAX_SPOKEN_CHARS = 6_000;
const TAG = /^\s*\[P(\d{1,6})\]/i;
const TAG_REF = /^\[?p(\d{1,6})\]?$/i;

export type ParlumeChatPostKind = "reply" | "suggestion" | "held";
type ParlumeChatDelivery = "queued" | "confirmed" | "unconfirmed";

export interface ParlumeChatPost {
	tag: string;
	/** What `say` and `go` speak: the post without its tag or framing. */
	text: string;
	turnId: string | null;
	kind: ParlumeChatPostKind;
	/**
	 * A held change's request, as it was asked: what `go` runs. Cleared once
	 * it has run, so a second `go` cannot make the change twice.
	 */
	request?: string;
	sentAt: number;
	delivery: ParlumeChatDelivery;
}

export interface ParlumeChatState {
	nextNumber: number;
	posts: ParlumeChatPost[];
	/** When the bridge last saw any message in the meeting chat; null until it has. */
	lastObservedAt: number | null;
	/** A post went unseen while the chat had shown nothing at all. */
	unavailable: boolean;
	/** Parlume has said aloud that it cannot write in the chat. */
	announced: boolean;
	seenMessageIds: string[];
}

/** One meeting chat message as Fabric relays it from Attendee. */
export interface ParlumeChatMessage {
	id: string;
	text: string;
	senderName: string | null;
	senderId: string | null;
	/** Sent privately to the bot rather than to everyone. */
	toBot: boolean;
	timestampMs: number | null;
}

export type ParlumeChatObservation =
	| { kind: "duplicate" }
	| {
			kind: "parlume";
			becameAvailable: boolean;
			confirmed: ParlumeChatPost | null;
			late: boolean;
	  }
	| { kind: "participant"; becameAvailable: boolean };

export function emptyParlumeChatState(): ParlumeChatState {
	return {
		nextNumber: 1,
		posts: [],
		lastObservedAt: null,
		unavailable: false,
		announced: false,
		seenMessageIds: [],
	};
}

function boundedString(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length <= max ? value : null;
}

/**
 * The `chat-message` control action's body. Fabric validated the webhook it
 * came from; the bridge checks the bounds again rather than rely on that.
 */
export function parseParlumeChatMessage(
	body: unknown,
): ParlumeChatMessage | null {
	if (!isRecord(body)) {
		return null;
	}
	const id = boundedString(body.id, MAX_MESSAGE_ID_CHARS);
	const text = boundedString(body.text, MAX_INBOUND_CHARS);
	if (!id || text === null) {
		return null;
	}
	const timestampMs =
		typeof body.timestampMs === "number" &&
		Number.isFinite(body.timestampMs)
			? body.timestampMs
			: null;
	return {
		id,
		text: text.trim(),
		senderName: boundedString(body.senderName, MAX_SENDER_CHARS) || null,
		senderId: boundedString(body.senderId, MAX_SENDER_CHARS) || null,
		toBot: body.toBot === true,
		timestampMs,
	};
}

/**
 * The tag a message opens with ("P7"), or null.
 * @public
 */
export function parlumeChatTag(text: string): string | null {
	const match = TAG.exec(text);
	return match ? `P${Number(match[1])}` : null;
}

/** A tag as a participant types it back: "P7", "p7" or "[P7]". */
export function normalizeParlumeChatTag(ref: string): string | null {
	const match = TAG_REF.exec(ref.trim());
	return match ? `P${Number(match[1])}` : null;
}

/**
 * The meeting chat receives a post as one typed line: Markdown shows as
 * literal asterisks and line breaks are lost. So emphasis and rules go, and
 * each line follows the one before it, a list item after a bullet.
 */
function plainParlumeChatText(body: string): string {
	return body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !/^([-*_])\1{2,}$/.test(line))
		.map((line) =>
			line
				.replace(/^#{1,6}\s+/, "")
				.replace(/^[-*+]\s+/, "• ")
				.replace(/(\*\*|__)(.+?)\1/g, "$2"),
		)
		.join(" ");
}

export function composeParlumeChatMessage(tag: string, body: string): string {
	const prefix = `[${tag}] `;
	const room = PARLUME_CHAT_MAX_CHARS - prefix.length;
	const text = plainParlumeChatText(body);
	return `${prefix}${text.length > room ? `${text.slice(0, room - 1)}…` : text}`;
}

export function findParlumeChatPost(
	state: ParlumeChatState,
	tag: string,
): ParlumeChatPost | undefined {
	return state.posts.find((post) => post.tag === tag);
}

/** Numbers and keeps a post before it is sent; the oldest beyond fifty are forgotten. */
export function recordParlumeChatPost(
	state: ParlumeChatState,
	input: {
		text: string;
		turnId: string | null;
		kind: ParlumeChatPostKind;
		request?: string;
	},
	now: number,
): ParlumeChatPost {
	const post: ParlumeChatPost = {
		tag: `P${state.nextNumber}`,
		text: input.text.trim(),
		turnId: input.turnId,
		kind: input.kind,
		...(input.request ? { request: input.request } : {}),
		sentAt: now,
		delivery: "queued",
	};
	state.nextNumber++;
	state.posts.push(post);
	if (state.posts.length > MAX_TRACKED_POSTS) {
		state.posts.splice(0, state.posts.length - MAX_TRACKED_POSTS);
	}
	return post;
}

/** A post Fabric refused to send is not waited for. */
export function forgetParlumeChatPost(
	state: ParlumeChatState,
	tag: string,
): void {
	state.posts = state.posts.filter((post) => post.tag !== tag);
}

/**
 * Any message shows the chat works, and clears an earlier "unavailable". One
 * that carries a waiting post's tag, or comes from Parlume itself, confirms
 * that post and is never treated as a participant's request.
 */
export function observeParlumeChatMessage(
	state: ParlumeChatState,
	message: ParlumeChatMessage,
	fromParlumeSender: boolean,
	now: number,
): ParlumeChatObservation {
	if (state.seenMessageIds.includes(message.id)) {
		return { kind: "duplicate" };
	}
	state.seenMessageIds.push(message.id);
	if (state.seenMessageIds.length > MAX_SEEN_MESSAGES) {
		state.seenMessageIds.splice(
			0,
			state.seenMessageIds.length - MAX_SEEN_MESSAGES,
		);
	}
	const becameAvailable = state.unavailable;
	state.unavailable = false;
	state.lastObservedAt = now;
	const tag = parlumeChatTag(message.text);
	const post = tag ? findParlumeChatPost(state, tag) : undefined;
	if (!post && !tag && !fromParlumeSender) {
		return { kind: "participant", becameAvailable };
	}
	if (!post || post.delivery === "confirmed") {
		return {
			kind: "parlume",
			becameAvailable,
			confirmed: null,
			late: false,
		};
	}
	const late = post.delivery === "unconfirmed";
	post.delivery = "confirmed";
	return { kind: "parlume", becameAvailable, confirmed: post, late };
}

/**
 * Posts still waiting after the confirmation window become unconfirmed. When
 * the chat has shown nothing at all since Parlume joined, a missing post means
 * the chat is out of Parlume's reach, not slow.
 */
export function expireParlumeChatPosts(
	state: ParlumeChatState,
	now: number,
): { expired: ParlumeChatPost[]; becameUnavailable: boolean } {
	const expired = state.posts.filter(
		(post) =>
			post.delivery === "queued" &&
			now - post.sentAt >= PARLUME_CHAT_CONFIRM_MS,
	);
	for (const post of expired) {
		post.delivery = "unconfirmed";
	}
	const becameUnavailable =
		expired.length > 0 &&
		state.lastObservedAt === null &&
		!state.unavailable;
	if (becameUnavailable) {
		state.unavailable = true;
	}
	return { expired, becameUnavailable };
}

/** When the next waiting post runs out of time, or null. */
export function nextParlumeChatDeadline(
	state: ParlumeChatState,
): number | null {
	const deadlines = state.posts
		.filter((post) => post.delivery === "queued")
		.map((post) => post.sentAt + PARLUME_CHAT_CONFIRM_MS);
	return deadlines.length ? Math.min(...deadlines) : null;
}

/**
 * A post read aloud: addresses become "the link", and the text is cut into
 * sentences the bridge's synthesizer accepts.
 */
export async function* parlumeChatSpeech(text: string): AsyncGenerator<string> {
	const spoken = text
		.replace(/https?:\/\/\S+/gi, "the link")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_SPOKEN_CHARS);
	for (const match of spoken.matchAll(/[^.!?]+(?:[.!?]+|$)/g)) {
		let sentence = match[0].trim();
		while (sentence.length > MAX_SPOKEN_SENTENCE_CHARS) {
			yield sentence.slice(0, MAX_SPOKEN_SENTENCE_CHARS);
			sentence = sentence.slice(MAX_SPOKEN_SENTENCE_CHARS).trim();
		}
		if (sentence) {
			yield sentence;
		}
	}
}

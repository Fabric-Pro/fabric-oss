import { isRecord } from "./parlume-stream-auth";

// Attendee only queues a chat message: its Teams bot drops one silently when
// the meeting gives a guest no chat box, and reports it sent all the same. So
// every post carries a short tag ("[P7]"), and the post counts as delivered
// only once the meeting chat shows it back to the bridge.

/**
 * The most a post may hold, tag and header included, and the most lines its
 * body shows: a few short lines a participant reads at a glance. A longer
 * answer is shortened, with how to ask for the rest. The agent is asked for
 * eight short lines, and a live answer still came as 10 lines and 1,438
 * characters, so the bridge holds the limit itself.
 */
const PARLUME_CHAT_MAX_CHARS = 600;
const PARLUME_CHAT_MAX_LINES = 8;
/**
 * How long a post may take to appear in the meeting chat. Short posts echo
 * back in four to five seconds; a long one has taken over eight.
 */
export const PARLUME_CHAT_CONFIRM_MS = 15_000;
/**
 * How long after the chat is marked out of reach Parlume waits before saying
 * so. A join notice's echo has arrived under a second after its window, while
 * the line was being said.
 */
export const PARLUME_CHAT_UNAVAILABLE_GRACE_MS = 5_000;
export const PARLUME_CHAT_UNAVAILABLE_LINE =
	"I can't write in this meeting's chat. Guests may not have chat here.";
/**
 * The answer to `say`, `go` or `more` on a post this session issued and no
 * longer has.
 */
export function parlumePostNotAvailableLine(tag: string): string {
	return `${tag}: This prepared answer is no longer available. Ask me again.`;
}

/** Tags as ranges, consecutive ones joined: "P4 to P6, P9". */
function parlumeTagRanges(numbers: number[]): string {
	const ranges: Array<{ first: number; last: number }> = [];
	for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
		const last = ranges.at(-1);
		if (last && number === last.last + 1) {
			last.last = number;
		} else {
			ranges.push({ first: number, last: number });
		}
	}
	return ranges
		.map(({ first, last }) =>
			first === last ? `P${first}` : `P${first} to P${last}`,
		)
		.join(", ");
}

/**
 * The line Parlume posts as it leaves the meeting: the posts this session
 * offered, and sent, can no longer be played. Notices and refused posts are
 * not among them. A proposed change is named apart: its Confirm and Dismiss
 * links are on its page in Fabric, which the meeting ending does not close.
 */
export function parlumeChatEndedText(
	offered: number[],
	proposed: number[] = [],
): string {
	const ended = offered.length
		? `Unavailable: ${parlumeTagRanges(offered)}. This meeting has ended for Parlume, so these posts can no longer be played.`
		: "This meeting has ended for Parlume.";
	if (!proposed.length) {
		return ended;
	}
	const tags = parlumeTagRanges(proposed);
	return new Set(proposed).size === 1
		? `${ended} The proposed change ${tags} stays on its page in Fabric.`
		: `${ended} The proposed changes ${tags} stay on their pages in Fabric.`;
}

/**
 * The answer to a typed `go` or `more` on a proposal: the way to confirm it,
 * which no chat command does. The link label never starts with a tag.
 */
export function parlumeGoOnProposalText(
	tag: string,
	confirmUrl: string,
): string {
	return `${tag} is a proposed change. A signed-in member confirms it in Fabric: [Confirm ${tag} in Fabric](${confirmUrl})`;
}

/** The answer to `say`, `go` or `more` on a post an earlier session made. */
const PARLUME_CHAT_EARLIER_SESSION_LINE =
	"This meeting has ended for the Parlume session that posted it, so it can no longer be played.";
/** The highest number a session's first tag may start from. */
export const PARLUME_CHAT_MAX_FIRST_NUMBER = 100_000;
// The chat state tracks the delivery of the latest fifty posts. Every post is
// also stored on its own key for the rest of the session, so `go` plays it
// however old it is.
const MAX_TRACKED_POSTS = 50;
const MAX_SEEN_MESSAGES = 200;
const MAX_MESSAGE_ID_CHARS = 128;
const MAX_INBOUND_CHARS = 20_000;
const MAX_SENDER_CHARS = 256;
const MAX_SPOKEN_SENTENCE_CHARS = 1_500;
const MAX_SPOKEN_CHARS = 6_000;
/**
 * The longest Parlume speaks at once, in either voice: one answer, or one
 * chapter of a post read aloud. The worker holds the same budget for the
 * answers it speaks (`PARLUME_MAX_SPOKEN_CHARS`).
 */
export const PARLUME_SPOKEN_BUDGET_SECONDS = 45;
// Aura and the realtime voice both speak about 15 characters a second.
const SPOKEN_CHARS_PER_SECOND = 15;
const SPOKEN_BUDGET_CHARS =
	PARLUME_SPOKEN_BUDGET_SECONDS * SPOKEN_CHARS_PER_SECOND;
/** Said at the end of a chapter that has another after it. */
const CONTINUE_HINT =
	"There is more. Ask me to continue, or type continue in the chat.";
// A chapter leaves room for the hint, and for the asker's name it may open
// with.
const CHAPTER_CHARS = SPOKEN_BUDGET_CHARS - CONTINUE_HINT.length - 40;
/** How long the rest of a read waits to be asked for. */
const CHAPTER_HOLD_MS = 5 * 60 * 1000;
const SPOKEN_SENTENCE = /[^.!?]+(?:[.!?]+|$)/g;
/** A line that holds one address and nothing else but a list marker. */
const SPOKEN_ADDRESS_LINE = /^(?:(?:[-*+•]|\d{1,3}[.)])\s+)?https?:\/\/\S+$/i;
const TAG = /^\s*\[P(\d{1,6})\]/i;
/**
 * The most of the rest's own words a shortened post quotes: with the longest
 * header, the shown part still keeps about a hundred characters.
 */
const MAX_OUTCOME_QUOTE_CHARS = 150;
// What a shortened answer can leave behind "more": a change that did not
// happen or could not be confirmed. The first post must not read as full
// success when the rest says otherwise. A post carries only the agent's
// words, so these are the ways it words an action that failed, was refused,
// cancelled or interrupted, or whose outcome is unknown.
const INCOMPLETE_OUTCOME =
	/\b(?:unavailable|unconfirmed|unverified|not (?:confirmed|verified|found|permitted|allowed)|failed|skipped|timed out|interrupted|cancell?ed|denied|rejected|unable to|outcome (?:is )?unknown|can(?:not| not|['’]t)|(?:could|did|was|were) ?n(?:o|['’])t|(?:has|have|had) ?n(?:o|['’])t been)\b/i;

export type ParlumeChatPostKind =
	| "reply"
	| "suggestion"
	| "proposal"
	| "notice";
type ParlumeChatDelivery = "queued" | "confirmed" | "unconfirmed";

/** A change Parlume proposed, which a member confirms or dismisses in Fabric. */
export interface ParlumeChatProposal {
	actionId: string;
	confirmUrl: string;
	dismissUrl: string;
}

export interface ParlumeChatPost {
	tag: string;
	/** What `say` and `go` speak: the post without its tag or framing. */
	text: string;
	/** The lines under the tag that say what the post is and whom it answers. */
	header?: string;
	turnId: string | null;
	kind: ParlumeChatPostKind;
	/** A proposal's action and links: what `go` and `more` point to. */
	proposal?: ParlumeChatProposal;
	/** It answers a request: the meeting is told when it does not show up. */
	requested?: true;
	sentAt: number;
	delivery: ParlumeChatDelivery;
}

export interface ParlumeChatState {
	nextNumber: number;
	/**
	 * This session's first tag number. Earlier sessions in the same meeting
	 * chat issued the numbers below it. Absent from a state stored before
	 * sessions continued the meeting's numbering, which started at 1.
	 */
	firstNumber?: number;
	posts: ParlumeChatPost[];
	/** When the bridge last saw any message in the meeting chat; null until it has. */
	lastObservedAt: number | null;
	/** A post went unseen while the chat had shown nothing at all. */
	unavailable: boolean;
	/** When the chat was marked out of reach. Absent from an older state. */
	unavailableAt?: number;
	/** Parlume has said aloud that it cannot write in the chat. */
	announced: boolean;
	/**
	 * The numbers of requested posts that went unconfirmed in a chat that
	 * works, until Parlume has said they did not show up. One the chat shows
	 * late is taken off.
	 */
	unseen?: number[];
	seenMessageIds: string[];
	/** Absent until the bot's stream is first verified. */
	joinNotice?: ParlumeChatJoinNotice;
	/**
	 * The numbers of the posts other than notices and proposals that Fabric
	 * took to send; absent until there is one.
	 */
	offered?: number[];
	/** The numbers of the proposals Fabric took to send; absent until one is. */
	proposed?: number[];
	/** Fabric is having the bot leave: the meeting was told once. */
	ended?: true;
	/** The meeting was told once why Parlume is leaving. */
	departed?: true;
	/**
	 * The recap, kept until Parlume may answer in the chat and the meeting
	 * has the join notice. Dropped once Parlume's leaving line was posted.
	 */
	heldRecap?: string;
	/**
	 * The notes-only notice, kept until the meeting has the join notice.
	 * Dropped once Parlume's leaving line was posted.
	 */
	guestsNoticeHeld?: true;
	/** Fabric gave a join notice when it verified the stream. */
	joinNoticeDue?: true;
}

/** The notice Parlume posts once per session, when it is admitted. */
interface ParlumeChatJoinNotice {
	text: string;
	/** Said aloud in its place when the chat is out of Parlume's reach. */
	spoken: string;
	/** The notice's post, once Fabric took it. */
	tag: string | null;
	/** How the meeting got the notice, once it did. */
	deliveredVia: "chat" | "voice" | null;
	/** Fabric recorded the delivery on the session. */
	reported: boolean;
}

/** One meeting chat message as Fabric relays it from Attendee. */
export interface ParlumeChatMessage {
	id: string;
	text: string;
	senderName: string | null;
	senderId: string | null;
	/** Fabric took the sender for an external guest. */
	senderExternal?: true;
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
		...(body.senderExternal === true ? { senderExternal: true } : {}),
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

/**
 * Headings and rules go, a list item gets a bullet and a numbered item keeps
 * "1.". Bold, italics and named links stay: Fabric renders them as HTML. Each
 * line stays a line and a blank line stays one paragraph break, as Fabric
 * sends a break per line, so a list reads one item per line instead of
 * running together.
 */
function plainParlumeChatText(body: string): string {
	return body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => !/^([-*_])\1{2,}$/.test(line))
		.map((line) =>
			line
				.replace(/^#{1,6}\s+/, "")
				.replace(/^[-*+]\s+/, "• ")
				.replace(/^(\d{1,3})[.)]\s+/, "$1. "),
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Cuts text to `max` at the last paragraph, line, sentence or word break in
 * its second half, so a shortened post never stops mid-word unless one word
 * fills it.
 */
function shortenParlumeChatText(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const window = text.slice(0, max);
	const cut = ["\n\n", "\n", ". ", " "]
		.map((mark) => window.lastIndexOf(mark) + (mark === ". " ? 1 : 0))
		.find((at) => at >= max / 2);
	return window.slice(0, cut ?? max).trim();
}

/** The text up to the end of its `max`th non-blank line; all of it when it has no more. */
function firstParlumeChatLines(text: string, max: number): string {
	let lines = 0;
	let end = 0;
	for (const line of text.split("\n")) {
		end += line.length + 1;
		if (line.trim() && ++lines === max) {
			return text.slice(0, end - 1);
		}
	}
	return text;
}

/**
 * The chat message for a post, and the part of its text a shortened post
 * leaves out, which a "more" reply posts from the stored text.
 */
function splitParlumeChatMessage(
	tag: string,
	body: string,
	header: string | undefined,
	kind: ParlumeChatPostKind | undefined,
): { message: string; rest: string } {
	// The header is kept whole: only the body is shortened.
	const prefix = header ? `[${tag}] ${header}\n` : `[${tag}] `;
	const text = plainParlumeChatText(body);
	const lines = firstParlumeChatLines(text, PARLUME_CHAT_MAX_LINES);
	// A proposal is posted whole: its template bounds each of its six lines,
	// and its Confirm and Dismiss links, two full addresses, must never wait
	// behind "more".
	if (
		kind === "proposal" ||
		(lines === text &&
			prefix.length + text.length <= PARLUME_CHAT_MAX_CHARS)
	) {
		return { message: `${prefix}${text}`, rest: "" };
	}
	const split = (more: string) => {
		const room = PARLUME_CHAT_MAX_CHARS - prefix.length - more.length - 1;
		const shown = shortenParlumeChatText(lines, room);
		// A cut right after a sentence's end gets no "…": after its full
		// stop, the two read as four dots.
		const ellipsis = /[.!?…]["'”’)\]]*$/.test(shown) ? "" : "…";
		return {
			message: `${prefix}${shown}${ellipsis}${more}`,
			rest: text.slice(shown.length).trim(),
		};
	};
	const whole = split(
		`\n\nShortened for the chat. Reply "more ${tag}" for the rest.`,
	);
	// The rest's own words are quoted, never summed up: plain prose can use
	// the same words as an outcome that did not complete. A shorter cut only
	// moves text into the rest, so it still holds the quoted sentence.
	const outcome = incompleteOutcome(whole.rest);
	return outcome
		? split(
				`\n\nShortened for the chat. The rest also says: “${outcome}” Reply "more ${tag}" for all of it.`,
			)
		: whole;
}

/** The rest's first sentence that words an outcome that did not complete. */
function incompleteOutcome(rest: string): string | null {
	const sentence = rest
		.split(/(?<=[.!?])\s+|\n+/)
		.map((part) => part.replace(/^(?:•|\d{1,3}\.)\s+/, "").trim())
		.find((part) => INCOMPLETE_OUTCOME.test(part));
	if (!sentence) {
		return null;
	}
	return sentence.length <= MAX_OUTCOME_QUOTE_CHARS
		? sentence
		: `${shortenParlumeChatText(sentence, MAX_OUTCOME_QUOTE_CHARS - 1)}…`;
}

export function composeParlumeChatMessage(
	tag: string,
	body: string,
	header?: string,
	kind?: ParlumeChatPostKind,
): string {
	return splitParlumeChatMessage(tag, body, header, kind).message;
}

/** What a shortened post left out of the chat; empty when it was posted whole. */
export function parlumeChatPostRest(
	post: Pick<ParlumeChatPost, "tag" | "text" | "header"> &
		Partial<Pick<ParlumeChatPost, "kind">>,
): string {
	return splitParlumeChatMessage(post.tag, post.text, post.header, post.kind)
		.rest;
}

export function findParlumeChatPost(
	state: ParlumeChatState,
	tag: string,
): ParlumeChatPost | undefined {
	return state.posts.find((post) => post.tag === tag);
}

/**
 * Continues the meeting chat's numbering from the tags earlier sessions in
 * the same meeting issued, so no tag names two posts. Only a session that
 * has posted nothing yet starts later.
 */
export function startParlumeChatTagsAt(
	state: ParlumeChatState,
	first: number,
): void {
	if (state.posts.length > 0 || state.firstNumber !== undefined) {
		return;
	}
	state.firstNumber = Math.max(state.nextNumber, first);
	state.nextNumber = state.firstNumber;
}

/** A tag an earlier session in this meeting issued. */
export function isEarlierParlumeSessionTag(
	state: ParlumeChatState,
	tag: string,
): boolean {
	const number = Number(tag.slice(1));
	return number >= 1 && number < (state.firstNumber ?? 1);
}

/**
 * The answer to `say`, `go` or `more` on a tag this session has no post
 * for: an earlier session's post, a tag no post in this meeting carried, or
 * a post this session issued and no longer has.
 */
export function parlumeMissingPostLine(
	state: ParlumeChatState,
	tag: string,
): string {
	if (isEarlierParlumeSessionTag(state, tag)) {
		return `${tag}: ${PARLUME_CHAT_EARLIER_SESSION_LINE}`;
	}
	const number = Number(tag.slice(1));
	return number < 1 || number >= state.nextNumber
		? `${tag}: There is no ${tag} in this meeting's chat. Check the tag on the post you mean.`
		: parlumePostNotAvailableLine(tag);
}

/** The storage key that keeps a post for the rest of the session. */
export function parlumeChatPostKey(tag: string): string {
	return `chatPost:${tag}`;
}

/**
 * Numbers a post before it is sent and tracks its delivery. Only the latest
 * fifty are tracked here; the caller stores each post under its own key.
 */
export function recordParlumeChatPost(
	state: ParlumeChatState,
	input: {
		text: string;
		header?: string;
		turnId: string | null;
		kind: ParlumeChatPostKind;
		proposal?: ParlumeChatProposal;
		requested?: boolean;
	},
	now: number,
): ParlumeChatPost {
	const post: ParlumeChatPost = {
		tag: `P${state.nextNumber}`,
		text: input.text.trim(),
		...(input.header ? { header: input.header } : {}),
		turnId: input.turnId,
		kind: input.kind,
		...(input.proposal ? { proposal: input.proposal } : {}),
		...(input.requested ? { requested: true } : {}),
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
 * Fabric took a post to send: unless it is a notice, it is one of the posts
 * the leaving line names, a proposal apart from the rest.
 */
export function noteParlumeChatOffer(
	state: ParlumeChatState,
	post: Pick<ParlumeChatPost, "tag" | "kind">,
): void {
	const number = Number(post.tag.slice(1));
	switch (post.kind) {
		case "notice":
			return;
		case "proposal":
			state.proposed = [...(state.proposed ?? []), number];
			return;
		case "reply":
		case "suggestion":
			state.offered = [...(state.offered ?? []), number];
			return;
		default: {
			const unreachable: never = post.kind;
			throw new Error(`Unknown post kind: ${unreachable}`);
		}
	}
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
	if (late && state.unseen) {
		const number = Number(post.tag.slice(1));
		state.unseen = state.unseen.filter((unseen) => unseen !== number);
	}
	return { kind: "parlume", becameAvailable, confirmed: post, late };
}

/**
 * Posts still waiting after the confirmation window become unconfirmed. When
 * the chat has shown nothing at all since Parlume joined, a missing post means
 * the chat is out of Parlume's reach, not slow, and the meeting is told that
 * instead. Otherwise each requested one is kept to be said as unseen.
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
		state.unavailableAt = now;
	}
	const unseen = state.unavailable
		? []
		: expired
				.filter((post) => post.requested)
				.map((post) => Number(post.tag.slice(1)));
	if (unseen.length > 0) {
		state.unseen = [...(state.unseen ?? []), ...unseen];
	}
	return { expired, becameUnavailable };
}

/** What Parlume says when posts it made for a request did not show up. */
export function parlumeUnseenPostsLine(numbers: number[]): string {
	return `${parlumeTagRanges(numbers)} did not show up in the chat.`;
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
 * A post as either voice reads it: a link says only its title, as the chat
 * shows it ("Overview — address", "Overview: address", or "Overview" over a
 * line holding only the address), and an address without one says "the
 * link". Formatting marks go, and each line ends as a sentence, so a list is
 * read item by item rather than as one run-on line.
 */
export function parlumeSpokenPostText(text: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	return lines
		.filter(
			(line, index) =>
				!SPOKEN_ADDRESS_LINE.test(line) ||
				!lines.slice(0, index).some(Boolean),
		)
		.map((line) =>
			line
				.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/gi, "$1")
				.replace(/^(.*\S)\s*(?:[—–-]|:)\s+https?:\/\/\S+$/i, "$1")
				.replace(/https?:\/\/\S+/gi, "the link")
				.replace(/^#{1,6}\s+/, "")
				.replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, "")
				.replace(/\*\*|__|`/g, ""),
		)
		.filter((line) => line && !/^([-*_])\1{2,}$/.test(line))
		.map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`))
		.join(" ")
		.slice(0, MAX_SPOKEN_CHARS);
}

/**
 * A post read aloud by the classic voice, cut into sentences the bridge's
 * synthesizer accepts.
 */
export async function* parlumeChatSpeech(text: string): AsyncGenerator<string> {
	const spoken = parlumeSpokenPostText(text);
	for (const match of spoken.matchAll(SPOKEN_SENTENCE)) {
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

/** A sentence too long for one chapter, cut between words. */
function chapterParts(sentence: string): string[] {
	const parts: string[] = [];
	let rest = sentence;
	while (rest.length > CHAPTER_CHARS) {
		const space = rest.lastIndexOf(" ", CHAPTER_CHARS);
		const cut = space > 0 ? space : CHAPTER_CHARS;
		parts.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	return rest ? [...parts, rest] : parts;
}

/** A post as it is read aloud, in chapters that end where sentences end. */
function readAloudChapters(text: string): string[] {
	const chapters: string[] = [];
	let chapter = "";
	for (const match of parlumeSpokenPostText(text).matchAll(SPOKEN_SENTENCE)) {
		for (const part of chapterParts(match[0].trim())) {
			const joined = chapter ? `${chapter} ${part}` : part;
			if (joined.length <= CHAPTER_CHARS) {
				chapter = joined;
			} else {
				chapters.push(chapter);
				chapter = part;
			}
		}
	}
	return chapter ? [...chapters, chapter] : chapters;
}

/**
 * A post read aloud a chapter at a time, so that no chapter runs past the
 * spoken budget. Each chapter with another after it ends by saying how to
 * hear the next, which waits five minutes to be asked for.
 */
export class ParlumeReadChapters {
	private rest: string[] = [];
	private until = 0;

	constructor(private readonly now: () => number) {}

	/** The first chapter of `text`, to read now; the rest wait. */
	begin(text: string): string {
		const [first = "", ...rest] = readAloudChapters(text);
		return this.hold(first, rest);
	}

	/** Whether a chapter waits to be asked for. */
	get waiting(): boolean {
		return this.rest.length > 0 && this.now() <= this.until;
	}

	/** The next chapter, or null when none waits any more. */
	next(): string | null {
		const [chapter, ...rest] = this.waiting ? this.rest : [];
		if (chapter === undefined) {
			this.rest = [];
			return null;
		}
		return this.hold(chapter, rest);
	}

	private hold(chapter: string, rest: string[]): string {
		this.rest = rest;
		this.until = this.now() + CHAPTER_HOLD_MS;
		return rest.length > 0 ? `${chapter} ${CONTINUE_HINT}` : chapter;
	}
}

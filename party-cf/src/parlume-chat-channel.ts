import type { ParlumeJoinNotice } from "./parlume-bridge-state";
import {
	composeParlumeChatMessage,
	emptyParlumeChatState,
	expireParlumeChatPosts,
	findParlumeChatPost,
	forgetParlumeChatPost,
	isEarlierParlumeSessionTag,
	nextParlumeChatDeadline,
	noteParlumeChatOffer,
	observeParlumeChatMessage,
	PARLUME_CHAT_CONFIRM_MS,
	PARLUME_CHAT_UNAVAILABLE_GRACE_MS,
	PARLUME_CHAT_UNAVAILABLE_LINE,
	type ParlumeChatMessage,
	type ParlumeChatPost,
	type ParlumeChatPostKind,
	type ParlumeChatProposal,
	type ParlumeChatState,
	parlumeChatEndedText,
	parlumeChatPostKey,
	parlumeChatPostRest,
	parlumeGoOnProposalText,
	parlumeMissingPostLine,
	parlumeUnseenPostsLine,
	parseParlumeChatMessage,
	recordParlumeChatPost,
	startParlumeChatTagsAt,
} from "./parlume-chat";
import {
	type ParlumeConfirmLink,
	type ParlumePostAction,
	type ParlumeReplyChannel,
	type ParlumeTaggedCommand,
	parlumePostReply,
	parseParlumeChatCommand,
} from "./parlume-chat-commands";
import { parseParlumeChatSendBody } from "./parlume-chat-send";
import { PARLUME_GUESTS_NOTICE, type ParlumeGuests } from "./parlume-guests";
import {
	PARLUME_HELP_TEXT,
	parlumeRestPostHeader,
	parlumeTurnPostHeader,
} from "./parlume-post-templates";
import type { ParlumeStopActor } from "./parlume-stop";
import { isRecord } from "./parlume-stream-auth";
import {
	acceptParlumeSuggestion,
	emptyParlumeSuggestionState,
	formatParlumeSuggestion,
	hasParlumeSuggestionMaterial,
	isNearDuplicateParlumeSuggestion,
	isParlumeSuggestionPassDue,
	nextParlumeSuggestionPassAt,
	type ParlumeSuggestion,
	type ParlumeSuggestionAudience,
	type ParlumeSuggestionState,
	parseParlumeSuggestion,
	parseParlumeSuggestionAudience,
	spokenParlumeSuggestion,
} from "./parlume-suggestions";

const CHAT_STATE_KEY = "chat";
const SUGGESTION_STATE_KEY = "chatSuggestions";
/** A chat request still counts as being answered for at most this long. */
const CHAT_TURN_MAX_MS = 2 * 60 * 1000;
const PRIVATE_REQUEST_LINE =
	"I can only answer in the meeting chat, where everyone reads it. Ask me there.";
/** The soonest a suggestion pass runs, and how long it waits while Parlume is busy. */
const SUGGESTION_RETRY_MS = 5_000;
const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_CHARS = 1_000;
const MAX_GRAPH_MESSAGES = 10_000;
const MAX_DEPARTURE_NOTICE_CHARS = 500;
const GRAPH_MESSAGE_COUNT_KEY = "graphChatMessageCount";
/** The longest one of Parlume's own posts waits for the speech before it. */
const POST_HOLD_MS = 30_000;

/** Whether the leaving line, and the notice saying why, reached the chat. */
interface LeavingResult {
	posted: boolean;
	noticed: boolean;
}

export interface ParlumeChatBot {
	sessionId: string;
	botId: string;
}

export interface ParlumeChatTurn {
	text: string;
	replyChannel: ParlumeReplyChannel;
	speakerName: string | null;
	speakerId: string | null;
	chatMessageId: string;
}

/**
 * `queued`: Fabric took the post. `unknown`: Fabric could not confirm it
 * after the chat may have got it, so it is kept as sent, not confirmed.
 */
type ParlumeChatSendDelivery = "queued" | "unknown";

export type ParlumeChatSendResult =
	| { sent: true; tag: string; delivery: ParlumeChatSendDelivery }
	| {
			sent: false;
			reason: "chat_unavailable" | "guests_present" | "failed" | "no_bot";
	  };

/** How far Fabric's answer to a chat post got it; null when it was not sent. */
async function chatPostDelivery(
	response: Response | null,
): Promise<ParlumeChatSendDelivery | null> {
	if (!response) {
		return null;
	}
	if (response.ok) {
		return "queued";
	}
	const body: unknown = await response.json().catch(() => null);
	return isRecord(body) && body.outcome === "unknown" ? "unknown" : null;
}

/** A held post Fabric could not take, or sent to a chat out of reach. */
function isRetryable(result: ParlumeChatSendResult): boolean {
	return (
		!result.sent &&
		(result.reason === "failed" || result.reason === "chat_unavailable")
	);
}

/** What the chat channel needs from the Durable Object it lives in. */
export interface ParlumeChatHost {
	storage: {
		get<T>(key: string): Promise<T | undefined>;
		put<T>(key: string, value: T): Promise<void>;
		put(entries: Record<string, unknown>): Promise<void>;
		delete(key: string): Promise<boolean>;
	};
	postToFabric(path: string, body: object): Promise<Response | null>;
	/** Fabric's answer whatever its status, or null when it gave none. */
	requestFabric(path: string, body: object): Promise<Response | null>;
	/** The session's verified provider bot, or null before one has connected. */
	bot(): Promise<ParlumeChatBot | null>;
	isParlumeSender(name: string | null): boolean;
	/** Whether Parlume may answer in the meeting now, and who is a guest. */
	guests: Pick<ParlumeGuests, "open" | "isGuest">;
	/** Parlume is speaking, about to speak, or answering any request. */
	isBusy(): boolean;
	/**
	 * Resolves once Parlume's voice has sent the speech it holds; null when
	 * it holds none.
	 */
	whenSpeechSent(): Promise<void> | null;
	/**
	 * Speaks text into the meeting once what Parlume is saying ends. `asker`
	 * is who asked for it, named if someone stops it.
	 */
	speak(text: string, asker: ParlumeStopActor | null): Promise<boolean>;
	/** "continue": the next chapter of a post being read aloud. */
	continueReading(actor: ParlumeStopActor): Promise<boolean>;
	/** Says the join notice: heard even while a guest is in. */
	speakJoinNotice(text: string): Promise<boolean>;
	/** A stop typed in the chat ends the answer Parlume is giving. */
	stop(actor: ParlumeStopActor): Promise<void>;
	pause(actor: ParlumeStopActor): Promise<void>;
	/** The answer on this voice generation was stopped: none of its posts go out. */
	isStopped(generation: number): boolean;
	dispatchTurn(turn: ParlumeChatTurn): Promise<void>;
	persistSegment(bot: ParlumeChatBot, message: ParlumeChatMessage): void;
	/** A participant wrote in the chat, so the meeting is not idle. */
	noteActivity(): Promise<void>;
	/** Calls `checkDeliveries` at about this time. */
	wakeAt(at: number): void;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}

/**
 * The meeting chat as Parlume sees it: what it posts and whether each post
 * arrived, what participants type to it, and its passive suggestions. State
 * that must survive a restart lives in Durable Object storage; the rest is
 * per-instance.
 */
export class ParlumeChatChannel {
	private state: ParlumeChatState | null = null;
	private graphMessages: Promise<void> = Promise.resolve();
	private suggestions: ParlumeSuggestionState | null = null;
	private newSegments = 0;
	private chatTurn: { generation: number; startedAt: number } | null = null;
	private recent: Array<{ from: string | null; text: string }> = [];
	private joinNoticeSettling: Promise<void> = Promise.resolve();
	private lookups: Promise<void> = Promise.resolve();
	// The leaving line being posted; calls at the same time share it.
	private ending: Promise<LeavingResult> | null = null;
	// Why Parlume is leaving, until the chat has it.
	private departureNotice: string | null = null;

	constructor(private readonly host: ParlumeChatHost) {}

	/** True when this segment is the one that makes a suggestion pass worth running. */
	noteSpeechSegment(): boolean {
		this.newSegments++;
		return (
			hasParlumeSuggestionMaterial(this.newSegments) &&
			!hasParlumeSuggestionMaterial(this.newSegments - 1)
		);
	}

	beginChatTurn(generation: number): void {
		this.chatTurn = { generation, startedAt: this.host.now() };
	}

	/** A chat request is being answered on this voice generation. */
	isChatTurnCurrent(generation: number): boolean {
		return (
			this.chatTurn?.generation === generation &&
			this.host.now() - this.chatTurn.startedAt < CHAT_TURN_MAX_MS
		);
	}

	/** The worker's `?action=chat`: a post for the current answer. */
	async send(body: unknown): Promise<Response> {
		const input = parseParlumeChatSendBody(body);
		if (!input) {
			return Response.json({ error: "Invalid message" }, { status: 400 });
		}
		if (
			input.voiceGeneration !== null &&
			this.host.isStopped(input.voiceGeneration)
		) {
			return Response.json({ sent: false, reason: "stopped" });
		}
		if (
			input.final &&
			input.voiceGeneration !== null &&
			this.chatTurn?.generation === input.voiceGeneration
		) {
			this.chatTurn = null;
		}
		if (input.close) {
			return Response.json({ closed: true });
		}
		const bot = await this.host.bot();
		if (!bot) {
			return Response.json({ sent: false, reason: "no_bot" });
		}
		// Fabric makes the recap once, as Parlume is admitted, often before
		// it has confirmed anyone or posted the join notice: the recap waits
		// for both.
		if (input.plain) {
			const state = await this.chatState();
			if (!state.unavailable && !this.recapMayPost(state)) {
				state.heldRecap = input.message;
				await this.saveChatState();
				this.host.log("info", "chat.recap_held", {
					...bot,
					chars: input.message.length,
				});
				return Response.json({ sent: false, reason: "guests_present" });
			}
		}
		const proposal = input.proposal;
		const forTurn = input.turnId
			? { id: input.turnId, failed: input.header?.kind === "error" }
			: undefined;
		return Response.json(
			await this.post(
				bot,
				proposal
					? {
							text: proposal.spoken,
							turnId: input.turnId,
							forTurn,
							kind: "proposal",
							proposal: {
								actionId: proposal.actionId,
								confirmUrl: proposal.confirmUrl,
								dismissUrl: proposal.dismissUrl,
							},
							compose: () => input.message,
						}
					: {
							text: input.message,
							...(input.header
								? {
										header: parlumeTurnPostHeader(
											input.header,
										),
									}
								: {}),
							turnId: input.turnId,
							forTurn,
							kind: "reply",
							plain: input.plain,
							recap: input.plain,
							requested: input.turnId !== null,
						},
			),
		);
	}

	/**
	 * Posts the recap that waited for the chat to open, once. As with the
	 * guests notice, a post Fabric could not take, or one for a chat out of
	 * reach, waits again.
	 */
	async postHeldRecap(): Promise<void> {
		const state = await this.chatState();
		const text = state.heldRecap;
		if (
			!text ||
			(await this.dropHeldAfterLeaving(state)) ||
			!this.recapMayPost(state)
		) {
			return;
		}
		delete state.heldRecap;
		await this.saveChatState();
		const bot = await this.host.bot();
		if (!bot) {
			return;
		}
		const posted = await this.post(bot, {
			text,
			turnId: null,
			kind: "reply",
			plain: true,
			recap: true,
		});
		if (isRetryable(posted)) {
			state.heldRecap ??= text;
			await this.saveChatState();
		}
	}

	/** Fabric's verified stream carries a join notice: the recap follows it. */
	async expectJoinNotice(): Promise<void> {
		const state = await this.chatState();
		if (!state.joinNoticeDue) {
			state.joinNoticeDue = true;
			await this.saveChatState();
		}
	}

	// Posts sent at the same time can reach the chat in either order, and
	// one sent a moment after the join notice never showed in a live
	// meeting: the recap waits until the meeting has the join notice.
	private recapMayPost(state: ParlumeChatState): boolean {
		return (
			this.host.guests.open &&
			(!state.joinNoticeDue || this.hasJoinNotice(state))
		);
	}

	// The meeting showed the join notice or heard it, or its post went
	// unconfirmed and holds nothing back any longer.
	private hasJoinNotice(state: ParlumeChatState): boolean {
		const notice = state.joinNotice;
		return (
			notice !== undefined &&
			(notice.deliveredVia !== null ||
				(notice.tag !== null &&
					findParlumeChatPost(state, notice.tag)?.delivery ===
						"unconfirmed"))
		);
	}

	// What waited for the join notice goes out after it: the notes-only
	// notice, then the recap.
	private async releaseHeld(state: ParlumeChatState): Promise<void> {
		await this.releaseGuestsNotice(state);
		await this.postHeldRecap();
	}

	// Nothing held is posted after Parlume's leaving line: it is dropped.
	private async dropHeldAfterLeaving(
		state: ParlumeChatState,
	): Promise<boolean> {
		if (!state.departed && !state.ended) {
			return false;
		}
		const guestsNotice = state.guestsNoticeHeld === true;
		const recap = state.heldRecap !== undefined;
		if (guestsNotice || recap) {
			delete state.guestsNoticeHeld;
			delete state.heldRecap;
			await this.saveChatState();
			const bot = await this.host.bot();
			if (bot) {
				this.host.log("info", "chat.held_dropped", {
					...bot,
					guestsNotice,
					recap,
				});
			}
		}
		return true;
	}

	/** A post Parlume's realtime voice decided to make, tagged like any other. */
	async postFromVoice(text: string): Promise<ParlumeChatSendResult> {
		const bot = await this.host.bot();
		return bot
			? this.post(bot, {
					text,
					turnId: null,
					kind: "reply",
					requested: true,
				})
			: { sent: false, reason: "no_bot" };
	}

	/** Whether the meeting chat has shown the post tagged `tag`. */
	async shown(tag: string): Promise<boolean> {
		const state = await this.chatState();
		return state.posts.some(
			(post) => post.tag === tag && post.delivery === "confirmed",
		);
	}

	/**
	 * Starts this session's tags where earlier sessions in the same meeting
	 * left off, as Fabric counted them when Parlume was invited.
	 */
	async startTagsAt(first: number): Promise<void> {
		startParlumeChatTagsAt(await this.chatState(), first);
		await this.saveChatState();
	}

	/** The latest messages the meeting chat showed, oldest first. */
	recentMessages(): Array<{ from: string | null; text: string }> {
		return [...this.recent];
	}

	/** Whether Parlume can still expect its posts to reach the meeting chat. */
	async isAvailable(): Promise<boolean> {
		return !(await this.chatState()).unavailable;
	}

	/** Fabric's `?action=chat-message`: one message from the meeting chat. */
	async receive(body: unknown): Promise<Response> {
		const message = parseParlumeChatMessage(body);
		if (!message) {
			return Response.json(
				{ error: "Invalid chat message" },
				{ status: 400 },
			);
		}
		if (message.id.startsWith("graph:")) {
			const received = this.graphMessages.then(() =>
				this.receiveGraphMessage(message),
			);
			this.graphMessages = received.then(
				() => undefined,
				() => undefined,
			);
			return received;
		}
		return this.receiveMessage(message);
	}

	private async receiveGraphMessage(
		message: ParlumeChatMessage,
	): Promise<Response> {
		if (!(await this.host.bot())) {
			return Response.json(
				{ error: "Meeting stream unavailable" },
				{ status: 409 },
			);
		}
		const key = `graphChatMessage:${message.id}`;
		if (await this.host.storage.get<boolean>(key)) {
			return Response.json({ accepted: true, duplicate: true });
		}
		const count =
			(await this.host.storage.get<number>(GRAPH_MESSAGE_COUNT_KEY)) ?? 0;
		if (count >= MAX_GRAPH_MESSAGES) {
			return Response.json(
				{ error: "Channel message limit reached" },
				{ status: 429 },
			);
		}
		return this.receiveMessage(message, { key, count: count + 1 });
	}

	private async receiveMessage(
		message: ParlumeChatMessage,
		graphReceipt?: { key: string; count: number },
	): Promise<Response> {
		const bot = await this.host.bot();
		if (!bot) {
			return Response.json(
				{ error: "Meeting stream unavailable" },
				{ status: 409 },
			);
		}
		const state = await this.chatState();
		const observation = observeParlumeChatMessage(
			state,
			message,
			graphReceipt
				? false
				: this.host.isParlumeSender(message.senderName),
			this.host.now(),
		);
		if (observation.kind === "duplicate") {
			return Response.json({ accepted: true, duplicate: true });
		}
		if (graphReceipt) {
			try {
				if (observation.kind === "participant") {
					await this.host.noteActivity();
				}
				// Receipt, capacity and observed state commit together after
				// preparation, before any external command effect may begin.
				await this.host.storage.put({
					[graphReceipt.key]: true,
					[GRAPH_MESSAGE_COUNT_KEY]: graphReceipt.count,
					[CHAT_STATE_KEY]: state,
				});
			} catch (error) {
				this.state = null;
				throw error;
			}
		} else {
			await this.saveChatState();
		}
		// A private message to the bot is not part of the meeting's chat: it
		// stays out of the shared transcript and the chat context, and is kept
		// only on the request it makes.
		if (message.text && !message.toBot) {
			// The first echo of a post this session sent, under Parlume's name,
			// is Parlume's own line. Attendee gives its bot an anonymous guest's
			// Teams id, which would mark Parlume in the saved transcript as an
			// unverified speaker, so the line is saved without a speaker id.
			const ownPost =
				observation.kind === "parlume" &&
				observation.confirmed !== null &&
				this.host.isParlumeSender(message.senderName);
			this.host.persistSegment(
				bot,
				ownPost ? { ...message, senderId: null } : message,
			);
			this.recent.push({
				from: message.senderName,
				text: message.text.slice(0, MAX_RECENT_CHARS),
			});
			this.recent.splice(0, this.recent.length - MAX_RECENT_MESSAGES);
		}
		if (observation.becameAvailable) {
			this.host.log("info", "chat.available", { ...bot });
			// The join notice was said aloud while the chat was out of reach.
			await this.releaseHeld(state);
		}
		switch (observation.kind) {
			case "parlume": {
				const post = observation.confirmed;
				if (post) {
					const latencyMs = this.host.now() - post.sentAt;
					this.host.log("info", "chat.confirmed", {
						...bot,
						tag: post.tag,
						kind: post.kind,
						latencyMs,
						late: observation.late,
					});
					await this.report(bot, post, "confirmed", latencyMs);
					await this.noteJoinNoticeShown(state, post);
				}
				return Response.json({ accepted: true });
			}
			case "participant":
				if (!graphReceipt) {
					await this.host.noteActivity();
				}
				this.handleCommand(bot, message);
				return Response.json({ accepted: true });
			default: {
				const unreachable: never = observation;
				return unreachable;
			}
		}
	}

	/** Settles every post whose confirmation window has passed. */
	async checkDeliveries(): Promise<void> {
		const state = await this.chatState();
		const now = this.host.now();
		const { expired, becameUnavailable } = expireParlumeChatPosts(
			state,
			now,
		);
		if (expired.length > 0) {
			await this.saveChatState();
			const bot = await this.host.bot();
			for (const post of expired) {
				const latencyMs = now - post.sentAt;
				if (bot) {
					this.host.log("warn", "chat.unconfirmed", {
						...bot,
						tag: post.tag,
						kind: post.kind,
						latencyMs,
					});
					await this.report(
						bot,
						post,
						state.unavailable ? "unavailable" : "unconfirmed",
						latencyMs,
					);
				}
			}
			if (becameUnavailable && state.unavailable && bot) {
				this.host.log("warn", "chat.unavailable", { ...bot });
			}
		}
		await this.announceUnavailable(state);
		await this.announceUnseen(state);
		await this.settleJoinNotice(state);
	}

	// Taken off before it is said, so two checks at once say it once. While
	// Parlume speaks, or when it could not be said, it waits for the next
	// check.
	private async announceUnseen(state: ParlumeChatState): Promise<void> {
		const unseen = state.unseen;
		if (!unseen?.length || this.host.isBusy()) {
			return;
		}
		delete state.unseen;
		await this.saveChatState();
		const spoken = await this.host.speak(
			parlumeUnseenPostsLine(unseen),
			null,
		);
		const bot = await this.host.bot();
		if (bot) {
			this.host.log(spoken ? "info" : "warn", "chat.unseen_announced", {
				...bot,
				tags: unseen.map((number) => `P${number}`),
				spoken,
			});
		}
		if (!spoken) {
			state.unseen = [...unseen, ...(state.unseen ?? [])];
			await this.saveChatState();
		}
	}

	/**
	 * The notice Parlume gives once per session, when it is admitted. It is
	 * posted, or said aloud instead when the chat turns out to be out of
	 * reach (see `announceUnavailable`), and Fabric records when the meeting
	 * got it. A post Fabric could not take, and a record it missed, are
	 * retried by `checkDeliveries`.
	 */
	async giveJoinNotice(notice: ParlumeJoinNotice): Promise<void> {
		const state = await this.chatState();
		if (!state.joinNotice) {
			state.joinNotice = {
				...notice,
				tag: null,
				deliveredVia: null,
				reported: false,
			};
			await this.saveChatState();
		}
		await this.settleJoinNotice(state);
	}

	/**
	 * Says in the chat that a guest is in, so Parlume keeps notes only. It
	 * waits until the meeting has the join notice: posted a moment after the
	 * join notice, it never showed in a live meeting.
	 */
	async noteGuestArrived(): Promise<void> {
		const state = await this.chatState();
		if (state.joinNotice && !this.hasJoinNotice(state)) {
			state.guestsNoticeHeld = true;
			await this.saveChatState();
			return;
		}
		await this.postNotice(PARLUME_GUESTS_NOTICE, true);
	}

	// Cleared before the post, so two releases at once post it once. A post
	// Fabric could not take is tried again at the next settle, and one for a
	// chat out of reach once the chat shows a message again.
	private async releaseGuestsNotice(state: ParlumeChatState): Promise<void> {
		if (
			!state.guestsNoticeHeld ||
			(await this.dropHeldAfterLeaving(state)) ||
			!this.hasJoinNotice(state)
		) {
			return;
		}
		delete state.guestsNoticeHeld;
		const posted = await this.postNotice(PARLUME_GUESTS_NOTICE, true);
		if (isRetryable(posted)) {
			state.guestsNoticeHeld = true;
		}
		await this.saveChatState();
	}

	// One at a time, each after the one before: a stream verified twice in
	// quick succession must not post the notice twice, and a settle that
	// began before the notice was recorded (the alarm's delivery check) must
	// not stand in for the one that gives it.
	private settleJoinNotice(state: ParlumeChatState): Promise<void> {
		const settled = this.joinNoticeSettling.then(() =>
			this.postOrReportJoinNotice(state),
		);
		this.joinNoticeSettling = settled.catch(() => {});
		return settled;
	}

	private async postOrReportJoinNotice(
		state: ParlumeChatState,
	): Promise<void> {
		const notice = state.joinNotice;
		const bot = await this.host.bot();
		if (!notice || !bot) {
			return;
		}
		if (notice.deliveredVia === null) {
			if (notice.tag !== null || state.unavailable) {
				// Once its post went unconfirmed, a join notice the chat
				// never showed holds nothing back any longer.
				await this.releaseHeld(state);
				return;
			}
			const posted = await this.post(bot, {
				text: notice.text,
				turnId: null,
				kind: "notice",
				essential: true,
			});
			if (posted.sent) {
				notice.tag = posted.tag;
				await this.saveChatState();
			}
			return;
		}
		if (!notice.reported) {
			const reported = await this.host.postToFabric(
				"/api/internal/parlume/join-notice",
				notice.deliveredVia === "chat" && notice.tag !== null
					? { ...bot, via: "chat", tag: notice.tag }
					: { ...bot, via: "voice" },
			);
			this.host.log(reported ? "info" : "warn", "join_notice.delivered", {
				...bot,
				via: notice.deliveredVia,
				tag: notice.tag,
				recorded: reported !== null,
			});
			if (reported) {
				notice.reported = true;
				await this.saveChatState();
			}
		}
		// After the record: Fabric records when the meeting got the notice.
		await this.releaseHeld(state);
	}

	// The post can show up before Fabric's answer to it names its tag.
	private async noteJoinNoticeShown(
		state: ParlumeChatState,
		post: ParlumeChatPost,
	): Promise<void> {
		const notice = state.joinNotice;
		if (
			notice?.deliveredVia === null &&
			(notice.tag === post.tag ||
				(notice.tag === null && post.text === notice.text.trim()))
		) {
			notice.tag = post.tag;
			notice.deliveredVia = "chat";
			await this.saveChatState();
			await this.settleJoinNotice(state);
		}
	}

	/**
	 * One suggestion pass, when it is due and nothing else is going on. Fabric
	 * decides whether there is anything worth offering and who it is for; the
	 * bridge limits how often, and drops one too close to a recent suggestion.
	 * A suggestion is posted in the chat only when both the verified session
	 * and the pass's answer say it is for the meeting; otherwise it is for the
	 * team and is not. Either is recorded for the Parlume page and counts
	 * toward the limits. `audience` is the one Fabric gave when it verified the
	 * stream.
	 */
	async runSuggestionPass(input: {
		enabled: boolean;
		audience: ParlumeSuggestionAudience;
		/** The session's Parlume page, which a posted suggestion links to. */
		pageUrl?: string | null;
	}): Promise<void> {
		if (!input.enabled || this.host.isBusy()) {
			return;
		}
		const chat = await this.chatState();
		// A team-only session needs no chat.
		if (chat.unavailable && input.audience !== "TEAM") {
			return;
		}
		const suggestions = await this.suggestionState();
		const now = this.host.now();
		if (
			!isParlumeSuggestionPassDue(suggestions, {
				now,
				newSegments: this.newSegments,
			})
		) {
			return;
		}
		const bot = await this.host.bot();
		if (!bot) {
			return;
		}
		suggestions.lastPassAt = now;
		this.newSegments = 0;
		await this.saveSuggestionState();
		const response = await this.host.postToFabric(
			"/api/internal/parlume/suggest",
			{
				...bot,
				previous: suggestions.recent.map((entry) => entry.text),
				teamAudience: true,
			},
		);
		const body = response ? await response.json().catch(() => null) : null;
		const answered = parseParlumeSuggestionAudience(body);
		// TEAM wins on any disagreement; an audience nobody knows is dropped.
		const audience: ParlumeSuggestionAudience | null =
			answered === null
				? null
				: answered === "MEETING" && input.audience === "MEETING"
					? "MEETING"
					: "TEAM";
		const suggestion = audience ? parseParlumeSuggestion(body) : null;
		const duplicate =
			suggestion !== null &&
			isNearDuplicateParlumeSuggestion(suggestions, suggestion, now);
		this.host.log("info", "suggestion.pass", {
			...bot,
			answered: response !== null,
			suggested: suggestion !== null,
			kind: suggestion?.kind ?? null,
			audience,
			duplicate,
		});
		if (!suggestion || !audience || duplicate || this.host.isBusy()) {
			return;
		}
		acceptParlumeSuggestion(suggestions, suggestion, now);
		await this.saveSuggestionState();
		const posted =
			audience === "MEETING"
				? await this.post(bot, {
						text: spokenParlumeSuggestion(suggestion),
						turnId: null,
						kind: "suggestion",
						plain: true,
						compose: (tag) =>
							formatParlumeSuggestion(
								tag,
								suggestion,
								input.pageUrl ?? null,
							),
					})
				: null;
		await this.recordSuggestion(bot, suggestion, {
			chatTag: posted?.sent ? posted.tag : null,
		});
	}

	// The record is the Parlume page's copy; a failed one leaves the meeting
	// as it was and the pass goes on. Fabric takes the audience from the
	// session, so only where it went is sent.
	private async recordSuggestion(
		bot: ParlumeChatBot,
		suggestion: ParlumeSuggestion,
		delivery: { chatTag: string | null },
	): Promise<void> {
		const recorded = await this.host.postToFabric(
			"/api/internal/parlume/suggestions",
			{ ...bot, ...suggestion, ...delivery },
		);
		if (!recorded) {
			this.host.log("warn", "suggestion.record_failed", {
				...bot,
				kind: suggestion.kind,
				posted: delivery.chatTag !== null,
			});
		}
	}

	/** The next time the Durable Object's alarm should fire for the chat. */
	async nextWakeAt(input: {
		suggestions: boolean;
		audience: ParlumeSuggestionAudience;
	}): Promise<number | null> {
		const now = this.host.now();
		const chat = await this.chatState();
		const deadline = nextParlumeChatDeadline(chat);
		// A pass waits for speech, not for a timer: with too little said since
		// the last one there is nothing to wake for, and the segment that
		// changes that schedules the wake. Once due, a pass Parlume could not
		// run (it was busy) is tried again shortly.
		const nextPass =
			input.suggestions &&
			(!chat.unavailable || input.audience === "TEAM") &&
			hasParlumeSuggestionMaterial(this.newSegments)
				? Math.max(
						nextParlumeSuggestionPassAt(
							await this.suggestionState(),
							now,
						),
						now + SUGGESTION_RETRY_MS,
					)
				: null;
		const future = [deadline, nextPass].filter(
			(at): at is number => at !== null && at > now,
		);
		return future.length ? Math.min(...future) : null;
	}

	private async post(
		bot: ParlumeChatBot,
		input: {
			text: string;
			/** The lines under the tag; never shortened, never read aloud. */
			header?: string;
			turnId: string | null;
			/**
			 * The worker's post for a turn, which Fabric drops when the turn
			 * no longer runs; an error post is for a turn that just failed.
			 */
			forTurn?: { id: string; failed: boolean };
			kind: ParlumeChatPostKind;
			proposal?: ParlumeChatProposal;
			compose?: (tag: string) => string;
			/** Posted even while a guest is in: the join and guest notices. */
			essential?: boolean;
			/**
			 * Sent as one paragraph, without the formatting of answers and
			 * results: suggestions and the recap.
			 */
			plain?: boolean;
			/**
			 * The recap: Fabric records its tag for the Parlume page, also
			 * when it waited here and Fabric's own request got no tag.
			 */
			recap?: boolean;
			/** It answers a request: the meeting hears if it does not show up. */
			requested?: boolean;
		},
	): Promise<ParlumeChatSendResult> {
		if (!input.essential) {
			await this.afterSpeech(bot, input.kind);
		}
		const state = await this.chatState();
		// While a guest is in, or someone Fabric has not confirmed, Parlume
		// answers nothing in the chat (D2).
		const skipped = state.unavailable
			? "chat_unavailable"
			: !this.host.guests.open && !input.essential
				? "guests_present"
				: null;
		if (skipped) {
			this.host.log("info", "chat.skipped", {
				...bot,
				kind: input.kind,
				reason: skipped,
			});
			return { sent: false, reason: skipped };
		}
		const post = recordParlumeChatPost(state, input, this.host.now());
		await this.host.storage.put({
			[CHAT_STATE_KEY]: state,
			[parlumeChatPostKey(post.tag)]: post,
		});
		const message = composeParlumeChatMessage(
			post.tag,
			input.compose ? input.compose(post.tag) : input.text,
			input.header,
			input.kind,
		);
		const delivery = await chatPostDelivery(
			await this.host.requestFabric("/api/internal/parlume/chat", {
				...bot,
				message,
				...(input.plain ? { plain: true } : {}),
				...(input.recap ? { recap: true } : {}),
				...(input.forTurn
					? {
							turnId: input.forTurn.id,
							...(input.forTurn.failed
								? { turnFailed: true }
								: {}),
						}
					: {}),
			}),
		);
		this.host.log(
			delivery === "queued" ? "info" : "warn",
			"chat.forwarded",
			{
				...bot,
				tag: post.tag,
				kind: post.kind,
				chars: message.length,
				sent: delivery !== null,
				delivery,
			},
		);
		if (!delivery) {
			forgetParlumeChatPost(state, post.tag);
			await this.saveChatState();
			await this.host.storage.delete(parlumeChatPostKey(post.tag));
			return { sent: false, reason: "failed" };
		}
		// A post whose outcome is unknown may be in the chat: it stays
		// playable, the leaving line names it, and it is confirmed or found
		// unconfirmed like one Fabric took.
		if (post.kind !== "notice") {
			noteParlumeChatOffer(state, post);
			await this.saveChatState();
		}
		this.host.wakeAt(post.sentAt + PARLUME_CHAT_CONFIRM_MS);
		return { sent: true, tag: post.tag, delivery };
	}

	/**
	 * Parlume's own posts wait, for at most `POST_HOLD_MS`, for the speech it
	 * is playing: one that showed up mid-sentence drew the meeting away from
	 * the answer, and so did a realtime post made as soon as its response
	 * was written, seconds before it was heard. An essential notice, about who
	 * is in or about Parlume leaving, does not wait.
	 */
	private async afterSpeech(
		bot: ParlumeChatBot,
		kind: ParlumeChatPostKind,
	): Promise<void> {
		const speech = this.host.whenSpeechSent();
		if (!speech) {
			return;
		}
		const heldAt = this.host.now();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const capped = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), POST_HOLD_MS);
		});
		try {
			const timedOut = await Promise.race([
				speech.then(() => false),
				capped,
			]);
			this.host.log("info", "chat.held_for_speech", {
				...bot,
				kind,
				heldMs: this.host.now() - heldAt,
				timedOut,
			});
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * A notice is tagged and confirmed like any other post: a message without
	 * a tag is lost in a channel meeting and leaves no delivery record. An
	 * `essential` one is posted even while a guest is in.
	 */
	async postNotice(
		text: string,
		essential = false,
	): Promise<ParlumeChatSendResult> {
		const bot = await this.host.bot();
		return bot
			? this.post(bot, { text, turnId: null, kind: "notice", essential })
			: { sent: false, reason: "no_bot" };
	}

	/**
	 * Fabric's `?action=leaving`: it is about to have the bot leave (a stop,
	 * the idle rule, the meeting's cap, a guest policy, lost access, a failed
	 * stream). Once the bot is gone nothing can answer a `go`, so while it
	 * can still post, the meeting is told once that the posts this session
	 * offered can no longer be played. A `notice` in the body, which says why
	 * Parlume is leaving, is posted first, once. A meeting that ended on its
	 * own took the bot with it, and gets no such line. Only a line Fabric
	 * took counts: a later call tries again after one that failed, and calls
	 * at the same time share one post. A notice that arrives while a call is
	 * under way is posted by that call, before its line, when it has not yet
	 * got that far; otherwise by a call that runs after it. Either way, the
	 * call with the notice is told whether the meeting got it, so Fabric can
	 * record one that it did not.
	 */
	async leaving(body: unknown): Promise<Response> {
		const notice =
			isRecord(body) && typeof body.notice === "string"
				? body.notice.trim().slice(0, MAX_DEPARTURE_NOTICE_CHARS)
				: "";
		if (notice) {
			this.departureNotice = notice;
		}
		const ending =
			this.ending && !notice ? this.ending : this.endAfterEarlier();
		const { posted, noticed } = await ending;
		return Response.json(notice ? { posted, noticed } : { posted });
	}

	/** Runs once the leaving call under way, if any, has finished. */
	private endAfterEarlier(): Promise<LeavingResult> {
		const earlier = (this.ending ?? Promise.resolve()).then(
			() => undefined,
			() => undefined,
		);
		const ending: Promise<LeavingResult> = earlier
			.then(() => this.postEnded())
			.finally(() => {
				if (this.ending === ending) {
					this.ending = null;
				}
			});
		this.ending = ending;
		return ending;
	}

	private async postEnded(): Promise<LeavingResult> {
		const bot = await this.host.bot();
		if (!bot) {
			return { posted: false, noticed: false };
		}
		const state = await this.chatState();
		// Read only now: a notice that came in meanwhile goes first.
		const notice = this.departureNotice;
		if (notice && !state.departed) {
			const said = await this.post(bot, {
				text: notice,
				turnId: null,
				kind: "notice",
				essential: true,
				plain: true,
			});
			if (said.sent) {
				state.departed = true;
				this.departureNotice = null;
				await this.saveChatState();
			}
		}
		const noticed = state.departed === true;
		if (state.ended || !(state.offered?.length || state.proposed?.length)) {
			return { posted: false, noticed };
		}
		const sent = await this.post(bot, {
			text: parlumeChatEndedText(
				state.offered ?? [],
				state.proposed ?? [],
			),
			turnId: null,
			kind: "notice",
			essential: true,
		});
		if (sent.sent) {
			state.ended = true;
			await this.saveChatState();
		}
		return { posted: sent.sent, noticed };
	}

	// Speech and turns run on after the webhook is answered: Attendee waits on
	// the callback, and a reply read aloud takes seconds.
	private handleCommand(bot: ParlumeChatBot, message: ParlumeChatMessage) {
		const command = parseParlumeChatCommand(message.text, message.toBot);
		if (!command) {
			return;
		}
		const fromGuest =
			message.senderExternal === true ||
			this.host.guests.isGuest(message.senderId);
		this.host.log("info", "chat.command", {
			...bot,
			command: command.kind,
			fromGuest,
		});
		// Parlume takes no command from an external guest (D2), except a pause,
		// which only lets it take in less.
		if (fromGuest && command.kind !== "pause") {
			return;
		}
		const turn = {
			speakerName: message.senderName,
			speakerId: message.senderId,
			chatMessageId: message.id,
		};
		const actor = { name: message.senderName, id: message.senderId };
		switch (command.kind) {
			case "stop":
				void this.host.stop(actor);
				return;
			case "pause":
				void this.host.pause(actor);
				return;
			case "continue":
				void this.host.continueReading(actor);
				return;
			case "help":
				void this.postNotice(PARLUME_HELP_TEXT);
				return;
			case "say":
			case "go":
			case "more":
				void this.selectPost(bot, command, turn);
				return;
			case "ask":
				// Parlume posts only to the whole meeting chat, so an answer
				// to a private message would show everyone what was asked.
				if (message.toBot) {
					void this.postNotice(PRIVATE_REQUEST_LINE);
					return;
				}
				void this.host.dispatchTurn({
					...turn,
					text: command.text,
					replyChannel: command.replyChannel,
				});
				return;
			default: {
				const unreachable: never = command;
				return unreachable;
			}
		}
	}

	/**
	 * A typed `say`, `go` or `more`. Looked up one after another, so reads
	 * are queued in the order they were typed, even when an older post has
	 * to be read from storage. A tag this session never posted, or an earlier
	 * session's, gets a notice rather than leave the selection unanswered.
	 */
	private selectPost(
		bot: ParlumeChatBot,
		command: ParlumeTaggedCommand,
		turn: Pick<
			ParlumeChatTurn,
			"speakerName" | "speakerId" | "chatMessageId"
		>,
	): void {
		const found = this.lookups.then(() => this.findPost(command.tag));
		this.lookups = found.then(
			() => undefined,
			() => undefined,
		);
		void found
			.then(async (post) => {
				if (post) {
					await this.actOnPost(bot, command.kind, post, turn);
					return;
				}
				const state = await this.chatState();
				this.host.log("info", "chat.command_unknown_post", {
					...bot,
					command: command.kind,
					tag: command.tag,
					earlierSession: isEarlierParlumeSessionTag(
						state,
						command.tag,
					),
				});
				await this.postNotice(
					parlumeMissingPostLine(state, command.tag),
				);
			})
			.catch((error: unknown) => {
				this.host.log("warn", "chat.command_failed", {
					...bot,
					command: command.kind,
					tag: command.tag,
					error:
						error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** Any post this session made, however long ago. */
	private async findPost(tag: string): Promise<ParlumeChatPost | undefined> {
		return (
			findParlumeChatPost(await this.chatState(), tag) ??
			(await this.host.storage.get<ParlumeChatPost>(
				parlumeChatPostKey(tag),
			))
		);
	}

	/** A typed command's request is answered in the chat. */
	private async actOnPost(
		bot: ParlumeChatBot,
		command: ParlumeTaggedCommand["kind"],
		post: ParlumeChatPost,
		turn: Pick<
			ParlumeChatTurn,
			"speakerName" | "speakerId" | "chatMessageId"
		>,
	): Promise<void> {
		// A shortened post's rest is posted from the stored text, not asked of
		// the agent again; a longer rest is itself shortened with its own tag.
		const rest = command === "more" ? parlumeChatPostRest(post) : "";
		if (rest) {
			this.host.log("info", "chat.more_rest", { ...bot, tag: post.tag });
			await this.post(bot, {
				text: rest,
				header: parlumeRestPostHeader(post.tag),
				turnId: post.turnId,
				kind: "reply",
				requested: true,
			});
			return;
		}
		const reply = parlumePostReply(command, post);
		switch (reply.kind) {
			case "speak":
				await this.host.speak(reply.text, {
					name: turn.speakerName,
					id: turn.speakerId,
				});
				return;
			case "ask":
				await this.host.dispatchTurn({
					...turn,
					text: reply.text,
					replyChannel: "CHAT",
				});
				return;
			case "confirm-link":
				await this.postConfirmLink(bot, reply);
				return;
			default: {
				const unreachable: never = reply;
				return unreachable;
			}
		}
	}

	/**
	 * What a spoken "go P3", "read P3" or "more on P3" asks for. The caller
	 * answers it by voice. A tag this session has no post for is answered as
	 * the typed command is: an earlier session's post, a tag no post carried,
	 * or a post no longer available. `go` or `more` on a proposal posts its
	 * Confirm link and says one sentence pointing to it: it never makes the
	 * change. Null when Parlume has no bot to post with.
	 */
	async spokenReference(
		command: ParlumeTaggedCommand,
	): Promise<ParlumePostAction | null> {
		const state = await this.chatState();
		const post = await this.findPost(command.tag);
		if (!post) {
			return {
				kind: "speak",
				text: parlumeMissingPostLine(state, command.tag),
			};
		}
		const bot = await this.host.bot();
		if (!bot) {
			return null;
		}
		const reply = parlumePostReply(command.kind, post);
		if (reply.kind !== "confirm-link") {
			return reply;
		}
		const posted = await this.postConfirmLink(bot, reply);
		return {
			kind: "speak",
			text: posted.sent
				? `I posted the link to confirm ${reply.tag} in the chat; a signed-in project member confirms it in Fabric.`
				: `${reply.tag} waits on the Parlume page in Fabric, where a signed-in project member can confirm it.`,
		};
	}

	private postConfirmLink(
		bot: ParlumeChatBot,
		reply: ParlumeConfirmLink,
	): Promise<ParlumeChatSendResult> {
		this.host.log("info", "chat.proposal_link", { ...bot, tag: reply.tag });
		return this.postNotice(
			parlumeGoOnProposalText(reply.tag, reply.confirmUrl),
		);
	}

	// A late echo inside the grace clears the mark, and nothing is said.
	private async announceUnavailable(state: ParlumeChatState): Promise<void> {
		if (!state.unavailable || state.announced) {
			return;
		}
		const dueAt =
			(state.unavailableAt ?? 0) + PARLUME_CHAT_UNAVAILABLE_GRACE_MS;
		if (this.host.now() < dueAt) {
			this.host.wakeAt(dueAt);
			return;
		}
		if (this.host.isBusy()) {
			return;
		}
		state.announced = true;
		await this.saveChatState();
		// A join notice the chat never showed is said in place of the line.
		const notice =
			state.joinNotice?.deliveredVia === null ? state.joinNotice : null;
		const spoken = notice
			? await this.host.speakJoinNotice(notice.spoken)
			: await this.host.speak(PARLUME_CHAT_UNAVAILABLE_LINE, null);
		if (spoken && notice) {
			notice.deliveredVia = "voice";
			await this.saveChatState();
		}
		const bot = await this.host.bot();
		if (bot) {
			this.host.log(
				spoken ? "info" : "warn",
				"chat.unavailable_announced",
				{
					...bot,
					spoken,
					joinNotice: notice !== null,
				},
			);
		}
		if (!spoken) {
			state.announced = false;
			await this.saveChatState();
		}
	}

	private async report(
		bot: ParlumeChatBot,
		post: ParlumeChatPost,
		outcome: "confirmed" | "unconfirmed" | "unavailable",
		latencyMs: number,
	): Promise<void> {
		const reported = await this.host.postToFabric(
			"/api/internal/parlume/chat-delivery",
			{
				...bot,
				turnId: post.turnId,
				tag: post.tag,
				kind: post.kind,
				outcome,
				latencyMs,
			},
		);
		if (!reported) {
			this.host.log("warn", "chat.delivery_report_failed", {
				...bot,
				tag: post.tag,
				outcome,
			});
		}
	}

	private async chatState(): Promise<ParlumeChatState> {
		if (!this.state) {
			const stored =
				await this.host.storage.get<ParlumeChatState>(CHAT_STATE_KEY);
			// Two first reads at once share the one that landed first: a
			// later one replaced it, and the join notice recorded on it was
			// lost.
			this.state ??= stored ?? emptyParlumeChatState();
		}
		return this.state;
	}

	private async saveChatState(): Promise<void> {
		if (this.state) {
			await this.host.storage.put(CHAT_STATE_KEY, this.state);
		}
	}

	private async suggestionState(): Promise<ParlumeSuggestionState> {
		if (!this.suggestions) {
			const stored =
				await this.host.storage.get<ParlumeSuggestionState>(
					SUGGESTION_STATE_KEY,
				);
			// As with the chat state: a later first read replaced the state a
			// pass had just recorded itself on.
			this.suggestions ??=
				stored ?? emptyParlumeSuggestionState(this.host.now());
		}
		return this.suggestions;
	}

	private async saveSuggestionState(): Promise<void> {
		if (this.suggestions) {
			await this.host.storage.put(SUGGESTION_STATE_KEY, this.suggestions);
		}
	}
}

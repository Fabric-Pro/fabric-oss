import {
	composeParlumeChatMessage,
	emptyParlumeChatState,
	expireParlumeChatPosts,
	findParlumeChatPost,
	forgetParlumeChatPost,
	nextParlumeChatDeadline,
	observeParlumeChatMessage,
	PARLUME_CHAT_CONFIRM_MS,
	PARLUME_CHAT_UNAVAILABLE_LINE,
	type ParlumeChatMessage,
	type ParlumeChatPost,
	type ParlumeChatPostKind,
	type ParlumeChatState,
	parseParlumeChatMessage,
	recordParlumeChatPost,
} from "./parlume-chat";
import {
	type ParlumeReplyChannel,
	type ParlumeTaggedCommand,
	parseParlumeChatCommand,
} from "./parlume-chat-commands";
import { isRecord } from "./parlume-stream-auth";
import {
	acceptParlumeSuggestion,
	emptyParlumeSuggestionState,
	formatParlumeSuggestion,
	hasParlumeSuggestionMaterial,
	isNearDuplicateParlumeSuggestion,
	isParlumeSuggestionPassDue,
	nextParlumeSuggestionPassAt,
	type ParlumeSuggestionState,
	parseParlumeSuggestion,
	spokenParlumeSuggestion,
} from "./parlume-suggestions";

const CHAT_STATE_KEY = "chat";
const SUGGESTION_STATE_KEY = "chatSuggestions";
/** A chat request still counts as being answered for at most this long. */
const CHAT_TURN_MAX_MS = 2 * 60 * 1000;
/** The soonest a suggestion pass runs, and how long it waits while Parlume is busy. */
const SUGGESTION_RETRY_MS = 5_000;
const MAX_OUTBOUND_CHARS = 8_000;
const MAX_TURN_ID_CHARS = 128;
const MAX_HELD_ACTION_CHARS = 200;
const MAX_HELD_REQUEST_CHARS = 2_000;
const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_CHARS = 1_000;

export interface ParlumeChatBot {
	sessionId: string;
	botId: string;
}

/** What a tagged command asks for: a post read aloud, or a request to run. */
export type ParlumePostAction =
	| { kind: "speak"; text: string }
	| { kind: "ask"; text: string };

export interface ParlumeChatTurn {
	text: string;
	replyChannel: ParlumeReplyChannel;
	speakerName: string | null;
	speakerId: string | null;
	chatMessageId: string;
}

export type ParlumeChatSendResult =
	| { sent: true; tag: string; delivery: "queued" }
	| { sent: false; reason: "chat_unavailable" | "failed" | "no_bot" };

/** What the chat channel needs from the Durable Object it lives in. */
export interface ParlumeChatHost {
	storage: {
		get<T>(key: string): Promise<T | undefined>;
		put<T>(key: string, value: T): Promise<void>;
	};
	postToFabric(path: string, body: object): Promise<Response | null>;
	/** The session's verified provider bot, or null before one has connected. */
	bot(): Promise<ParlumeChatBot | null>;
	isParlumeSender(name: string | null): boolean;
	/** Parlume is speaking, about to speak, or answering any request. */
	isBusy(): boolean;
	/** Speaks text into the meeting, interrupting whatever Parlume was saying. */
	speak(text: string): Promise<boolean>;
	interrupt(): Promise<void>;
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

/** A change Parlume did not make because it was interrupted first. */
interface HeldChange {
	/** What it would have done, as a verb phrase: "create the work item “Export”". */
	action: string;
	/** The request that asked for it, run again by `go`. */
	request: string;
}

function parseHeldChange(value: unknown): HeldChange | null {
	if (
		!isRecord(value) ||
		typeof value.action !== "string" ||
		typeof value.request !== "string"
	) {
		return null;
	}
	const action = value.action.trim();
	const request = value.request.trim();
	return action &&
		request &&
		action.length <= MAX_HELD_ACTION_CHARS &&
		request.length <= MAX_HELD_REQUEST_CHARS
		? { action, request }
		: null;
}

function heldChangeText(held: HeldChange): string {
	return `I did not ${held.action} because I was interrupted.`;
}

function parseSendBody(body: unknown): {
	message: string;
	held: HeldChange | null;
	turnId: string | null;
	voiceGeneration: number | null;
	final: boolean;
} | null {
	if (!isRecord(body)) {
		return null;
	}
	const held = body.held === undefined ? null : parseHeldChange(body.held);
	const message = held ? heldChangeText(held) : body.message;
	if (
		(body.held !== undefined && !held) ||
		typeof message !== "string" ||
		message.trim() === "" ||
		message.length > MAX_OUTBOUND_CHARS
	) {
		return null;
	}
	return {
		message,
		held,
		turnId:
			typeof body.turnId === "string" &&
			body.turnId.length > 0 &&
			body.turnId.length <= MAX_TURN_ID_CHARS
				? body.turnId
				: null,
		voiceGeneration:
			typeof body.voiceGeneration === "number" &&
			Number.isSafeInteger(body.voiceGeneration)
				? body.voiceGeneration
				: null,
		final: body.final === true,
	};
}

/**
 * The meeting chat as Parlume sees it: what it posts and whether each post
 * arrived, what participants type to it, and its passive suggestions. State
 * that must survive a restart lives in Durable Object storage; the rest is
 * per-instance.
 */
export class ParlumeChatChannel {
	private state: ParlumeChatState | null = null;
	private suggestions: ParlumeSuggestionState | null = null;
	private newSegments = 0;
	private chatTurn: { generation: number; startedAt: number } | null = null;
	private recent: Array<{ from: string | null; text: string }> = [];

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
		const input = parseSendBody(body);
		if (!input) {
			return Response.json({ error: "Invalid message" }, { status: 400 });
		}
		if (
			input.final &&
			input.voiceGeneration !== null &&
			this.chatTurn?.generation === input.voiceGeneration
		) {
			this.chatTurn = null;
		}
		const bot = await this.host.bot();
		if (!bot) {
			return Response.json({ sent: false, reason: "no_bot" });
		}
		const held = input.held;
		return Response.json(
			await this.post(
				bot,
				held
					? {
							text: input.message,
							turnId: input.turnId,
							kind: "held",
							request: held.request,
							compose: (tag) =>
								`${input.message} Reply "go ${tag}" to do it.`,
						}
					: {
							text: input.message,
							turnId: input.turnId,
							kind: "reply",
						},
			),
		);
	}

	/** A post Parlume's realtime voice decided to make, tagged like any other. */
	async postFromVoice(text: string): Promise<ParlumeChatSendResult> {
		const bot = await this.host.bot();
		return bot
			? this.post(bot, { text, turnId: null, kind: "reply" })
			: { sent: false, reason: "no_bot" };
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
			this.host.isParlumeSender(message.senderName),
			this.host.now(),
		);
		if (observation.kind === "duplicate") {
			return Response.json({ accepted: true, duplicate: true });
		}
		await this.saveChatState();
		if (message.text) {
			this.host.persistSegment(bot, message);
			this.recent.push({
				from: message.senderName,
				text: message.text.slice(0, MAX_RECENT_CHARS),
			});
			this.recent.splice(0, this.recent.length - MAX_RECENT_MESSAGES);
		}
		if (observation.becameAvailable) {
			this.host.log("info", "chat.available", { ...bot });
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
				}
				return Response.json({ accepted: true });
			}
			case "participant":
				await this.host.noteActivity();
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
			if (becameUnavailable && bot) {
				this.host.log("warn", "chat.unavailable", { ...bot });
			}
		}
		await this.announceUnavailable(state);
	}

	/**
	 * One suggestion pass, when it is due and nothing else is going on. Fabric
	 * decides whether there is anything worth offering; the bridge limits how
	 * often, and drops one too close to a recent suggestion.
	 */
	async runSuggestionPass(input: { enabled: boolean }): Promise<void> {
		if (!input.enabled || this.host.isBusy()) {
			return;
		}
		const chat = await this.chatState();
		if (chat.unavailable) {
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
			},
		);
		const suggestion = response
			? parseParlumeSuggestion(await response.json().catch(() => null))
			: null;
		const duplicate =
			suggestion !== null &&
			isNearDuplicateParlumeSuggestion(suggestions, suggestion, now);
		this.host.log("info", "suggestion.pass", {
			...bot,
			answered: response !== null,
			suggested: suggestion !== null,
			duplicate,
		});
		if (!suggestion || duplicate || this.host.isBusy()) {
			return;
		}
		acceptParlumeSuggestion(suggestions, suggestion, now);
		await this.saveSuggestionState();
		await this.post(bot, {
			text: spokenParlumeSuggestion(suggestion),
			turnId: null,
			kind: "suggestion",
			compose: (tag) => formatParlumeSuggestion(tag, suggestion),
		});
	}

	/** The next time the Durable Object's alarm should fire for the chat. */
	async nextWakeAt(input: { suggestions: boolean }): Promise<number | null> {
		const now = this.host.now();
		const chat = await this.chatState();
		const deadline = nextParlumeChatDeadline(chat);
		// A pass waits for speech, not for a timer: with too little said since
		// the last one there is nothing to wake for, and the segment that
		// changes that schedules the wake. Once due, a pass Parlume could not
		// run (it was busy) is tried again shortly.
		const nextPass =
			input.suggestions &&
			!chat.unavailable &&
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
			turnId: string | null;
			kind: ParlumeChatPostKind;
			request?: string;
			compose?: (tag: string) => string;
		},
	): Promise<ParlumeChatSendResult> {
		const state = await this.chatState();
		if (state.unavailable) {
			this.host.log("info", "chat.skipped", {
				...bot,
				kind: input.kind,
				reason: "chat_unavailable",
			});
			return { sent: false, reason: "chat_unavailable" };
		}
		const post = recordParlumeChatPost(state, input, this.host.now());
		await this.saveChatState();
		const message = composeParlumeChatMessage(
			post.tag,
			input.compose ? input.compose(post.tag) : input.text,
		);
		const sent = await this.host.postToFabric(
			"/api/internal/parlume/chat",
			{
				...bot,
				message,
			},
		);
		this.host.log(sent ? "info" : "warn", "chat.forwarded", {
			...bot,
			tag: post.tag,
			kind: post.kind,
			chars: message.length,
			sent: Boolean(sent),
			delivery: sent ? "queued" : null,
		});
		if (!sent) {
			forgetParlumeChatPost(state, post.tag);
			await this.saveChatState();
			return { sent: false, reason: "failed" };
		}
		this.host.wakeAt(post.sentAt + PARLUME_CHAT_CONFIRM_MS);
		return { sent: true, tag: post.tag, delivery: "queued" };
	}

	// Speech and turns run on after the webhook is answered: Attendee waits on
	// the callback, and a reply read aloud takes seconds.
	private handleCommand(bot: ParlumeChatBot, message: ParlumeChatMessage) {
		const command = parseParlumeChatCommand(message.text, message.toBot);
		if (!command) {
			return;
		}
		this.host.log("info", "chat.command", {
			...bot,
			command: command.kind,
		});
		const turn = {
			speakerName: message.senderName,
			speakerId: message.senderId,
			chatMessageId: message.id,
		};
		switch (command.kind) {
			case "stop":
				void this.host.interrupt();
				return;
			case "say":
			case "go":
			case "more": {
				const post = this.state
					? findParlumeChatPost(this.state, command.tag)
					: undefined;
				if (!post) {
					this.host.log("info", "chat.command_unknown_post", {
						...bot,
						command: command.kind,
						tag: command.tag,
					});
					return;
				}
				void this.actOnPost(bot, command.kind, post, turn);
				return;
			}
			case "ask":
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
		const action = await this.postAction(bot, command, post);
		if (action?.kind === "speak") {
			await this.host.speak(action.text);
		} else if (action?.kind === "ask") {
			await this.host.dispatchTurn({
				...turn,
				text: action.text,
				replyChannel: "CHAT",
			});
		}
	}

	/**
	 * What a spoken "go P3", "read P3" or "more on P3" asks for. The caller
	 * answers it by voice. Null when this meeting has no such post, or the
	 * change it held back was already asked for again.
	 */
	async spokenReference(
		command: ParlumeTaggedCommand,
	): Promise<ParlumePostAction | null> {
		const post = findParlumeChatPost(await this.chatState(), command.tag);
		const bot = await this.host.bot();
		if (!post || !bot) {
			return null;
		}
		return this.postAction(bot, command.kind, post);
	}

	/**
	 * `go` on a change Parlume held back asks for it again, once; on any other
	 * post it reads the post aloud as `say` does. `more` asks about the post.
	 */
	private async postAction(
		bot: ParlumeChatBot,
		command: ParlumeTaggedCommand["kind"],
		post: ParlumeChatPost,
	): Promise<ParlumePostAction | null> {
		switch (command) {
			case "say":
				return { kind: "speak", text: post.text };
			case "go": {
				if (post.kind !== "held") {
					return { kind: "speak", text: post.text };
				}
				const request = post.request;
				if (!request) {
					this.host.log("info", "chat.held_already_run", {
						...bot,
						tag: post.tag,
					});
					return null;
				}
				post.request = undefined;
				await this.saveChatState();
				return { kind: "ask", text: request };
			}
			// The agent took "P1" for a work item it could not find ("There is
			// no P1 identifier"): the tag is only the post's label in the chat.
			case "more":
				return {
					kind: "ask",
					text: `More detail on what Parlume posted in the meeting chat as ${post.tag} (the label of that chat message, not a work item ID): ${post.text}`,
				};
			default: {
				const unreachable: never = command;
				return unreachable;
			}
		}
	}

	private async announceUnavailable(state: ParlumeChatState): Promise<void> {
		if (!state.unavailable || state.announced || this.host.isBusy()) {
			return;
		}
		state.announced = true;
		await this.saveChatState();
		const spoken = await this.host.speak(PARLUME_CHAT_UNAVAILABLE_LINE);
		const bot = await this.host.bot();
		if (bot) {
			this.host.log(
				spoken ? "info" : "warn",
				"chat.unavailable_announced",
				{
					...bot,
					spoken,
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
		this.state ??=
			(await this.host.storage.get<ParlumeChatState>(CHAT_STATE_KEY)) ??
			emptyParlumeChatState();
		return this.state;
	}

	private async saveChatState(): Promise<void> {
		if (this.state) {
			await this.host.storage.put(CHAT_STATE_KEY, this.state);
		}
	}

	private async suggestionState(): Promise<ParlumeSuggestionState> {
		this.suggestions ??=
			(await this.host.storage.get<ParlumeSuggestionState>(
				SUGGESTION_STATE_KEY,
			)) ?? emptyParlumeSuggestionState(this.host.now());
		return this.suggestions;
	}

	private async saveSuggestionState(): Promise<void> {
		if (this.suggestions) {
			await this.host.storage.put(SUGGESTION_STATE_KEY, this.suggestions);
		}
	}
}

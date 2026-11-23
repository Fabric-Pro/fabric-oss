import type { ParlumeChatSendResult } from "./parlume-chat-channel";
import { isParlumePauseRequest } from "./parlume-chat-commands";
import {
	type ParlumeAskedStopCause,
	type ParlumeStopActor,
	type ParlumeStopDetection,
	type ParlumeStopResult,
	parlumePausedNotice,
	parlumeResumedNotice,
	parlumeStoppedNotice,
} from "./parlume-stop";
import { isRecord } from "./parlume-stream-auth";
import { parseParlumeWake } from "./parlume-wake";

const LISTENING_KEY = "listening";
const MAX_PENDING_REPORTS = 20;
const MAX_ACTOR_CHARS = 256;
/** The most text Say in meeting reads: a suggestion or a missed question. */
const MAX_READ_ALOUD_CHARS = 2_000;
// Fabric keeps segment times within the meeting's four hours.
const MAX_OFFSET_MS = 14_400_000;

/** What the Parlume page asks the bridge for, as `?action=`. */
export type ParlumeLiveControl =
	| "stop-speech"
	| "pause"
	| "resume"
	| "continue-reading"
	| "read-aloud";

/** A pause or resume Fabric has not recorded yet. */
interface ListeningReport {
	paused: boolean;
	by: string | null;
	/** When it happened, epoch milliseconds. */
	at: number;
	/** Where it falls in the transcript, from the start of capture. */
	offsetMs: number | null;
}

interface ListeningState {
	paused: boolean;
	reports: ListeningReport[];
}

export interface ParlumeLiveControlsHost {
	storage: {
		get<T>(key: string): Promise<T | undefined>;
		put<T>(key: string, value: T): Promise<void>;
	};
	floor: {
		stop(
			cause: ParlumeAskedStopCause | "pause",
			actor: ParlumeStopActor | null,
			detection?: ParlumeStopDetection | null,
		): Promise<ParlumeStopResult>;
		/** The next chapter of a post read aloud; false when none waits. */
		continueReading(actor: ParlumeStopActor): Promise<boolean>;
		/** Reads `text` in its turn; false when Parlume may not speak. */
		readAloud(text: string, actor: ParlumeStopActor): Promise<boolean>;
	};
	postNotice(
		text: string,
		essential: boolean,
	): Promise<ParlumeChatSendResult>;
	/** Forgets a request still waiting to be answered: a bare wake phrase, a realtime arm. */
	dropQueued(): Promise<void>;
	bot(): Promise<{ sessionId: string; botId: string } | null>;
	/** When the meeting audio this session transcribes started, or null before any. */
	audioStartedAt(): number | null;
	postToFabric(path: string, body: object): Promise<Response | null>;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}

/** "Parlume, pause" or "Parlume, stop listening", said as the whole request. */
export function isSpokenParlumePause(text: string): boolean {
	const request = parseParlumeWake(text);
	return request !== null && isParlumePauseRequest(request);
}

function boundedText(value: unknown): string | null {
	return typeof value === "string" && value.trim()
		? value.trim().slice(0, MAX_ACTOR_CHARS)
		: null;
}

/** The member a Parlume page control is for, as Fabric sends it. */
function parseActor(body: unknown): ParlumeStopActor | null {
	if (!isRecord(body) || !isRecord(body.actor)) {
		return null;
	}
	const id = boundedText(body.actor.id);
	return id ? { id, name: boundedText(body.actor.name) } : null;
}

/**
 * The controls anyone in the meeting has over Parlume (F2, V4): a stop that
 * ends the answer it is giving, and a pause that stops it listening until a
 * member resumes it on the Parlume page. The paused state lives in Durable
 * Object storage, so it survives a restart; Fabric records each pause and
 * resume on the session and as a transcript marker.
 */
export class ParlumeLiveControls {
	private state: ListeningState = { paused: false, reports: [] };

	constructor(private readonly host: ParlumeLiveControlsHost) {}

	async load(): Promise<void> {
		this.state =
			(await this.host.storage.get<ListeningState>(LISTENING_KEY)) ??
			this.state;
	}

	/** Listening is paused: no meeting audio reaches speech-to-text. */
	get paused(): boolean {
		return this.state.paused;
	}

	/**
	 * A stop said aloud, typed in the chat, or the page's Stop speaking
	 * button. The answer ends, and the chat gets one line naming who stopped
	 * it. `detection` says how a stop said aloud was heard.
	 */
	async stop(
		cause: ParlumeAskedStopCause,
		actor: ParlumeStopActor | null,
		detection: ParlumeStopDetection | null = null,
	): Promise<ParlumeStopResult> {
		const result = await this.host.floor.stop(cause, actor, detection);
		if (result.stopped) {
			await this.host.postNotice(
				parlumeStoppedNotice(actor, result.asker),
				false,
			);
		}
		return result;
	}

	/**
	 * Parlume stops listening, by voice, in the chat or from the page. The
	 * gate closes before the first await, so the next audio chunk is already
	 * dropped; the answer in progress stops and nothing queued is answered.
	 */
	async pause(actor: ParlumeStopActor): Promise<boolean> {
		if (this.state.paused) {
			return false;
		}
		this.state.paused = true;
		const stopping = this.host.floor.stop("pause", actor);
		await this.record(true, actor);
		await stopping;
		await this.host.dropQueued();
		await this.host.postNotice(parlumePausedNotice(actor), true);
		await this.flushReports();
		return true;
	}

	/** Only a member resumes, from the page: a paused Parlume hears nothing. */
	async resume(actor: ParlumeStopActor): Promise<boolean> {
		if (!this.state.paused) {
			return false;
		}
		this.state.paused = false;
		await this.record(false, actor);
		await this.host.postNotice(parlumeResumedNotice(actor), true);
		await this.flushReports();
		return true;
	}

	/**
	 * Say in meeting on the Parlume page: Parlume reads the suggestion in its
	 * turn. Refused while it is paused, a guest is in, or past the cap.
	 */
	async readAloud(body: unknown, actor: ParlumeStopActor): Promise<Response> {
		if (
			!isRecord(body) ||
			typeof body.text !== "string" ||
			body.text.length > MAX_READ_ALOUD_CHARS ||
			!body.text.trim()
		) {
			return Response.json({ error: "Invalid text" }, { status: 400 });
		}
		const text = body.text.trim();
		const spoken = await this.host.floor.readAloud(text, actor);
		this.host.log("info", "page.read_aloud", {
			sessionId: (await this.host.bot())?.sessionId ?? null,
			actorId: actor.id,
			suggestionId:
				typeof body.suggestionId === "string"
					? body.suggestionId.slice(0, MAX_ACTOR_CHARS)
					: null,
			spoken,
		});
		return Response.json({ spoken });
	}

	/**
	 * Fabric's `?action=stop-speech|pause|resume|continue-reading|read-aloud`,
	 * for a member on the page.
	 */
	async control(
		action: ParlumeLiveControl,
		body: unknown,
	): Promise<Response> {
		const actor = parseActor(body);
		if (!actor) {
			return Response.json({ error: "Invalid control" }, { status: 400 });
		}
		switch (action) {
			case "stop-speech":
				return Response.json({
					changed: (await this.stop("page", actor)).stopped,
				});
			case "pause":
				return Response.json({ changed: await this.pause(actor) });
			case "resume":
				return Response.json({ changed: await this.resume(actor) });
			case "continue-reading":
				return Response.json({
					changed: await this.host.floor.continueReading(actor),
				});
			case "read-aloud":
				return this.readAloud(body, actor);
			default: {
				const unreachable: never = action;
				return unreachable;
			}
		}
	}

	/**
	 * Hands Fabric the pauses and resumes it has not recorded, in order. One
	 * it could not take is tried again on the next alarm.
	 */
	async flushReports(): Promise<boolean> {
		const bot = await this.host.bot();
		if (!bot) {
			return this.state.reports.length === 0;
		}
		while (this.state.reports.length > 0) {
			const [report] = this.state.reports;
			if (
				!report ||
				!(await this.host.postToFabric(
					"/api/internal/parlume/listening",
					{
						...bot,
						...report,
					},
				))
			) {
				this.host.log("warn", "listening.report_failed", {
					...bot,
					pending: this.state.reports.length,
				});
				return false;
			}
			this.state.reports.shift();
			await this.save();
		}
		return true;
	}

	/**
	 * Called once the meeting is over. Without a bot, Fabric has no meeting to
	 * record a pause or resume on, and the session will never get one now, so
	 * those reports are dropped rather than kept until the bridge is purged.
	 * Returns whether no report is left to send.
	 */
	async dropReportsWithoutBot(): Promise<boolean> {
		if (this.state.reports.length === 0) {
			return true;
		}
		if (await this.host.bot()) {
			return false;
		}
		this.host.log("warn", "listening.reports_dropped", {
			dropped: this.state.reports.length,
		});
		this.state.reports = [];
		await this.save();
		return true;
	}

	private async record(
		paused: boolean,
		actor: ParlumeStopActor,
	): Promise<void> {
		const at = this.host.now();
		const startedAt = this.host.audioStartedAt();
		this.state.reports = [
			...this.state.reports,
			{
				paused,
				by: actor.name,
				at,
				offsetMs:
					startedAt === null
						? null
						: Math.min(
								MAX_OFFSET_MS,
								Math.max(0, Math.round(at - startedAt)),
							),
			},
		].slice(-MAX_PENDING_REPORTS);
		await this.save();
		this.host.log(
			"info",
			paused ? "listening.paused" : "listening.resumed",
			{
				sessionId: (await this.host.bot())?.sessionId ?? null,
				actorId: actor.id,
			},
		);
	}

	private save(): Promise<void> {
		return this.host.storage.put(LISTENING_KEY, this.state);
	}
}

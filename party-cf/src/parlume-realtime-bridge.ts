import type { ParlumeAuraOutlet } from "./parlume-aura";
import type { ParlumeChatChannel } from "./parlume-chat-channel";
import {
	openParlumeRealtimeSocket,
	type ParlumeRealtimeCredentials,
	parseParlumeRealtimeCredentials,
} from "./parlume-realtime";
import { ParlumeRealtimeEngine } from "./parlume-realtime-engine";
import type { ParlumeRealtimeContext } from "./parlume-realtime-host";
import { isRecord } from "./parlume-stream-auth";

const VOICE_POST_SHOWN_WAIT_MS = 3_000;
const VOICE_POST_SHOWN_POLL_MS = 200;

/** What the realtime engine needs from the meeting's bridge. */
export interface ParlumeRealtimeBridge {
	sessionId: string;
	botId: string;
	postToFabric(path: string, body: object): Promise<Response | null>;
	/** Resolves once the meeting's final segments so far have reached Fabric. */
	segmentsSent(): Promise<void>;
	outlet(): ParlumeAuraOutlet | null;
	generation(): number;
	/** The voice floor's gate; see `ParlumeVoiceFloor.maySpeak`. */
	maySpeak(): boolean;
	/** The meeting's last two minutes before its cap; see `parlumeCapClosing`. */
	closing(): boolean;
	/** Who Fabric rechecks before a job's turn; see `ParlumeGuests`. */
	attendees(): string[];
	/** The Fabric account of a confirmed participant; see `ParlumeGuests.userFor`. */
	userFor(speakerKey: string | null): string | null;
	chat: Pick<
		ParlumeChatChannel,
		"postFromVoice" | "recentMessages" | "shown"
	>;
	saveContext(context: ParlumeRealtimeContext): void;
	/** The engine gave up; the meeting carries on with the classic engine. */
	fallBack(engine: ParlumeRealtimeEngine, reason: string): void;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
}

/**
 * The realtime engine for one meeting, wired to Fabric: client secrets come
 * from `realtime-session`, `ask_fabric` runs as an ordinary meeting turn
 * whose result the worker posts back as `fabric-result`, usage is reported
 * to `realtime-usage`, and when a job's answer was heard to `realtime-spoken`.
 */
export function createParlumeRealtimeEngine(
	bridge: ParlumeRealtimeBridge,
): ParlumeRealtimeEngine {
	const { sessionId, botId } = bridge;
	// Usage is recorded against whichever host the latest secret was minted on.
	let provider: ParlumeRealtimeCredentials["provider"] = "OPENAI_DIRECT";
	const engine: ParlumeRealtimeEngine = new ParlumeRealtimeEngine({
		credentials: async () => {
			const response = await bridge.postToFabric(
				"/api/internal/parlume/realtime-session",
				{ sessionId, botId },
			);
			const credentials = parseParlumeRealtimeCredentials(
				await response?.json().catch(() => null),
			);
			provider = credentials?.provider ?? provider;
			return credentials;
		},
		connect: openParlumeRealtimeSocket,
		outlet: () => bridge.outlet(),
		generation: () => bridge.generation(),
		maySpeak: () => bridge.maySpeak(),
		closing: () => bridge.closing(),
		dispatchJob: async (job) => {
			// The request's segments reach Fabric first, so the turn sees them.
			await bridge.segmentsSent();
			const response = await bridge.postToFabric(
				"/api/internal/parlume/turns",
				{
					sessionId,
					botId,
					voiceGeneration: job.generation,
					text: job.request,
					speakerName: job.requester,
					speakerId: null,
					utteranceStartMs: null,
					utteranceEndMs: null,
					replyChannel: "VOICE",
					delivery: "realtime",
					job: job.job,
					attendees: bridge.attendees(),
					// Fabric reads the job with this account's access, and
					// looks nothing up when nobody confirmed asked.
					requester: bridge.userFor(job.requesterKey),
				},
			);
			const body: unknown = await response?.json().catch(() => null);
			return isRecord(body) && body.accepted === true;
		},
		postChat: async (text) => {
			const sent = await bridge.chat.postFromVoice(text);
			if (!sent.sent) {
				return { posted: false, reason: sent.reason };
			}
			// The chat usually shows a post within a second; the voice waits
			// that long so what it says about the post is true.
			const until = Date.now() + VOICE_POST_SHOWN_WAIT_MS;
			let shown = await bridge.chat.shown(sent.tag);
			while (!shown && Date.now() < until) {
				await new Promise((resolve) =>
					setTimeout(resolve, VOICE_POST_SHOWN_POLL_MS),
				);
				shown = await bridge.chat.shown(sent.tag);
			}
			return { posted: true, tag: sent.tag, shown };
		},
		readChat: () => bridge.chat.recentMessages(),
		reportUsage: (usage) =>
			void bridge.postToFabric("/api/internal/parlume/realtime-usage", {
				sessionId,
				botId,
				provider,
				...usage,
			}),
		reportSpoken: (spoken) =>
			void bridge.postToFabric("/api/internal/parlume/realtime-spoken", {
				sessionId,
				botId,
				...spoken,
			}),
		saveContext: (context) => bridge.saveContext(context),
		fallBack: (reason) => bridge.fallBack(engine, reason),
		log: (level, event, meta) =>
			bridge.log(level, event, { sessionId, botId, ...meta }),
		now: () => Date.now(),
	});
	return engine;
}

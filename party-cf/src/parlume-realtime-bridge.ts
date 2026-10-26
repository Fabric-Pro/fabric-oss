import type { ParlumeAuraOutlet } from "./parlume-aura";
import type { ParlumeChatChannel } from "./parlume-chat-channel";
import {
	openParlumeRealtimeSocket,
	type ParlumeRealtimeCredentials,
	parseParlumeRealtimeCredentials,
} from "./parlume-realtime";
import {
	type ParlumeRealtimeContext,
	ParlumeRealtimeEngine,
} from "./parlume-realtime-engine";
import { isRecord } from "./parlume-stream-auth";

/** What the realtime engine needs from the meeting's bridge. */
export interface ParlumeRealtimeBridge {
	sessionId: string;
	botId: string;
	postToFabric(path: string, body: object): Promise<Response | null>;
	/** Resolves once the meeting's final segments so far have reached Fabric. */
	segmentsSent(): Promise<void>;
	outlet(): ParlumeAuraOutlet | null;
	generation(): number;
	chat: Pick<ParlumeChatChannel, "postFromVoice" | "recentMessages">;
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
 * whose result the worker posts back as `fabric-result`, and usage is
 * reported to `realtime-usage`.
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
				},
			);
			const body: unknown = await response?.json().catch(() => null);
			return isRecord(body) && body.accepted === true;
		},
		postChat: async (text) => {
			const sent = await bridge.chat.postFromVoice(text);
			return sent.sent
				? { posted: true, tag: sent.tag }
				: { posted: false, reason: sent.reason };
		},
		readChat: () => bridge.chat.recentMessages(),
		reportUsage: (usage) =>
			void bridge.postToFabric("/api/internal/parlume/realtime-usage", {
				sessionId,
				botId,
				provider,
				...usage,
			}),
		saveContext: (context) => bridge.saveContext(context),
		fallBack: (reason) => bridge.fallBack(engine, reason),
		log: (level, event, meta) =>
			bridge.log(level, event, { sessionId, botId, ...meta }),
		now: () => Date.now(),
	});
	return engine;
}

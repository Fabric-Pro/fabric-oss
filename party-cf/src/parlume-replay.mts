import { readFileSync } from "node:fs";
import {
	audio,
	control,
	flush,
	meeting,
	STREAM_URL,
	sleep,
} from "./parlume-meeting-harness.mts";

// Replays a recorded (or hand-written) meeting through the real bridge, with
// the fakes of `meeting()`, and scores what reached Fabric. Fixture times are
// seconds from the start of the meeting audio.

export interface ParlumeReplayFixture {
	/** Where the fixture came from: a recording, or written by hand. */
	source: string;
	/** Spans of meeting audio the bot sent; Flux's clock counts these. */
	audio: Array<{ at: number; seconds: number }>;
	/**
	 * Participant speech as the meeting reports it: `at` is when it changed,
	 * `deliveredAt` (default `at`) when the update reached the bridge.
	 */
	speech: Array<{
		at: number;
		deliveredAt?: number;
		name: string;
		id: string;
		speaking: boolean;
	}>;
	/** Flux events as they arrived, verbatim. */
	flux: Array<{ at: number; event: Record<string, unknown> }>;
	/** The requests to Parlume the meeting holds; anything else is a false wake. */
	questions: Array<{ speaker: string; contains: string }>;
}

interface ParlumeReplayQuestion {
	text: string;
	speaker: string | null;
	/** The speaker asks Parlume something in the fixture. */
	expected: boolean;
	/** The request contains what that speaker asked about. */
	heardRight: boolean;
	/** The latest Flux end-of-turn event before the request. */
	trigger: string | null;
	/** From that event reaching the bridge to the request leaving it. */
	delayMs: number | null;
}

export interface ParlumeReplayScorecard {
	/** Requests handed to Fabric (`/turns`). */
	wakes: number;
	questions: ParlumeReplayQuestion[];
	/** Requests from a speaker who asks Parlume nothing. */
	falseWakes: ParlumeReplayQuestion[];
	/** Questions whose speaker never woke Parlume. */
	missed: ParlumeReplayFixture["questions"];
	/** Requests stopped again, such as an early start Flux took back. */
	interrupts: number;
}

export function readReplayFixture(path: URL | string): ParlumeReplayFixture {
	return JSON.parse(readFileSync(path, "utf8"));
}

// Where second 0 of the fixture sits on the provider's audio clock.
const AUDIO_EPOCH_MS = 1_000_000;
const CHUNK_MS = 10;
const END_OF_TURN_EVENTS = new Set(["EagerEndOfTurn", "EndOfTurn"]);

interface Step {
	atMs: number;
	run: () => unknown;
	endOfTurn?: string;
}

/**
 * `speed` replays that many times faster than the meeting happened; the
 * bridge's own timers still run in real time. `settleMs` is how long the
 * bridge gets after the last step before the scorecard is read.
 */
export async function replayMeeting(
	fixture: ParlumeReplayFixture,
	options: { speed?: number; settleMs?: number } = {},
): Promise<ParlumeReplayScorecard> {
	const { speed = 10, settleMs = 400 } = options;
	const harness = meeting();
	const { bridge, bot, flux } = harness;
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });

	const steps: Step[] = [];
	for (const span of fixture.audio) {
		const startMs = Math.round(span.at * 1000);
		const chunks = Math.round((span.seconds * 1000) / CHUNK_MS);
		for (let index = 1; index <= chunks; index++) {
			// Attendee stamps a chunk when it ends.
			const endMs = startMs + index * CHUNK_MS;
			steps.push({
				atMs: endMs,
				run: () => bridge.onMessage(bot, audio(AUDIO_EPOCH_MS + endMs)),
			});
		}
	}
	const deliveries = new Map<number, ParlumeReplayFixture["speech"]>();
	for (const update of fixture.speech) {
		const deliveredMs = Math.round(
			(update.deliveredAt ?? update.at) * 1000,
		);
		deliveries.set(deliveredMs, [
			...(deliveries.get(deliveredMs) ?? []),
			update,
		]);
	}
	for (const [atMs, updates] of deliveries) {
		steps.push({
			atMs,
			run: () =>
				bridge.onRequest(
					control("speakers", {
						updates: updates.map((update) => ({
							name: update.name,
							id: update.id,
							timestamp:
								AUDIO_EPOCH_MS + Math.round(update.at * 1000),
							isSpeaking: update.speaking,
						})),
					}),
				),
		});
	}
	for (const { at, event } of fixture.flux) {
		const type = String(event.event);
		steps.push({
			atMs: Math.round(at * 1000),
			run: () => flux.turn(event),
			endOfTurn: END_OF_TURN_EVENTS.has(type) ? type : undefined,
		});
	}
	// Stable: at the same moment audio goes first, then speech, then Flux.
	steps.sort((a, b) => a.atMs - b.atMs);

	const endsOfTurn: Array<{ type: string; at: number }> = [];
	const startedAt = performance.now();
	for (const step of steps) {
		const wait = startedAt + step.atMs / speed - performance.now();
		if (wait >= 1) {
			await sleep(wait);
		}
		if (step.endOfTurn) {
			endsOfTurn.push({ type: step.endOfTurn, at: performance.now() });
		}
		await step.run();
		await flush();
	}
	await sleep(settleMs);
	// Closing the stream stops the answer it left pending; that is not scored.
	const closedAt = performance.now();
	await bridge.onClose(bot, 1000, "replay finished");

	const questions = harness.requests
		.filter((request) => request.path.endsWith("/turns"))
		.map((request): ParlumeReplayQuestion => {
			const text = String(request.body.text ?? "");
			const speaker =
				typeof request.body.speakerName === "string"
					? request.body.speakerName
					: null;
			const trigger = endsOfTurn
				.filter((end) => end.at <= request.at)
				.at(-1);
			const asked = fixture.questions.filter(
				(question) => question.speaker === speaker,
			);
			return {
				text,
				speaker,
				expected: asked.length > 0,
				heardRight: asked.some((question) =>
					text
						.toLowerCase()
						.includes(question.contains.toLowerCase()),
				),
				trigger: trigger?.type ?? null,
				delayMs: trigger ? Math.round(request.at - trigger.at) : null,
			};
		});
	return {
		wakes: questions.length,
		questions,
		falseWakes: questions.filter((question) => !question.expected),
		missed: fixture.questions.filter(
			(question) =>
				!questions.some((asked) => asked.speaker === question.speaker),
		),
		interrupts: harness.requests.filter(
			(request) =>
				request.path.endsWith("/interrupt") && request.at < closedAt,
		).length,
	};
}

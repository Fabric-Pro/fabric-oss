import type { ParlumeRealtimeCut } from "./parlume-realtime-host";

// How the realtime voice carries on across the end of a session: when a
// session is replaced before OpenAI ends it, and how much of an answer that a
// drop or a restart cut short the meeting heard.

/** A session OpenAI did not say the end of lasts this long. */
const PARLUME_REALTIME_SESSION_MS = 60 * 60 * 1000;

/**
 * Where a session is on its way to its end. From `quiet`, it is replaced at
 * the first moment Parlume is not answering; from `hold`, no new response
 * starts and it is replaced once the current one is done; at `force`, it is
 * replaced at once, the response in progress resumed on the next one.
 */
type ParlumeRotationPhase = "early" | "quiet" | "hold" | "force";

/** How long before the session ends a phase begins. */
function phaseLeadMs(phase: Exclude<ParlumeRotationPhase, "early">): number {
	switch (phase) {
		case "quiet":
			return 10 * 60 * 1000;
		case "hold":
			return 2 * 60 * 1000;
		case "force":
			return 30_000;
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
}

/** The phase after `phase`, and when it begins; null after the last one. */
function nextPhase(
	phase: ParlumeRotationPhase,
	expiresAt: number,
): { phase: ParlumeRotationPhase; at: number } | null {
	switch (phase) {
		case "early":
			return { phase: "quiet", at: expiresAt - phaseLeadMs("quiet") };
		case "quiet":
			return { phase: "hold", at: expiresAt - phaseLeadMs("hold") };
		case "hold":
			return { phase: "force", at: expiresAt - phaseLeadMs("force") };
		case "force":
			return null;
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
}

/**
 * One session's way to its end: the phase it is in, each begun on a timer
 * from when OpenAI ends the session. `onPhase` runs as each one begins, and
 * after `retryIn`.
 */
export class ParlumeRealtimeRotation {
	private phase: ParlumeRotationPhase = "early";
	private expiresAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private retry: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly now: () => number,
		private readonly onPhase: () => void,
	) {}

	get current(): ParlumeRotationPhase {
		return this.phase;
	}

	/** No new response starts: the session is about to be replaced. */
	get holding(): boolean {
		return this.phase === "hold" || this.phase === "force";
	}

	/** A new session, which ends in an hour until it says otherwise. */
	start(): void {
		this.clear();
		this.phase = "early";
		this.expiresAt = this.now() + PARLUME_REALTIME_SESSION_MS;
		this.schedule();
	}

	/** The session said when it ends, in epoch milliseconds. */
	expireAt(at: number): void {
		if (at > this.now()) {
			this.expiresAt = at;
			this.schedule();
		}
	}

	/** Replacing the session failed: `onPhase` runs again in `ms`. */
	retryIn(ms: number): void {
		if (this.retry) {
			clearTimeout(this.retry);
		}
		this.retry = setTimeout(() => {
			this.retry = null;
			this.onPhase();
		}, ms);
	}

	clear(): void {
		for (const timer of [this.timer, this.retry]) {
			if (timer) {
				clearTimeout(timer);
			}
		}
		this.timer = null;
		this.retry = null;
	}

	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = null;
		const next = nextPhase(this.phase, this.expiresAt);
		if (!next) {
			return;
		}
		const delayMs = Math.max(0, next.at - this.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			this.phase = next.phase;
			this.schedule();
			this.onPhase();
		}, delayMs);
	}
}

/** A response a session's end may cut short, as the engine tracks it. */
interface ParlumeCutResponse {
	kind: ParlumeRealtimeCut["kind"];
	transcript: string;
	turnId: string | null;
	result: ParlumeRealtimeCut["result"];
	requester: ParlumeRealtimeCut["requester"];
	/** Its audio so far, and when the first of it was queued. */
	audioMs: number;
	firstAudioAt: number | null;
}

/**
 * `response` as its session's end cuts it: what it said so far, and how
 * much of that was heard, cut back to a whole word. A restart of the bridge
 * loses the audio its outlet held, so only what played by `now` was heard;
 * a session's end does not, and the outlet plays all it was sent.
 */
export function parlumeRealtimeCut(
	response: ParlumeCutResponse,
	cause: ParlumeRealtimeCut["cause"],
	now: number,
): ParlumeRealtimeCut {
	const { audioMs, transcript } = response;
	const playedMs =
		cause === "restart" ? now - (response.firstAudioAt ?? now) : audioMs;
	const share =
		audioMs > 0 ? Math.min(1, Math.max(0, playedMs / audioMs)) : 0;
	const chars = Math.floor(transcript.length * share);
	return {
		kind: response.kind,
		cause,
		transcript,
		heardChars:
			chars >= transcript.length
				? transcript.length
				: Math.max(0, transcript.lastIndexOf(" ", chars)),
		lostMs: Math.round(Math.max(0, audioMs - playedMs)),
		turnId: response.turnId,
		result: response.result,
		requester: response.requester,
		at: now,
	};
}

/**
 * What of a cut answer the meeting did not hear, for its chat: a Fabric
 * result's answer whole, its headline included, or the rest of what the
 * voice had said.
 */
export function parlumeUnheardText(cut: ParlumeRealtimeCut): string {
	return cut.result?.status === "completed"
		? cut.result.text
		: cut.transcript.slice(cut.heardChars).trim();
}

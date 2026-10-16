/**
 * Quiet time after a request that followed a bare "Hey Fabric". Its speaker
 * had already paused once, so a second pause inside the question is likelier
 * than after a complete request.
 */
const PARLUME_ARMED_QUIET_MS = 300;
/**
 * A request that carries its own question is final: Flux reports it only after
 * its own end-of-turn detection, so waiting again only delays the answer. The
 * request is still handed over on a timer tick rather than synchronously, so
 * the segment that holds it is queued for Fabric first.
 */
export const PARLUME_COMPLETE_REQUEST_QUIET_MS = 0;
const PARLUME_MAX_TURN_MS = 8_000;

interface EndpointedTurn {
	text: string;
	utteranceEndMs: number | null;
}

interface Draft<T> {
	speakerKey: string;
	turn: T;
	deadline: number;
	quietMs: number;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Holds a woken request until its speaker stops talking, for as long as the
 * request asks for. While it is held, the requester's following final segments
 * are appended to the request instead of being dropped.
 */
export class ParlumeTurnEndpoint<T extends EndpointedTurn> {
	private draft: Draft<T> | null = null;
	private readonly onComplete: (turn: T) => void;
	private readonly quietMs: number;
	private readonly maxMs: number;

	constructor(
		onComplete: (turn: T) => void,
		quietMs = PARLUME_ARMED_QUIET_MS,
		maxMs = PARLUME_MAX_TURN_MS,
	) {
		this.onComplete = onComplete;
		this.quietMs = quietMs;
		this.maxMs = maxMs;
	}

	/** `quietMs` is how long the speaker must stay quiet; it defaults to the constructor's. */
	begin(speakerKey: string, turn: T, quietMs = this.quietMs): void {
		this.cancel();
		const deadline = Date.now() + this.maxMs;
		this.draft = {
			speakerKey,
			turn,
			deadline,
			quietMs,
			timer: this.schedule(deadline, quietMs),
		};
	}

	hold(speakerKey: string): boolean {
		const draft = this.draft;
		if (!draft || draft.speakerKey !== speakerKey) {
			return false;
		}
		clearTimeout(draft.timer);
		draft.timer = this.schedule(draft.deadline, draft.quietMs);
		return true;
	}

	append(
		speakerKey: string,
		text: string,
		utteranceEndMs: number | null,
	): boolean {
		const draft = this.draft;
		if (!draft || !this.hold(speakerKey)) {
			return false;
		}
		draft.turn = {
			...draft.turn,
			text: `${draft.turn.text} ${text}`.trim(),
			utteranceEndMs: utteranceEndMs ?? draft.turn.utteranceEndMs,
		};
		return true;
	}

	cancel(): void {
		if (this.draft) {
			clearTimeout(this.draft.timer);
			this.draft = null;
		}
	}

	private schedule(
		deadline: number,
		quietMs: number,
	): ReturnType<typeof setTimeout> {
		const delay = Math.max(0, Math.min(quietMs, deadline - Date.now()));
		return setTimeout(() => {
			const draft = this.draft;
			this.draft = null;
			if (draft) {
				this.onComplete(draft.turn);
			}
		}, delay);
	}
}

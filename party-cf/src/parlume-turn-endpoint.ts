const PARLUME_END_OF_TURN_MS = 600;
const PARLUME_MAX_TURN_MS = 8_000;

interface EndpointedTurn {
	text: string;
	utteranceEndMs: number | null;
}

interface Draft<T> {
	speakerKey: string;
	turn: T;
	deadline: number;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Holds a woken request until its speaker stops talking. Transcription can
 * finalize a sentence at a short pause, so the requester's following final
 * segments are appended to the request instead of being dropped.
 */
export class ParlumeTurnEndpoint<T extends EndpointedTurn> {
	private draft: Draft<T> | null = null;
	private readonly onComplete: (turn: T) => void;
	private readonly quietMs: number;
	private readonly maxMs: number;

	constructor(
		onComplete: (turn: T) => void,
		quietMs = PARLUME_END_OF_TURN_MS,
		maxMs = PARLUME_MAX_TURN_MS,
	) {
		this.onComplete = onComplete;
		this.quietMs = quietMs;
		this.maxMs = maxMs;
	}

	begin(speakerKey: string, turn: T): void {
		this.cancel();
		const deadline = Date.now() + this.maxMs;
		this.draft = {
			speakerKey,
			turn,
			deadline,
			timer: this.schedule(deadline),
		};
	}

	hold(speakerKey: string): boolean {
		const draft = this.draft;
		if (!draft || draft.speakerKey !== speakerKey) {
			return false;
		}
		clearTimeout(draft.timer);
		draft.timer = this.schedule(draft.deadline);
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

	private schedule(deadline: number): ReturnType<typeof setTimeout> {
		const delay = Math.max(
			0,
			Math.min(this.quietMs, deadline - Date.now()),
		);
		return setTimeout(() => {
			const draft = this.draft;
			this.draft = null;
			if (draft) {
				this.onComplete(draft.turn);
			}
		}, delay);
	}
}

// The meeting audio reaches the bridge incomplete for its first seconds: on
// staging, 641 and 792 of about 1,000 chunks arrived in the first ten
// seconds, with gaps up to 0.8 s, and a request said then went unheard.
// Parlume says it is in the meeting only once the audio arrives whole.

/** How long a stretch of audio is measured for. */
const READY_STRETCH_MS = 2_000;
/** The share of a stretch its chunks must fill. */
const READY_COVERAGE = 0.9;
/** How long the welcome waits at most for whole audio after verification. */
export const PARLUME_AUDIO_READY_MAX_WAIT_MS = 15_000;

/**
 * Whether the meeting audio arrives whole: a stretch of two seconds in which
 * chunks holding at least 90% of that time arrived. Time is Attendee's: it
 * stamps each chunk with its own clock when it sends it, so chunks that never
 * came leave a gap, and the bridge's network delay does not count. A stretch
 * that falls short starts another.
 */
export class ParlumeAudioReadiness {
	private since: number | null = null;
	private receivedMs = 0;

	/** A chunk of `chunkMs` stamped `atMs`; true once the audio arrives whole. */
	note(chunkMs: number, atMs: number): boolean {
		// The first chunk holds audio from before the stretch began.
		if (this.since === null) {
			this.since = atMs;
			this.receivedMs = 0;
			return false;
		}
		const elapsed = atMs - this.since;
		// A chunk sent twice or out of order never counts for more than the
		// time that passed.
		this.receivedMs = Math.min(this.receivedMs + chunkMs, elapsed);
		if (elapsed < READY_STRETCH_MS) {
			return false;
		}
		if (this.receivedMs >= elapsed * READY_COVERAGE) {
			return true;
		}
		this.since = atMs;
		this.receivedMs = 0;
		return false;
	}
}

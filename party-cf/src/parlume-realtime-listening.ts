import type { ParlumeRealtimeClient } from "./parlume-realtime";

/**
 * How much meeting audio from before the window opens the session still
 * hears: the wake phrase, which Flux reports a moment after it was said, and
 * the start of the request.
 */
const PRE_ROLL_MS = 5_000;

interface HeldChunk {
	pcm: Uint8Array;
	sampleRate: number;
	ms: number;
}

/**
 * The meeting audio the realtime session hears: only from a wake phrase to
 * the end of Parlume's reply. Outside that window the latest few seconds are
 * held here, never sent, and dropped as newer audio arrives.
 */
export class ParlumeRealtimeAudioWindow {
	private held: HeldChunk[] = [];
	private heldMs = 0;
	private open = false;

	/**
	 * Hands the session this chunk while `listening`, after the audio held
	 * before the window opened; otherwise holds it. Returns true when the
	 * window has just closed: the session's unfinished input was dropped.
	 */
	append(
		client: ParlumeRealtimeClient,
		pcm: Uint8Array,
		sampleRate: number,
		listening: boolean,
	): boolean {
		if (listening) {
			this.flush(client);
			client.appendAudio(pcm, sampleRate);
			return false;
		}
		const ms = (pcm.byteLength / 2 / sampleRate) * 1000;
		this.held.push({ pcm, sampleRate, ms });
		this.heldMs += ms;
		while (this.held.length > 1 && this.heldMs > PRE_ROLL_MS) {
			this.heldMs -= this.held.shift()?.ms ?? 0;
		}
		if (!this.open) {
			return false;
		}
		this.open = false;
		client.clearAudio();
		return true;
	}

	/** Opens the window now, sending what was held, so a request is heard from its start. */
	flush(client: ParlumeRealtimeClient): void {
		this.open = true;
		for (const chunk of this.held.splice(0)) {
			client.appendAudio(chunk.pcm, chunk.sampleRate);
		}
		this.heldMs = 0;
	}
}

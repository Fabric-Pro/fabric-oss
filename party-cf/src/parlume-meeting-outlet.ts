import type { ParlumeAuraOutlet } from "./parlume-aura";
import {
	PARLUME_SPEECH_SAMPLE_RATE,
	ParlumeAudioOutlet,
	type ParlumeOutletReplyObserver,
} from "./parlume-pcm";

/** Why the outlet sends nothing: a stop being confirmed, or a socket swap. */
type ParlumeOutletHold = "stop" | "swap";

/** A socket took over the meeting's speech mid-reply. */
type ParlumeOutletHandOver = {
	/** How long the speech waited for the new socket. */
	gapMs: number;
	/** The lead the old socket held when replaced: perhaps never played. */
	lostMs: number;
};

interface BoundSocket<C> {
	connection: C;
	botId: string;
	send: (frame: Uint8Array) => void;
}

/**
 * The meeting's one audio outlet, bound to the bot's newest verified socket
 * rather than to one socket. A reply plays on it whichever socket carries it.
 * When the same bot connects again, the outlet holds what it has not sent;
 * once the new socket is verified, the speech goes on there, opening with
 * silence. Only the lead the old socket held can be lost.
 */
export class ParlumeMeetingOutlet<C> implements ParlumeAuraOutlet {
	private readonly outlet: ParlumeAudioOutlet;
	private socket: BoundSocket<C> | null = null;
	// A socket of the same bot that connected and is being verified.
	private joining: {
		connection: C;
		since: number;
		lostMs: number;
		inReply: boolean;
	} | null = null;
	private readonly holds = new Set<ParlumeOutletHold>();
	// The speech goes to a new socket when the holds end.
	private handOver = false;
	private readonly now: () => number;

	constructor(
		options: {
			now?: () => number;
			schedule?: (run: () => void, milliseconds: number) => void;
			/** Told how each reply played, for the speech telemetry. */
			replies?: ParlumeOutletReplyObserver;
		} = {},
	) {
		this.now = options.now ?? Date.now;
		this.outlet = new ParlumeAudioOutlet({
			sampleRate: PARLUME_SPEECH_SAMPLE_RATE,
			send: (frame) => this.socket?.send(frame),
			now: this.now,
			schedule: options.schedule,
			replies: options.replies,
		});
	}

	/** A socket carries the speech, or one is being verified to. */
	get live(): boolean {
		return this.socket !== null || this.joining !== null;
	}

	get sampleRate(): number {
		return this.outlet.sampleRate;
	}

	get droppedBytes(): number {
		return this.outlet.droppedBytes;
	}

	/** Resolves once the queued speech is sent; null when none waits. */
	whenSent(): Promise<void> | null {
		return this.outlet.pending ? this.outlet.whenSent() : null;
	}

	/**
	 * The bot connected again on another socket: what is not sent waits for
	 * it, rather than going to a socket the bot may have given up on.
	 */
	join(connection: C, botId: string): void {
		const socket = this.socket;
		if (
			!socket ||
			socket.botId !== botId ||
			socket.connection === connection ||
			this.joining
		) {
			return;
		}
		this.joining = {
			connection,
			since: this.now(),
			lostMs: this.outlet.leadMs,
			inReply: this.outlet.inReply,
		};
		this.hold("swap");
	}

	/**
	 * The socket is verified: the speech goes to it from now on, the speech
	 * held for a socket that joined included. Returns the hand-over when it
	 * took over a reply from the socket before it.
	 */
	bind(
		connection: C,
		botId: string,
		send: (frame: Uint8Array) => void,
	): ParlumeOutletHandOver | null {
		this.socket = { connection, botId, send };
		const joined = this.joining;
		if (!joined) {
			return null;
		}
		this.joining = null;
		this.handOver = true;
		this.release("swap");
		return joined.inReply
			? { gapMs: this.now() - joined.since, lostMs: joined.lostMs }
			: null;
	}

	/**
	 * The socket closed or was superseded. A socket still being verified to
	 * take over keeps the speech held; with none, it is dropped.
	 */
	unbind(connection: C): void {
		if (this.joining?.connection === connection) {
			this.joining = null;
			this.release("swap");
		}
		if (this.socket?.connection !== connection) {
			return;
		}
		this.socket = null;
		if (!this.joining) {
			this.outlet.clear();
		}
	}

	/** Holds the speech where it is until `release` with the same reason. */
	hold(reason: ParlumeOutletHold): void {
		this.holds.add(reason);
		this.outlet.pause();
	}

	release(reason: ParlumeOutletHold): void {
		this.holds.delete(reason);
		if (this.holds.size === 0) {
			const handOver = this.handOver;
			this.handOver = false;
			this.outlet.resume(handOver);
		}
	}

	enqueue(bytes: Uint8Array): void {
		this.outlet.enqueue(bytes);
	}

	end(): void {
		this.outlet.end();
	}

	/**
	 * Drops what is queued. It ends a hold for a stop being confirmed, but
	 * not one for a socket swap: the next speech waits for the new socket.
	 */
	clear(): void {
		this.outlet.clear();
		this.holds.delete("stop");
		if (this.holds.size > 0) {
			this.outlet.pause();
		} else {
			this.handOver = false;
		}
	}

	drained(): Promise<void> {
		return this.outlet.drained();
	}
}

/**
 * `outlet`, calling `onAudio` whenever speech is queued on it: the voice
 * floor notes which reply generation has sent the bot audio.
 */
export function parlumeNotingOutlet(
	outlet: ParlumeAuraOutlet,
	onAudio: () => void,
): ParlumeAuraOutlet {
	return {
		enqueue: (bytes) => {
			if (bytes.length > 0) {
				onAudio();
			}
			outlet.enqueue(bytes);
		},
		end: () => outlet.end(),
		clear: () => outlet.clear(),
		drained: () => outlet.drained(),
		get droppedBytes() {
			return outlet.droppedBytes;
		},
	};
}

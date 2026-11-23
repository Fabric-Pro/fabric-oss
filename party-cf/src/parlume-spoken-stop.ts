import {
	classifyParlumeStop,
	isParlumeEcho,
	type ParlumeStop,
} from "./parlume-barge-in";
import type { ParlumeStopActor, ParlumeStopDetection } from "./parlume-stop";

// How long a stop heard in a partial transcript holds Parlume's speech for
// its final one. With no final by then, the stop stands.
const STOP_CONFIRM_MS = 4_000;

export interface ParlumeSpokenStopHost {
	/** Parlume is audible, through either voice. */
	speaking(): boolean;
	/** Parlume is audible, or an answer is on its way. */
	stoppable(): boolean;
	/** The sentences Parlume is saying now, to tell its own voice heard back. */
	saying(): readonly string[];
	/** Holds what Parlume is saying where it is, in both voices. */
	hold(): void;
	/** Goes on with what `hold` held. */
	release(): void;
	/** Stops Parlume's answer, as a stop said aloud. */
	stop(
		actor: ParlumeStopActor | null,
		detection: ParlumeStopDetection,
	): Promise<void>;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}

interface HeldStop {
	/** When the stop's words ended and when Parlume was held, epoch ms. */
	heardAt: number;
	heldAt: number;
	actor: ParlumeStopActor | null;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * What a stop said aloud does to Parlume's answer. Talk over Parlume,
 * its requester's included, never stops it: only a stop phrase does. One
 * that names Parlume holds its speech as soon as a partial transcript has
 * it, and the final transcript decides: a stop ends the answer, anything
 * else lets the same audio go on. A stop without the name acts on the final
 * alone, so side talk never pauses Parlume. Words that are Parlume's own
 * sentence heard back are not a stop.
 */
export class ParlumeSpokenStop {
	private held: HeldStop | null = null;

	constructor(private readonly host: ParlumeSpokenStopHost) {}

	/** A partial transcript; `heardAt` is when its words ended. */
	onPartial(
		text: string,
		actor: ParlumeStopActor | null,
		heardAt: number,
	): void {
		if (
			this.held ||
			!this.host.speaking() ||
			classifyParlumeStop(text, false) === "none" ||
			isParlumeEcho(text, this.host.saying())
		) {
			return;
		}
		this.host.hold();
		const held: HeldStop = {
			heardAt,
			heldAt: this.host.now(),
			actor,
			timer: setTimeout(() => {
				if (this.held === held) {
					this.held = null;
					void this.host.stop(held.actor, {
						detectMs: this.detectMs(held),
						confirmed: false,
					});
				}
			}, STOP_CONFIRM_MS),
		};
		this.held = held;
		this.host.log("info", "speech.stop_held", {
			actorId: actor?.id ?? null,
		});
	}

	/**
	 * A final transcript. Returns what it was: a stop is never a request of
	 * its own, and `stop-then-request` goes on to one.
	 */
	async onFinal(
		text: string,
		actor: ParlumeStopActor | null,
		heardAt: number,
	): Promise<ParlumeStop> {
		const stop = isParlumeEcho(text, this.host.saying())
			? "none"
			: classifyParlumeStop(text, true);
		const held = this.held;
		this.held = null;
		if (held) {
			clearTimeout(held.timer);
		}
		if (stop === "none") {
			if (held) {
				this.host.release();
				this.host.log("info", "speech.stop_withdrawn", {
					heldMs: this.host.now() - held.heldAt,
				});
			}
			return stop;
		}
		if (held || this.host.stoppable()) {
			// The final names the speaker more surely: Teams reports speakers late.
			await this.host.stop(actor ?? held?.actor ?? null, {
				detectMs: held
					? this.detectMs(held)
					: Math.max(0, this.host.now() - heardAt),
				confirmed: held !== null,
			});
		}
		return stop;
	}

	private detectMs(held: HeldStop): number {
		return Math.max(0, held.heldAt - held.heardAt);
	}
}

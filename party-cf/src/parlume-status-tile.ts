// What the bot's video tile shows, as an image Fabric sends the meeting:
// Parlume listening, paused or answering.

const STATUS_IMAGE_PATH = "/api/internal/parlume/status-image";
/** A change settles this long before it is shown, so one answer is one change. */
const SETTLE_MS = 400;
/** While the tile says answering, the state is read again this often. */
const ANSWERING_RECHECK_MS = 2_000;
/** The events after which the state may have changed. */
const TILE_EVENTS = new Set([
	"speech.started",
	"speech.synthesized",
	"speech.played",
	"speech.stopped",
	"realtime.done",
	"listening.paused",
	"listening.resumed",
]);

export type ParlumeTileState = "LISTENING" | "PAUSED" | "ANSWERING";

type ParlumeLog = (
	level: "info" | "warn" | "error",
	event: string,
	meta: Record<string, unknown>,
) => void;

export interface ParlumeStatusTileHost {
	/** What Parlume is doing now. */
	state(): ParlumeTileState;
	bot(): Promise<{ sessionId: string; botId: string } | null>;
	postToFabric(path: string, body: object): Promise<Response | null>;
	log: ParlumeLog;
}

/**
 * Keeps the bot's video tile on what Parlume is doing. A change is sent
 * to Fabric once it has settled; one Fabric could not take is sent again on
 * the next change or alarm. A restart sends the state again.
 */
export class ParlumeStatusTile {
	private shown: ParlumeTileState | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private sending: Promise<void> | null = null;

	constructor(private readonly host: ParlumeStatusTileHost) {}

	/** `log`, taking each speech or listening event it logs as a possible change. */
	observing(log: ParlumeLog): ParlumeLog {
		return (level, event, meta) => {
			log(level, event, meta);
			if (TILE_EVENTS.has(event)) {
				this.changed();
			}
		};
	}

	/** The state may have changed: it is shown once it settles. */
	changed(delayMs = SETTLE_MS): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.sync();
		}, delayMs);
	}

	/** Shows the state now, unless the tile already shows it. */
	async sync(): Promise<void> {
		while (this.sending) {
			await this.sending;
		}
		const state = this.host.state();
		if (state !== this.shown) {
			this.sending = this.show(state);
			try {
				await this.sending;
			} finally {
				this.sending = null;
			}
		}
		// A realtime answer plays on after its response is done, with no
		// event to say when it ends.
		if (state === "ANSWERING") {
			this.changed(ANSWERING_RECHECK_MS);
		}
	}

	private async show(state: ParlumeTileState): Promise<void> {
		const bot = await this.host.bot();
		if (!bot) {
			return;
		}
		const shown = await this.host.postToFabric(STATUS_IMAGE_PATH, {
			...bot,
			state,
		});
		if (shown) {
			this.shown = state;
			return;
		}
		this.host.log("warn", "tile.failed", { ...bot, state });
	}
}

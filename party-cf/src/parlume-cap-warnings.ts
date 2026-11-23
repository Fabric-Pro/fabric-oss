// The warnings before a meeting's four-hour cap, and the last two minutes,
// in which Parlume starts no spoken answer.

const CAP_WARNINGS_KEY = "capWarnings";
/** From this long before the cap, a request is answered in the chat. */
const PARLUME_CAP_CLOSING_MS = 2 * 60 * 1000;
/** At the cap, the most the sentence being heard may still take. */
export const PARLUME_CAP_DRAIN_MS = 5_000;

type ParlumeCapWarning = "ten" | "two";

/** In the order they fall due. */
const WARNINGS: ReadonlyArray<{ id: ParlumeCapWarning; beforeMs: number }> = [
	{ id: "ten", beforeMs: 10 * 60 * 1000 },
	{ id: "two", beforeMs: PARLUME_CAP_CLOSING_MS },
];

/** The warnings given before the cap at `hardStopAt`. */
interface GivenWarnings {
	hardStopAt: number;
	given: ParlumeCapWarning[];
}

export interface ParlumeCapWarningsHost {
	storage: Pick<DurableObjectStorage, "get" | "put">;
	/**
	 * Reads the warning aloud in its turn, after what Parlume is saying and
	 * at a pause in the meeting; nothing when Parlume may not speak.
	 */
	speak(text: string): Promise<unknown>;
	/** The warning's line in the meeting chat, shown while a guest is in. */
	postNotice(text: string): Promise<unknown>;
	/** The last two minutes began: requests are answered in the chat. */
	onClosing(): void;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}

/** Whether the meeting is in its last two minutes, or past its cap. */
export function parlumeCapClosing(
	openUntil: number | null,
	now: number,
): boolean {
	return (
		openUntil !== null &&
		Number.isFinite(openUntil) &&
		now >= openUntil - PARLUME_CAP_CLOSING_MS
	);
}

function minutesText(minutes: number): string {
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function chatLine(id: ParlumeCapWarning, minutes: number): string {
	const line = `**Leaving in ${minutesText(minutes)}** · This meeting reaches Parlume's four-hour limit, and I leave then.`;
	return id === "two"
		? `${line}\nI answer new requests here in the chat until I leave.`
		: line;
}

function spokenLine(id: ParlumeCapWarning, minutes: number): string {
	const line = `I leave this meeting in ${minutesText(minutes)}, at its four-hour limit.`;
	return id === "two" ? `${line} I answer in the chat from now on.` : line;
}

/**
 * Ten and two minutes before the cap, Parlume posts one line in the meeting
 * chat and says it in its turn. Each is given once, a restart of the bridge
 * included: what was given is kept in Durable Object storage. When both are
 * due at once, as after an alarm that came late, only the later is given.
 */
export class ParlumeCapWarnings {
	private state: GivenWarnings | null = null;

	constructor(private readonly host: ParlumeCapWarningsHost) {}

	async load(): Promise<void> {
		this.state =
			(await this.host.storage.get<GivenWarnings>(CAP_WARNINGS_KEY)) ??
			null;
	}

	/** When the next warning falls due; null when none is left. */
	nextAt(hardStopAt: number): number | null {
		if (!(hardStopAt > 0)) {
			return null;
		}
		const given = this.givenFor(hardStopAt);
		const next = WARNINGS.find(({ id }) => !given.includes(id));
		return next ? Math.max(hardStopAt - next.beforeMs, 0) : null;
	}

	/** Gives the warning due now, if one is. */
	async run(hardStopAt: number): Promise<void> {
		const now = this.host.now();
		if (!(hardStopAt > now)) {
			return;
		}
		const given = this.givenFor(hardStopAt);
		const due = WARNINGS.filter(
			({ id, beforeMs }) =>
				!given.includes(id) && now >= hardStopAt - beforeMs,
		);
		const warning = due.at(-1);
		if (!warning) {
			return;
		}
		// Kept before it is posted: a restart mid-way never gives it twice.
		this.state = {
			hardStopAt,
			given: [...given, ...due.map(({ id }) => id)],
		};
		await this.host.storage.put(CAP_WARNINGS_KEY, this.state);
		const minutes = Math.max(1, Math.round((hardStopAt - now) / 60_000));
		this.host.log("info", "cap.warned", {
			warning: warning.id,
			minutesLeft: minutes,
			skipped: due.length - 1,
		});
		if (warning.id === "two") {
			this.host.onClosing();
		}
		await this.host.postNotice(chatLine(warning.id, minutes));
		void this.host.speak(spokenLine(warning.id, minutes));
	}

	// A cap moved by Fabric starts its warnings over.
	private givenFor(hardStopAt: number): ParlumeCapWarning[] {
		return this.state?.hardStopAt === hardStopAt ? this.state.given : [];
	}
}

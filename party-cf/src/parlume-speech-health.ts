import {
	PARLUME_OUTLET_LEAD_MS,
	type ParlumeOutletReply,
	type ParlumeOutletReplyObserver,
} from "./parlume-pcm";

const SPEECH_HEALTH_KEY = "speechHealth";
const SPEECH_HEALTH_PATH = "/api/internal/parlume/speech-health";
// A stop said aloud should leave the meeting quiet within this long.
const SLOW_STOP_MS = 1_500;

/**
 * The meeting's speech telemetry, as totals since it began. Fabric stores
 * the latest on the session and logs what each report added, for alerts.
 */
const SPEECH_COUNTERS = [
	// Stretches of Parlume's speech the meeting heard (`speech.ended`).
	"replies",
	// Their length, from first audio to end, and the time their audio ran
	// out inside them past the gap allowance, when the bot may mute, so
	// underrun over speaking time is a rate.
	"speakingMs",
	"underrunMs",
	// The silence that covered a reply's planned waits for its next part,
	// such as a tool call: heard as a pause, not starvation.
	"waitMs",
	// Times a late timer restarted the outlet's clock (`outlet.stall_reset`).
	"stallResets",
	// Stops said aloud while Parlume was audible, those after which it was
	// audible for more than 1.5 s, and the slowest: from the end of the
	// stop's words, the stop's `detectMs` plus the 200 ms the bot still holds.
	"stops",
	"slowStops",
	"worstStopMs",
	// Speech resumed after a socket swap, a restart or a session's end, and
	// realtime resumes that never started (`realtime.resume_missed`).
	"resumes",
	"failedResumes",
	// Realtime answers cut at the spoken limit (`realtime.capped`).
	"capped",
	// A realtime voice that could not be kept up (`engine.fallback`).
	"fallbacks",
	// Aura sentences asked for again, and those the second try did not play.
	"auraRetries",
	"auraRetryFailures",
] as const;

type SpeechCounter = (typeof SPEECH_COUNTERS)[number];

export type ParlumeSpeechTotals = Record<SpeechCounter, number>;

function noTotals(): ParlumeSpeechTotals {
	return {
		replies: 0,
		speakingMs: 0,
		underrunMs: 0,
		waitMs: 0,
		stallResets: 0,
		stops: 0,
		slowStops: 0,
		worstStopMs: 0,
		resumes: 0,
		failedResumes: 0,
		capped: 0,
		fallbacks: 0,
		auraRetries: 0,
		auraRetryFailures: 0,
	};
}

function sameTotals(a: ParlumeSpeechTotals, b: ParlumeSpeechTotals): boolean {
	return SPEECH_COUNTERS.every((counter) => a[counter] === b[counter]);
}

/** How a reply ended, as `speech.ended` says it. */
type ParlumeSpeechOutcome =
	| "completed"
	| "stopped"
	| "capped"
	| "failed"
	| "dropped"
	| "silent";

type ParlumeLog = (
	level: "info" | "warn" | "error",
	event: string,
	meta: Record<string, unknown>,
) => void;

type Voice = "classic" | "realtime";

/** A reply a voice started (`speech.started`) that has sent no audio yet. */
interface StartedReply {
	voice: Voice;
	route: string;
	kind: string | null;
	voiceGeneration: number | null;
	startedAt: number;
	/** Aura failed it twice before any of its audio was queued. */
	failed: boolean;
}

/** What ended the stretch being heard, ahead of the outlet's own end. */
interface Ending {
	outcome: "stopped" | "capped" | "failed";
	cause: string | null;
	actorId: string | null;
}

/**
 * Speech the meeting hears without a break: one reply, or a reply and the
 * next one queued before it played out. Its numbers are the outlet's.
 */
interface HeardStretch {
	first: StartedReply | null;
	replies: number;
	ending: Ending | null;
}

interface StoredSpeechHealth {
	totals: ParlumeSpeechTotals;
	reported: ParlumeSpeechTotals | null;
}

export interface ParlumeSpeechHealthHost {
	storage: Pick<DurableObjectStorage, "get" | "put">;
	sessionId(): string;
	bot(): Promise<{ sessionId: string; botId: string } | null>;
	postToFabric(path: string, body: object): Promise<Response | null>;
	log: ParlumeLog;
	now(): number;
}

const text = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

function newStretch(): HeardStretch {
	return { first: null, replies: 0, ending: null };
}

function described(reply: StartedReply | null): Record<string, unknown> {
	return {
		voice: reply?.voice ?? null,
		route: reply?.route ?? null,
		kind: reply?.kind ?? null,
		voiceGeneration: reply?.voiceGeneration ?? null,
	};
}

/**
 * The meeting's speech telemetry. It reads the events the voices already
 * log (`observing`), so what it counts is what the logs show, and hears
 * from the meeting's outlet how each reply played (`queued`, `ended`). From
 * them it logs `speech.first_audio`, `speech.ended`, `outlet.underrun` and
 * `outlet.stall_reset`. The totals live in Durable Object storage, so a
 * restart keeps them, and the alarm reports them to Fabric (`report`).
 */
export class ParlumeSpeechHealth implements ParlumeOutletReplyObserver {
	private totals = noTotals();
	private reported: ParlumeSpeechTotals | null = null;
	// Replies started that have sent no audio yet, oldest first.
	private waiting: StartedReply[] = [];
	private stretch: HeardStretch | null = null;

	constructor(private readonly host: ParlumeSpeechHealthHost) {}

	async load(): Promise<void> {
		const stored =
			await this.host.storage.get<StoredSpeechHealth>(SPEECH_HEALTH_KEY);
		if (stored) {
			this.totals = { ...noTotals(), ...stored.totals };
			this.reported = stored.reported;
		}
	}

	/** `log`, counting each event it logs in these totals as well. */
	observing(log: ParlumeLog): ParlumeLog {
		return (level, event, meta) => {
			log(level, event, meta);
			this.observe(event, meta);
		};
	}

	observe(event: string, meta: Record<string, unknown>): void {
		switch (event) {
			case "speech.started":
				this.started(meta);
				break;
			case "speech.stopped":
				this.stopped(meta);
				break;
			// A voice is done with a reply; one that sent no audio ends here.
			case "speech.synthesized":
			case "speech.played":
				this.endWaiting("classic", null);
				break;
			case "realtime.done":
				this.endWaiting("realtime", null);
				break;
			case "aura.retry":
				this.retried(meta.played === true);
				break;
			case "realtime.capped":
				this.mark("capped");
				this.count("capped");
				break;
			case "speech.resumed":
				this.count("resumes");
				break;
			case "realtime.resume_missed":
				this.count("failedResumes");
				break;
			case "engine.fallback":
				this.count("fallbacks");
				break;
			default:
				break;
		}
	}

	/** Speech was queued on the outlet: the oldest reply waiting is heard. */
	queued(opened: boolean): void {
		const stretch: HeardStretch =
			opened || !this.stretch ? newStretch() : this.stretch;
		this.stretch = stretch;
		const reply = this.waiting.shift();
		if (!reply) {
			return;
		}
		stretch.first ??= reply;
		stretch.replies++;
		this.host.log("info", "speech.first_audio", {
			sessionId: this.host.sessionId(),
			...described(reply),
			firstAudioMs: this.host.now() - reply.startedAt,
		});
	}

	/** The outlet played the stretch out, or dropped what was left of it. */
	ended(reply: ParlumeOutletReply): void {
		const stretch = this.stretch ?? newStretch();
		this.stretch = null;
		const outcome: ParlumeSpeechOutcome =
			stretch.ending?.outcome ?? (reply.played ? "completed" : "dropped");
		const meta = {
			sessionId: this.host.sessionId(),
			...described(stretch.first),
		};
		this.logEnded(meta, stretch.replies, outcome, stretch.ending, reply);
		if (reply.underrunMs > 0) {
			this.host.log("info", "outlet.underrun", {
				...meta,
				underrunMs: reply.underrunMs,
				waitMs: reply.waitMs,
				speakingMs: reply.speakingMs,
			});
		}
		if (reply.stallResets > 0) {
			this.host.log("warn", "outlet.stall_reset", {
				...meta,
				stallResets: reply.stallResets,
			});
		}
		this.totals.replies++;
		this.totals.speakingMs += reply.speakingMs;
		this.totals.underrunMs += reply.underrunMs;
		this.totals.waitMs += reply.waitMs;
		this.totals.stallResets += reply.stallResets;
		void this.save();
	}

	/**
	 * Sends Fabric the totals, on the alarm, when they changed since it last
	 * took them. Returns false when Fabric did not: the next alarm tries again.
	 */
	async report(): Promise<boolean> {
		const totals = { ...this.totals };
		if (sameTotals(totals, this.reported ?? noTotals())) {
			return true;
		}
		const bot = await this.host.bot();
		if (!bot) {
			return false;
		}
		const taken = await this.host.postToFabric(SPEECH_HEALTH_PATH, {
			...bot,
			totals,
		});
		if (!taken) {
			this.host.log("warn", "speech_health.report_failed", { ...bot });
			return false;
		}
		this.reported = totals;
		await this.save();
		return true;
	}

	private started(meta: Record<string, unknown>): void {
		const voice: Voice = meta.voice === "realtime" ? "realtime" : "classic";
		// Each voice says one reply at a time: one still silent is over.
		this.endWaiting(voice, null);
		this.waiting.push({
			voice,
			route: text(meta.route) ?? voice,
			kind: text(meta.kind),
			voiceGeneration: finite(meta.voiceGeneration),
			startedAt: this.host.now(),
			failed: false,
		});
	}

	private stopped(meta: Record<string, unknown>): void {
		// The join notice a guest's arrival does not cut plays on.
		if (meta.stopped !== true || meta.keepsJoinNotice === true) {
			return;
		}
		const ending: Ending = {
			outcome: "stopped",
			cause: text(meta.cause),
			actorId: text(meta.actorId),
		};
		if (this.stretch) {
			this.stretch.ending = ending;
		}
		this.endWaiting(null, ending);
		const detectMs = finite(meta.detectMs);
		if (
			meta.cause !== "voice" ||
			meta.speaking !== true ||
			detectMs === null
		) {
			return;
		}
		const quietAfterMs = Math.round(detectMs + PARLUME_OUTLET_LEAD_MS);
		this.totals.stops++;
		if (quietAfterMs > SLOW_STOP_MS) {
			this.totals.slowStops++;
		}
		this.totals.worstStopMs = Math.max(
			this.totals.worstStopMs,
			quietAfterMs,
		);
		void this.save();
	}

	private retried(played: boolean): void {
		this.totals.auraRetries++;
		if (!played) {
			this.totals.auraRetryFailures++;
			const silent = this.waiting.find(
				(reply) => reply.voice === "classic",
			);
			if (silent) {
				silent.failed = true;
			} else {
				this.mark("failed");
			}
		}
		void this.save();
	}

	/** What the stretch being heard ends as, unless someone stopped it. */
	private mark(outcome: "capped" | "failed"): void {
		if (!this.stretch || this.stretch.ending?.outcome === "stopped") {
			return;
		}
		this.stretch.ending = { outcome, cause: null, actorId: null };
	}

	/** Ends the replies of `voice` (or every voice) that sent no audio. */
	private endWaiting(voice: Voice | null, ending: Ending | null): void {
		const over = this.waiting.filter(
			(reply) => voice === null || reply.voice === voice,
		);
		if (over.length === 0) {
			return;
		}
		this.waiting = this.waiting.filter((reply) => !over.includes(reply));
		for (const reply of over) {
			this.logEnded(
				{ sessionId: this.host.sessionId(), ...described(reply) },
				1,
				ending?.outcome ?? (reply.failed ? "failed" : "silent"),
				ending,
				null,
			);
		}
	}

	private logEnded(
		meta: Record<string, unknown>,
		replies: number,
		outcome: ParlumeSpeechOutcome,
		ending: Ending | null,
		reply: ParlumeOutletReply | null,
	): void {
		this.host.log("info", "speech.ended", {
			...meta,
			replies,
			outcome,
			cause: ending?.cause ?? null,
			actorId: ending?.actorId ?? null,
			heardMs: reply ? Math.max(0, reply.speechMs - reply.droppedMs) : 0,
			droppedMs: reply?.droppedMs ?? 0,
			underrunMs: reply?.underrunMs ?? 0,
			waitMs: reply?.waitMs ?? 0,
			speakingMs: reply?.speakingMs ?? 0,
			stallResets: reply?.stallResets ?? 0,
		});
	}

	private count(counter: SpeechCounter): void {
		this.totals[counter]++;
		void this.save();
	}

	private save(): Promise<void> {
		return this.host.storage.put<StoredSpeechHealth>(SPEECH_HEALTH_KEY, {
			totals: { ...this.totals },
			reported: this.reported,
		});
	}
}

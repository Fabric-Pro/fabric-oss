/**
 * Proposal artifact: the agent stream's limits and the gateway fallback's
 * bound (Fizzy #2946). Activity-side only: these read the clock, the
 * environment and the activity's attempt deadline.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { currentActivityAttemptDeadline } from "./activity-liveness";
import { activityLogger } from "./activity-logger";

/**
 * How long a coordinated Proposal's agent stream may take to send its first
 * `updates` or `values` event: today's whole-stream limit, since the agent
 * reads its context before it writes anything.
 * `AGENT_STREAM_FIRST_CHUNK_TIMEOUT_MS` overrides it.
 */
const PROPOSAL_STREAM_FIRST_CHUNK_MS = 300_000;

/**
 * The silence between two `updates` or `values` events after which a
 * coordinated Proposal's stream would be cut. Observe-only unless
 * `AGENT_STREAM_IDLE_TIMEOUT_MS` is set: until production's gaps support a
 * value, crossing it only logs. A too-short limit turns a slow, healthy run
 * into a second generation on the same model.
 */
const PROPOSAL_STREAM_IDLE_MS = 180_000;

/**
 * What the gateway fallback is left: the stream's wall cap ends this long
 * before the attempt's deadline. `AGENT_STREAM_FALLBACK_RESERVE_MS`
 * overrides it.
 */
const PROPOSAL_FALLBACK_RESERVE_MS = 300_000;

/**
 * The wall cap where no attempt deadline is known (outside an activity):
 * today's whole-stream limit.
 */
const PROPOSAL_STREAM_WALL_WITHOUT_DEADLINE_MS = 300_000;

/**
 * What the handover from a cut stream to the fallback may take before the
 * reserve counts as spent: the stop, the milestone with its nudge and the
 * audit write, each bounded at ten seconds. A stream cut at its wall cap
 * therefore still falls back.
 */
const PROPOSAL_FALLBACK_HANDOVER_MS = 60_000;

/**
 * What the activity still needs once the fallback has written the Main: the
 * checks and the baseline read before it returns. The fallback is aborted
 * this long before the attempt's deadline.
 */
const PROPOSAL_FALLBACK_FINISH_MARGIN_MS = 30_000;

/** The error a cancelled attempt's fallback ends with. */
export const FALLBACK_CANCELLED_MESSAGE = "Fallback generation cancelled";

/** The code of an attempt failed because the fallback had no time left. */
const FALLBACK_TIME_EXHAUSTED = "FALLBACK_TIME_EXHAUSTED";

/** Why a coordinated Proposal's agent stream was cut. */
type StreamCutReason = "idle" | "wall" | "first-chunk";

/**
 * The time a coordinated Proposal's generation attempt has: its deadline,
 * read once on entry to the activity, and the reserve its fallback keeps.
 */
export interface ProposalAttemptBudget {
	/** Undefined outside an activity, where no deadline is known. */
	deadline: Date | undefined;
	fallbackReserveMs: number;
}

/** Positive milliseconds from environment variable `name`, if it holds them. */
function envMs(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function proposalAttemptBudget(): ProposalAttemptBudget {
	return {
		deadline: currentActivityAttemptDeadline(),
		fallbackReserveMs:
			envMs("AGENT_STREAM_FALLBACK_RESERVE_MS") ??
			PROPOSAL_FALLBACK_RESERVE_MS,
	};
}

/** The whole text of `textStream`. */
export async function collectText(
	textStream: AsyncIterable<string>,
): Promise<string> {
	let text = "";
	for await (const chunk of textStream) {
		text += chunk;
	}
	return text;
}

/** A timer that never holds the process open on its own. */
function unrefTimer(
	ms: number,
	fire: () => void,
): ReturnType<typeof setTimeout> {
	const timer = setTimeout(fire, Math.max(0, ms));
	timer.unref?.();
	return timer;
}

/**
 * The limits of a coordinated Proposal's agent stream (Fizzy #2946): a long
 * stream is cut by silence, not by the clock.
 *
 * - Before the first `updates` or `values` event, the first-chunk allowance
 *   ({@link PROPOSAL_STREAM_FIRST_CHUNK_MS}); the agent's opening `metadata`
 *   event does not end it.
 * - After it, the idle limit ({@link PROPOSAL_STREAM_IDLE_MS}), reset by
 *   every `updates` or `values` event. It cuts only when
 *   `AGENT_STREAM_IDLE_TIMEOUT_MS` is set; otherwise it logs that it would
 *   have, with the gap.
 * - Throughout, the wall cap: what is left of the attempt's deadline less the
 *   fallback's reserve, so a stream still producing is cut only when the
 *   fallback would otherwise have no time. An explicit
 *   `AGENT_STREAM_TIMEOUT_MS` replaces it.
 *
 * A cut runs `onCut` (which aborts the stream) and settles
 * {@link ProposalStreamLimits.cut} with its reason. Every timer is cleared by
 * {@link ProposalStreamLimits.dispose}, which every exit calls. Logs carry
 * ids and numbers only.
 */
export class ProposalStreamLimits {
	/** Settles with the reason once a limit cuts the stream; else never. */
	readonly cut: Promise<StreamCutReason>;
	private resolveCut: (reason: StreamCutReason) => void = () => {};
	private reason: StreamCutReason | undefined;
	private lastEventAt: number | undefined;
	private largestGap = 0;
	private readonly firstChunkMs: number;
	private readonly idleMs: number;
	private readonly idleEnforced: boolean;
	private readonly wallMs: number;
	private firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly wallTimer: ReturnType<typeof setTimeout>;

	constructor(
		budget: ProposalAttemptBudget,
		private readonly onCut: () => void,
		private readonly logIds: Record<string, unknown>,
	) {
		this.cut = new Promise((resolve) => {
			this.resolveCut = resolve;
		});
		const now = Date.now();
		const idleOverride = envMs("AGENT_STREAM_IDLE_TIMEOUT_MS");
		this.firstChunkMs =
			envMs("AGENT_STREAM_FIRST_CHUNK_TIMEOUT_MS") ??
			PROPOSAL_STREAM_FIRST_CHUNK_MS;
		this.idleMs = idleOverride ?? PROPOSAL_STREAM_IDLE_MS;
		this.idleEnforced = idleOverride !== undefined;
		this.wallMs =
			envMs("AGENT_STREAM_TIMEOUT_MS") ??
			(budget.deadline
				? Math.max(
						0,
						budget.deadline.getTime() -
							now -
							budget.fallbackReserveMs,
					)
				: PROPOSAL_STREAM_WALL_WITHOUT_DEADLINE_MS);
		this.firstChunkTimer = unrefTimer(this.firstChunkMs, () =>
			this.cutFor("first-chunk"),
		);
		this.wallTimer = unrefTimer(this.wallMs, () => this.cutFor("wall"));
	}

	/**
	 * Count one stream event toward the limits, as it is received: only
	 * `updates` and `values` events show the agent is writing.
	 */
	observe(event: string): void {
		if (
			this.reason !== undefined ||
			(event !== "updates" && event !== "values")
		) {
			return;
		}
		const now = Date.now();
		if (this.lastEventAt === undefined) {
			clearTimeout(this.firstChunkTimer);
			this.firstChunkTimer = undefined;
		} else {
			this.largestGap = Math.max(this.largestGap, now - this.lastEventAt);
		}
		this.lastEventAt = now;
		clearTimeout(this.idleTimer);
		this.idleTimer = unrefTimer(this.idleMs, () => this.idle());
	}

	/** Why the stream was cut, if it was. */
	get cutReason(): StreamCutReason | undefined {
		return this.reason;
	}

	/** The largest gap between two events, the one a cut ended included. */
	get largestGapMs(): number {
		return this.largestGap;
	}

	/** The limit a cut of `reason` enforced, for the error message. */
	limitMs(reason: StreamCutReason): number {
		if (reason === "first-chunk") {
			return this.firstChunkMs;
		}
		return reason === "idle" ? this.idleMs : this.wallMs;
	}

	/** Clear every timer. Safe to call more than once. */
	dispose(): void {
		clearTimeout(this.firstChunkTimer);
		clearTimeout(this.idleTimer);
		clearTimeout(this.wallTimer);
	}

	private idle(): void {
		if (this.idleEnforced) {
			this.cutFor("idle");
			return;
		}
		const gapMs = Date.now() - (this.lastEventAt ?? Date.now());
		activityLogger.warn(
			"Agent stream silent past its idle limit; it would have been cut",
			{
				...this.logIds,
				idleLimitMs: this.idleMs,
				gapMs,
				largestGapMs: Math.max(this.largestGap, gapMs),
			},
		);
	}

	private cutFor(reason: StreamCutReason): void {
		if (this.reason !== undefined) {
			return;
		}
		this.reason = reason;
		if (this.lastEventAt !== undefined) {
			this.largestGap = Math.max(
				this.largestGap,
				Date.now() - this.lastEventAt,
			);
		}
		this.dispose();
		this.onCut();
		this.resolveCut(reason);
	}
}

/**
 * The failure of an attempt whose gateway fallback could not finish before
 * the attempt's deadline (Fizzy #2946): starting it would only spend the
 * attempt. Retryable, so the next attempt starts with its own time.
 */
function fallbackTimeExhaustedFailure(): ApplicationFailure {
	return ApplicationFailure.retryable(
		"Too little of this generation attempt was left for the fallback model to write the document.",
		FALLBACK_TIME_EXHAUSTED,
	);
}

/**
 * Refuse a coordinated Proposal's fallback that cannot finish: less than the
 * reserve is left of the attempt, less the bounded handover a cut stream
 * takes to reach the fallback. Nothing to refuse when no deadline is known.
 */
export function assertFallbackTimeLeft(
	budget: ProposalAttemptBudget | undefined,
	logIds: Record<string, unknown>,
	cutReason: StreamCutReason | undefined,
): void {
	if (!budget?.deadline) {
		return;
	}
	const remainingMs = budget.deadline.getTime() - Date.now();
	if (
		remainingMs >=
		budget.fallbackReserveMs - PROPOSAL_FALLBACK_HANDOVER_MS
	) {
		return;
	}
	activityLogger.warn(
		"Too little of the attempt is left for the fallback; failing the attempt",
		{
			...logIds,
			remainingMs,
			fallbackReserveMs: budget.fallbackReserveMs,
			cutReason: cutReason ?? null,
			error: FALLBACK_TIME_EXHAUSTED,
		},
	);
	throw fallbackTimeExhaustedFailure();
}

/**
 * The bound of a coordinated Proposal's gateway fallback (Fizzy #2946),
 * after `docs/solutions/architecture-patterns/an-abort-signal-is-not-a-deadline.md`:
 * the abort signal handed to the model call only asks it to stop, so the
 * reading of its text is also raced against an independent timer (what is
 * left of the attempt's deadline, less
 * {@link PROPOSAL_FALLBACK_FINISH_MARGIN_MS}) and against the activity's
 * cancellation, either of which aborts the call and ends the wait at once.
 * Without a known deadline only the cancellation bounds it. `dispose` clears
 * the timer and the listener.
 */
export class FallbackBound {
	private readonly controller = new AbortController();
	private readonly ended: Promise<never>;
	private rejectEnded: (error: Error) => void = () => {};
	private readonly timer: ReturnType<typeof setTimeout> | undefined;
	private readonly onCancel = () => this.end("cancelled");

	constructor(
		budget: ProposalAttemptBudget | undefined,
		private readonly cancellation: AbortSignal | undefined,
	) {
		this.ended = new Promise<never>((_, reject) => {
			this.rejectEnded = reject;
		});
		this.ended.catch(() => {});
		if (budget?.deadline) {
			this.timer = unrefTimer(
				budget.deadline.getTime() -
					Date.now() -
					PROPOSAL_FALLBACK_FINISH_MARGIN_MS,
				() => this.end("deadline"),
			);
		}
		if (cancellation?.aborted) {
			this.end("cancelled");
		} else {
			cancellation?.addEventListener("abort", this.onCancel, {
				once: true,
			});
		}
	}

	/** The abort signal handed to the model call. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** The whole text of `textStream`, or a throw once the bound ends. */
	async collect(textStream: AsyncIterable<string>): Promise<string> {
		const reading = collectText(textStream);
		// An abandoned read may reject once the bound has ended the wait.
		reading.catch(() => {});
		return await Promise.race([reading, this.ended]);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.cancellation?.removeEventListener("abort", this.onCancel);
	}

	private end(reason: "deadline" | "cancelled"): void {
		if (this.controller.signal.aborted) {
			return;
		}
		this.controller.abort();
		this.rejectEnded(
			new Error(
				reason === "cancelled"
					? FALLBACK_CANCELLED_MESSAGE
					: "Fallback generation did not finish before the attempt's deadline",
			),
		);
	}
}

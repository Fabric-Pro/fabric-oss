/**
 * Keeps a research run's document row visibly alive.
 *
 * The page judges a GENERATING run by its last server write, and stops
 * treating it as writing once that is older than
 * `GENERATION_RUN_SILENCE_CEILING_MS` (ten minutes). A run without live
 * sections writes progress only before its generation activity starts, and a
 * run allowed to research may spend nearly all of that on the agent stream,
 * then more on the gateway fallback. So the activity repeats the child's own
 * progress write while the stream runs, at most once a minute, and once when
 * the fallback starts.
 *
 * The write itself is the caller's: it must be scoped to the attempt, so a
 * superseded attempt never touches a newer one and a finished document is
 * never reopened. Best effort: a write still in flight is never stacked on,
 * and a failed one is logged with ids only and never fails the generation.
 */
import { activityLogger } from "./activity-logger";

/** The most often a running stream writes: well inside the ceiling. */
export const RESEARCH_PROGRESS_WRITE_INTERVAL_MS = 60_000;

export class ResearchProgressKeepalive {
	private lastWriteAt = Date.now();
	private inFlight = false;

	constructor(
		private readonly write: () => Promise<unknown>,
		private readonly logIds: Record<string, unknown>,
	) {}

	/**
	 * From the stream's heartbeat: writes once a full interval has passed
	 * since the last write (or since the keepalive started).
	 */
	tick(): void {
		if (
			Date.now() - this.lastWriteAt >=
			RESEARCH_PROGRESS_WRITE_INTERVAL_MS
		) {
			this.writeNow();
		}
	}

	/** Writes now, unless a write is still in flight. Never throws. */
	writeNow(): void {
		if (this.inFlight) {
			return;
		}
		this.inFlight = true;
		this.lastWriteAt = Date.now();
		void (async () => {
			try {
				await this.write();
			} catch (error) {
				activityLogger.warn(
					"Could not record a research run's progress; generation continues",
					{
						...this.logIds,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			} finally {
				this.inFlight = false;
			}
		})();
	}
}

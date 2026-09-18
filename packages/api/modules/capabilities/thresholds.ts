/**
 * How long a job may sit in Processing before gating calls it stalled.
 *
 * Deliberately dependency-free — no imports, not even type-only ones — so this
 * file can be read from either side of the app without dragging a server module
 * into a browser bundle. `__tests__/readiness-isolation.test.ts` enforces it.
 *
 * ## Why these are not one number
 *
 * The three job sources this feature gates have genuinely different lifecycles,
 * and a single timeout would be wrong for at least two of them:
 *
 * **Background-job rows** already have a durable closer. A scheduled watchdog
 * fails any row whose heartbeat has gone stale, and it is the only writer that
 * can terminalise a row whose worker died. A read-time window *longer* than
 * that watchdog's is therefore inert — the row is already FAILED before this
 * value matters — and one much *shorter* would declare a live run dead while it
 * is still reporting progress. So this value tracks the watchdog rather than
 * competing with it, and is deliberately a little under it: the aim is for the
 * page to stop spinning at roughly the same moment the sweep gives up, not
 * before.
 *
 * **Atlas** is not a background-job row and is not swept. Its own status
 * accessor self-heals a stale in-flight run on read, on its own much longer
 * clock, and that accessor is what evidence reads. Gating does not impose a
 * second, disagreeing clock on it — there is no entry for Atlas here on purpose.
 *
 * **Project scans** had no closer at all until this change: their own model,
 * no sweep, no self-heal, and no heartbeat column either, so staleness is
 * measured from when the run started rather than from its last sign of life.
 * That makes the window necessarily generous — a long scan reporting nothing is
 * indistinguishable from a dead one, and calling a working scan dead is the
 * worse error. A sweep now terminalises these rows too, so this value is what
 * the page shows in the gap before the sweep next runs.
 */

/**
 * Background-job-backed work: context ingestion, code indexing, document and
 * topic generation, PM polling, the chat monitors.
 *
 * Kept below the watchdog's own staleness window so the two agree rather than
 * contradict each other. Raising this above that window has no effect.
 */
const BACKGROUND_JOB_STALL_MINUTES = 40;

/**
 * Project security and accessibility scans, measured from `startedAt` because
 * the model carries no heartbeat.
 */
const PROJECT_SCAN_STALL_MINUTES = 90;

/**
 * Stall windows by evidence source, for the resolver.
 *
 * Atlas is absent by design — see the file comment. A source with no entry is
 * never declared stalled by gating, which is the safe direction: an unknown age
 * is not evidence of death.
 */
export const STALL_MINUTES_BY_SOURCE = {
	backgroundJob: BACKGROUND_JOB_STALL_MINUTES,
	projectScan: PROJECT_SCAN_STALL_MINUTES,
} as const;

export type StallSource = keyof typeof STALL_MINUTES_BY_SOURCE;

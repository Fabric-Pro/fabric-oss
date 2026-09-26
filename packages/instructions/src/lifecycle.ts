/**
 * When an unfinished Coding Instructions upload stops being "in progress",
 * and when a snapshot left mid-validation stops being believable.
 */

/**
 * How long a snapshot may sit in RECEIVING with no `finalize` before it is
 * treated as abandoned.
 *
 * `projects.instructions.begin` creates the row and hands the browser one
 * signed PUT per file; `finalize` is what moves the row on. Close the upload
 * dialog (or the tab, or the laptop lid) part-way through and `finalize` is
 * never called: the row stays RECEIVING forever, the Coding Instructions tab
 * keeps polling it as work in progress, and its staged objects are referenced
 * by nothing that will ever delete them.
 *
 * Six hours because the upload page's signed URLs live 15 minutes. An upload
 * that has not finalized within a whole working morning is not slow, it is
 * gone — while the margin over 15 minutes is wide enough that no genuine
 * upload, however large or however often its URLs were re-issued, is reaped
 * out from under a user who is still there.
 *
 * A CONSTANT rather than an env var on purpose: the reaper
 * (`packages/temporal/src/activities/project-instructions-reaper.ts`) and the
 * tab's polling decision
 * (`apps/web/modules/saas/projects/lib/instructions-poll.ts`) have to agree on
 * it. If they could drift, the tab would either keep polling rows the reaper
 * has already given up on, or stop polling an upload the reaper still
 * considers live.
 */
export const RECEIVING_ABANDON_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Absolute lifetime of a proposal's writable staging capability.
 *
 * Every presigned proposal PUT expires no later than this boundary measured
 * from the snapshot's immutable `createdAt`. A canceled or rejected proposal
 * therefore has a finite point after which its staging prefix can be swept
 * without a still-live URL recreating an object behind the sweep.
 */
export const PROPOSAL_UPLOAD_SIGNING_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a snapshot may sit in VALIDATING before the reaper considers the
 * row worth INSPECTING.
 *
 * Not a bound on how long a validation may legitimately run, and nothing may
 * be decided on this age alone. The workflow's 10-minute `startToCloseTimeout`
 * and 3 attempts are PER ACTIVITY
 * (`packages/temporal/src/workflows/project-instruction-snapshot.ts`), and its
 * activities run in sequence — verification, promotion, publication, pruning,
 * and then the failure marker's own attempts if a late one fails — so their
 * limits multiply rather than cap the execution. Queue wait is not covered by
 * `startToCloseTimeout` at all. A large upload (up to `SNAPSHOT_LIMITS.maxFiles`
 * files under the byte cap) can therefore still be running, correctly, well
 * past an hour.
 *
 * What an hour buys is a bounded candidate population: old enough that asking
 * Temporal about every one of them is cheap and rare. The LIVE-RUN safeguards
 * are the two the reaper applies to each candidate — `describe()` on the
 * snapshot's deterministic workflow id, which skips anything still running and
 * treats an unreachable Temporal as "unknown", and the compare-and-set on the
 * row's observed `updatedAt`
 * (`failStaleValidatingInstructionSnapshot`), which refuses to write over a
 * row that moved after it was described. A shorter threshold would cost sweep
 * work; it would not make a longer one unsafe.
 *
 * The same constant governs the tab, with a further hour of slack on top so
 * the hourly reaper has had a full cycle to write the verdict before the tab
 * gives up on it — a tab that stopped at the bare threshold would leave the
 * row unwatched for up to an hour while the sweep was still going to move it.
 * The tab giving up is a polling decision, not a statement that the run is
 * over.
 *
 * A CONSTANT for the same reason `RECEIVING_ABANDON_AFTER_MS` is: the reaper
 * and the tab have to agree about which rows are still worth watching.
 */
export const VALIDATING_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * How long a publish-first snapshot (Fizzy #2737) may stay READY with its
 * deferred secret scan still PENDING before the reaper considers the row worth
 * INSPECTING.
 *
 * A pending scan is owned by the snapshot's own workflow, which records a
 * verdict whichever way the scan goes — INCOMPLETE included, when the scan
 * exhausts its retries. What this bounds is the case where that workflow is
 * GONE: the publish activity or the outcome write failed past its retries,
 * the execution was terminated or timed out, or a worker died. Nothing else
 * would ever move such a row, and a version that published unscanned would
 * read "scan pending" forever.
 *
 * Measured from `readyAt`, the moment the version could first be read. Half an
 * hour is several times what the scan of a maximum-size snapshot takes with
 * all of its retries. As with `VALIDATING_STALE_AFTER_MS`, nothing is decided
 * on age alone: the reaper still asks Temporal whether the workflow is
 * running, and a row whose workflow is live is left to it.
 *
 * A CONSTANT for the same reason as the two above: the reaper and the tab's
 * polling decision have to agree about which pending scans are still alive.
 */
export const DEFERRED_SCAN_STALE_AFTER_MS = 30 * 60 * 1000;

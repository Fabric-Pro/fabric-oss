/**
 * The retry budget of the publish-first path's deferred secret scan (Fizzy
 * #2737), shared by the workflow that schedules the activity and the activity
 * that has to know when it is on its last attempt.
 *
 * Both sides read this one constant so they cannot drift. The activity
 * behaves differently on its final attempt: before it, a per-file storage
 * error is thrown so Temporal retries the whole scan; on it, the error is
 * caught, the remaining files are still scanned, and the verdict is
 * INCOMPLETE with every finding already established. If the workflow's
 * `maximumAttempts` moved without the activity's idea of "final" moving with
 * it, one side would either discard findings (the activity never reaching
 * what it thinks is the last attempt) or stop retrying early.
 *
 * Kept apart from the workflow module, and free of runtime imports, so the
 * workflow bundle can import it without loading activity code.
 */
export const DEFERRED_SCAN_MAX_ATTEMPTS = 6;

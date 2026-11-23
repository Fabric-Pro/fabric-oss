/**
 * How many times Temporal runs the meeting notes activity. The workflow sets
 * it as the retry policy and passes it to the activity: every attempt before
 * the last rethrows a failed model call for Temporal to retry, and only the
 * last records the notes as failed.
 */
export const PARLUME_NOTES_MAX_ATTEMPTS = 3;

/**
 * The retry policy of a notes activity scheduled before the workflow passed
 * its attempts, which therefore arrives without them.
 */
export const PARLUME_NOTES_LEGACY_MAX_ATTEMPTS = 2;

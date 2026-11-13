/**
 * The limits of Living Memory decision extraction: how much of a file the
 * model reads and how many of its decisions are kept.
 *
 * Lives in `@repo/utils` so the Temporal activity that applies them and the
 * Decisions tab, which tells a reviewer when a file met one, share ONE value.
 */

/** Characters of a file the model reads; the rest is cut with a marker. */
export const LIVING_MEMORY_DECISION_FILE_CHAR_CAP = 60_000;

/** A file listing more than this is not a decision log; the first are kept. */
export const LIVING_MEMORY_DECISION_MAX_PER_FILE = 50;

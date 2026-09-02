/**
 * The shape of a run resolution — `WIDTHxHEIGHT`, e.g. `1920x1080`.
 *
 * One invariant, three consumers (the QA-settings API, the run-configuration
 * API, and the settings form's custom-resolution field), so the pattern lives
 * here rather than being hand-copied: a copy that drifts lets the client bless
 * values the server refuses, or reject values it accepts, with no compile-time
 * signal.
 */
export const QA_RESOLUTION_PATTERN = /^\d{3,5}x\d{3,5}$/;

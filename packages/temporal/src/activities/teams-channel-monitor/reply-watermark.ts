/**
 * The one "is this reply new?" rule shared by the fetch activity (which
 * decides whether a seen thread comes back as a revisit) and the analyze
 * activity (which splits a revisited thread into already-reviewed context and
 * new replies). They must agree: a thread fetched as a revisit has to have at
 * least one reply the analyzer also treats as new, and vice versa.
 *
 * Deliberately NOT re-exported from this folder's `index.ts`: that barrel is
 * spread into the worker's activity registry, and a plain helper does not
 * belong there.
 */

/**
 * True when `createdAt` parses and is strictly later than `watermarkMs`.
 *
 * - A reply created exactly at the watermark is the one the previous analysis
 *   ended on, so it is not new.
 * - A missing or unparseable timestamp is NOT new. Graph always sets
 *   `createdDateTime` on channel messages, so this is a malformed-input
 *   guard, and "not new" is the only safe answer for it: a time that can
 *   never compare later than any watermark would otherwise send the thread
 *   back as a revisit on every tick, forever, with nothing ever advancing.
 */
export function isReplyNewerThanWatermark(
	createdAt: string | undefined,
	watermarkMs: number,
): boolean {
	if (!createdAt) {
		return false;
	}
	const createdMs = new Date(createdAt).getTime();
	return !Number.isNaN(createdMs) && createdMs > watermarkMs;
}

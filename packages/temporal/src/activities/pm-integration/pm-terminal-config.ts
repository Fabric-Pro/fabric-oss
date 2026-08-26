/**
 * Shared terminal-status config helpers (#1741 payload-size fix).
 *
 * Both `fetchAdoWorkItemStates` (classification) and `reconcileAdoStates`
 * (revalidation) must derive the SAME effective terminal set and the SAME hash,
 * or the settings-change gate would false-trip. Keep the fallback + hashing in
 * one place so they cannot drift apart. Pure — no deps.
 */

/** The effective terminal-status set: the project's configured list, or the
 *  built-in fallback when it is empty/null. Mirrors the inline fallback that
 *  reconcileAdoStates and the per-item Pull path have used since #1360. */
export function resolveTerminalSet(
	statuses: string[] | null | undefined,
): string[] {
	return statuses && statuses.length > 0
		? statuses
		: ["Closed", "Done", "Removed"];
}

/** Order- and case-insensitive, COLLISION-PROOF fingerprint of a terminal set.
 *  JSON-encodes the sorted lowercased array rather than a delimiter join, so
 *  user-controlled statuses that contain the delimiter — e.g. ["a|b","c"] vs
 *  ["a","b|c"] — cannot collide to the same fingerprint and make a real settings
 *  change look stable (Codex round-3). Not cryptographic; the gate only needs
 *  determinism + no collisions. */
export function hashTerminalStatuses(statuses: string[]): string {
	return JSON.stringify([...statuses].map((s) => s.toLowerCase()).sort());
}

/**
 * "Dismiss for this session" — the one dismissal that is never stored
 * (Fizzy #1930, FR27 / AC-5).
 *
 * It lives in `sessionStorage`, so it dies with the tab, which is what the
 * option promises. The server refuses to store it for the same reason: a row
 * for a dismissal that ends when the tab closes is a row nothing ever cleans up.
 *
 * Keyed by the gate's fingerprint as well as its capability and reason, so a
 * session dismissal comes back on exactly the material change a stored one
 * does. Every storage access is wrapped: a private window or blocked site data
 * throws, and the right outcome then is that the warning shows, not that the
 * page breaks.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";

const STORAGE_PREFIX = "fabric-capability-dismissed:";

/** One dismissal's identity. */
export function sessionDismissalKey(
	gate: Pick<CapabilityGate, "capabilityKey" | "reasonKey" | "fingerprint">,
): string {
	return `${gate.capabilityKey}:${gate.reasonKey ?? ""}:${gate.fingerprint}`;
}

export function readSessionDismissals(projectId: string): Set<string> {
	if (typeof window === "undefined") {
		return new Set();
	}
	try {
		const raw = window.sessionStorage.getItem(
			`${STORAGE_PREFIX}${projectId}`,
		);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return new Set(
			Array.isArray(parsed)
				? parsed.filter(
						(entry): entry is string => typeof entry === "string",
					)
				: [],
		);
	} catch {
		return new Set();
	}
}

export function writeSessionDismissals(
	projectId: string,
	keys: ReadonlySet<string>,
): void {
	try {
		window.sessionStorage.setItem(
			`${STORAGE_PREFIX}${projectId}`,
			JSON.stringify([...keys]),
		);
	} catch {
		// Held in memory for this page either way; storage only carries it
		// across a reload.
	}
}

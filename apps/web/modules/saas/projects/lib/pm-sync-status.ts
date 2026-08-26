/**
 * Pure derivation of the PM "ticket-status sync" freshness for a project,
 * driven by the hourly state-poll fields (`adoStatePollActive`,
 * `lastAdoStatePollAt`). Render-free so it is unit-testable; the component
 * maps the returned status to copy + a design token. `now` is injected so the
 * threshold logic is deterministic in tests.
 *
 * Note: the `ado*` field names are historical (Phase A); they now cover all PM
 * tools (Phase B). A cosmetic rename to `pm*` is deferred to a later cycle.
 */
export type PmSyncStatus =
	| { kind: "disabled" } // no PM tool connected → caller renders nothing
	| { kind: "not-enrolled" } // tool connected, poll not yet active
	| { kind: "awaiting" } // active, never polled
	| { kind: "ok"; at: Date } // active, polled, fresh
	| { kind: "stale"; at: Date }; // active, polled, older than STALE_AFTER_MS

/**
 * Staleness threshold = 2× the hourly poll interval. A `lastAdoStatePollAt`
 * older than this means the poll missed at least one cycle.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function derivePmSyncStatus(args: {
	hasPmToolConnected: boolean;
	adoStatePollActive: boolean | null | undefined;
	lastAdoStatePollAt: Date | string | null | undefined;
	now: number;
}): PmSyncStatus {
	const { hasPmToolConnected, adoStatePollActive, lastAdoStatePollAt, now } =
		args;

	if (!hasPmToolConnected) {
		return { kind: "disabled" };
	}
	if (!adoStatePollActive) {
		return { kind: "not-enrolled" };
	}
	if (lastAdoStatePollAt == null) {
		return { kind: "awaiting" };
	}

	const at =
		lastAdoStatePollAt instanceof Date
			? lastAdoStatePollAt
			: new Date(lastAdoStatePollAt);

	// Guard against an unparseable string.
	if (Number.isNaN(at.getTime())) {
		return { kind: "awaiting" };
	}

	const ageMs = now - at.getTime();
	return ageMs > STALE_AFTER_MS ? { kind: "stale", at } : { kind: "ok", at };
}

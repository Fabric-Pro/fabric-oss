/**
 * PM → Fabric mapped-status sync: the pure decision table (Fizzy #2304).
 *
 * Spec §4.4 rows 4–10 (the poll) and §4.5 step 2 (the REST GitLab push gate).
 * No I/O. The poll leaf (`@repo/temporal` `reconcile-story-mapped-status.ts`)
 * and the push both decide through this module, so the two sides cannot
 * disagree about what "the ticket changed" means.
 *
 * The merge base is four columns on the story:
 * - P, `pmStatusSyncBaseId` — the last observed ticket status: a Fabric status
 *   id, or one of the sentinels below for a no-status observation;
 * - T, `pmStatusSyncBaseAt` — the ticket clock at that observation;
 * - `pmStatusSyncBaseLink` — the link key the observation was made against;
 * - F, `pmStatusSyncBaseFabricId` — the Fabric status the observation was
 *   made against. The push compares the story's status with F, never with P:
 *   after a no-status observation P is a sentinel no Fabric status equals.
 *
 * P, T and F count ONLY while the base link equals the story's current link
 * key K. A relinked story (or a base written before a relink) is a first
 * observation, never a stale comparison against someone else's ticket.
 */
import type { StatusResolution } from "./resolve-pm-status";

/**
 * Base values for observations that carry no status. Recording them (instead
 * of leaving P alone) is what makes a later return to a mapped status count as
 * a change (AC6).
 */
export const PM_STATUS_SYNC_SENTINEL = {
	NONE: "__none__",
	AMBIGUOUS: "__ambiguous__",
	TERMINAL: "__terminal__",
} as const;

/** Every outcome one polled item can have (spec AC13). The type is derived from this list. */
export const STATUS_SYNC_OUTCOMES = [
	"moved",
	"unchanged",
	"fabric-ahead",
	"not-mapped",
	"ambiguous",
	"unverified",
	"stale",
	"skipped-conflict",
	"raced",
] as const;

export type StatusSyncOutcome = (typeof STATUS_SYNC_OUTCOMES)[number];

/** Resolved ticket status (R): a Fabric status id, or a no-status observation. */
export type ResolvedTicketStatus =
	| { kind: "status"; statusId: string }
	| { kind: "none" }
	| { kind: "ambiguous"; statusIds: string[]; labels: string[] };

export interface StatusSyncBase {
	/** `pmStatusSyncBaseId` — a status id or a sentinel. */
	baseId: string | null;
	/** `pmStatusSyncBaseAt`. */
	baseAt: Date | null;
	/** `pmStatusSyncBaseLink`. */
	baseLink: string | null;
	/** `pmStatusSyncBaseFabricId` — the Fabric status P was observed against. */
	baseFabricId: string | null;
}

/** P, T and F as the decision sees them: null unless the base belongs to link K. */
function observedBase(
	base: StatusSyncBase,
	linkKey: string,
): { p: string | null; t: Date | null; f: string | null } {
	return base.baseLink === linkKey
		? { p: base.baseId, t: base.baseAt, f: base.baseFabricId }
		: { p: null, t: null, f: null };
}

/** The value a resolution is recorded as in P. */
function baseTokenOf(resolved: ResolvedTicketStatus): string {
	switch (resolved.kind) {
		case "status":
			return resolved.statusId;
		case "none":
			return PM_STATUS_SYNC_SENTINEL.NONE;
		case "ambiguous":
			return PM_STATUS_SYNC_SENTINEL.AMBIGUOUS;
	}
}

/**
 * Spec §4.4 rows 4–10, in order. Rows 1–3 (terminal verdicts, non-syncing
 * verdicts, the linked-issue check) are the caller's. Pure.
 */
export function decidePmStatusSync(input: {
	resolved: ResolvedTicketStatus;
	/** L — the story's `statusId`. */
	fabricStatusId: string;
	base: StatusSyncBase;
	/** K — the story's current link key. */
	linkKey: string;
	/** d — the verdict's `stateChangedDate`. */
	stateChangedDate: Date | null;
	/** `lastPmSyncStatus === "CONFLICT"`. */
	pushConflictPending: boolean;
}): {
	outcome: Exclude<StatusSyncOutcome, "unverified" | "raced">;
	/** null = no story write. `baseLink` is always `linkKey` when non-null. */
	write: null | {
		/** Present only for "moved". */
		statusId?: string;
		baseId: string;
		baseAt: Date | null;
		baseLink: string;
		/** F — L for rows 6–8, R for row 10 (the story's status once written). */
		baseFabricId: string;
	};
} {
	const { resolved, fabricStatusId, linkKey, stateChangedDate } = input;
	const { p, t } = observedBase(input.base, linkKey);

	// Row 4 — a push CONFLICT owns this story until someone resolves it.
	if (input.pushConflictPending) {
		return { outcome: "skipped-conflict", write: null };
	}

	// Row 5 — an observation older than the base (typically fetched before a
	// push stamped the base) says nothing the base does not already know.
	if (
		stateChangedDate !== null &&
		t !== null &&
		stateChangedDate.getTime() < t.getTime()
	) {
		return { outcome: "stale", write: null };
	}

	const r = baseTokenOf(resolved);
	// Rows 6–8 only record the observation, and only when it differs from P.
	// F is recorded with it. When P does not change, neither does F: a Fabric
	// move made while the ticket's observation stands stays visible to the push
	// as L ≠ F, so the push can carry it.
	const observe = (outcome: "not-mapped" | "ambiguous" | "unchanged") => ({
		outcome,
		write:
			p === r
				? null
				: {
						baseId: r,
						baseAt: stateChangedDate,
						baseLink: linkKey,
						baseFabricId: fabricStatusId,
					},
	});

	if (resolved.kind === "none") {
		return observe("not-mapped"); // Row 6
	}
	if (resolved.kind === "ambiguous") {
		return observe("ambiguous"); // Row 7
	}
	if (r === fabricStatusId) {
		return observe("unchanged"); // Row 8
	}
	// Row 9 — the ticket still shows what was last observed, so the difference
	// is a Fabric-only move. It stands.
	if (r === p) {
		return { outcome: "fabric-ahead", write: null };
	}
	// Row 10 — the ticket changed since the last observation (or this is the
	// first one) and disagrees with Fabric: the ticket wins.
	return {
		outcome: "moved",
		write: {
			statusId: r,
			baseId: r,
			baseAt: stateChangedDate,
			baseLink: linkKey,
			baseFabricId: r,
		},
	};
}

/**
 * Spec §4.5 step 2 — may a REST GitLab push change mapped status labels?
 * Only when there is an observation on this link (P non-null), Fabric's status
 * moved since that observation was made (L ≠ F), AND the live ticket still
 * shows it (R_live = P, sentinel-aware through `baseTokenOf`: none ↔
 * `__none__`, ambiguous ↔ `__ambiguous__`, a status ↔ its id; `__terminal__`
 * never matches). With no observation the next poll decides (a first
 * observation applies the ticket's status, AC5). Otherwise the push leaves
 * labels alone and the next poll applies whatever the ticket now says. Pure.
 */
export function shouldPushStatusLabels(input: {
	/** L. */
	fabricStatusId: string;
	base: StatusSyncBase;
	/** K. */
	linkKey: string;
	/** R_live — resolved from the live issue's labels. */
	liveResolved: ResolvedTicketStatus;
}): boolean {
	const { p, f } = observedBase(input.base, input.linkKey);
	if (p === null) {
		return false;
	}
	const fabricMoved = input.fabricStatusId !== f;
	const ticketUnchanged = baseTokenOf(input.liveResolved) === p;
	return fabricMoved && ticketUnchanged;
}

/** Maps `resolveMappedStatus` output to a `ResolvedTicketStatus`. */
export function toResolvedTicketStatus(
	r: StatusResolution,
): ResolvedTicketStatus {
	switch (r.kind) {
		case "matched":
			return { kind: "status", statusId: r.statusId };
		case "conflict":
			return {
				kind: "ambiguous",
				statusIds: [...r.statusIds],
				labels: [...r.labels],
			};
		case "none":
			return { kind: "none" };
	}
}

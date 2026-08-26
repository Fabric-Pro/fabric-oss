/**
 * Pure, framework-free helpers for PM-link handling in the duplicate-resolve
 * merge flow. Two responsibilities:
 *
 *  - `classifyMergeLinkScenario` — decide which use case a survivor/duplicate
 *    pair falls into (UC0–UC3) purely from the two `externalId` values, so the
 *    dialog knows whether to fire the merge immediately or open a link step.
 *  - `derivePmLinkState` — derive everything the badge / link step needs to
 *    display (tool name + brand type, ticket reference, stale/error flag) from
 *    fields already loaded for the dialog. No network calls, no React.
 *
 * Kept out of the dialog component so they can be unit-tested in isolation and
 * reused. PM-tool name/brand resolution uses the same `externalUrl`-host
 * convention as `StoryCard` / `PmSyncCloudToggle` (`@repo/utils`), not an
 * MCPServer join.
 */

import { detectPMTypeFromUrl, pmDetectedTypeDisplayName } from "@repo/utils";

/** The PM-link-relevant subset of a flagged-duplicate story (the fields
 * `listPendingDuplicateLinks` now selects). Structural on purpose so these
 * helpers don't depend on the dialog's full `DuplicateLinkStory` type. */
export type PmLinkStory = {
	externalId: string | null;
	externalUrl: string | null;
	externalMcpServerId?: string | null;
	pmAutoSyncEnabled?: boolean;
	lastPmSyncStatus?: string | null;
	lastSyncedAt?: string | Date | null;
};

/** Which use case a survivor/duplicate pair falls into, from the survivor's
 * perspective. Drives whether the merge fires immediately or opens a link step. */
export type MergeLinkScenario = "UC0" | "UC1" | "UC2" | "UC3_SAME" | "UC3_DIFF";

export type PmLinkState = {
	/** True iff the story is linked to an external PM ticket (`externalId` set). */
	linked: boolean;
	externalId: string | null;
	url: string | null;
	/** PM-tool detectedType (e.g. `"gitlab"`) for brand-icon lookup, or null. */
	detectedType: string | null;
	/** Human-readable PM-tool name (e.g. `"GitLab"`), or null when the host is
	 * unrecognized — the UI supplies a generic fallback label. */
	toolName: string | null;
	/** Short ticket reference for display (e.g. `"#1234"` or `"PROJ-12"`), or
	 * null when unlinked. */
	ticketRef: string | null;
	lastSyncedAt: Date | null;
	/** The last PM sync attempt failed (`lastPmSyncStatus === "FAILED"`). */
	error: boolean;
	/** Linked, but the last successful sync is older than the threshold — a soft
	 * "this link may be out of date" hint (DV-4). Never blocks selection. A
	 * linked-but-never-synced story is NOT flagged (it may simply not have been
	 * pushed yet, which is not a failure). */
	stale: boolean;
};

/**
 * Classify a pending duplicate pair by each side's PM-link state, from the
 * perspective of the chosen survivor (the clicked card). Pure over the two
 * `externalId` values:
 *  - UC0: neither linked.
 *  - UC1: survivor unlinked, discarded linked → migrate prompt.
 *  - UC2: survivor linked, discarded unlinked → no prompt.
 *  - UC3_SAME: both linked to the SAME ticket → auto-resolve (behaves like UC2).
 *  - UC3_DIFF: both linked to DIFFERENT tickets → link-selection step.
 */
export function classifyMergeLinkScenario(
	survivor: Pick<PmLinkStory, "externalId">,
	duplicate: Pick<PmLinkStory, "externalId">,
): MergeLinkScenario {
	const s = survivor.externalId ?? null;
	const d = duplicate.externalId ?? null;
	if (s === null && d === null) {
		return "UC0";
	}
	if (s === null && d !== null) {
		return "UC1";
	}
	if (s !== null && d === null) {
		return "UC2";
	}
	// Both linked.
	return s === d ? "UC3_SAME" : "UC3_DIFF";
}

/** A linked story whose last successful sync is older than this is flagged
 * "may be out of date". Generous — this is only a soft visual hint, never a
 * gate, so a conservative threshold avoids false alarms. */
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Derive the display + health state of a story's PM link from already-loaded
 * fields. `now` is injectable for deterministic tests.
 */
export function derivePmLinkState(
	story: PmLinkStory,
	now: number = Date.now(),
): PmLinkState {
	const linked = story.externalId != null;
	const url = story.externalUrl ?? null;
	const detectedType = detectPMTypeFromUrl(url) ?? null;
	const toolName = pmDetectedTypeDisplayName(detectedType) ?? null;
	const lastSyncedAt = story.lastSyncedAt
		? new Date(story.lastSyncedAt)
		: null;
	// PmSyncStatus enum: PENDING | SUCCESS | CONFLICT | FAILED. A failed push is
	// the "broken link" signal surfaced as "Last sync failed" (DV-4).
	const error = story.lastPmSyncStatus === "FAILED";
	const stale =
		linked &&
		lastSyncedAt !== null &&
		now - lastSyncedAt.getTime() > STALE_AFTER_MS;

	return {
		linked,
		externalId: story.externalId ?? null,
		url,
		detectedType,
		toolName,
		ticketRef: linked ? formatTicketRef(story.externalId) : null,
		lastSyncedAt,
		error,
		stale,
	};
}

/**
 * A short, human display reference for a PM ticket. Only the raw `externalId`
 * (the PM work-item id) is stored, so render a purely-numeric id as `#1234` and
 * an alphanumeric key (e.g. Jira `PROJ-12`) verbatim. Display-only.
 */
function formatTicketRef(externalId: string | null): string | null {
	if (!externalId) {
		return null;
	}
	const trimmed = externalId.trim();
	if (trimmed === "") {
		return null;
	}
	return /^\d+$/.test(trimmed) ? `#${trimmed}` : trimmed;
}

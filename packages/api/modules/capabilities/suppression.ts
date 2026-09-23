/**
 * Reading and writing the warnings a person has silenced (Fizzy #1930).
 *
 * The only thing this feature persists. Everything else about a gate is derived
 * on each read, so it cannot drift; this is the one exception, because a
 * deliberate choice is not derivable from anything.
 *
 * Stored as a JSON map on the row that already exists for this user and this
 * project, beside four other per-user JSON columns that evolve the same way.
 * That row is already registered for tenant isolation three separate ways, so
 * nothing here needs a new policy — which is most of the reason the column won
 * over a table of its own.
 */

import { z } from "zod";
import type { StoredSuppression } from "./resolve";

/**
 * What the client may ask for.
 *
 * A fixed vocabulary, by explicit decision — there is no custom date picker in
 * v1. `session` is part of it and is refused by the write path: the client
 * holds a session dismissal in `sessionStorage`, where it dies with the tab, so
 * letting it reach the database would create a row nothing ever cleans up.
 */
export const SNOOZE_DURATIONS = [
	"session",
	"1d",
	"7d",
	"30d",
	"forever",
] as const;
export type SnoozeDuration = (typeof SNOOZE_DURATIONS)[number];

const DURATION_DAYS: Record<
	Exclude<SnoozeDuration, "session" | "forever">,
	number
> = { "1d": 1, "7d": 7, "30d": 30 };

/** The stored shape, validated on read so a hand-edited row cannot crash a page. */
const storedEntrySchema = z.object({
	fingerprint: z.string().min(1),
	expiresAt: z.string().datetime().optional(),
	createdAt: z.string().datetime().optional(),
	duration: z.string().optional(),
});

type StoredEntry = z.infer<typeof storedEntrySchema>;

const storedMapSchema = z.record(z.string(), storedEntrySchema);

/**
 * Parse the column into the list the resolver takes.
 *
 * Tolerant on purpose. This column is per-user convenience state, not a
 * correctness input: if it is malformed, the right outcome is that the person
 * sees their warnings again, not that the project page fails to load. So a
 * parse failure yields an empty list rather than an exception.
 */
export function parseSuppressions(raw: unknown): StoredSuppression[] {
	const parsed = storedMapSchema.safeParse(raw ?? {});
	if (!parsed.success) {
		return [];
	}
	return Object.entries(parsed.data).map(([key, entry]) => ({
		key,
		fingerprint: entry.fingerprint,
		expiresAt: entry.expiresAt,
		createdAt: entry.createdAt,
		duration: entry.duration,
	}));
}

/** Serialize back, dropping anything already expired so the column self-prunes. */
export function serializeSuppressions(
	suppressions: readonly StoredSuppression[],
	now: Date,
): Record<string, StoredEntry> {
	const out: Record<string, StoredEntry> = {};
	for (const s of suppressions) {
		if (s.expiresAt !== undefined && new Date(s.expiresAt) <= now) {
			continue;
		}
		// Absent fields stay absent rather than being written as undefined,
		// so an entry from before they were recorded round-trips unchanged.
		const entry: StoredEntry = { fingerprint: s.fingerprint };
		if (s.expiresAt) {
			entry.expiresAt = s.expiresAt;
		}
		if (s.createdAt) {
			entry.createdAt = s.createdAt;
		}
		if (s.duration) {
			entry.duration = s.duration;
		}
		out[s.key] = entry;
	}
	return out;
}

/**
 * When a suppression of this duration stops applying.
 *
 * `undefined` means never — "do not show again for this project". It still
 * ends when the dependency materially changes, because the fingerprint stops
 * matching; "forever" is about time, not about the world staying the same.
 */
export function expiryFor(
	duration: SnoozeDuration,
	now: Date,
): string | undefined {
	if (duration === "forever") {
		return undefined;
	}
	if (duration === "session") {
		throw new Error(
			"A session dismissal is client-side only and must never be stored.",
		);
	}
	const days = DURATION_DAYS[duration];
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Upsert one suppression into the map, replacing any earlier one for the key. */
export function withSuppression(
	existing: readonly StoredSuppression[],
	entry: StoredSuppression,
): StoredSuppression[] {
	return [...existing.filter((s) => s.key !== entry.key), entry];
}

/**
 * Remove the named suppressions, or — with no list at all — every one on this
 * project.
 *
 * A list, so a restore of several warnings is one read and one write. One call
 * per warning, fired together, each read the same column and wrote back its
 * own copy of it, and the last write won: all but one restore were lost.
 *
 * An empty list removes nothing. Only an absent one means "everything", so a
 * caller that computed an empty scope can never clear the project by accident.
 */
export function withoutSuppressions(
	existing: readonly StoredSuppression[],
	keys?: readonly string[],
): StoredSuppression[] {
	if (keys === undefined) {
		return [];
	}
	const removed = new Set(keys);
	return existing.filter((s) => !removed.has(s.key));
}

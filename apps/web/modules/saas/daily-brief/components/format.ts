/**
 * Shared formatting helpers for the Daily Brief UI.
 *
 * Keep these purely client-safe (no server-only imports) — the Daily Brief
 * card components are client components.
 */

import { formatDistanceToNow } from "date-fns";

/**
 * Format a date as a short relative distance ("2 hours ago", "1 day ago").
 * Falls back to a locale-formatted short date for older items and on any
 * parsing error, so the UI never throws for bad fixture data.
 */
export function formatRelativeOccurredAt(input: Date | string): string {
	try {
		const d = input instanceof Date ? input : new Date(input);
		if (Number.isNaN(d.getTime())) {
			return "—";
		}
		return formatDistanceToNow(d, { addSuffix: true });
	} catch {
		return "—";
	}
}

export function occurredAtMs(input: { occurredAt: Date | string }): number {
	return input.occurredAt instanceof Date
		? input.occurredAt.getTime()
		: new Date(input.occurredAt).getTime();
}

/**
 * Format a cursor date for the deterministic "since last review" summary.
 *
 * Example: "April 21, 2026 at 3:42 PM"
 */
export function formatCursorForSummary(input: Date): string {
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "long",
			timeStyle: "short",
		}).format(input);
	} catch {
		return input.toISOString();
	}
}

/**
 * Title helpers for project documents.
 *
 * BUSINESS_CASE uses the dynamic format `Business Case — {projectName} — {YYYY-MM-DD}`
 * (AC-3), but ONLY when the title is still the default ("" or the bare "Business Case"
 * label) — a title the user deliberately typed is always preserved. The date is rendered
 * in the caller's `timeZone` when provided (so it matches the user's local day), falling
 * back to UTC.
 *
 * Every other type defaults to its catalog label. That label comes from the same
 * shared catalog the create flow's type picker renders from, so what the user sees
 * pre-filled and what gets stored cannot drift — the create dialog and this helper
 * are reading one map, not two copies of it.
 */

import { documentTypeLabel } from "@repo/utils/document-type-catalog";

const BUSINESS_CASE_LABEL = "Business Case";

function isDefaultBusinessCaseTitle(title: string | undefined | null): boolean {
	const t = (title ?? "").trim();
	return t === "" || t === BUSINESS_CASE_LABEL;
}

/**
 * The title the create flow pre-fills for a type before the user edits it.
 *
 * Deliberately the bare label for BUSINESS_CASE too: `buildDocumentTitle` treats
 * that exact string as "still default" and substitutes its dynamic form on the
 * way in, so the client shows a stable name and the server owns the one type
 * whose stored title is computed.
 */
function defaultDocumentTitleForType(type: string): string {
	return documentTypeLabel(type);
}

/** Formats `now` as YYYY-MM-DD in `timeZone` (IANA); falls back to UTC if absent/invalid. */
function formatIsoDate(now: Date, timeZone?: string): string {
	if (timeZone) {
		try {
			// en-CA renders as YYYY-MM-DD
			return new Intl.DateTimeFormat("en-CA", {
				timeZone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(now);
		} catch {
			// invalid timeZone — fall through to UTC
		}
	}
	return now.toISOString().slice(0, 10);
}

export function buildDocumentTitle(
	type: string,
	projectName: string,
	providedTitle: string,
	opts: { now?: Date; timeZone?: string } = {},
): string {
	if (type === "BUSINESS_CASE" && isDefaultBusinessCaseTitle(providedTitle)) {
		const date = formatIsoDate(opts.now ?? new Date(), opts.timeZone);
		return `Business Case — ${projectName} — ${date}`;
	}
	// A blank title from any other type falls back to that type's label rather
	// than storing a nameless document. Reachable from callers that build a
	// document without user input, and from the API directly: the procedure's
	// schema requires a non-empty string, which a single space satisfies.
	if (providedTitle.trim() === "") {
		return defaultDocumentTitleForType(type);
	}
	return providedTitle;
}

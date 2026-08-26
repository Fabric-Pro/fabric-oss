/**
 * Pure helpers for classifying a project context into one of the three
 * download classes (A / B / C) and for de-duplicating filenames inside a
 * single batch ZIP. See spec §8.4 and §8.5 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * Both helpers are intentionally structural / string-only so they can be
 * unit-tested without pulling in Prisma types.
 *
 * Note on spec drift: spec §8.4 references a `NOTE` enum value, but the
 * current `ProjectContextType` schema uses `TEXT`. This helper honours the
 * real schema — `TEXT` (and the planning-surface variants `TECH_STACK`,
 * `FEATURES`, `GOALS`, `DESCRIPTION`) are treated as Class B (synthesized
 * Markdown). Unknown values fall back to Class B per the defensive default.
 */

import type { ContextDownloadClass } from "./context-download-filename";

/**
 * Classify a context by its `type` string. The input is intentionally a
 * structural `{ type: string }` so we can run unit tests without importing
 * Prisma's generated enum.
 */
export function classifyContext(ctx: { type: string }): ContextDownloadClass {
	switch (ctx.type) {
		// Class A — binary / original-file downloads served via signed URL.
		case "FILE":
		case "IMAGE":
		case "DOCUMENT":
		case "SPREADSHEET":
		// An API spec is an uploaded file that happens to be indexed by endpoint.
		// Without this it falls to the defensive `default` and downloads as
		// synthesized Markdown — so uploading `petstore.yaml` and pressing
		// Download would stop returning `petstore.yaml`, purely as a side effect
		// of the type changing at ingestion.
		case "API_SPEC":
			return "A";

		// Class B — synthesized Markdown (pulled text + free-text planning).
		case "TEXT":
		case "TECH_STACK":
		case "FEATURES":
		case "GOALS":
		case "DESCRIPTION":
		case "LINK":
		case "INTEGRATION":
		case "MEETING_TRANSCRIPT":
			return "B";

		// Class C — code-specific synthesized text.
		case "CODE_FILE":
		case "CODE_FILE_SUMMARY":
			return "C";

		default:
			// Defensive default: unknown future types ship as Class B Markdown.
			return "B";
	}
}

/**
 * De-duplicate a filename within a single batch ZIP. Mutates the shared
 * `seen` map as a side-effect on its argument (the helper is pure with
 * respect to the module — state lives on the caller).
 *
 * Collision rules:
 * - First sighting: returned unchanged.
 * - Nth sighting: `{stem}-{n-1}{ext}`, where `stem`/`ext` are split on the
 *   last `.`. If there is no `.`, the suffix is appended bare.
 */
export function dedupeFilename(
	seen: Map<string, number>,
	name: string,
): string {
	const count = seen.get(name) ?? 0;
	seen.set(name, count + 1);
	if (count === 0) {
		return name;
	}
	const dot = name.lastIndexOf(".");
	const stem = dot === -1 ? name : name.slice(0, dot);
	const ext = dot === -1 ? "" : name.slice(dot);
	return `${stem}-${count}${ext}`;
}

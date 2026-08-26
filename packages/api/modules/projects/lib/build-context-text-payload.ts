/**
 * Pure helper that builds the text payload body for a Class B (note/text) or
 * Class C (link / integration / transcript) project context download. See
 * spec §8.2 in `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * The same header is shared by single-file synthesized downloads and batch
 * ZIP text entries so tests can assert on it in one place.
 *
 * Pure — no I/O, no database imports. Accepts a structural input type so it
 * can be driven from both a real Prisma `ProjectContext` row and a lightweight
 * unit-test fixture.
 */

export interface ContextTextPayloadInput {
	id: string;
	title: string;
	type: string;
	integrationProvider?: string | null;
	createdAt: Date;
	content: string;
}

/** Format a Date as ISO 8601 UTC with the `Z` suffix, seconds precision. */
function formatIsoUtc(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the synthesized text payload for a Class B/C context. Returns a
 * string; callers are responsible for encoding it to UTF-8 bytes when needed.
 */
export function buildContextTextPayload(ctx: ContextTextPayloadInput): string {
	const source = ctx.integrationProvider ?? "—";
	const header =
		"Fabric Context Export\n" +
		`Title       : ${ctx.title}\n` +
		`Context ID  : ${ctx.id}\n` +
		`Type        : ${ctx.type}\n` +
		`Source      : ${source}\n` +
		`Captured at : ${formatIsoUtc(ctx.createdAt)}\n`;
	return `${header}\n---\n\n${ctx.content}`;
}

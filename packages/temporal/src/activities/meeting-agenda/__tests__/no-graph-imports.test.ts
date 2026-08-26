import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AC4 — personal meeting transcripts are never a context source.
 *
 * Personal meetings have ZERO database representation (#1899): they are read
 * live from Microsoft Graph and never persisted. So the guarantee is not "we
 * filter them out", it is "the collectors physically cannot reach them" — they
 * read only from Postgres.
 *
 * This test is what keeps that true. A future edit that pulls the Graph client
 * into agenda context assembly fails here, loudly, instead of quietly widening
 * the blast radius of a privacy-sensitive feature.
 */
const AGENDA_DIR = join(__dirname, "..");

const FORBIDDEN = [
	"@repo/integrations/microsoft",
	"executeMicrosoftTeamsTool",
	"calendarView",
	"graph.microsoft.com",
];

describe("meeting-agenda context assembly", () => {
	const sourceFiles = readdirSync(AGENDA_DIR).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
	);

	it("has source files to check", () => {
		expect(sourceFiles.length).toBeGreaterThan(0);
	});

	it.each(FORBIDDEN)("never reaches Microsoft Graph (%s)", (needle) => {
		for (const file of sourceFiles) {
			const source = readFileSync(join(AGENDA_DIR, file), "utf8");
			expect(
				source,
				`${file} must not reference ${needle} — see AC4 in the #1901 design`,
			).not.toContain(needle);
		}
	});
});

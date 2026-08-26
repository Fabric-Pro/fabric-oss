import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEETING_AGENDA_PROMPT_FALLBACK_BODY } from "../src/activities/meeting-agenda/build-agenda-prompt";

/**
 * The prompts seed is insert-only (seed-prompts-only.ts:8-26): once this prompt
 * exists in an environment, editing the in-code fallback changes NOTHING there.
 * So the two bodies can drift apart silently, and a fresh environment would then
 * generate different agendas from a seeded one.
 *
 * Read as text rather than imported: the seed module connects to the database at
 * import time, and importing it here would also point a package dependency the
 * wrong way round (@repo/temporal depends on @repo/database, not the reverse).
 */
const SEED = readFileSync(
	join(__dirname, "..", "..", "database", "prisma", "seed-prompts-only.ts"),
	"utf8",
);

describe("meeting_agenda_generator seed", () => {
	it("declares the prompt with a GENERAL, kind-null binding", () => {
		expect(SEED).toContain("meeting_agenda_generator");
		expect(SEED).toMatch(
			/meeting_agenda_generator:\s*\{[^}]*documentTypes:\s*\["GENERAL"\][^}]*storyKind:\s*null/s,
		);
	});

	it("seeds the body as HANDLEBARS", () => {
		const entry = SEED.slice(
			SEED.indexOf('key: "meeting_agenda_generator"'),
		);
		expect(entry.slice(0, 800)).toContain('format: "HANDLEBARS"');
	});

	it("keeps the seeded body in sync with the in-code fallback", () => {
		// Every non-empty line of the fallback must appear in the seed file.
		for (const line of MEETING_AGENDA_PROMPT_FALLBACK_BODY.split("\n")) {
			if (line.trim().length === 0) {
				continue;
			}
			expect(SEED).toContain(line);
		}
	});
});

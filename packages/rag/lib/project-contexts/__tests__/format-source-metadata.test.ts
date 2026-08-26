/**
 * Prompt-formatting contract for Context Source Type Labeling (Fizzy
 * #1888).
 *
 * FR6 is the load-bearing assertion: a context WITHOUT label/instructions
 * must format byte-identically to the pre-feature output — the header
 * shape `(type, relevance: N%)` and no guidance line. With metadata, the
 * user's type label LEADS the parenthetical (role before system type) and
 * the instructions render as a `> Source guidance:` line between header
 * and content.
 */
import { describe, expect, it } from "vitest";
import { formatContextsForPrompt, type RetrievedContext } from "../retrieval";

function makeContext(
	overrides: Partial<RetrievedContext> = {},
): RetrievedContext {
	return {
		id: "ctx-1",
		type: "LINK",
		content: "The body text.",
		score: 0.871,
		sourceTitle: "Docs home",
		...overrides,
	};
}

describe("formatContextsForPrompt — no metadata (FR6)", () => {
	it("produces the legacy header with no guidance line", () => {
		const out = formatContextsForPrompt([makeContext()]);
		expect(out).toContain(
			"--- Docs home (LINK, relevance: 87.1%) ---\nThe body text.",
		);
		expect(out).not.toContain("Source guidance");
	});
});

describe("formatContextsForPrompt — with metadata (FR5)", () => {
	it("leads the parenthetical with the user label and injects guidance", () => {
		const out = formatContextsForPrompt([
			makeContext({
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth for requirements.",
			}),
		]);
		expect(out).toContain("(Client Chat, LINK, relevance: 87.1%)");
		expect(out).toContain(
			"> Source guidance: Use as source of truth for requirements.",
		);
		// Guidance sits BETWEEN the header and the content it governs.
		const headerIdx = out.indexOf("--- Docs home");
		const guidanceIdx = out.indexOf("> Source guidance:");
		const contentIdx = out.indexOf("The body text.");
		expect(headerIdx).toBeLessThan(guidanceIdx);
		expect(guidanceIdx).toBeLessThan(contentIdx);
	});

	it("renders only the label when instructions are unset", () => {
		const out = formatContextsForPrompt([
			makeContext({ sourceType: "QA Thread" }),
		]);
		expect(out).toContain("(QA Thread, LINK, relevance: 87.1%)");
		expect(out).not.toContain("Source guidance");
	});

	it("renders only the guidance line when the label is unset", () => {
		const out = formatContextsForPrompt([
			makeContext({ aiInstructions: "Weight this highly." }),
		]);
		expect(out).toContain("--- Docs home (LINK, relevance: 87.1%)");
		expect(out).toContain("> Source guidance: Weight this highly.");
	});

	it("keeps unannotated sources in a mixed set byte-identical", () => {
		const out = formatContextsForPrompt([
			makeContext(),
			makeContext({
				id: "ctx-2",
				sourceTitle: "Spec",
				sourceType: "Architect Chat",
			}),
		]);
		expect(out).toContain("--- Docs home (LINK, relevance: 87.1%) ---");
		expect(out).toContain("--- Spec (Architect Chat, LINK,");
	});
});

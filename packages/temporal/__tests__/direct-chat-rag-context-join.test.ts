/**
 * U5 — inline attachment text must survive retrieval (R7, AE4).
 *
 * Loom Direct sends a file's full text alongside the document identifiers it
 * already sends, and the workflow assembles both into the prompt. Before this,
 * the document branch *assigned* the retrieval result over `ragContext` rather
 * than joining onto it, so anything seeded — including the inline entries —
 * was discarded the moment a document was attached. Which is precisely when an
 * attachment exists to seed it: the failure fired in exactly the case the
 * feature was built for, and in no other.
 *
 * The workspace branch, a few lines below, had always concatenated. The two
 * disagreeing is what made the bug easy to miss on review.
 */

import { describe, expect, it } from "vitest";
import { joinRagContextParts } from "../src/workflows/direct-chat";

const INLINE =
	"<fabric_attachment>\n[Uploaded Document: budget.xlsx]\nQ4 rows\n</fabric_attachment>";
const RETRIEVED = "## Retrieved Context\n\nA prior decision.";
const WORKSPACE = "## Workspace\n\nA workspace chunk.";

describe("joinRagContextParts", () => {
	it("keeps the inline entry when retrieval also returns context", () => {
		// AE4. The regression this file exists for.
		const joined = joinRagContextParts([INLINE, RETRIEVED]);

		expect(joined).toContain("[Uploaded Document: budget.xlsx]");
		expect(joined).toContain("A prior decision.");
	});

	it("keeps every source when all three are present", () => {
		const joined = joinRagContextParts([INLINE, RETRIEVED, WORKSPACE]);

		expect(joined).toContain("Q4 rows");
		expect(joined).toContain("A prior decision.");
		expect(joined).toContain("A workspace chunk.");
	});

	it("puts a blank line between sources", () => {
		// The workspace branch used bare `+`, running two contexts together so
		// the model met one section's tail and the next section's heading on
		// the same line.
		expect(joinRagContextParts(["alpha", "beta"])).toBe("alpha\n\nbeta");
	});

	it("preserves order — inline entries lead", () => {
		const joined = joinRagContextParts([INLINE, RETRIEVED]);

		expect(joined.indexOf("Uploaded Document")).toBeLessThan(
			joined.indexOf("Retrieved Context"),
		);
	});

	it("drops empty, undefined, and null parts without leaving separators", () => {
		expect(
			joinRagContextParts([undefined, "alpha", "", null, "beta"]),
		).toBe("alpha\n\nbeta");
	});

	it("returns an empty string when nothing is present", () => {
		expect(joinRagContextParts([])).toBe("");
		expect(joinRagContextParts([undefined, "", null])).toBe("");
	});

	it("is pure — the same input yields the same output on replay", () => {
		// This runs inside workflow code, so it must be deterministic. A helper
		// that read a clock or a random value here would make every history
		// unreplayable.
		const parts = [INLINE, RETRIEVED];

		expect(joinRagContextParts(parts)).toBe(joinRagContextParts(parts));
	});

	it("does not mutate the array it is given", () => {
		const parts = [INLINE, RETRIEVED];
		joinRagContextParts(parts);

		expect(parts).toEqual([INLINE, RETRIEVED]);
	});
});

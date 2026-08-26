import { describe, expect, it, vi } from "vitest";

// sanitizeCitations is pure, but its module imports the AI SDK + model selector
// at load time — stub those so the unit test doesn't pull real providers.
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../dynamic-model-selector", () => ({
	getAIModelWithMetadata: vi.fn(),
}));
vi.mock("../prompt-cache", () => ({ cacheableSystem: vi.fn() }));

import { sanitizeCitations } from "../summarize-project-context";

describe("sanitizeCitations", () => {
	it("keeps allowed markers and reports them as cited", () => {
		const { content, citedMarkers } = sanitizeCitations(
			"Adopted RLS [S1] and Temporal [S2].",
			new Set(["S1", "S2", "S3"]),
		);
		expect(content).toBe("Adopted RLS [S1] and Temporal [S2].");
		expect(citedMarkers.sort()).toEqual(["S1", "S2"]);
	});

	it("strips hallucinated markers not in the allowed set", () => {
		const { content, citedMarkers } = sanitizeCitations(
			"Real [S1] but invented [S99] and [S1234].",
			new Set(["S1"]),
		);
		expect(content).toBe("Real [S1] but invented  and .");
		expect(citedMarkers).toEqual(["S1"]);
	});

	it("splits comma-joined markers and keeps only the allowed ones", () => {
		const { content, citedMarkers } = sanitizeCitations(
			"Grounded in [S1, S9, S2].",
			new Set(["S1", "S2"]),
		);
		expect(content).toBe("Grounded in [S1][S2].");
		expect(citedMarkers.sort()).toEqual(["S1", "S2"]);
	});

	it("removes a bracket entirely when no marker inside is allowed", () => {
		const { content, citedMarkers } = sanitizeCitations(
			"Nothing valid [S8, S9] here.",
			new Set(["S1"]),
		);
		expect(content).toBe("Nothing valid  here.");
		expect(citedMarkers).toEqual([]);
	});

	it("never mangles genuine markdown links or reference-style lists", () => {
		const input = "See [the docs](https://x.example) and [1] footnote.";
		const { content, citedMarkers } = sanitizeCitations(
			input,
			new Set(["S1"]),
		);
		expect(content).toBe(input);
		expect(citedMarkers).toEqual([]);
	});
});

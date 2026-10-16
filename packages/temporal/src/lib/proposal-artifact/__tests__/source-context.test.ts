/**
 * The source material of an Internal Analysis run (Fizzy #2801, #2946): the
 * bounded, numbered source context and its evidence manifest, directly on
 * the pure helpers the analysis activity records a run with.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/lib/proposal-artifact/__tests__/source-context.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	alignRetrievalManifest,
	proposalAnalysisSourceContext,
	proposalSourceManifest,
	SOURCE_CONTEXT_BUDGET_CHARS,
} from "../source-context";
import {
	type ProposalRetrievalSource,
	proposalSourceFingerprint,
} from "../types";

const HEADER_LENGTH = "### Source 1\n".length;

function described(
	text: string,
	overrides: Partial<ProposalRetrievalSource> = {},
): ProposalRetrievalSource {
	return {
		kind: "projectContext",
		id: "context-1",
		contextType: "MEETING_NOTES",
		title: "Kickoff notes",
		sourceName: null,
		fingerprint: proposalSourceFingerprint(text),
		...overrides,
	};
}

describe("proposalAnalysisSourceContext", () => {
	it("numbers each context by its position, skipping empty ones", () => {
		const { text, emitted } = proposalAnalysisSourceContext([
			"  First source.  ",
			"   ",
			"Third source.",
		]);

		expect(text).toBe(
			"### Source 1\nFirst source.\n\n### Source 3\nThird source.",
		);
		expect(emitted).toEqual([{ index: 0 }, { index: 2 }]);
	});

	it("drops the heading marks of a source line that reads as a source block", () => {
		const { text } = proposalAnalysisSourceContext([
			"Notes\n## Source 7 says otherwise\n  ### source 2\n#### Sources list",
		]);

		expect(text).toBe(
			"### Source 1\nNotes\n Source 7 says otherwise\n   source 2\n#### Sources list",
		);
		expect(text.match(/^#{1,6}[ \t]+source[ \t]+\d+/gim)).toEqual([
			"### Source 1",
		]);
	});

	it("is empty for no contexts", () => {
		expect(proposalAnalysisSourceContext([])).toEqual({
			text: "",
			emitted: [],
		});
	});

	it("cuts the source that passes the budget and stops there", () => {
		const { text, emitted } = proposalAnalysisSourceContext([
			"a".repeat(50_000),
			"b".repeat(50_000),
			"c",
		]);

		expect(text).toHaveLength(SOURCE_CONTEXT_BUDGET_CHARS);
		expect(text.endsWith("b")).toBe(true);
		expect(emitted).toEqual([{ index: 0 }, { index: 1 }]);
	});

	it("does not emit a source when only part of its header fits", () => {
		const first = "a".repeat(
			SOURCE_CONTEXT_BUDGET_CHARS - HEADER_LENGTH - 2 - 10,
		);

		const { text, emitted } = proposalAnalysisSourceContext([first, "b"]);

		expect(emitted).toEqual([{ index: 0 }]);
		expect(text).toBe(`### Source 1\n${first}`);
	});

	it("never cuts between the halves of a surrogate pair", () => {
		const body = `${"x".repeat(SOURCE_CONTEXT_BUDGET_CHARS - HEADER_LENGTH - 1)}😀tail`;

		const { text, emitted } = proposalAnalysisSourceContext([body]);

		expect(emitted).toEqual([{ index: 0 }]);
		expect(text).toHaveLength(SOURCE_CONTEXT_BUDGET_CHARS - 1);
		expect(text.endsWith("x")).toBe(true);
	});
});

describe("alignRetrievalManifest", () => {
	it("aligns retrieval's manifest to the tail of the contexts", () => {
		const contexts = [
			"Supplied context.",
			"Retrieved one.",
			"Retrieved two.",
		];
		const one = described("Retrieved one.", { id: "one" });
		const two = described("Retrieved two.", { id: "two" });

		const aligned = alignRetrievalManifest(contexts, [one, two]);

		expect([...aligned.entries()]).toEqual([
			[1, one],
			[2, two],
		]);
	});

	it("drops an entry whose fingerprint does not match its string", () => {
		const contexts = ["Retrieved one.", "Retrieved two."];

		const aligned = alignRetrievalManifest(contexts, [
			described("Something else."),
			described("Retrieved two."),
		]);

		expect([...aligned.keys()]).toEqual([1]);
	});

	it("aligns nothing for no manifest or one longer than the contexts", () => {
		expect(alignRetrievalManifest(["One."], undefined).size).toBe(0);
		expect(
			alignRetrievalManifest(
				["One."],
				[described("One."), described("One.")],
			).size,
		).toBe(0);
	});
});

describe("proposalSourceManifest", () => {
	it("describes each emitted source, and only those, by its source number", () => {
		const contexts = [
			"Supplied context.",
			"",
			"  Retrieved notes.  ",
			"Retrieved company source.",
		];
		const { emitted } = proposalAnalysisSourceContext(contexts);

		const manifest = proposalSourceManifest(contexts, emitted, [
			described("  Retrieved notes.  ", { id: "context-7" }),
			described("Retrieved company source.", {
				kind: "company",
				id: "source-3",
				contextType: null,
				title: null,
				sourceName: "Example wiki",
			}),
		]);

		expect(manifest).toEqual([
			{
				source: 1,
				kind: "other",
				id: null,
				contextType: null,
				title: null,
				sourceName: null,
				fingerprint: proposalSourceFingerprint("Supplied context."),
			},
			{
				source: 3,
				kind: "projectContext",
				id: "context-7",
				contextType: "MEETING_NOTES",
				title: "Kickoff notes",
				sourceName: null,
				// Of the string as it sits in the contexts, untrimmed.
				fingerprint: proposalSourceFingerprint("  Retrieved notes.  "),
			},
			{
				source: 4,
				kind: "company",
				id: "source-3",
				contextType: null,
				title: null,
				sourceName: "Example wiki",
				fingerprint: proposalSourceFingerprint(
					"Retrieved company source.",
				),
			},
		]);
	});

	it("describes every source as other without a retrieval manifest", () => {
		const contexts = ["One.", "Two."];
		const { emitted } = proposalAnalysisSourceContext(contexts);

		expect(
			proposalSourceManifest(contexts, emitted, undefined).map(
				(entry) => [entry.source, entry.kind, entry.id],
			),
		).toEqual([
			[1, "other", null],
			[2, "other", null],
		]);
	});
});

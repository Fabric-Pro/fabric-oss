import { describe, expect, it } from "vitest";
import {
	dedupeDraftedCases,
	draftDedupeKeys,
	normaliseCaseTitle,
} from "../dedupe-drafted-cases";

/**
 * The rule has to be tight enough to catch a re-draft and loose enough never to
 * discard a genuinely new case. Losing coverage is much worse than leaving a
 * near-duplicate for a human to merge, so the "does NOT match" cases matter more
 * than the "does match" ones.
 */
describe("normaliseCaseTitle", () => {
	it("collapses the cosmetic differences between two drafting runs", () => {
		expect(
			normaliseCaseTitle("Verify the user can reset their password."),
		).toBe(normaliseCaseTitle("verify user can reset their password"));
	});

	it("strips the filler verbs QA titles open with", () => {
		const canonical = normaliseCaseTitle("User can log out");
		for (const prefix of [
			"Verify that ",
			"Check ",
			"Ensure ",
			"Validate that ",
			"Confirm ",
			"Test ",
		]) {
			expect(normaliseCaseTitle(`${prefix}user can log out`)).toBe(
				canonical,
			);
		}
	});

	it("keeps genuinely different cases apart", () => {
		expect(normaliseCaseTitle("Rejects an expired token")).not.toBe(
			normaliseCaseTitle("Rejects a malformed token"),
		);
	});
});

describe("draftDedupeKeys", () => {
	it("scopes by acceptance criterion, so one title can serve two criteria", () => {
		// "Rejects an invalid input" is a reasonable title under two different
		// criteria, and those are two different cases. A title-only key would drop
		// the second and quietly lose coverage.
		expect(
			draftDedupeKeys({
				title: "Rejects an invalid input",
				acceptanceCriterionRefs: ["AC 1"],
			}),
		).not.toEqual(
			draftDedupeKeys({
				title: "Rejects an invalid input",
				acceptanceCriterionRefs: ["AC 2"],
			}),
		);
	});

	it("treats a missing criterion as its own shared bucket", () => {
		expect(draftDedupeKeys({ title: "x" })).toEqual(
			draftDedupeKeys({ title: "x", acceptanceCriterionRefs: [] }),
		);
	});

	it("emits one key per criterion a case covers", () => {
		// A stored link can cover several criteria; a re-draft naming any of them
		// must find it. One key per ref is what makes that possible without a
		// fuzzy match.
		expect(
			draftDedupeKeys({
				title: "Rejects an invalid input",
				acceptanceCriterionRefs: ["AC 1", "ac 3"],
			}),
		).toHaveLength(2);
	});

	it("collapses ref spellings the resolver treats as one criterion", () => {
		// The resolver reads the FIRST integer ("AC 3", "3", "criterion 3" all
		// resolve to criterion 3), and the prompt invites free-text refs like
		// "AC 3 (retry policy)". Keying raw strings meant every novel spelling
		// of the same criterion re-created the case on the next draft —
		// observed live as the same case stored twice under "AC 20 (Upload
		// retry policy)" and "AC (Upload retry policy)". Keys must follow the
		// resolver, not the spelling.
		expect(
			draftDedupeKeys({
				title: "Upload failure surfaces a warning",
				acceptanceCriterionRefs: ["AC 20 (Upload retry policy)"],
			}),
		).toEqual(
			draftDedupeKeys({
				title: "Upload failure surfaces a warning",
				acceptanceCriterionRefs: ["AC-20"],
			}),
		);
		expect(
			draftDedupeKeys({
				title: "Upload failure surfaces a warning",
				acceptanceCriterionRefs: ["1"],
			}),
		).toEqual(
			draftDedupeKeys({
				title: "Upload failure surfaces a warning",
				acceptanceCriterionRefs: ["AC 1"],
			}),
		);
		// Zero-padded spellings resolve to the same criterion index.
		expect(
			draftDedupeKeys({
				title: "Upload failure surfaces a warning",
				acceptanceCriterionRefs: ["AC 03"],
			}),
		).toEqual(
			draftDedupeKeys({
				title: "Upload failure surfaces a warning",
				acceptanceCriterionRefs: ["AC 3"],
			}),
		);
	});

	it("sends refs the resolver cannot place to the shared no-ref bucket", () => {
		// criterionIndexFromRef returns null for a ref with no number, mapping
		// it exactly where no ref at all lands. Dedupe follows: such a case
		// cannot be told apart from an unnamed one, so it shares the bucket.
		expect(
			draftDedupeKeys({
				title: "Tenant isolation holds",
				acceptanceCriterionRefs: ["Tenant isolation"],
			}),
		).toEqual(draftDedupeKeys({ title: "Tenant isolation holds" }));
		expect(
			draftDedupeKeys({
				title: "Tenant isolation holds",
				acceptanceCriterionRefs: ["AC 0"],
			}),
		).toEqual(draftDedupeKeys({ title: "Tenant isolation holds" }));
	});
});

describe("dedupeDraftedCases", () => {
	it("skips a case the feature already has", () => {
		// The whole point: re-running the drafter after a feature changes used to
		// append a second copy of everything.
		const result = dedupeDraftedCases(
			[
				{
					title: "Verify user can log in",
					acceptanceCriterionRefs: ["AC 1"],
				},
				{
					title: "User can log out",
					acceptanceCriterionRefs: ["AC 2"],
				},
			],
			[{ title: "user can log in", acceptanceCriterionRefs: ["AC 1"] }],
		);

		expect(result.toCreate.map((c) => c.title)).toEqual([
			"User can log out",
		]);
		// Reported, never silently dropped — "we generated 2 and created 1" is
		// information the person who pressed the button needs.
		expect(result.skippedTitles).toEqual(["Verify user can log in"]);
	});

	it("matches a candidate naming the second criterion of a multi-criterion link", () => {
		// The regression this guards: mapping the existing side to refs[0] would
		// stop matching here and quietly produce a near-duplicate on every
		// re-draft. The link covers AC 2 and AC 5; only AC 5 was re-drafted.
		const result = dedupeDraftedCases(
			[
				{
					title: "Verify user can log in",
					acceptanceCriterionRefs: ["AC 5"],
				},
			],
			[
				{
					title: "user can log in",
					acceptanceCriterionRefs: ["AC 2", "AC 5"],
				},
			],
		);

		expect(result.toCreate).toHaveLength(0);
		expect(result.skippedTitles).toEqual(["Verify user can log in"]);
	});

	it("does not match across different criteria", () => {
		// Same title under a different criterion is a DIFFERENT case — dropping it
		// would lose coverage.
		const result = dedupeDraftedCases(
			[
				{
					title: "Rejects an invalid input",
					acceptanceCriterionRefs: ["AC 9"],
				},
			],
			[
				{
					title: "rejects an invalid input",
					acceptanceCriterionRefs: ["AC 1"],
				},
			],
		);

		expect(result.toCreate).toHaveLength(1);
		expect(result.skippedTitles).toEqual([]);
	});

	it("skips the re-draft of a case stored under a differently-spelled ref", () => {
		// The live failure this whole canonicalisation exists for: run one
		// stored the case as "AC 20 (Upload retry policy)", the next run
		// emitted the same check as "AC-20". Spelling-level keys created a
		// second copy; resolver-level keys must skip it.
		const result = dedupeDraftedCases(
			[
				{
					title: "Verify user can log in",
					acceptanceCriterionRefs: ["AC-20"],
				},
			],
			[
				{
					title: "user can log in",
					acceptanceCriterionRefs: ["AC 20 (retry policy)"],
				},
			],
		);

		expect(result.toCreate).toHaveLength(0);
		expect(result.skippedTitles).toEqual(["Verify user can log in"]);
	});

	it("deduplicates within a single run", () => {
		// A model asked twice about one criterion can emit the same case twice in
		// one response; creating both would be this bug in miniature.
		const result = dedupeDraftedCases(
			[
				{
					title: "Rejects an expired token",
					acceptanceCriterionRefs: ["AC 1"],
				},
				{
					title: "rejects expired token",
					acceptanceCriterionRefs: ["AC 1"],
				},
			],
			[],
		);

		expect(result.toCreate).toHaveLength(1);
		expect(result.skippedTitles).toHaveLength(1);
	});

	it("creates everything when the feature has no cases yet", () => {
		const drafted = [
			{ title: "A", acceptanceCriterionRefs: ["AC 1"] },
			{ title: "B", acceptanceCriterionRefs: ["AC 2"] },
		];

		const result = dedupeDraftedCases(drafted, []);

		expect(result.toCreate).toEqual(drafted);
		expect(result.skippedTitles).toEqual([]);
	});

	it("does not discard a new case that merely resembles an existing one", () => {
		// The failure mode that would matter: an over-eager rule silently losing
		// coverage. Similar wording, different assertion — both must survive.
		const result = dedupeDraftedCases(
			[
				{
					title: "Rejects a malformed token",
					acceptanceCriterionRefs: ["AC 1"],
				},
			],
			[
				{
					title: "Rejects an expired token",
					acceptanceCriterionRefs: ["AC 1"],
				},
			],
		);

		expect(result.toCreate).toHaveLength(1);
		expect(result.skippedTitles).toEqual([]);
	});

	it("can skip an entire re-draft without error", () => {
		const cases = [
			{ title: "A", acceptanceCriterionRefs: ["AC 1"] },
			{ title: "B", acceptanceCriterionRefs: ["AC 2"] },
		];

		const result = dedupeDraftedCases(cases, cases);

		expect(result.toCreate).toEqual([]);
		expect(result.skippedTitles).toEqual(["A", "B"]);
	});
});

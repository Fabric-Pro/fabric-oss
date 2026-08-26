import { describe, expect, it } from "vitest";
import {
	combineCleanSpec,
	recoveredAcceptanceCriteria,
	separateEmbeddedAcceptanceCriteria,
	splitCleanSpec,
} from "../clean-spec-content";

/** What TipTap stores when the PO highlights the heading with the toolbar. */
const HIGHLIGHTED_AC_HEADING =
	'## <mark data-color="#fef08a">Acceptance Criteria</mark>';

interface ParityFixture {
	name: string;
	markdown: string;
	expected: { description: string; acceptanceCriteria: string };
}

/**
 * SHARED PARITY FIXTURES — keep byte-identical with the copy in
 * `apps/web/modules/saas/projects/lib/__tests__/story-content.test.ts`.
 *
 * `splitCleanSpec` (Decision→Spec patch path) and `parseStoryContent` (editor)
 * state a byte-compatibility contract and have already drifted once. The two
 * packages cannot import each other's splitter, so the contract is pinned by
 * running the SAME table of documents against each splitter and asserting the
 * SAME expected split: any divergence turns one of the two suites red.
 *
 * The two-AC-heading fixtures are the load-bearing ones — that is the corrupted
 * document shape this bug produced, and it is where the loops used to disagree.
 */
const PARITY_FIXTURES: ParityFixture[] = [
	{
		name: "plain heading",
		markdown: [
			"Desc body",
			"",
			"## Acceptance Criteria",
			"",
			"- AC 1",
		].join("\n"),
		expected: { description: "Desc body", acceptanceCriteria: "- AC 1" },
	},
	{
		name: "highlighted heading (TipTap mark)",
		markdown: ["Desc body", "", HIGHLIGHTED_AC_HEADING, "", "- AC 1"].join(
			"\n",
		),
		expected: { description: "Desc body", acceptanceCriteria: "- AC 1" },
	},
	{
		name: "bolded heading",
		markdown: [
			"Desc body",
			"",
			"## **Acceptance Criteria**",
			"",
			"- AC 1",
		].join("\n"),
		expected: { description: "Desc body", acceptanceCriteria: "- AC 1" },
	},
	{
		name: "demoted AND highlighted heading",
		markdown: [
			"Desc body",
			"",
			"### <mark>Acceptance Criteria</mark>",
			"",
			"- AC 1",
		].join("\n"),
		expected: { description: "Desc body", acceptanceCriteria: "- AC 1" },
	},
	{
		name: "two AC headings, decorated first — every heading dropped",
		markdown: [
			"Desc body",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"- AC 1",
			"",
			"## Acceptance Criteria",
			"",
			"- AC 2",
		].join("\n"),
		expected: {
			description: "Desc body",
			acceptanceCriteria: ["- AC 1", "", "", "- AC 2"].join("\n"),
		},
	},
	{
		name: "two AC headings, plain first — every heading dropped",
		markdown: [
			"Desc body",
			"",
			"## Acceptance Criteria",
			"",
			"- AC 1",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"- AC 2",
		].join("\n"),
		expected: {
			description: "Desc body",
			acceptanceCriteria: ["- AC 1", "", "", "- AC 2"].join("\n"),
		},
	},
	{
		name: "backticked heading in the body is not a boundary (forgery guard)",
		markdown: [
			"Desc body",
			"",
			"`## Acceptance Criteria`",
			"",
			"More description prose.",
			"",
			"## Acceptance Criteria",
			"",
			"- AC 1",
		].join("\n"),
		expected: {
			description: [
				"Desc body",
				"",
				"`## Acceptance Criteria`",
				"",
				"More description prose.",
			].join("\n"),
			acceptanceCriteria: "- AC 1",
		},
	},
	{
		name: "a heading merely mentioning acceptance mid-sentence is not a boundary",
		markdown: [
			"Desc body",
			"",
			"## Notes on acceptance testing",
			"",
			"prose",
		].join("\n"),
		expected: {
			description: [
				"Desc body",
				"",
				"## Notes on acceptance testing",
				"",
				"prose",
			].join("\n"),
			acceptanceCriteria: "",
		},
	},
	{
		name: "decorated bodies are stored verbatim (normalization is match-only)",
		markdown: [
			'## <mark data-color="#fef08a">Overview</mark>',
			"",
			"Body with **bold**, `code` and 5 * 3 rules.",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			'- <mark data-color="#fef08a">AC 1</mark>',
			"- **AC 2**",
		].join("\n"),
		expected: {
			description: [
				'## <mark data-color="#fef08a">Overview</mark>',
				"",
				"Body with **bold**, `code` and 5 * 3 rules.",
			].join("\n"),
			acceptanceCriteria: [
				'- <mark data-color="#fef08a">AC 1</mark>',
				"- **AC 2**",
			].join("\n"),
		},
	},
	{
		name: "no AC heading at all",
		markdown: "## Description\n\nJust a description.",
		expected: {
			description: "## Description\n\nJust a description.",
			acceptanceCriteria: "",
		},
	},
];

describe("clean-spec-content combine/split", () => {
	it("combines description + AC under an Acceptance Criteria heading", () => {
		expect(combineCleanSpec("Intro.", "- AC#1")).toBe(
			"Intro.\n\n## Acceptance Criteria\n\n- AC#1",
		);
	});

	it("omits the AC heading when there is no acceptance criteria", () => {
		expect(combineCleanSpec("Just a description.", "")).toBe(
			"Just a description.",
		);
		expect(combineCleanSpec("Just a description.", null)).toBe(
			"Just a description.",
		);
	});

	it("emits AC-only when description is empty", () => {
		expect(combineCleanSpec("", "- AC#1")).toBe(
			"## Acceptance Criteria\n\n- AC#1",
		);
	});

	it("round-trips description + AC byte-for-byte", () => {
		const description =
			"# Title\n\nSome intro prose with a list:\n- a\n- b";
		const acceptanceCriteria = "- AC#1: one\n- AC#2: two";
		const split = splitCleanSpec(
			combineCleanSpec(description, acceptanceCriteria),
		);
		expect(split.description).toBe(description);
		expect(split.acceptanceCriteria).toBe(acceptanceCriteria);
	});

	it("keeps a `## Description` heading inside the description (not a split point)", () => {
		const doc =
			"## Description\n\nbody\n\n## Acceptance Criteria\n\n- AC#1";
		const split = splitCleanSpec(doc);
		expect(split.description).toBe("## Description\n\nbody");
		expect(split.acceptanceCriteria).toBe("- AC#1");
	});

	it("splits on a single-hash Acceptance heading too", () => {
		const split = splitCleanSpec("desc\n\n# Acceptance Criteria\n\n- AC#1");
		expect(split.description).toBe("desc");
		expect(split.acceptanceCriteria).toBe("- AC#1");
	});

	it("splits on a DEMOTED heading, so a patch can't empty the criteria column", () => {
		// The editor's parseStoryContent matches any level; this split had
		// stayed at `#{1,2}`. A patch that demotes `## Acceptance Criteria` to
		// `###` therefore folded every criterion back into `description` and
		// persisted an empty `acceptanceCriteria` — which silently empties the
		// QA tab's matrix and makes drafting refuse for that feature.
		for (const heading of [
			"### Acceptance Criteria",
			"#### Acceptance Criteria",
			"###### acceptance criteria",
		]) {
			const split = splitCleanSpec(`desc\n\n${heading}\n\n- AC#1`);
			expect(split.description).toBe("desc");
			expect(split.acceptanceCriteria).toBe("- AC#1");
		}
	});
});

describe("splitCleanSpec with an inline-decorated heading", () => {
	// Highlighting the heading in the editor stores
	// `## <mark data-color="…">Acceptance Criteria</mark>`. It still renders as
	// the heading, so a patch produced against that document must split here the
	// same way the editor splits it — otherwise the criteria fold back into
	// `description` and the column is persisted empty.
	const undecorated = splitCleanSpec(
		"desc\n\n## Acceptance Criteria\n\n- AC#1",
	);

	it("splits a highlighted heading exactly like the undecorated one", () => {
		expect(
			splitCleanSpec(`desc\n\n${HIGHLIGHTED_AC_HEADING}\n\n- AC#1`),
		).toEqual(undecorated);
	});

	it("splits bolded, demoted and nested-tag decorations identically", () => {
		for (const heading of [
			"## **Acceptance Criteria**",
			"## *Acceptance Criteria*",
			"### <mark>Acceptance Criteria</mark>",
			'###### <mark data-color="#fef08a"><strong>acceptance criteria</strong></mark>',
		]) {
			expect(splitCleanSpec(`desc\n\n${heading}\n\n- AC#1`)).toEqual(
				undecorated,
			);
		}
	});

	it("does NOT treat a backticked body line as the boundary (forgery guard)", () => {
		// `stripInlineDecoration` deletes backticks, so an inline-code body line
		// normalizes into heading shape. The helper's forgery guard keeps it out
		// of the boundary test — a crafted body line must not move a section
		// boundary on the patch path.
		const doc = "desc\n\n`## Acceptance Criteria`\n\nstill desc";
		expect(splitCleanSpec(doc)).toEqual({
			description: "desc\n\n`## Acceptance Criteria`\n\nstill desc",
			acceptanceCriteria: "",
		});
	});

	it("does NOT treat a heading that merely mentions acceptance as the boundary", () => {
		const doc = "desc\n\n## Notes on acceptance testing\n\nprose";
		expect(splitCleanSpec(doc).acceptanceCriteria).toBe("");
	});

	it("keeps the ORIGINAL decorated lines in both columns (normalized value is never stored)", () => {
		const description = [
			'## <mark data-color="#fef08a">Overview</mark>',
			"",
			"Body with **bold**, `code` and 5 * 3 rules.",
		].join("\n");
		const acceptanceCriteria = '- <mark data-color="#fef08a">AC#1</mark>';
		const split = splitCleanSpec(
			combineCleanSpec(description, acceptanceCriteria),
		);
		expect(split.description).toBe(description);
		expect(split.acceptanceCriteria).toBe(acceptanceCriteria);
	});

	it("drops EVERY acceptance heading when a document carries two", () => {
		// The corrupted shape this bug produced — a decorated heading that never
		// matched, so the section was re-appended under a fresh plain heading.
		// The editor's parseStoryContent behaves identically.
		//
		// Keeping the second heading as literal body text would leave a heading
		// inside `acceptanceCriteria`, and `parseAcceptanceCriteria` stops at the
		// first heading it meets — so the QA traceability matrix would report
		// only AC#1. Dropping them all also lets `combineCleanSpec` collapse the
		// fork back to a single section.
		const doc = [
			"desc",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"- AC#1",
			"",
			"## Acceptance Criteria",
			"",
			"- AC#2",
		].join("\n");
		const parts = splitCleanSpec(doc);
		expect(parts).toEqual({
			description: "desc",
			acceptanceCriteria: ["- AC#1", "", "", "- AC#2"].join("\n"),
		});
		expect(
			(
				combineCleanSpec(
					parts.description,
					parts.acceptanceCriteria,
				).match(/## Acceptance Criteria/g) ?? []
			).length,
		).toBe(1);
	});
});

describe("parity fixtures: splitCleanSpec === parseStoryContent", () => {
	// The same table runs against `parseStoryContent` in
	// `apps/web/modules/saas/projects/lib/__tests__/story-content.test.ts`.
	for (const fixture of PARITY_FIXTURES) {
		it(`splits "${fixture.name}" as the editor does`, () => {
			expect(splitCleanSpec(fixture.markdown)).toEqual(fixture.expected);
		});
	}
});

/**
 * The drafting schemas ask a model for `description` and `acceptanceCriteria`
 * separately. Nothing checked that it complied, so a feature whose criteria the
 * model folded into the description under the template's own heading persisted
 * with an empty criteria column — the spec looked complete in the editor while
 * test-case drafting refused, the traceability matrix was empty, and a PM push
 * carried no criteria. It stayed that way until someone opened the editor and
 * saved, because that save was the only thing that ever ran the split.
 */
describe("separateEmbeddedAcceptanceCriteria", () => {
	it("recovers criteria the model buried in the description", () => {
		const drafted = separateEmbeddedAcceptanceCriteria({
			description:
				"## Overview\n\nLet users mute a project.\n\n## Acceptance Criteria\n\n- GIVEN a muted project WHEN a mention arrives THEN no notification is sent",
			acceptanceCriteria: undefined,
		});

		expect(drafted.description).toBe(
			"## Overview\n\nLet users mute a project.",
		);
		expect(drafted.acceptanceCriteria).toBe(
			"- GIVEN a muted project WHEN a mention arrives THEN no notification is sent",
		);
	});

	it("recovers them from a DEMOTED heading too", () => {
		// Demoting the heading is a common model edit, and it is the exact shape
		// that caused the earlier incident this module documents.
		const drafted = separateEmbeddedAcceptanceCriteria({
			description: "Body.\n\n### Acceptance Criteria\n\n- AC 1",
			acceptanceCriteria: "",
		});

		expect(drafted.acceptanceCriteria).toBe("- AC 1");
	});

	it("never second-guesses a model that complied", () => {
		// A description may legitimately discuss criteria while the field is
		// correctly populated. Re-deriving here would DISCARD the value the
		// generator was explicitly asked for.
		const drafted = separateEmbeddedAcceptanceCriteria({
			description: "Body.\n\n## Acceptance Criteria\n\n- stale copy",
			acceptanceCriteria: "- the real one",
		});

		expect(drafted.acceptanceCriteria).toBe("- the real one");
		expect(drafted.description).toBe(
			"Body.\n\n## Acceptance Criteria\n\n- stale copy",
		);
	});

	it("leaves a description with no acceptance section alone", () => {
		const input = {
			description: "Just a narrative.",
			acceptanceCriteria: undefined,
		};

		expect(separateEmbeddedAcceptanceCriteria(input)).toEqual(input);
	});

	it("carries the caller's other fields through untouched", () => {
		// Callers pass their whole drafted object (needsMoreInfo, changeSummary
		// …); dropping those would silently lose a bug's triage flag.
		const drafted = separateEmbeddedAcceptanceCriteria({
			description: "Body.\n\n## Acceptance Criteria\n\n- AC 1",
			acceptanceCriteria: undefined,
			needsMoreInfo: true,
			changeSummary: ["one"],
		});

		expect(drafted.needsMoreInfo).toBe(true);
		expect(drafted.changeSummary).toEqual(["one"]);
	});
});

/**
 * The recovery above is a no-op whenever the model fills both fields correctly,
 * so from outside "never needed" and "silently not working" look identical.
 * That is not a hypothetical distinction: the usage interceptor had the same
 * shape of blind spot and it cost a full ship-and-measure round to find, because
 * nothing recorded which of the two was happening.
 */
describe("recoveredAcceptanceCriteria", () => {
	it("reports a recovery when the field went from empty to populated", () => {
		expect(
			recoveredAcceptanceCriteria(
				{ acceptanceCriteria: undefined },
				{ acceptanceCriteria: "- AC 1" },
			),
		).toBe(true);
	});

	it("treats whitespace-only as empty, matching the recovery's own guard", () => {
		expect(
			recoveredAcceptanceCriteria(
				{ acceptanceCriteria: "   \n" },
				{ acceptanceCriteria: "- AC 1" },
			),
		).toBe(true);
	});

	it("reports nothing when the model already complied", () => {
		expect(
			recoveredAcceptanceCriteria(
				{ acceptanceCriteria: "- the real one" },
				{ acceptanceCriteria: "- the real one" },
			),
		).toBe(false);
	});

	it("reports nothing when there was no acceptance section to recover", () => {
		expect(
			recoveredAcceptanceCriteria(
				{ acceptanceCriteria: undefined },
				{ acceptanceCriteria: undefined },
			),
		).toBe(false);
	});

	it("agrees with what the recovery actually did, on both outcomes", () => {
		// Guards the guard: asserting the predicate against the real function
		// rather than against hand-written pairs, so the two cannot drift.
		const folded = {
			description: "Body.\n\n## Acceptance Criteria\n\n- AC 1",
			acceptanceCriteria: undefined,
		};
		expect(
			recoveredAcceptanceCriteria(
				folded,
				separateEmbeddedAcceptanceCriteria(folded),
			),
		).toBe(true);

		const compliant = {
			description: "Body.",
			acceptanceCriteria: "- AC 1",
		};
		expect(
			recoveredAcceptanceCriteria(
				compliant,
				separateEmbeddedAcceptanceCriteria(compliant),
			),
		).toBe(false);
	});
});

/**
 * Tests for parseStoryContent / formatStoryContent.
 *
 * Pins the round-trip behavior between the editor's single markdown document
 * and the database's two columns (description + acceptanceCriteria). The key
 * invariant: stage-enhance content with a preamble (`# Passive Analysis: ...`)
 * must round-trip without losing the preamble (issue #737 follow-up).
 */

import { parseAcceptanceCriteria } from "@repo/utils/acceptance-criteria";
import { describe, expect, it } from "vitest";
import {
	formatStoryContent,
	hasAcceptanceCriteriaHeading,
	parseStoryContent,
	resolveStoryContentForSave,
} from "../story-content";

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
 * `packages/api/modules/projects/lib/__tests__/clean-spec-content.test.ts`.
 *
 * `parseStoryContent` (editor) and `splitCleanSpec` (Decision→Spec patch path)
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

describe("parseStoryContent", () => {
	it("treats whole input as description when no AC heading present", () => {
		const input = "Plain description with no headings.";
		expect(parseStoryContent(input)).toEqual({
			description: "Plain description with no headings.",
			acceptanceCriteria: "",
		});
	});

	it("splits at ## Acceptance Criteria heading", () => {
		const input = [
			"User can log in with email and password.",
			"",
			"## Acceptance Criteria",
			"",
			"- Given a registered user",
			"- When they enter valid credentials",
			"- Then they are redirected to the dashboard",
		].join("\n");
		const result = parseStoryContent(input);
		expect(result.description).toBe(
			"User can log in with email and password.",
		);
		expect(result.acceptanceCriteria).toBe(
			[
				"- Given a registered user",
				"- When they enter valid credentials",
				"- Then they are redirected to the dashboard",
			].join("\n"),
		);
	});

	it("splits at # Acceptance Criteria (h1) variant", () => {
		const input = [
			"Description text",
			"# Acceptance Criteria",
			"AC text",
		].join("\n");
		expect(parseStoryContent(input)).toEqual({
			description: "Description text",
			acceptanceCriteria: "AC text",
		});
	});

	it("matches AC heading case-insensitively", () => {
		const input = ["Description", "## acceptance criteria", "AC body"].join(
			"\n",
		);
		expect(parseStoryContent(input)).toEqual({
			description: "Description",
			acceptanceCriteria: "AC body",
		});
	});

	it("preserves a leading ## Description heading inside the description field", () => {
		// The previous implementation stripped this heading by treating it
		// as a section marker; the new implementation keeps it as content.
		const input = [
			"## Description",
			"",
			"User-facing description text.",
			"",
			"## Acceptance Criteria",
			"",
			"AC body",
		].join("\n");
		const result = parseStoryContent(input);
		expect(result.description).toBe(
			"## Description\n\nUser-facing description text.",
		);
		expect(result.acceptanceCriteria).toBe("AC body");
	});

	it("preserves stage-enhance preamble (issue #737)", () => {
		// LLM emits a stage-titled `# Passive Analysis` preamble plus a
		// nested `## Description` subsection. All of it must end up in the
		// description field — only the `## Acceptance Criteria` content
		// goes to the AC field.
		const input = [
			"# Passive Analysis: Knowledge Base Access",
			"",
			"This stage analyzes how the agent accesses the project's KB.",
			"",
			"## Description",
			"",
			"Refined description content.",
			"",
			"## Acceptance Criteria",
			"",
			"- AC item 1",
			"- AC item 2",
		].join("\n");
		const result = parseStoryContent(input);
		expect(result.description).toBe(
			[
				"# Passive Analysis: Knowledge Base Access",
				"",
				"This stage analyzes how the agent accesses the project's KB.",
				"",
				"## Description",
				"",
				"Refined description content.",
			].join("\n"),
		);
		expect(result.acceptanceCriteria).toBe("- AC item 1\n- AC item 2");
	});

	it("returns empty AC when no AC heading is present", () => {
		const input = "## Description\n\nJust a description.";
		expect(parseStoryContent(input)).toEqual({
			description: "## Description\n\nJust a description.",
			acceptanceCriteria: "",
		});
	});

	it("trims leading/trailing whitespace from each section", () => {
		const input = [
			"",
			"",
			"Description body",
			"",
			"",
			"## Acceptance Criteria",
			"",
			"AC body",
			"",
			"",
		].join("\n");
		expect(parseStoryContent(input)).toEqual({
			description: "Description body",
			acceptanceCriteria: "AC body",
		});
	});

	it("splits at a demoted ### Acceptance Criteria heading (h3)", () => {
		// A common AI restructuring is to demote `## Acceptance Criteria` to
		// `### Acceptance Criteria`. The prior `#{1,2}` anchor missed this and
		// folded the criteria into the description; any heading level now splits.
		const input = [
			"Description body",
			"",
			"### Acceptance Criteria",
			"",
			"AC body",
		].join("\n");
		expect(parseStoryContent(input)).toEqual({
			description: "Description body",
			acceptanceCriteria: "AC body",
		});
	});
});

describe("parseStoryContent with an inline-decorated heading", () => {
	// Staging bug: highlighting the heading in the editor makes TipTap store
	// `## <mark data-color="…">Acceptance Criteria</mark>`. It still LOOKS like
	// the heading, but it stopped matching, so the criteria folded into the
	// description and the section was re-appended on every save.
	const undecorated = parseStoryContent(
		["Description body", "", "## Acceptance Criteria", "", "AC body"].join(
			"\n",
		),
	);

	it("splits a highlighted heading exactly like the undecorated one", () => {
		const input = [
			"Description body",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"AC body",
		].join("\n");
		expect(parseStoryContent(input)).toEqual(undecorated);
	});

	it("splits a bolded heading exactly like the undecorated one", () => {
		const input = [
			"Description body",
			"",
			"## **Acceptance Criteria**",
			"",
			"AC body",
		].join("\n");
		expect(parseStoryContent(input)).toEqual(undecorated);
	});

	it("splits a DEMOTED decorated heading (`#{1,6}` tolerance survives)", () => {
		const input = [
			"Description body",
			"",
			"### <mark>Acceptance Criteria</mark>",
			"",
			"AC body",
		].join("\n");
		expect(parseStoryContent(input)).toEqual(undecorated);
	});

	it("splits a heading wrapped in both a mark and a strong tag", () => {
		const input = [
			"Description body",
			"",
			'## <mark data-color="#fef08a"><strong>Acceptance Criteria</strong></mark>',
			"",
			"AC body",
		].join("\n");
		expect(parseStoryContent(input)).toEqual(undecorated);
	});

	it("does NOT treat a backticked body line as the boundary (forgery guard)", () => {
		// `stripInlineDecoration` deletes backticks, so an inline-code body line
		// normalizes into heading shape. The helper's forgery guard must keep it
		// out of the boundary test — otherwise a crafted body line could move a
		// section boundary.
		const input = [
			"Description body",
			"",
			"`## Acceptance Criteria`",
			"",
			"Still description.",
		].join("\n");
		expect(parseStoryContent(input)).toEqual({
			description: [
				"Description body",
				"",
				"`## Acceptance Criteria`",
				"",
				"Still description.",
			].join("\n"),
			acceptanceCriteria: "",
		});
	});

	it("does NOT treat a heading that merely mentions acceptance as the boundary", () => {
		const input = [
			"Description body",
			"",
			"## Notes on acceptance testing",
			"",
			"Still description.",
		].join("\n");
		expect(parseStoryContent(input).acceptanceCriteria).toBe("");
	});

	it("keeps the ORIGINAL decorated lines in both sections (normalized value is never stored)", () => {
		const input = [
			'## <mark data-color="#fef08a">Overview</mark>',
			"",
			"Body with **bold**, `code` and 5 * 3 rules.",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			'- <mark data-color="#fef08a">AC 1</mark>',
		].join("\n");
		expect(parseStoryContent(input)).toEqual({
			description: [
				'## <mark data-color="#fef08a">Overview</mark>',
				"",
				"Body with **bold**, `code` and 5 * 3 rules.",
			].join("\n"),
			acceptanceCriteria: '- <mark data-color="#fef08a">AC 1</mark>',
		});
	});

	it("drops EVERY acceptance heading when a document carries two", () => {
		// The shape this bug produced: the decorated heading did not match, so
		// the criteria were re-appended under a fresh plain heading.
		//
		// The first heading opens the section and every acceptance heading is
		// dropped. Leaving the second one in the body as literal text would look
		// harmless here but empties the QA traceability matrix: the assertion
		// below pins that downstream consumer, because `parseAcceptanceCriteria`
		// stops at the first heading it meets and would report only "AC 1".
		const input = [
			"Desc body",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"- AC 1",
			"",
			"## Acceptance Criteria",
			"",
			"- AC 2",
		].join("\n");
		const parts = parseStoryContent(input);
		expect(parts).toEqual({
			description: "Desc body",
			acceptanceCriteria: ["- AC 1", "", "", "- AC 2"].join("\n"),
		});

		// The reason the heading must not survive into the column.
		expect(
			parseAcceptanceCriteria(parts.acceptanceCriteria).map(
				(c) => c.text,
			),
		).toEqual(["AC 1", "AC 2"]);

		// And the fork heals: re-rendering emits exactly one heading again.
		expect(
			(formatStoryContent(parts).match(/## Acceptance Criteria/g) ?? [])
				.length,
		).toBe(1);
	});
});

describe("parity fixtures: parseStoryContent === splitCleanSpec", () => {
	// The same table runs against `splitCleanSpec` in
	// `packages/api/modules/projects/lib/__tests__/clean-spec-content.test.ts`.
	for (const fixture of PARITY_FIXTURES) {
		it(`splits "${fixture.name}" as the backend does`, () => {
			expect(parseStoryContent(fixture.markdown)).toEqual(
				fixture.expected,
			);
		});
	}
});

describe("hasAcceptanceCriteriaHeading", () => {
	it("is true for any heading level of an Acceptance Criteria section", () => {
		expect(hasAcceptanceCriteriaHeading("## Acceptance Criteria")).toBe(
			true,
		);
		expect(hasAcceptanceCriteriaHeading("# Acceptance Criteria")).toBe(
			true,
		);
		expect(hasAcceptanceCriteriaHeading("### Acceptance Criteria")).toBe(
			true,
		);
		expect(
			hasAcceptanceCriteriaHeading("Body\n\n## acceptance tests\n\nx"),
		).toBe(true);
	});

	it("is false when the heading is renamed or absent", () => {
		expect(hasAcceptanceCriteriaHeading("## Success Criteria\n\nx")).toBe(
			false,
		);
		expect(hasAcceptanceCriteriaHeading("Just a plain description.")).toBe(
			false,
		);
		// Not a heading — a paragraph mentioning the words does not count.
		expect(
			hasAcceptanceCriteriaHeading("The acceptance criteria are strict."),
		).toBe(false);
	});

	it("is true when the heading carries inline decoration", () => {
		expect(hasAcceptanceCriteriaHeading(HIGHLIGHTED_AC_HEADING)).toBe(true);
		expect(hasAcceptanceCriteriaHeading("## **Acceptance Criteria**")).toBe(
			true,
		);
		expect(
			hasAcceptanceCriteriaHeading(
				"### <mark>Acceptance Criteria</mark>",
			),
		).toBe(true);
	});

	it("is false for a backticked body line in heading shape (forgery guard)", () => {
		expect(
			hasAcceptanceCriteriaHeading(
				"Body\n\n`## Acceptance Criteria`\n\nx",
			),
		).toBe(false);
	});
});

describe("resolveStoryContentForSave (anti-wipe guard)", () => {
	it("returns the parsed split when the AC heading is present", () => {
		const markdown = "Desc\n\n## Acceptance Criteria\n\nAC body";
		const result = resolveStoryContentForSave(markdown, "old AC");
		expect(result).toEqual({
			description: "Desc",
			acceptanceCriteria: "AC body",
			acceptanceCriteriaPreserved: false,
		});
	});

	it("preserves existing criteria when an edit RENAMES the AC heading (proven staging bug)", () => {
		// Reproduces the staging repro: the AI renamed `## Acceptance Criteria`
		// to `## Success Criteria`. Without the guard, the criteria fold into
		// the description and the column is persisted as null.
		const edited = [
			"Feature Narrative body",
			"",
			"## Success Criteria",
			"",
			"GIVEN a button WHEN rendered THEN it is green",
		].join("\n");
		const existing = "GIVEN a button WHEN rendered THEN it is blue";
		const result = resolveStoryContentForSave(edited, existing);
		expect(result.acceptanceCriteriaPreserved).toBe(true);
		expect(result.acceptanceCriteria).toBe(existing);
		// The edited body (including the renamed section) still becomes the
		// description — only the separate column is protected from a wipe.
		expect(result.description).toContain("## Success Criteria");
	});

	it("preserves existing criteria when an edit REMOVES the AC section entirely", () => {
		const edited = "Only the description survived the rewrite.";
		const result = resolveStoryContentForSave(edited, "- AC 1\n- AC 2");
		expect(result).toEqual({
			description: "Only the description survived the rewrite.",
			acceptanceCriteria: "- AC 1\n- AC 2",
			acceptanceCriteriaPreserved: true,
		});
	});

	it("does NOT preserve (respects a genuine clear) when the heading stays but the body is emptied", () => {
		// User intentionally deleted the criteria but kept the heading — this is
		// a real clear, so the empty value must go through.
		const edited = "Desc\n\n## Acceptance Criteria\n\n";
		const result = resolveStoryContentForSave(edited, "old AC");
		expect(result).toEqual({
			description: "Desc",
			acceptanceCriteria: "",
			acceptanceCriteriaPreserved: false,
		});
	});

	it("does not preserve when there were no existing criteria to protect", () => {
		const edited = "Description only, never had AC.";
		for (const existing of [null, undefined, "", "   "]) {
			const result = resolveStoryContentForSave(edited, existing);
			expect(result.acceptanceCriteriaPreserved).toBe(false);
			expect(result.acceptanceCriteria).toBe("");
		}
	});

	it("splits cleanly (no preserve) when the heading is only demoted", () => {
		const edited = "Desc\n\n### Acceptance Criteria\n\nnew AC body";
		const result = resolveStoryContentForSave(edited, "old AC");
		expect(result).toEqual({
			description: "Desc",
			acceptanceCriteria: "new AC body",
			acceptanceCriteriaPreserved: false,
		});
	});

	it("does NOT warn when the heading was merely HIGHLIGHTED (staging symptom)", () => {
		// The exact reproduction: the PO highlighted the heading and every save
		// then raised the "kept your existing acceptance criteria" toast while
		// re-appending the section. Nothing about the edit removed the heading,
		// so the guard must not fire and the edit must go through.
		const edited = [
			"Feature Narrative body",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"- new AC",
		].join("\n");
		const result = resolveStoryContentForSave(edited, "- old AC");
		expect(result).toEqual({
			description: "Feature Narrative body",
			acceptanceCriteria: "- new AC",
			acceptanceCriteriaPreserved: false,
		});
	});

	it("does NOT warn when the heading was bolded or demoted-and-highlighted", () => {
		for (const heading of [
			"## **Acceptance Criteria**",
			"### <mark>Acceptance Criteria</mark>",
			'###### <mark data-color="#fef08a">acceptance criteria</mark>',
		]) {
			const result = resolveStoryContentForSave(
				`Desc\n\n${heading}\n\n- new AC`,
				"- old AC",
			);
			expect(result).toEqual({
				description: "Desc",
				acceptanceCriteria: "- new AC",
				acceptanceCriteriaPreserved: false,
			});
		}
	});

	it("still warns when a decorated heading is RENAMED (guard is not weakened)", () => {
		const edited = [
			"Desc",
			"",
			'## <mark data-color="#fef08a">Success Criteria</mark>',
			"",
			"- rewritten",
		].join("\n");
		const result = resolveStoryContentForSave(edited, "- old AC");
		expect(result.acceptanceCriteriaPreserved).toBe(true);
		expect(result.acceptanceCriteria).toBe("- old AC");
	});
});

describe("formatStoryContent", () => {
	it("returns description as-is when AC is empty", () => {
		expect(
			formatStoryContent({
				description: "Plain description.",
				acceptanceCriteria: "",
			}),
		).toBe("Plain description.");
	});

	it("appends AC under heading when both present", () => {
		expect(
			formatStoryContent({
				description: "Description body",
				acceptanceCriteria: "AC body",
			}),
		).toBe("Description body\n\n## Acceptance Criteria\n\nAC body");
	});

	it("renders only AC heading when description is empty but AC present", () => {
		expect(
			formatStoryContent({
				description: "",
				acceptanceCriteria: "AC body",
			}),
		).toBe("## Acceptance Criteria\n\nAC body");
	});

	it("does NOT prepend ## Description (rich content stays as-is)", () => {
		// The previous implementation prepended `## Description\n\n` to plain
		// description content; the new implementation never adds that header,
		// because the description may already contain its own heading structure.
		const result = formatStoryContent({
			description: "# Passive Analysis: ...\n\nbody",
			acceptanceCriteria: "AC",
		});
		expect(result).toBe(
			"# Passive Analysis: ...\n\nbody\n\n## Acceptance Criteria\n\nAC",
		);
		expect(result).not.toContain("## Description");
	});

	it("returns empty string when both fields are empty", () => {
		expect(
			formatStoryContent({ description: "", acceptanceCriteria: "" }),
		).toBe("");
	});
});

describe("round-trip: parse(format(parts)) === parts", () => {
	it("plain description, no AC", () => {
		const parts = {
			description: "Plain description text.",
			acceptanceCriteria: "",
		};
		expect(parseStoryContent(formatStoryContent(parts))).toEqual(parts);
	});

	it("description + AC", () => {
		const parts = {
			description: "Description body",
			acceptanceCriteria: "- AC 1\n- AC 2",
		};
		expect(parseStoryContent(formatStoryContent(parts))).toEqual(parts);
	});

	it("rich stage-enhance preamble + description + AC", () => {
		const parts = {
			description: [
				"# Passive Analysis: KB Access",
				"",
				"Analysis content...",
				"",
				"## Description",
				"",
				"Refined description.",
			].join("\n"),
			acceptanceCriteria: "- AC 1\n- AC 2",
		};
		expect(parseStoryContent(formatStoryContent(parts))).toEqual(parts);
	});

	it("AC only, no description", () => {
		const parts = {
			description: "",
			acceptanceCriteria: "Only AC content here.",
		};
		expect(parseStoryContent(formatStoryContent(parts))).toEqual(parts);
	});

	it("inline-decorated content round-trips byte-for-byte", () => {
		// Proves the normalizer's output never reaches a stored column: the
		// transform is lossy (it would turn `5 * 3` into `5 3`), so a surviving
		// round-trip is the assertion that only the COMPARISON was normalized.
		const parts = {
			description: [
				'## <mark data-color="#fef08a">Overview</mark>',
				"",
				"Body with **bold**, `code`, ~~strike~~ and 5 * 3 rules.",
			].join("\n"),
			acceptanceCriteria: [
				'- <mark data-color="#fef08a">AC 1</mark>',
				"- **AC 2**",
			].join("\n"),
		};
		expect(parseStoryContent(formatStoryContent(parts))).toEqual(parts);
	});

	it("a decorated AC heading parses, re-formats to the canonical heading, and re-parses identically", () => {
		const decorated = [
			"Description body",
			"",
			HIGHLIGHTED_AC_HEADING,
			"",
			"- AC 1",
		].join("\n");
		const parts = parseStoryContent(decorated);
		expect(parts).toEqual({
			description: "Description body",
			acceptanceCriteria: "- AC 1",
		});
		expect(formatStoryContent(parts)).toBe(
			"Description body\n\n## Acceptance Criteria\n\n- AC 1",
		);
		expect(parseStoryContent(formatStoryContent(parts))).toEqual(parts);
	});
});

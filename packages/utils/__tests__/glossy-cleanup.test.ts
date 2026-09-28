import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cleanupDocument,
	GLOSSY_STATUS_QUALIFIERS,
	type GlossyAnchor,
	type GlossyCleanupResult,
	type GlossySection,
	placeAnchors,
	splitMarkdownBlocks,
} from "../lib/glossy/cleanup";
import { isKeySection } from "../lib/glossy/fact-guard";
import { computeSectionKey } from "../lib/glossy/keys";
import {
	parseVisualSlots,
	preserveVisualSlots,
	stripVisualSlots,
} from "../lib/glossy/visual-slots";

const PIPELINE_VERSION = "test-1";

function fixture(name: string): string {
	return readFileSync(join(__dirname, "fixtures", "glossy", name), "utf8");
}

/** Everything the main flow shows: headings and section text. */
function mainFlowText(result: GlossyCleanupResult): string {
	return result.sections
		.flatMap((section) => [section.heading ?? "", section.markdown])
		.join("\n");
}

function headings(sections: GlossySection[]): Array<string | null> {
	return sections.map((section) => section.heading);
}

function sectionByHeading(
	result: GlossyCleanupResult,
	heading: string,
): GlossySection {
	const section = result.sections.find((s) => s.heading === heading);
	if (!section) {
		throw new Error(
			`no section "${heading}" in ${headings(result.sections).join(", ")}`,
		);
	}
	return section;
}

function sectionKey(section: GlossySection): string {
	return computeSectionKey({ ...section, pipelineVersion: PIPELINE_VERSION });
}

/** Every section's key, main flow and appendix material, by heading path. */
function keysBySection(result: GlossyCleanupResult): Map<string, string> {
	return new Map(
		[...result.sections, ...result.appendix.additionalMaterial].map(
			(section) => [
				`${section.headingPath.join(" / ")}#${section.occurrenceIndex}`,
				sectionKey(section),
			],
		),
	);
}

/**
 * What saving through the editor does to generated markdown (TipTap →
 * Turndown, see apps/web/modules/saas/projects/lib/editor-markdown-save.ts):
 * soft-broken lines join with a space (a list item absorbs a lazy
 * continuation line), a list gets a blank line before it, markers pad to
 * `-   ` / `1.  `, brackets and a heading's ordered marker are escaped, a
 * rule becomes `* * *`, table cells are padded, and lines come back with
 * stray trailing spaces and CRLF endings.
 */
function simulateEditorRoundTrip(markdown: string): string {
	const out: string[] = [];
	let inFence = false;
	let joinable = false;
	let inList = false;

	for (const line of markdown.split("\n")) {
		if (line.startsWith("```")) {
			inFence = !inFence;
			out.push(line);
			joinable = false;
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		if (!line.trim()) {
			out.push("");
			joinable = false;
			inList = false;
			continue;
		}
		if (/^#{1,6} /.test(line)) {
			out.push(line.replace(/^(#{1,6} )(\d+)\. /, "$1$2\\. "));
			joinable = false;
			inList = false;
			continue;
		}
		if (line === "---") {
			out.push("* * *");
			joinable = false;
			continue;
		}
		const escaped = line.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
		if (line.startsWith("|")) {
			const cells = escaped
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim())
				.map((cell) => (/^:?-+:?$/.test(cell) ? "---" : cell));
			out.push(`| ${cells.join(" | ")} |`);
			joinable = false;
			continue;
		}
		const item = escaped.match(/^([-*+]|\d+\.) (.*)$/);
		if (item) {
			if (joinable && !inList) {
				out.push("");
			}
			out.push(
				`${/\d/.test(item[1]) ? `${item[1]}  ` : "-   "}${item[2]}`,
			);
			joinable = true;
			inList = true;
			continue;
		}
		if (joinable) {
			out[out.length - 1] += ` ${escaped}`;
			continue;
		}
		out.push(escaped);
		joinable = true;
		inList = false;
	}
	return out.map((line) => (line ? `${line}  ` : line)).join("\r\n");
}

describe("cleanupDocument — Business Case fixture", () => {
	const source = fixture("business-case.md");
	const result = cleanupDocument(source, "BUSINESS_CASE");

	it("carries AE1's 22 evidence parentheticals (fixture sanity)", () => {
		expect(source.match(/\(Status:/g)?.length).toBe(22);
		expect(source).toContain("\\[S2\\]");
	});

	// Covers AE1.
	it("leaves no evidence parenthetical, citation marker, TBD header field, or Source Index in the main flow", () => {
		const text = mainFlowText(result);

		expect(text).not.toMatch(/\(\s*Status:/i);
		expect(text).not.toMatch(/Evidence:/i);
		expect(text).not.toMatch(/Sources?:/i);
		expect(text).not.toMatch(/\\?\[S\d/);
		expect(text).toContain("Onboarding takes 14 days on average.\n");
		expect(text).toContain("Most delays start at contract signature\n");
		expect(text).not.toMatch(/\bTBD\b/);
		expect(text).not.toMatch(/^(?:Title|Owner|Decision Needed By|Links):/m);
		expect(text).not.toMatch(/Source Index/i);
		expect(text).not.toMatch(/^Confidence:/m);
		expect(result.scaffoldingUnrecognized).toBe(false);
		expect(result.issues).toEqual([]);
		expect(result.nothingToPresent).toBe(false);
	});

	// Covers AE1.
	it("lists every source and each removed placeholder in the appendix", () => {
		expect(result.appendix.sources).toEqual([
			{
				id: "S1",
				text: "Kickoff notes — steering group discussion of onboarding delays",
			},
			{
				id: "S2",
				text: "Operations report — quarterly onboarding cycle-time figures",
			},
			{
				id: "S3",
				text: "Customer survey — onboarding satisfaction results for example.com accounts",
			},
			{ id: null, text: "Example Operations Survey" },
		]);
		expect(result.appendix.placeholders.map((p) => p.text)).toEqual(
			expect.arrayContaining([
				"Owner: TBD",
				"Decision Needed By: TBD",
				"Links: TBD",
				"TBD — insufficient cost data in sources",
				"Owner/decider: TBD",
				"Needed by: TBD",
			]),
		);
		expect(result.appendix.details).toEqual([
			{ label: "Title", value: "Example Onboarding Automation" },
			{ label: "Status", value: "Draft" },
		]);
	});

	it("drops a section that only held placeholders, and keeps a heading whose subsections survive", () => {
		const sectionHeadings = headings(result.sections);

		expect(sectionHeadings).not.toContain("Business Case");
		expect(sectionHeadings).not.toContain("7) Costs & Investment");
		expect(sectionHeadings).toEqual(
			expect.arrayContaining([
				"2) Context & Case for Change",
				"2.1 Problem / Opportunity",
				"2.2 Who is impacted and why now?",
			]),
		);
		expect(
			sectionByHeading(result, "2) Context & Case for Change").markdown,
		).toBe("");
	});

	it("strips template instructions from field labels", () => {
		const summary = sectionByHeading(
			result,
			"1) Executive Summary",
		).markdown;

		expect(summary).toContain("Decision ask: Approve Pilot");
		expect(summary).not.toContain("(one line)");
		expect(summary).not.toContain("(1–3 bullets)");
	});

	it("produces the same output on every run", () => {
		expect(cleanupDocument(source, "BUSINESS_CASE")).toEqual(result);
	});

	it("moves a bracketed header value such as `Owner: [Owner Name]` to the placeholders", () => {
		const header = [
			"## Business Case",
			"Title: Example Pilot",
			"Owner: [Owner Name]",
			"Status: Draft",
			"",
			"## 1) Summary",
			"The pilot runs for eight weeks.",
		].join("\n");
		const direct = cleanupDocument(header, "BUSINESS_CASE");
		const roundTripped = cleanupDocument(
			simulateEditorRoundTrip(header),
			"BUSINESS_CASE",
		);

		for (const cleaned of [direct, roundTripped]) {
			expect(headings(cleaned.sections)).toEqual(["1) Summary"]);
			expect(cleaned.appendix.details).toEqual([
				{ label: "Title", value: "Example Pilot" },
				{ label: "Status", value: "Draft" },
			]);
			expect(mainFlowText(cleaned)).not.toContain("Owner");
		}
		expect(direct.appendix.placeholders.map((p) => p.text)).toEqual([
			"Owner: [Owner Name]",
		]);
		expect(roundTripped.appendix.placeholders.map((p) => p.text)).toEqual([
			"Owner: \\[Owner Name\\]",
		]);
	});
});

describe("cleanupDocument — Proposal fixture", () => {
	const source = fixture("proposal.md");
	const result = cleanupDocument(source, "PROPOSAL");

	it("drops [cite] and [S#] markers, bolded ones included", () => {
		const text = mainFlowText(result);

		expect(text).not.toMatch(/\[cite/i);
		expect(text).not.toMatch(/\[S\d/);
		expect(text).not.toMatch(/\*\*\\?\[|\*{4}/);
		expect(text).toContain("- The first phase is capped at 240k\n");
		expect(text).toContain(
			"- Top risk: the scheduling system has no public API yet",
		);
		expect(result.scaffoldingUnrecognized).toBe(false);
	});

	it("moves `1. Proposal Cover` and `1A. Source Index` to the appendix", () => {
		expect(headings(result.sections)).not.toContain("1. Proposal Cover");
		expect(headings(result.sections)).not.toContain("1A. Source Index");
		expect(result.appendix.details).toEqual(
			expect.arrayContaining([
				{ label: "Project", value: "Example Field Service Portal" },
				{ label: "Client", value: "Example Org" },
			]),
		);
		expect(result.appendix.placeholders.map((p) => p.text)).toEqual(
			expect.arrayContaining(["Sponsor: TBD", "Budget: TBD"]),
		);
		expect(result.appendix.sources.map((s) => s.id)).toEqual([
			"S1",
			"S2",
			"S3",
		]);
	});

	it("merges `15. Appendix` into additional material", () => {
		const material = result.appendix.additionalMaterial;

		expect(headings(material)).toEqual([
			"15. Appendix",
			"Glossary",
			"Reference links",
		]);
		expect(material[1].markdown).toBe(
			"- **Work order:** a request for on-site service",
		);
		expect(mainFlowText(result)).not.toMatch(/Appendix|Glossary/);
	});

	it("keeps numbering and drops tag suffixes on headings", () => {
		expect(headings(result.sections)).toEqual([
			"2. Executive Summary",
			"3. Background and Current State",
			"4. Objectives and Success Metrics",
			"Objectives",
			"Success Metrics",
			"7. Delivery Plan and Milestones",
			"13. Commercial Terms",
			"Estimate / Budget",
			"14. Open Questions / Needed Decisions",
		]);
		expect(result.title).toBe(
			"Project Proposal: Example Field Service Portal",
		);
	});
});

describe("cleanupDocument — qualifiers (R41)", () => {
	// Covers AE11.
	it("keeps an Assumed claim's qualifier next to its figure and lists it under assumptions; a Confirmed claim gets none", () => {
		const result = cleanupDocument(
			[
				"## 1) Executive Summary (Required)",
				"Expected value: a 30% efficiency gain in onboarding (Status: Assumed; Evidence: n/a)",
				"Current onboarding takes 14 days (Status: Confirmed; Evidence: [S1] — ops report)",
			].join("\n"),
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			[
				"Expected value: a 30% efficiency gain in onboarding (assumed)",
				"Current onboarding takes 14 days",
			].join("\n"),
		);
		expect(result.appendix.assumptions).toEqual([
			{
				heading: "1) Executive Summary",
				text: "Expected value: a 30% efficiency gain in onboarding",
				status: "ASSUMED",
				qualifier: "assumed",
			},
		]);
	});

	it.each([
		["Directionally Confirmed", "indicative"],
		["Assumed", "assumed"],
		["TBD", "to be confirmed"],
		["Derived Dependency — needed for the pilot", "dependent"],
	])("maps status %j to the qualifier %j", (status, qualifier) => {
		const result = cleanupDocument(
			`## Plan\nThe pilot runs for eight weeks (Status: ${status}; Evidence: n/a)`,
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			`The pilot runs for eight weeks (${qualifier})`,
		);
		expect(result.appendix.assumptions.map((a) => a.qualifier)).toEqual([
			qualifier,
		]);
	});

	it("exposes the status table the plan fixes", () => {
		expect(GLOSSY_STATUS_QUALIFIERS).toEqual({
			CONFIRMED: null,
			DIRECTIONALLY_CONFIRMED: "indicative",
			ASSUMED: "assumed",
			TBD: "to be confirmed",
			DERIVED_DEPENDENCY: "dependent",
		});
	});

	it("qualifies each statement of a line the editor joined, and a trailing Confidence tag qualifies the block's lead", () => {
		const result = cleanupDocument(
			[
				"## 3) Options Considered",
				"Option name: Extend the console Summary: add guided setup (Status: Assumed; Evidence: n/a) Effort: Medium (Status: Confirmed; Evidence: [S1]) Confidence: Directionally Confirmed",
			].join("\n"),
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			"Option name: Extend the console Summary: add guided setup (assumed) Effort: Medium",
		);
		expect(
			result.appendix.assumptions.map((a) => [a.text, a.qualifier]),
		).toEqual([
			[
				"Option name: Extend the console Summary: add guided setup Effort: Medium",
				"indicative",
			],
			[
				"Option name: Extend the console Summary: add guided setup",
				"assumed",
			],
		]);
	});

	it("turns a TBD in prose into 'to be confirmed' and lists the statement", () => {
		const result = cleanupDocument(
			"## Timeline\nThe launch window is TBD until the vendor replies.",
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			"The launch window is to be confirmed until the vendor replies.",
		);
		expect(result.appendix.assumptions).toEqual([
			{
				heading: "Timeline",
				text: "The launch window is to be confirmed until the vendor replies.",
				status: "TBD",
				qualifier: "to be confirmed",
			},
		]);
	});
});

describe("cleanupDocument — headings", () => {
	it("turns `## 3) Scope (Required)` into `3) Scope`", () => {
		const result = cleanupDocument(
			"## 3) Scope (Required)\nIn scope: intake and dispatch",
			"BUSINESS_CASE",
		);

		expect(result.sections[0].heading).toBe("3) Scope");
		expect(result.sections[0].level).toBe(2);
	});

	it.each([
		[
			"## 7) Costs & Investment (Include if context supports; otherwise TBD)",
			"7) Costs & Investment",
		],
		[
			"## 9) Delivery Approach (Lightweight) (Required)",
			"9) Delivery Approach",
		],
		[
			"## 5. Proposed Solution (What We're Building)",
			"5. Proposed Solution (What We're Building)",
		],
		[
			"## 2\\. Executive Summary (Approval Section)",
			"2. Executive Summary",
		],
	])("cleans %j to %j", (line, expected) => {
		const result = cleanupDocument(`${line}\nBody text.`, "PROPOSAL");

		expect(result.sections[0].heading).toBe(expected);
	});
});

describe("cleanupDocument — tables", () => {
	const table = [
		"### 6.2 Success Metrics",
		"| Goal | Metric | Target | Owner | Status | Evidence |",
		"| --- | --- | --- | --- | --- | --- |",
		"| Faster activation | Median onboarding days | TBD | Support lead | Confirmed | [S2] |",
		"| Higher satisfaction | TBD | 4.5 of 5 | TBD | Assumed | n/a |",
	].join("\n");

	it("keeps a row with one TBD cell as 'to be confirmed', moves a row whose metric is TBD, and drops Status and Evidence", () => {
		const result = cleanupDocument(table, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(
			[
				"| Goal | Metric | Target | Owner |",
				"| --- | --- | --- | --- |",
				"| Faster activation | Median onboarding days | to be confirmed | Support lead |",
			].join("\n"),
		);
		expect(result.appendix.placeholders).toEqual([
			{
				heading: "6.2 Success Metrics",
				text: "Goal: Higher satisfaction; Metric: TBD; Target: 4.5 of 5; Owner: TBD",
			},
		]);
		expect(result.appendix.assumptions).toEqual([
			{
				heading: "6.2 Success Metrics",
				text: "Goal: Faster activation; Metric: Median onboarding days; Target: TBD; Owner: Support lead",
				status: "TBD",
				qualifier: "to be confirmed",
			},
		]);
	});

	it("leaves a table with no scaffolding exactly as written", () => {
		const plain = [
			"## Plan",
			"|Phase|Weeks|",
			"|:--|--:|",
			"|Pilot|8|",
		].join("\n");

		expect(cleanupDocument(plain, "PROPOSAL").sections[0].markdown).toBe(
			["|Phase|Weeks|", "|:--|--:|", "|Pilot|8|"].join("\n"),
		);
	});
});

describe("cleanupDocument — status parentheticals", () => {
	it("leaves an unbalanced parenthetical in place, whole, and reports it", () => {
		const line =
			"A 30% efficiency gain (Status: Assumed; Evidence: [S1] — kickoff notes";
		const result = cleanupDocument(`## Value\n${line}`, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(line);
		expect(result.issues).toEqual([
			{
				kind: "unbalanced_parenthetical",
				heading: "Value",
				excerpt: "(Status: Assumed; Evidence: [S1] — kickoff notes",
			},
		]);
		expect(result.scaffoldingUnrecognized).toBe(true);
		expect(result.appendix.assumptions).toEqual([]);
	});

	it("leaves an over-long parenthetical in place and reports it", () => {
		const line = `Adoption doubles (Status: Assumed; Evidence: ${"survey detail ".repeat(40)})`;
		const result = cleanupDocument(`## Value\n${line}`, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(line);
		expect(result.issues.map((issue) => issue.kind)).toEqual([
			"overlong_parenthetical",
		]);
	});

	it("removes a parenthetical with nested parentheses in one piece", () => {
		const result = cleanupDocument(
			"## Problem\nSix manual handoffs (Status: Confirmed; Evidence: [S2] — process map (page 4)) slow onboarding.",
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			"Six manual handoffs slow onboarding.",
		);
	});

	it("keeps a parenthetical that is content, not a confidence tag", () => {
		const line =
			"The vendor integration (Status: in progress) ships in Q3.";
		const result = cleanupDocument(`## Plan\n${line}`, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(line);
		expect(result.issues).toEqual([]);
	});

	it("reports a marker that a removal spliced together instead of deleting again", () => {
		const result = cleanupDocument(
			"## Plan\nThe rollout plan [S[S1]1] is agreed.",
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			"The rollout plan [S1] is agreed.",
		);
		expect(result.issues).toEqual([
			{ kind: "residual_marker", heading: "Plan", excerpt: "[S1]" },
		]);
		expect(result.scaffoldingUnrecognized).toBe(true);
	});
});

describe("cleanupDocument — evidence and source clauses", () => {
	it("removes a mid-line `Evidence: [S2] — anchor` clause and keeps the sentence", () => {
		const result = cleanupDocument(
			"## Summary\nOnboarding takes 14 days. Evidence: [S2] — cycle-time table",
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe("Onboarding takes 14 days.");
		expect(mainFlowText(result)).not.toMatch(/Evidence:/i);
		expect(result.scaffoldingUnrecognized).toBe(false);
		expect(result.issues).toEqual([]);
	});

	it("ends a clause at a sentence end, so the prose after it stays", () => {
		const result = cleanupDocument(
			[
				"## Plan",
				"Onboarding takes 14 days. Evidence: [S2] — cycle-time table. The pilot starts in May.",
				"Setup takes one day. Evidence: n/a",
			].join("\n"),
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			[
				"Onboarding takes 14 days. The pilot starts in May.",
				"Setup takes one day.",
			].join("\n"),
		);
	});

	it("drops a `Sources:` line left empty, and leaves no `Sources:,` mid-line", () => {
		const result = cleanupDocument(
			[
				"## Value",
				"The pilot saves three hours a week. Sources: [S1], [S3]",
				"",
				"Sources: [S1], [S3]",
				"",
				"Adoption is high.",
			].join("\n"),
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			["The pilot saves three hours a week.", "Adoption is high."].join(
				"\n\n",
			),
		);
		expect(mainFlowText(result)).not.toMatch(/Sources/);
	});

	it("keeps both statements of two lines the editor joined", () => {
		const joined = simulateEditorRoundTrip(
			[
				"## Findings",
				"A holds. Evidence: [S2] — table",
				"B holds. Evidence: [S1] — notes",
			].join("\n"),
		);
		const result = cleanupDocument(joined, "BUSINESS_CASE");

		expect(joined).toContain(
			"A holds. Evidence: \\[S2\\] — table B holds. Evidence: \\[S1\\] — notes",
		);
		expect(result.sections[0].markdown).toBe("A holds. B holds.");
	});

	// The editor joins the next line onto a clause's anchor, and that line's
	// statement may lead with a digit, a currency sign, emphasis or a quote.
	it.each([
		"40% of new accounts stall at provisioning.",
		"$240k in renewals is at risk.",
		"€90k of licence spend is duplicated.",
		"**Renewals** slip when setup runs long.",
		"“Setup is slow” is the top survey answer.",
	])("keeps the joined statement %j after an anchor", (next) => {
		const joined = simulateEditorRoundTrip(
			[
				"## Findings",
				"Onboarding takes 14 days on average. Evidence: [S2] — cycle-time table",
				next,
			].join("\n"),
		);
		const result = cleanupDocument(joined, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(
			`Onboarding takes 14 days on average. ${next}`,
		);
	});

	it("ends a clause with no dash or colon right after its last reference", () => {
		const joined = simulateEditorRoundTrip(
			["## Findings", "A holds. Evidence: [S2]", "B holds."].join("\n"),
		);

		expect(
			cleanupDocument(joined, "BUSINESS_CASE").sections[0].markdown,
		).toBe("A holds. B holds.");
		// The `;` joining two such clauses goes with them.
		expect(
			cleanupDocument(
				"## Findings\nA holds. Evidence: [S1]; Sources: [S2]\nC holds. Evidence: [S1], Sources: [S2]",
				"BUSINESS_CASE",
			).sections[0].markdown,
		).toBe("A holds.\nC holds.");
	});

	it("keeps the statement after a mid-paragraph `Sources:` clause", () => {
		const result = cleanupDocument(
			"## Value\nThe pilot saves three hours a week. Sources: [S1], [S3] Adoption is high across both teams.",
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			"The pilot saves three hours a week. Adoption is high across both teams.",
		);
	});

	it("keeps a joined statement that has no terminal punctuation", () => {
		const joined = simulateEditorRoundTrip(
			[
				"## Findings",
				"A holds. Evidence: [S2] — table",
				"B holds",
				"Confidence: Assumed",
				"",
				"C holds. Evidence: [S1] — notes",
				"D holds Evidence: [S3] — survey",
			].join("\n"),
		);
		const result = cleanupDocument(joined, "BUSINESS_CASE");

		// `D holds Evidence:` opens a clause only because the label is
		// capitalized, so its anchor stays as a fragment.
		expect(result.sections[0].markdown).toBe(
			["A holds. B holds", "C holds. D holds survey"].join("\n\n"),
		);
		expect(result.appendix.assumptions.map((a) => a.text)).toEqual([
			"A holds. B holds",
		]);
	});

	// A capitalized label after a word may be an editor join or prose, so
	// only the label, its markers and the separator go; the text after them
	// always stays.
	it.each([
		[
			"The report's Evidence: [S1] — survey results show churn fell.",
			"The report's survey results show churn fell.",
		],
		[
			"The outcome was Sources: [S1] — pilot data confirms it.",
			"The outcome was pilot data confirms it.",
		],
	])(
		"keeps the prose after a capitalized mid-sentence label: %j",
		(line, expected) => {
			const result = cleanupDocument(
				`## Findings\n${line}`,
				"BUSINESS_CASE",
			);

			expect(result.sections[0].markdown).toBe(expected);
		},
	);

	it("removes the label of a line joined without punctuation, and pins the anchor fragment it leaves", () => {
		const joined = simulateEditorRoundTrip(
			[
				"## Findings",
				"A holds. Evidence: [S2] — table",
				"B holds Evidence: [S3] — survey",
			].join("\n"),
		);
		const result = cleanupDocument(joined, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe("A holds. B holds survey");
		expect(mainFlowText(result)).not.toMatch(/Evidence/);
	});

	it("keeps a joined statement's qualifier on that statement", () => {
		const joined = simulateEditorRoundTrip(
			[
				"## Findings",
				"Onboarding takes 14 days on average. Evidence: [S2] — cycle-time table",
				"$240k in renewals is at risk (Status: Assumed; Evidence: n/a)",
			].join("\n"),
		);
		const result = cleanupDocument(joined, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(
			"Onboarding takes 14 days on average. $240k in renewals is at risk (assumed)",
		);
		expect(result.appendix.assumptions).toEqual([
			{
				heading: "Findings",
				text: "$240k in renewals is at risk",
				status: "ASSUMED",
				qualifier: "assumed",
			},
		]);
	});

	// The documented trade-off: a capitalized word inside an anchor reads as
	// a joined statement's start, so part of the anchor stays rather than a
	// statement being lost. Pinned so a change in either direction shows.
	it("loses no statement around a multi-word capitalized anchor, and may leave a fragment", () => {
		const clean = (lines: string[]) =>
			cleanupDocument(
				simulateEditorRoundTrip(["## Findings", ...lines].join("\n")),
				"BUSINESS_CASE",
			).sections[0].markdown;

		expect(clean(["A holds. Evidence: [S1] — Steering Group notes."])).toBe(
			"A holds. Group notes.",
		);
		expect(
			clean([
				"A holds. Evidence: [S1] — Steering Group notes",
				"B holds.",
			]),
		).toBe("A holds. Group notes B holds.");
	});

	it("keeps a mid-sentence label as prose, removing only its markers and the colon before them", () => {
		const result = cleanupDocument(
			[
				"## Churn",
				"The key evidence: [S2] shows churn fell 4% in Q2.",
				"",
				"## Source Index",
				"[S2] Churn report",
			].join("\n"),
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			"The key evidence shows churn fell 4% in Q2.",
		);
		expect(result.issues).toEqual([]);
	});

	it("removes a clause whose label has a qualifier word, and keeps that label as prose mid-sentence", () => {
		const source = [
			"## Findings",
			"Adoption doubled in the pilot.",
			"Data sources: [S1]",
			"- Key evidence: [S1]",
			"Supporting evidence: [S2] — table",
			"**Primary sources:** [S1], [S2]",
			"",
			"The data sources: [S1] agree on the trend.",
		].join("\n");

		const direct = cleanupDocument(source, "BUSINESS_CASE");
		const roundTripped = cleanupDocument(
			simulateEditorRoundTrip(source),
			"BUSINESS_CASE",
		);

		expect(direct.sections[0].markdown).toBe(
			[
				"Adoption doubled in the pilot.",
				"The data sources agree on the trend.",
			].join("\n\n"),
		);
		// The editor joins the lines after the list item into it, so
		// `Supporting evidence:` follows `[S1] ` and opens a clause only by
		// its capital: its anchor `table` stays as a fragment.
		expect(roundTripped.sections[0].markdown).toBe(
			[
				"Adoption doubled in the pilot.",
				"- table",
				"The data sources agree on the trend.",
			].join("\n\n"),
		);
		for (const result of [direct, roundTripped]) {
			expect(mainFlowText(result)).not.toMatch(/evidence|:\s*$/im);
		}
	});

	it("loses nothing after a clause that follows a semicolon", () => {
		const result = cleanupDocument(
			"## Savings\nSavings are 12%; evidence: [S2] and costs fall 3% next year.",
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(
			"Savings are 12%; and costs fall 3% next year.",
		);
	});

	it("keeps a label with no marker, which is prose", () => {
		const line =
			"The case rests on one point. Evidence: the survey shows it.";
		const result = cleanupDocument(`## Case\n${line}`, "BUSINESS_CASE");

		expect(result.sections[0].markdown).toBe(line);
	});

	it("moves `(Source: Acme report)` to the appendix sources", () => {
		const result = cleanupDocument(
			"## Market\nDemand grew 12% last year (Source: Acme report).",
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe("Demand grew 12% last year.");
		expect(result.appendix.sources).toEqual([
			{ id: null, text: "Acme report" },
		]);
		expect(result.scaffoldingUnrecognized).toBe(false);
	});

	it("keeps an unlabelled part of a source parenthetical in the main flow, not in the sources", () => {
		const result = cleanupDocument(
			[
				"## Market",
				"Demand grew 12% last year (Source: Acme report; figures are rough).",
				"Churn fell to 4% (Status: Assumed; Evidence: n/a; pending finance review)",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			[
				"Demand grew 12% last year (figures are rough).",
				"Churn fell to 4% (pending finance review) (assumed)",
			].join("\n"),
		);
		expect(result.appendix.sources).toEqual([
			{ id: null, text: "Acme report" },
		]);
	});

	it("names the text beside a marker in a `Source:` part, and keeps an unlabelled part in the main flow", () => {
		const result = cleanupDocument(
			"## Market\nDemand grew 12% (Source: [S1] internal report; updated after launch).",
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			"Demand grew 12% (updated after launch).",
		);
		expect(result.appendix.sources).toEqual([
			{ id: null, text: "internal report" },
		]);
	});

	it.each([
		["(Source: [S1])", []],
		["(Sources: [S1], [S2])", []],
		["(Source: [S1] — n/a)", []],
		["(Sources: [S1], [S2] vendor survey)", ["vendor survey"]],
		["(Source: [S1] — internal report)", ["internal report"]],
	])(
		"names only the description a source part %j carries beside its markers",
		(parenthetical, named) => {
			const result = cleanupDocument(
				`## Market\nDemand grew 12% ${parenthetical}.`,
				"PROPOSAL",
			);

			expect(result.sections[0].markdown).toBe("Demand grew 12%.");
			expect(
				result.appendix.sources.map((source) => source.text),
			).toEqual(named);
		},
	);

	it("lists a source cited three times once", () => {
		const result = cleanupDocument(
			[
				"## Market",
				"Demand grew 12% last year (Source: Acme report).",
				"Churn fell to 4% (Source: Acme report) and support tickets halved (Source: acme report).",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			[
				"Demand grew 12% last year.",
				"Churn fell to 4% and support tickets halved.",
			].join("\n"),
		);
		expect(result.appendix.sources).toEqual([
			{ id: null, text: "Acme report" },
		]);
	});

	it("names no new source for a source parenthetical that only points into the index", () => {
		const result = cleanupDocument(
			[
				"## Market",
				"Demand grew 12% last year (Sources: [S1], [S3]).",
				"",
				"## Source Index",
				"[S1] Kickoff notes",
				"[S3] Customer survey",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe("Demand grew 12% last year.");
		expect(result.appendix.sources.map((source) => source.id)).toEqual([
			"S1",
			"S3",
		]);
	});
});

describe("cleanupDocument — numeric and footnote markers", () => {
	const sourceIndex = "## Source Index\n[S1] Vendor survey";
	const numberedSources = "## Sources\n[1] Vendor survey";

	it("removes `[^2]` but keeps and reports `[1]` when the only apparatus is an `[S#]` source index", () => {
		const result = cleanupDocument(
			`## Options\nOption A is cheaper [1] than B [^2].\n\n${sourceIndex}`,
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			"Option A is cheaper [1] than B.",
		);
		expect(result.issues).toEqual([
			{ kind: "residual_marker", heading: "Options", excerpt: "[1]" },
		]);
	});

	it("keeps `option [2] over option [1]` in a Business Case whose source index is `[S#]`", () => {
		const line = "We prefer option [2] over option [1] for scale.";
		const result = cleanupDocument(
			`## 3) Options Considered\n${line}\n\n## 0) Source Index\n[S1] Kickoff notes`,
			"BUSINESS_CASE",
		);

		expect(result.sections[0].markdown).toBe(line);
		expect(result.appendix.sources).toEqual([
			{ id: "S1", text: "Kickoff notes" },
		]);
	});

	it("never reads a four-digit bracketed year as a citation", () => {
		const result = cleanupDocument(
			[
				"## Market",
				"Revenue grew in [2025] by 12% [1].",
				"",
				"## References",
				"1. Vendor survey, 2025",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			"Revenue grew in [2025] by 12%.",
		);
		expect(result.issues).toEqual([]);
	});

	it("removes only the `[n]` a numbered References list defines, and reports the rest", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled [1] and costs fell [7].",
				"",
				"## References",
				"1. Vendor survey, 2025",
				"2. Operations report, 2026",
			].join("\n"),
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings"]);
		expect(result.sections[0].markdown).toBe(
			"Adoption doubled and costs fell [7].",
		);
		expect(result.issues).toEqual([
			{ kind: "residual_marker", heading: "Findings", excerpt: "[7]" },
		]);
	});

	// A bare `[1]` with nothing that defines it is content, but still reported.
	it("keeps `[1]` and reports it when the document has no citation apparatus", () => {
		const result = cleanupDocument(
			"## Options\nOption A is cheaper [1] than B.",
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			"Option A is cheaper [1] than B.",
		);
		expect(result.issues).toEqual([
			{ kind: "residual_marker", heading: "Options", excerpt: "[1]" },
		]);
		expect(result.scaffoldingUnrecognized).toBe(true);
	});

	it("leaves code, reference links, checkboxes and fenced blocks alone", () => {
		const body = [
			"Use `arr[1]` for the first item, or `see [1]` in a sentence.",
			"See the [guide][1] for details, or [the survey](https://example.com) [1](https://example.com).",
			"",
			"[1]: https://example.com",
			"",
			"- [ ] task",
			"- [x] done",
			"",
			"```text",
			"value [1]",
			"```",
		].join("\n");
		const result = cleanupDocument(
			`## Notes\n${body}\n\n${numberedSources}`,
			"PROPOSAL",
		);

		expect(sectionByHeading(result, "Notes").markdown).toBe(body);
	});

	it("moves a footnote definition to the appendix sources", () => {
		const result = cleanupDocument(
			[
				"## Options",
				"Option A is cheaper than B [^2].",
				"",
				"[^2]: Vendor survey 2025",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe("Option A is cheaper than B.");
		expect(result.appendix.sources).toEqual([
			{ id: "2", text: "Vendor survey 2025" },
		]);
		expect(result.issues).toEqual([]);
	});

	it("treats `\\[1\\]` and `\\[^2\\]` from an editor round trip like `[1]` and `[^2]`", () => {
		const source = [
			"## Options",
			"Option A is cheaper [1] than B [^2].",
			"",
			"[^2]: Vendor survey 2025",
			"",
			"## Sources",
			"[1] Operations report",
		].join("\n");
		const roundTripped = simulateEditorRoundTrip(source);
		const before = cleanupDocument(source, "PROPOSAL");
		const after = cleanupDocument(roundTripped, "PROPOSAL");

		expect(roundTripped).toContain("cheaper \\[1\\] than B \\[^2\\].");
		expect(roundTripped).toContain("\\[^2\\]: Vendor survey 2025");
		expect(after.sections[0].markdown).toBe("Option A is cheaper than B.");
		expect(after.sections).toEqual(before.sections);
		expect(after.appendix.sources).toEqual(before.appendix.sources);
		expect(after.issues).toEqual([]);
	});

	it("removes `[1]` above a References section that closes the document", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled in the pilot [1].",
				"",
				"## References",
				"- [1] Vendor survey, 2025",
			].join("\n"),
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings"]);
		expect(result.sections[0].markdown).toBe(
			"Adoption doubled in the pilot.",
		);
		expect(result.appendix.sources).toEqual([
			{ id: "1", text: "Vendor survey, 2025" },
		]);
		expect(result.issues).toEqual([]);
	});
});

describe("cleanupDocument — References sections", () => {
	it("moves a References section of `[S#]` entries to the appendix sources", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled in the pilot.",
				"",
				"## References",
				"- [S1] Kickoff notes",
				"- [S2] Operations report",
			].join("\n"),
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings"]);
		expect(result.appendix.sources).toEqual([
			{ id: "S1", text: "Kickoff notes" },
			{ id: "S2", text: "Operations report" },
		]);
	});

	it("keeps a list of customer references in the main flow", () => {
		const body = [
			"- Acme Corp — CRM rollout, 2024",
			"- Example Bank — payments migration, 2025",
		].join("\n");
		const result = cleanupDocument(
			`## Findings\nAdoption doubled in the pilot.\n\n## References\n${body}`,
			"PROPOSAL",
		);

		expect(sectionByHeading(result, "References").markdown).toBe(body);
		expect(result.appendix.sources).toEqual([]);
	});

	it("moves a numbered References list the text cites as `[n]`, and removes the markers", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled in the pilot [1], and costs fell [2].",
				"",
				"## References",
				"1. Vendor survey, 2025",
				"2. Operations report, 2026",
			].join("\n"),
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings"]);
		expect(result.sections[0].markdown).toBe(
			"Adoption doubled in the pilot, and costs fell.",
		);
		expect(result.appendix.sources.map((source) => source.text)).toEqual([
			"Vendor survey, 2025",
			"Operations report, 2026",
		]);
		expect(result.issues).toEqual([]);
	});

	it("keeps a References list of customer case studies with links in the main flow", () => {
		const body = [
			"- Example Co — reduced onboarding time 30% ([case study](https://example.com/case))",
			"- Example Bank — cut support tickets in half ([case study](https://example.com/bank))",
		].join("\n");
		const result = cleanupDocument(
			`## Findings\nAdoption doubled in the pilot.\n\n## References\n${body}`,
			"PROPOSAL",
		);

		expect(sectionByHeading(result, "References").markdown).toBe(body);
		expect(result.appendix.sources).toEqual([]);
	});

	it("keeps a References list of bare URLs in the main flow", () => {
		const body = [
			"- https://example.com/customer-portal",
			"- https://example.com/partner-directory",
		].join("\n");
		const result = cleanupDocument(
			`## Findings\nAdoption doubled in the pilot.\n\n## References\n${body}`,
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings", "References"]);
		expect(sectionByHeading(result, "References").markdown).toBe(body);
		expect(result.appendix.sources).toEqual([]);
	});

	it.each([
		"[https://example.com](https://example.com)",
		"[](https://example.com/portal)",
		"[example.com/portal](https://example.com/portal)",
	])(
		"keeps a References entry %j, whose link has no title, in the main flow",
		(entry) => {
			const result = cleanupDocument(
				`## Findings\nAdoption doubled in the pilot.\n\n## References\n${entry}`,
				"PROPOSAL",
			);

			expect(sectionByHeading(result, "References").markdown).toBe(entry);
			expect(result.appendix.sources).toEqual([]);
		},
	);

	it("moves a References list of titled links to the appendix sources", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled in the pilot.",
				"",
				"## References",
				"- [Vendor survey 2025](https://example.com/survey)",
				"- Operations report, 2026 — https://example.com/ops",
			].join("\n"),
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings"]);
		expect(result.appendix.sources).toEqual([
			{
				id: null,
				text: "[Vendor survey 2025](https://example.com/survey)",
			},
			{
				id: null,
				text: "Operations report, 2026 — https://example.com/ops",
			},
		]);
	});

	it("lists an entry that both a Source Index and a References section carry once", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled in the pilot [S1].",
				"",
				"## Source Index",
				"[S1] Kickoff notes",
				"[S2] Operations report",
				"",
				"## References",
				"- [S1] Kickoff notes",
				"- [S3] Customer survey",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.appendix.sources).toEqual([
			{ id: "S1", text: "Kickoff notes" },
			{ id: "S2", text: "Operations report" },
			{ id: "S3", text: "Customer survey" },
		]);
	});

	it("keeps a References list of customer references that cite sources in the main flow", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled in the pilot.",
				"",
				"## References",
				"- Example Co — migrated from [S1] to [S2] (case study)",
				"- Sample Ltd — cut onboarding time 30% [S3]",
			].join("\n"),
			"PROPOSAL",
		);

		expect(headings(result.sections)).toEqual(["Findings", "References"]);
		expect(sectionByHeading(result, "References").markdown).toBe(
			[
				"- Example Co — migrated from to (case study)",
				"- Sample Ltd — cut onboarding time 30%",
			].join("\n"),
		);
		expect(result.appendix.sources).toEqual([]);
	});

	it("keeps a numbered References list nothing cites", () => {
		const body = ["1. Acme Corp, 2024", "2. Example Bank, 2025"].join("\n");
		const result = cleanupDocument(
			`## Findings\nAdoption doubled in the pilot.\n\n## References\n${body}`,
			"PROPOSAL",
		);

		expect(sectionByHeading(result, "References").markdown).toBe(body);
	});
});

// The editor joins soft-broken lines, so one line may hold a run of source
// entries or footnote definitions. A run splits only on its leading marker's
// kind, and only on an id with no line of its own: a real run defines each
// id once, inside it, while a mention of another source points at an id
// defined elsewhere.
describe("cleanupDocument — joined source and footnote lines", () => {
	it("splits an editor-joined run of footnote definitions into one source each", () => {
		const result = cleanupDocument(
			[
				"## Options",
				"Option A is cheaper [^1] than B [^2].",
				"",
				"[^1]: Vendor survey 2025 [^2]: Operations report",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe("Option A is cheaper than B.");
		expect(result.appendix.sources).toEqual([
			{ id: "1", text: "Vendor survey 2025" },
			{ id: "2", text: "Operations report" },
		]);
	});

	it("keeps a footnote that mentions `[^2]:` whole when `[^2]` has a definition of its own", () => {
		const result = cleanupDocument(
			[
				"## Options",
				"Option A is cheaper [^1] than B [^2].",
				"",
				"[^1]: See discussion [^2]: not a separate definition",
				"[^2]: Vendor survey 2025",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.appendix.sources).toEqual([
			{ id: "1", text: "See discussion [^2]: not a separate definition" },
			{ id: "2", text: "Vendor survey 2025" },
		]);
	});

	// Without a line of its own, `[^2]:` reads exactly like a joined run.
	it("splits `[^1]: See discussion [^2]: …` when `[^2]` has no definition of its own", () => {
		const result = cleanupDocument(
			[
				"## Options",
				"Option A is cheaper [^1] than B [^2].",
				"",
				"[^1]: See discussion [^2]: not a separate definition",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.appendix.sources).toEqual([
			{ id: "1", text: "See discussion" },
			{ id: "2", text: "not a separate definition" },
		]);
	});

	it("splits an editor-joined source index into one entry per `[S#]`", () => {
		const source = [
			"## Findings",
			"Adoption doubled [S1].",
			"",
			"## Source Index",
			"[S1] Kickoff notes",
			"[S2] Operations report",
		].join("\n");
		const roundTripped = simulateEditorRoundTrip(source);

		expect(roundTripped).toContain(
			"\\[S1\\] Kickoff notes \\[S2\\] Operations report",
		);
		expect(
			cleanupDocument(roundTripped, "PROPOSAL").appendix.sources,
		).toEqual([
			{ id: "S1", text: "Kickoff notes" },
			{ id: "S2", text: "Operations report" },
		]);
	});

	it("keeps `[S1] Vendor report cites [1] in its appendix` whole, and a main-flow `[1]` it does not define", () => {
		const source = [
			"## Findings",
			"Adoption doubled [1].",
			"",
			"## Source Index",
			"[S1] Vendor report cites [1] in its appendix",
		].join("\n");

		for (const markdown of [source, simulateEditorRoundTrip(source)]) {
			const result = cleanupDocument(markdown, "PROPOSAL");

			// An untouched line comes back as written, escapes included.
			expect(result.sections[0].markdown).toMatch(
				/^Adoption doubled \\?\[1\\?\]\.\s*$/,
			);
			expect(result.appendix.sources.map((s) => s.id)).toEqual(["S1"]);
			expect(result.appendix.sources[0].text).toMatch(
				/^Vendor report cites \\?\[1\\?\] in its appendix$/,
			);
			expect(result.issues).toEqual([
				{
					kind: "residual_marker",
					heading: "Findings",
					excerpt: expect.stringMatching(/^\\?\[1\\?\]$/),
				},
			]);
		}
	});

	it("keeps an entry that mentions another entry whole when that entry has its own line", () => {
		const result = cleanupDocument(
			[
				"## Findings",
				"Adoption doubled [1] and churn fell [S2].",
				"",
				"## Source Index",
				"[S1] Vendor report cites [1] and extends [S2] in its appendix",
				"[S2] Vendor appendix",
				"[1] Vendor survey 2025",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.sections[0].markdown).toBe(
			"Adoption doubled and churn fell.",
		);
		expect(result.appendix.sources).toEqual([
			{
				id: "S1",
				text: "Vendor report cites [1] and extends [S2] in its appendix",
			},
			{ id: "S2", text: "Vendor appendix" },
			{ id: "1", text: "Vendor survey 2025" },
		]);
	});
});

describe("cleanupDocument — Document Control and revision history", () => {
	const documentControl = [
		"# Example QA Plan",
		"",
		"## Document Control",
		"| Field | Value |",
		"|-------|-------|",
		"| **Version** | 0.3 |",
		"| **Owner** | TBD |",
		"| **Author** | [QA Lead] |",
		"| **Client** | Example Org |",
		"| **Source** | [S1] |",
		"",
		"## Revision History",
		"| Version | Date | Author | Changes |",
		"| --- | --- | --- | --- |",
		"| 0.3 | 2026-09-01 | Example Author | Draft |",
		"",
		"## 1. Introduction",
		"The plan covers the pilot release.",
	].join("\n");

	it("turns a `| Field | Value |` table into label/value details, with no header or separator row", () => {
		const result = cleanupDocument(documentControl, "PROPOSAL");

		expect(headings(result.sections)).toEqual(["1. Introduction"]);
		expect(result.appendix.details).toEqual(
			expect.arrayContaining([{ label: "Version", value: "0.3" }]),
		);
		expect(result.appendix.placeholders.map((p) => p.text)).toContain(
			"Owner: TBD",
		);
		const values = result.appendix.details.map((detail) => detail.value);
		expect(values.some((value) => value.startsWith("|"))).toBe(false);
		expect(values.some((value) => /-{3}/.test(value))).toBe(false);
		expect(
			result.appendix.details.map((detail) => detail.label),
		).not.toEqual(expect.arrayContaining(["Field"]));
	});

	it("flattens a four-column revision-history row to its first cell and the rest joined", () => {
		const result = cleanupDocument(documentControl, "PROPOSAL");

		expect(result.appendix.details).toContainEqual({
			label: "0.3",
			value: "2026-09-01 · Example Author · Draft",
		});
		expect(result.appendix.details).not.toContainEqual(
			expect.objectContaining({
				label: "Version",
				value: expect.stringMatching(/Date/),
			}),
		);
	});

	it("treats `[QA Lead]` and the editor's `\\[QA Lead\\]` as placeholders, but not `[S1]`", () => {
		const direct = cleanupDocument(documentControl, "PROPOSAL");
		const roundTripped = cleanupDocument(
			simulateEditorRoundTrip(documentControl),
			"PROPOSAL",
		);

		expect(direct.appendix.placeholders.map((p) => p.text)).toEqual([
			"Owner: TBD",
			"Author: [QA Lead]",
		]);
		expect(roundTripped.appendix.placeholders.map((p) => p.text)).toEqual([
			"Owner: TBD",
			"Author: \\[QA Lead\\]",
		]);
		expect(direct.appendix.details).toContainEqual({
			label: "Source",
			value: "[S1]",
		});
		expect(
			roundTripped.appendix.details.map((detail) => detail.label),
		).toEqual(direct.appendix.details.map((detail) => detail.label));
	});

	it("keeps a bracketed token in the main flow: a field value and a table key cell", () => {
		const body = [
			"Recommended: [Option B]",
			"",
			"| Phase | Weeks |",
			"| --- | --- |",
			"| [Phase 1] | 8 |",
		].join("\n");
		const result = cleanupDocument(`## Options\n${body}`, "PROPOSAL");

		expect(result.sections[0].markdown).toBe(body);
		expect(result.appendix.placeholders).toEqual([]);
	});

	it("keeps the first pair of a key/value table with no header, which sits in the header row", () => {
		const source = [
			"## Document Control",
			"| Version | 0.3 |",
			"|---|---|",
			"| Owner | TBD |",
			"| **Status** | Draft |",
			"",
			"## Plan",
			"The pilot runs for eight weeks.",
		].join("\n");

		for (const markdown of [source, simulateEditorRoundTrip(source)]) {
			const result = cleanupDocument(markdown, "PROPOSAL");

			expect(headings(result.sections)).toEqual(["Plan"]);
			expect(result.appendix.details).toEqual([
				{ label: "Version", value: "0.3" },
				{ label: "Status", value: "Draft" },
			]);
			expect(result.appendix.placeholders.map((p) => p.text)).toEqual([
				"Owner: TBD",
			]);
		}
	});

	it.each([
		"| Field | Value |",
		"| **Item** | **Details** |",
		"| Property | Value |",
		"|  |  |",
	])("treats the header row %j as layout", (header) => {
		const result = cleanupDocument(
			`## Document Control\n${header}\n|---|---|\n| Version | 0.3 |`,
			"PROPOSAL",
		);

		expect(result.appendix.details).toEqual([
			{ label: "Version", value: "0.3" },
		]);
		expect(result.appendix.placeholders).toEqual([]);
	});

	it("keeps a `Client` row as the detail the cover's recipient name is read from", () => {
		const result = cleanupDocument(documentControl, "PROPOSAL");

		expect(result.appendix.details).toContainEqual({
			label: "Client",
			value: "Example Org",
		});
	});

	it.each(["Version History", "Change Log"])(
		"moves a `%s` section to the appendix",
		(heading) => {
			const result = cleanupDocument(
				`## ${heading}\n- 0.2 — first draft\n\n## Plan\nThe pilot runs for eight weeks.`,
				"PROPOSAL",
			);

			expect(headings(result.sections)).toEqual(["Plan"]);
			expect(result.appendix.details).toEqual([
				{ label: null, value: "0.2 — first draft" },
			]);
		},
	);
});

describe("cleanupDocument — anchors (KTD7)", () => {
	const slot =
		'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="Phases &amp; gates"></visual-slot>';
	const withAnchors = [
		"## 9) Delivery Approach",
		"Discovery runs for four weeks.",
		"",
		slot,
		"",
		"Pilot follows with two teams.",
		"",
		"```mermaid",
		"flowchart LR",
		"  D --> P",
		"```",
		"",
		"Scale starts after the pilot review.",
	].join("\n");
	const withoutAnchors = [
		"## 9) Delivery Approach",
		"Discovery runs for four weeks.",
		"",
		"Pilot follows with two teams.",
		"",
		"Scale starts after the pilot review.",
	].join("\n");

	it("lifts a slot and a Mermaid fence into two anchors with block indexes", () => {
		const [section] = cleanupDocument(
			withAnchors,
			"BUSINESS_CASE",
		).sections;

		expect(section.markdown).toBe(
			[
				"Discovery runs for four weeks.",
				"Pilot follows with two teams.",
				"Scale starts after the pilot review.",
			].join("\n\n"),
		);
		expect(section.anchors).toEqual([
			{
				kind: "slot",
				blockIndex: 1,
				slotId: "slot-1",
				slotKind: "timeline",
				hint: "Phases & gates",
				markdown: slot,
			},
			{
				kind: "mermaid",
				blockIndex: 2,
				source: "flowchart LR\n  D --> P",
			},
		]);
	});

	it("keys the section the same as the same section without anchors", () => {
		const [withSection] = cleanupDocument(
			withAnchors,
			"BUSINESS_CASE",
		).sections;
		const [withoutSection] = cleanupDocument(
			withoutAnchors,
			"BUSINESS_CASE",
		).sections;

		expect(sectionKey(withSection)).toBe(sectionKey(withoutSection));
	});

	it("places anchors back where they were", () => {
		const [section] = cleanupDocument(
			withAnchors,
			"BUSINESS_CASE",
		).sections;
		const render = (anchor: GlossyAnchor) =>
			anchor.kind === "mermaid"
				? `[mermaid:${anchor.blockIndex}]`
				: anchor.kind;

		expect(placeAnchors(section.markdown, section.anchors, render)).toBe(
			[
				"Discovery runs for four weeks.",
				"slot",
				"Pilot follows with two teams.",
				"[mermaid:2]",
				"Scale starts after the pilot review.",
			].join("\n\n"),
		);
		// A rewrite with fewer blocks puts the rest at the end, in order.
		expect(placeAnchors("One paragraph.", section.anchors, render)).toBe(
			["One paragraph.", "slot", "[mermaid:2]"].join("\n\n"),
		);
	});

	it("counts only surviving blocks, and treats an anchor as transparent inside a block", () => {
		const [section] = cleanupDocument(
			[
				"## Plan",
				"TBD",
				"",
				slot,
				"First line of the plan.",
				slot.replace("slot-1", "slot-2"),
				"Second line of the plan.",
			].join("\n"),
			"BUSINESS_CASE",
		).sections;

		expect(section.markdown).toBe(
			"First line of the plan.\nSecond line of the plan.",
		);
		expect(splitMarkdownBlocks(section.markdown)).toHaveLength(1);
		expect(
			section.anchors.map((anchor) => [
				anchor.kind === "slot" ? anchor.slotId : anchor.kind,
				anchor.blockIndex,
			]),
		).toEqual([
			["slot-1", 0],
			["slot-2", 1],
		]);
	});

	it("makes an uploaded image under the document's project an anchor, but not a foreign or remote one", () => {
		const own =
			'<img src="https://storage.example.com/signed" alt="Flow" data-s3-key="document-media/project-a/doc-1/abc.png" />';
		const foreign =
			'<img src="https://storage.example.com/signed" alt="Other" data-s3-key="document-media/project-b/doc-9/def.png" />';
		const remote =
			'<img src="https://example.com/chart.png" alt="Remote" />';
		const markdown = ["## Context", own, "", foreign, "", remote].join(
			"\n",
		);

		const [section] = cleanupDocument(markdown, "PROPOSAL", {
			projectId: "project-a",
		}).sections;

		expect(section.anchors).toEqual([
			{
				kind: "image",
				blockIndex: 0,
				s3Key: "document-media/project-a/doc-1/abc.png",
				markdown: own,
			},
		]);
		expect(section.markdown).toBe([foreign, remote].join("\n\n"));

		expect(
			cleanupDocument(markdown, "PROPOSAL").sections[0].anchors,
		).toEqual([]);
		expect(
			cleanupDocument(markdown, "PROPOSAL", {
				projectId: "project-a",
				isOwnImageKey: (key) => key.includes("project-b"),
			}).sections[0].anchors.map((anchor) =>
				anchor.kind === "image" ? anchor.s3Key : anchor.kind,
			),
		).toEqual(["document-media/project-b/doc-9/def.png"]);
	});

	it("treats a slot tag inside a code fence as code", () => {
		const markdown = ["## Example", "```html", slot, "```"].join("\n");
		const [section] = cleanupDocument(markdown, "PROPOSAL").sections;

		expect(section.anchors).toEqual([]);
		expect(section.markdown).toBe(["```html", slot, "```"].join("\n"));
	});

	it("never keeps raw diagram source it cannot render (R13)", () => {
		const markdown = [
			"## Architecture",
			"Two services talk over a queue.",
			"",
			"```plantuml",
			"@startuml",
			"A -> B",
			"@enduml",
			"```",
		].join("\n");

		const [section] = cleanupDocument(markdown, "PROPOSAL").sections;

		expect(section.markdown).toBe("Two services talk over a queue.");
		expect(section.anchors).toEqual([]);
	});
});

describe("cleanupDocument — fence parity with visual-slots", () => {
	const slot = (id: string) =>
		`<visual-slot data-slot-id="${id}"></visual-slot>`;
	const image = (name: string) =>
		`<img src="https://storage.example.com/signed" alt="Chart" data-s3-key="document-media/project-a/doc-1/${name}.png" />`;
	const mermaidBody = [
		"flowchart LR",
		slot("slot-in-mermaid"),
		image("in-mermaid"),
		"## Not a heading",
		"~~~",
		"  A --> B",
	];
	const markdown = [
		"## Rollout",
		"Discovery runs for four weeks.",
		"",
		slot("slot-real"),
		"",
		"```mermaid",
		...mermaidBody,
		"```",
		"",
		image("real"),
		"",
		"~~~~html",
		slot("slot-in-code"),
		image("in-code"),
		"```",
		"~~~~",
		"",
		"Scale starts after the pilot review.",
	].join("\n");
	const cleanup = (text: string) =>
		cleanupDocument(text, "PROPOSAL", { projectId: "project-a" }).sections;

	it("lifts exactly the slots visual-slots parses, skipping fenced tags", () => {
		const sections = cleanup(markdown);
		const slotIds = sections.flatMap((section) =>
			section.anchors.flatMap((anchor) =>
				anchor.kind === "slot" ? [anchor.slotId] : [],
			),
		);

		// "## Not a heading" is inside the Mermaid fence on both sides.
		expect(headings(sections)).toEqual(["Rollout"]);
		expect(slotIds).toEqual(["slot-real"]);
		expect(parseVisualSlots(markdown).map((parsed) => parsed.id)).toEqual(
			slotIds,
		);
	});

	it("keeps every fenced tag and image as code on both sides", () => {
		const [section] = cleanup(markdown);

		expect(
			section.anchors.map((anchor) =>
				anchor.kind === "image" ? anchor.s3Key : anchor.kind,
			),
		).toEqual([
			"slot",
			"mermaid",
			"document-media/project-a/doc-1/real.png",
		]);
		expect(section.anchors[1]).toMatchObject({
			source: mermaidBody.join("\n"),
		});
		expect(section.markdown).toContain(
			[
				"~~~~html",
				slot("slot-in-code"),
				image("in-code"),
				"```",
				"~~~~",
			].join("\n"),
		);

		const stripped = stripVisualSlots(markdown);
		expect(stripped).not.toContain(slot("slot-real"));
		expect(stripped).toContain(slot("slot-in-mermaid"));
		expect(stripped).toContain(slot("slot-in-code"));
	});

	it("runs an unclosed fence to the end on both sides", () => {
		const unclosed = [
			"## Flow",
			"Intro.",
			"",
			"````mermaid",
			"flowchart LR",
			slot("slot-after"),
			"```",
		].join("\n");

		// The shorter "```" does not close the four-backtick fence, so it
		// stays part of the lifted source.
		expect(cleanup(unclosed)[0].anchors).toEqual([
			{
				kind: "mermaid",
				blockIndex: 1,
				source: ["flowchart LR", slot("slot-after"), "```"].join("\n"),
			},
		]);
		expect(parseVisualSlots(unclosed)).toEqual([]);
	});
});

describe("cleanupDocument — outcomes", () => {
	it("flags a custom-bound template with its own citation markers as unrecognized", () => {
		const result = cleanupDocument(
			fixture("custom-template.md"),
			"BUSINESS_CASE",
		);

		expect(result.scaffoldingUnrecognized).toBe(true);
		expect(result.issues.map((issue) => issue.excerpt)).toEqual(
			expect.arrayContaining(["[R1]", "[R2]", "[R1, R3]"]),
		);
		expect(
			result.issues.every((issue) => issue.kind === "residual_marker"),
		).toBe(true);
	});

	it("flags a document that matches none of its type's scaffolding rules", () => {
		const result = cleanupDocument(
			"## Summary\nA short, plain note with no template structure.",
			"PROPOSAL",
		);

		expect(result.scaffoldingUnrecognized).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it("reports nothingToPresent when only scaffolding remains", () => {
		const result = cleanupDocument(
			[
				"## Business Case",
				"Title: Example Pilot",
				"Owner: TBD",
				"",
				"## 0) Source Index",
				"[S1] Kickoff notes",
				"",
				"## 7) Costs & Investment",
				"TBD — insufficient cost data in sources",
			].join("\n"),
			"BUSINESS_CASE",
		);

		expect(result.sections).toEqual([]);
		expect(result.nothingToPresent).toBe(true);
		expect(result.scaffoldingUnrecognized).toBe(false);
	});

	it("keeps text before the first heading as an untitled section", () => {
		const result = cleanupDocument(
			"An opening paragraph [S1].\n\n## Next\nMore text.",
			"PROPOSAL",
		);

		expect(result.sections[0]).toMatchObject({
			heading: null,
			level: 0,
			headingPath: [],
			markdown: "An opening paragraph.",
		});
	});
});

describe("cleanupDocument — cost", () => {
	// Each shape backtracked quadratically in an earlier draft; a quadratic
	// regression takes minutes at this size, so the bound is generous.
	it.each([
		["a long interior space run", `## A\nx${" ".repeat(100_000)}y`],
		[
			"long indentation before a list item",
			`## A\n${" ".repeat(100_000)}- item`,
		],
		["spaces after a parenthesis", `## A\n(${" ".repeat(100_000)}x`],
		[
			"spaces after a status word",
			`## A\nx Confidence: Assumed${" ".repeat(100_000)}x`,
		],
		[
			"spaces after a label tag",
			`## A\nx (one line)${" ".repeat(100_000)}x`,
		],
		["many unclosed openers", `## A\n${"(Status: ".repeat(10_000)}`],
		// A numbered source list turns the numeric-marker rule on. The second
		// half puts a space before every bracket, so each one is a candidate.
		[
			"a 200 KB line of brackets and digits",
			`## A\n${"[1".repeat(50_000)}${" [12".repeat(25_000)}\n\n## Sources\n[1] Notes`,
		],
		[
			"a 200 KB line of adjacent numeric markers",
			`## A\n${"[1]".repeat(70_000)}\n\n## Sources\n[1] Notes`,
		],
		// `.` stops at a line separator (U+2028) that `\s` still matches, so
		// a value group after a whitespace run backtracked over the run.
		[
			"a footnote definition of spaces ending in a line separator",
			`## A\nText.\n[^1]:${" ".repeat(100_000)} `,
		],
		[
			"an escaped footnote definition of spaces before a line separator",
			`## A\nText.\n\\[^1\\]:${" ".repeat(100_000)} b`,
		],
		[
			"a status tag line with a line separator after spaces",
			`## A\nText.\n- **Confidence:**${" ".repeat(100_000)}a b`,
		],
		[
			"a cover field with a line separator after spaces",
			`## Cover\n- Client:${" ".repeat(100_000)}a b`,
		],
		[
			"a source entry with a line separator after spaces",
			`## Sources\n[S1]${" ".repeat(100_000)}a b`,
		],
		[
			"many mid-sentence evidence labels",
			`## A\n${"the key evidence: [S1] a ".repeat(10_000)}`,
		],
		[
			"many unseparated clauses",
			`## A\n${"x. Data sources: [S1] a ".repeat(10_000)}`,
		],
		[
			"a long anchor before a status parenthetical",
			`## A\nx. Evidence: [S1] — ${"a ".repeat(100_000)}(Status: Assumed)`,
		],
		[
			"a source-index line of many joined entries",
			`## A\nx [1]\n\n## Sources\n${Array.from({ length: 20_000 }, (_, i) => `[S${i}] a [${i % 999}] b`).join(" ")}`,
		],
		[
			"a line of many joined footnote definitions",
			`## A\nx [^1]\n\n${Array.from({ length: 20_000 }, (_, i) => `[^${i}]: a [^${i}]:`).join(" ")}`,
		],
		[
			"a source-index line with a long space run between entries",
			`## Sources\n[S1]${" ".repeat(100_000)}[S2]${" ".repeat(100_000)}x`,
		],
		[
			"a References entry of dashes and a link",
			`## A\nx [1]\n\n## References\n- a${" —".repeat(50_000)} [b](https://example.com)`,
		],
		[
			"many evidence clauses on one line",
			`## A\n${"x. Evidence: [S1] — a ".repeat(10_000)}`,
		],
		[
			"many evidence labels without markers",
			`## A\n${"Evidence: ".repeat(20_000)}`,
		],
		[
			"an evidence clause before a long anchor",
			`## A\nx. Evidence: [S1] — ${"a ".repeat(100_000)}B.`,
		],
	])("stays linear on %s", (_name, markdown) => {
		const start = performance.now();
		cleanupDocument(markdown, "BUSINESS_CASE");
		expect(performance.now() - start).toBeLessThan(2000);
	});
});

describe("cleanupDocument — title-free section identity", () => {
	const proposal = fixture("proposal.md");
	const originalTitle = "# Project Proposal: Example Field Service Portal";
	const renamed = proposal.replace(
		originalTitle,
		"# Revised Proposal: Example Dispatch Portal",
	);

	it("keys every section the same after the `#` title is renamed", () => {
		const before = cleanupDocument(proposal, "PROPOSAL");
		const after = cleanupDocument(renamed, "PROPOSAL");

		expect(proposal).toContain(originalTitle);
		expect(after.title).toBe("Revised Proposal: Example Dispatch Portal");
		expect(keysBySection(after)).toEqual(keysBySection(before));
		expect(sectionByHeading(before, "Objectives").headingPath).toEqual([
			"objectives and success metrics",
			"objectives",
		]);
	});

	it("keys a renamed, editor-round-tripped titled document the same as the original", () => {
		const before = cleanupDocument(proposal, "PROPOSAL");
		const after = cleanupDocument(
			simulateEditorRoundTrip(renamed),
			"PROPOSAL",
		);

		expect(keysBySection(after)).toEqual(keysBySection(before));
	});

	it("keeps the paths of a document with no `#` title", () => {
		const result = cleanupDocument(
			"## Scope\n### Phase 1\nIntake and dispatch.",
			"PROPOSAL",
		);

		expect(result.title).toBeNull();
		expect(result.sections.map((section) => section.headingPath)).toEqual([
			["scope"],
			["scope", "phase 1"],
		]);
		expect(
			sectionByHeading(
				cleanupDocument(fixture("business-case.md"), "BUSINESS_CASE"),
				"2.1 Problem / Opportunity",
			).headingPath,
		).toEqual(["context & case for change", "2.1 problem / opportunity"]);
	});

	it("drops the title only from the sections under it, not from a later `#`", () => {
		const result = cleanupDocument(
			[
				"# Example Proposal",
				"",
				"## Scope",
				"Intake and dispatch.",
				"",
				"# Delivery Detail",
				"",
				"## Scope",
				"Two phases.",
			].join("\n"),
			"PROPOSAL",
		);

		expect(result.title).toBe("Example Proposal");
		expect(result.sections.map((section) => section.headingPath)).toEqual([
			["scope"],
			["delivery detail"],
			["delivery detail", "scope"],
		]);
	});

	// Only a section's own headings decide whether it is key.
	it("makes `Budget` a key section under an `Investment Proposal` title, and `Background` not", () => {
		const result = cleanupDocument(
			[
				"# Investment Proposal",
				"## Background",
				"Dispatchers re-key every work order.",
				"## Budget",
				"The first phase is fixed at 240k.",
			].join("\n"),
			"PROPOSAL",
		);

		expect(
			isKeySection(sectionByHeading(result, "Budget").headingPath),
		).toBe(true);
		expect(
			isKeySection(sectionByHeading(result, "Background").headingPath),
		).toBe(false);
	});

	it("keeps a preserved slot under its heading, with the same section key, after a title rename", () => {
		const slot =
			'<visual-slot data-slot-id="slot-1" data-kind="timeline"></visual-slot>';
		const previous = [
			"# Investment Proposal",
			"",
			"## Scope",
			"Intake and dispatch.",
			"",
			slot,
			"",
			"Technician updates follow.",
		].join("\n");
		// A regenerated body: new title, slot tags gone.
		const incoming = stripVisualSlots(
			previous.replace("# Investment Proposal", "# Growth Proposal"),
		);
		const preserved = preserveVisualSlots(previous, incoming);

		const [before] = cleanupDocument(previous, "PROPOSAL").sections;
		const [after] = cleanupDocument(preserved, "PROPOSAL").sections;

		expect(preserved).toContain("# Growth Proposal");
		expect(after.heading).toBe("Scope");
		expect(after.anchors).toEqual(before.anchors);
		expect(after.anchors).toMatchObject([
			{ slotId: "slot-1", blockIndex: 1 },
		]);
		expect(sectionKey(after)).toBe(sectionKey(before));
	});
});

describe("cleanupDocument — editor round trip", () => {
	it("keys every Proposal section the same before and after a round trip", () => {
		const source = fixture("proposal.md");
		const before = cleanupDocument(source, "PROPOSAL");
		const after = cleanupDocument(
			simulateEditorRoundTrip(source),
			"PROPOSAL",
		);

		expect(keysBySection(after)).toEqual(keysBySection(before));
		expect(after.appendix.sources).toEqual(before.appendix.sources);
		expect(after.scaffoldingUnrecognized).toBe(false);
	});

	it("keys Business Case sections the same before and after a round trip", () => {
		const source = fixture("business-case.md");
		const before = keysBySection(cleanupDocument(source, "BUSINESS_CASE"));
		const roundTripped = cleanupDocument(
			simulateEditorRoundTrip(source),
			"BUSINESS_CASE",
		);
		const after = keysBySection(roundTripped);

		// Known exception: once the editor joins `Owner/decider: TBD` and
		// `Needed by: TBD` onto the question line, they are no longer
		// placeholder lines, so the Open Questions text itself differs.
		const openQuestions = "open questions#0";
		expect([...after.keys()]).toEqual([...before.keys()]);
		for (const [key, value] of before) {
			if (key !== openQuestions) {
				expect({ key, value: after.get(key) }).toEqual({ key, value });
			}
		}
		expect(roundTripped.appendix.sources).toEqual(
			cleanupDocument(source, "BUSINESS_CASE").appendix.sources,
		);
		expect(roundTripped.appendix.placeholders.map((p) => p.text)).toEqual(
			expect.arrayContaining([
				"Owner: TBD",
				"Decision Needed By: TBD",
				"Links: TBD",
			]),
		);
		expect(roundTripped.scaffoldingUnrecognized).toBe(false);
	});
});

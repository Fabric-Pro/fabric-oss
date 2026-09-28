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
import { computeSectionKey } from "../lib/glossy/keys";
import { parseVisualSlots, stripVisualSlots } from "../lib/glossy/visual-slots";

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
		expect(text).not.toMatch(/\\?\[S\d/);
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
	])("stays linear on %s", (_name, markdown) => {
		const start = performance.now();
		cleanupDocument(markdown, "BUSINESS_CASE");
		expect(performance.now() - start).toBeLessThan(2000);
	});
});

describe("cleanupDocument — editor round trip", () => {
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

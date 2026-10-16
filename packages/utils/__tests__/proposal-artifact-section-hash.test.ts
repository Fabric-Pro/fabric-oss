import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	documentProseHash,
	findSection,
	isCurrentSectionVersion,
	PREAMBLE_SECTION_KEY,
	type SectionMap,
} from "../lib/proposal-artifact/section-hash";
import golden from "./fixtures/proposal-section-hash.golden.json";

const lines = (...parts: string[]) => parts.join("\n");

const PROPOSAL = lines(
	"# Proposal for Example Org",
	"",
	"Prepared by the delivery team.",
	"",
	"## 3. Scope",
	"",
	"Example Org needs one reporting platform.",
	"",
	"### Out of Scope",
	"",
	"Hardware procurement.",
	"",
	"## 4. Timeline",
	"",
	"Twelve weeks in three phases.",
	"",
);

const keys = (map: SectionMap) => map.sections.map((section) => section.key);

const hashOf = (markdown: string, key: string) =>
	findSection(buildSectionMap(markdown), key)?.proseHash;

/** The section hashes of two bodies, keyed, for an at-a-glance comparison. */
const hashes = (markdown: string) =>
	Object.fromEntries(
		buildSectionMap(markdown).sections.map((section) => [
			section.key,
			section.proseHash,
		]),
	);

/** Whether `a` and `b`, each one section under `## S`, hash the same. */
const sameSection = (a: string, b: string) =>
	hashOf(`## S\n\n${a}`, "p1:s#0") === hashOf(`## S\n\n${b}`, "p1:s#0");

describe("golden fixture", () => {
	it.each(golden.cases.map((entry) => [entry.name, entry] as const))(
		"%s",
		(_name, entry) => {
			const map = buildSectionMap(entry.markdown);

			expect(map).toEqual(entry.expected);
			expect(documentProseHash(entry.markdown)).toBe(
				entry.expected.documentProseHash,
			);
		},
	);
});

describe("buildSectionMap", () => {
	it("keys sections by anchor path and occurrence, without the title", () => {
		const map = buildSectionMap(PROPOSAL);

		expect(map.sections.map(({ proseHash: _, ...rest }) => rest)).toEqual([
			{
				key: PREAMBLE_SECTION_KEY,
				headingText: null,
				depth: 0,
				headingPath: [],
				occurrenceIndex: 0,
				startLine: 1,
				endLine: 4,
			},
			{
				key: "p1:scope#0",
				headingText: "3. Scope",
				depth: 2,
				headingPath: ["scope"],
				occurrenceIndex: 0,
				startLine: 5,
				endLine: 8,
			},
			{
				key: "p1:scope/out of scope#0",
				headingText: "Out of Scope",
				depth: 3,
				headingPath: ["scope", "out of scope"],
				occurrenceIndex: 0,
				startLine: 9,
				endLine: 12,
			},
			{
				key: "p1:timeline#0",
				headingText: "4. Timeline",
				depth: 2,
				headingPath: ["timeline"],
				occurrenceIndex: 0,
				startLine: 13,
				endLine: 16,
			},
		]);
		for (const section of map.sections) {
			expect(section.proseHash).toMatch(/^p1:[0-9a-f]{16}$/);
		}
		expect(map.documentProseHash).toMatch(/^p1:[0-9a-f]{16}$/);
	});

	it("keeps the key and hash when a heading is renumbered, and changes the key when it is renamed", () => {
		const before = buildSectionMap(PROPOSAL);
		const renumbered = buildSectionMap(
			PROPOSAL.replace("## 3. Scope", "## 4. Scope"),
		);
		const renamed = buildSectionMap(
			PROPOSAL.replace("## 3. Scope", "## 3. Boundaries"),
		);

		expect(keys(renumbered)).toEqual(keys(before));
		expect(renumbered.sections.map((s) => s.proseHash)).toEqual(
			before.sections.map((s) => s.proseHash),
		);
		expect(keys(renamed)).toContain("p1:boundaries#0");
		expect(keys(renamed)).toContain("p1:boundaries/out of scope#0");
		expect(keys(renamed)).not.toContain("p1:scope#0");
	});

	it("changes no section key or hash when the document title is renamed", () => {
		const renamed = PROPOSAL.replace(
			"# Proposal for Example Org",
			"# Platform Proposal (Draft)",
		);

		expect(buildSectionMap(renamed).sections).toEqual(
			buildSectionMap(PROPOSAL).sections,
		);
	});

	it("changes only the edited section's hash when an H3 or a prose word changes", () => {
		const before = hashes(PROPOSAL);
		const h3Edit = hashes(
			PROPOSAL.replace("Hardware procurement.", "Hardware leasing."),
		);
		const h2Edit = hashes(PROPOSAL.replace("Twelve weeks", "Ten weeks"));

		expect(h3Edit["p1:scope/out of scope#0"]).not.toBe(
			before["p1:scope/out of scope#0"],
		);
		expect({ ...h3Edit, "p1:scope/out of scope#0": null }).toEqual({
			...before,
			"p1:scope/out of scope#0": null,
		});
		expect(h2Edit["p1:timeline#0"]).not.toBe(before["p1:timeline#0"]);
		expect({ ...h2Edit, "p1:timeline#0": null }).toEqual({
			...before,
			"p1:timeline#0": null,
		});
	});

	it("gives sections with the same heading distinct keys by occurrence", () => {
		const map = buildSectionMap(
			lines(
				"## Risks",
				"",
				"Vendor delays.",
				"",
				"## Risks",
				"",
				"Scope growth.",
			),
		);

		expect(keys(map)).toEqual(["p1:risks#0", "p1:risks#1"]);
		expect(map.sections[0].proseHash).not.toBe(map.sections[1].proseHash);
	});

	it("counts occurrences on the path without the title, so a later top-level heading cannot collide", () => {
		const map = buildSectionMap(
			lines(
				"# Proposal",
				"",
				"## Scope",
				"",
				"One.",
				"",
				"# Scope",
				"",
				"Two.",
			),
		);

		expect(keys(map)).toEqual(["p1:scope#0", "p1:scope#1"]);
	});

	it("reads setext and indented ATX headings as sections", () => {
		const map = buildSectionMap(
			lines(
				"Approach",
				"--------",
				"",
				"Text.",
				"",
				"   ## Delivery",
				"",
				"More text.",
			),
		);

		expect(keys(map)).toEqual(["p1:approach#0", "p1:delivery#0"]);
		expect(map.sections[0]).toMatchObject({
			depth: 2,
			startLine: 1,
			endLine: 5,
		});
	});

	it("never reads a heading inside a fence, an HTML block, a quote or a list as a section", () => {
		const map = buildSectionMap(
			lines(
				"## Background",
				"",
				"```",
				"## fenced",
				"```",
				"",
				"<div>",
				"## inside an HTML block",
				"</div>",
				"",
				"> ## quoted",
				"",
				"- ## listed",
			),
		);

		expect(keys(map)).toEqual(["p1:background#0"]);
	});

	it("reads CRLF and CR bodies exactly as their LF form", () => {
		const lf = buildSectionMap(PROPOSAL);

		expect(buildSectionMap(PROPOSAL.replace(/\n/g, "\r\n"))).toEqual(lf);
		expect(buildSectionMap(PROPOSAL.replace(/\n/g, "\r"))).toEqual(lf);
	});

	it("reads decomposed text as its NFC form", () => {
		const composed = "## Café\n\nRésumé review.";
		const decomposed = composed.normalize("NFD");

		expect(decomposed).not.toBe(composed);
		expect(buildSectionMap(decomposed)).toEqual(buildSectionMap(composed));
	});

	it("reads a lone surrogate as a replacement character and keeps emoji pairs", () => {
		expect(buildSectionMap("## Note \uD800\n\nText 🚀 \uDC00.")).toEqual(
			buildSectionMap("## Note \uFFFD\n\nText 🚀 \uFFFD."),
		);
		expect(sameSection("Ready 🚀", "Ready \uFFFD\uFFFD")).toBe(false);
	});

	it("lists the preamble only when it holds text, the title's lead-in included", () => {
		expect(keys(buildSectionMap("# Title\n\n## A\n\nText."))).toEqual([
			"p1:a#0",
		]);
		expect(keys(buildSectionMap("# Title\n\nLead-in.\n\n## A"))).toEqual([
			PREAMBLE_SECTION_KEY,
			"p1:a#0",
		]);
		expect(keys(buildSectionMap("Before any heading.\n\n## A"))).toEqual([
			PREAMBLE_SECTION_KEY,
			"p1:a#0",
		]);
		expect(keys(buildSectionMap(""))).toEqual([]);
	});

	it("escapes key separators in an anchor, so no heading spells a reserved key", () => {
		const map = buildSectionMap(
			lines(
				"## @preamble",
				"",
				"Text.",
				"",
				"## @document",
				"",
				"## a/b #c 100%",
			),
		);

		expect(keys(map)).toEqual([
			"p1:%40preamble#0",
			"p1:%40document#0",
			"p1:a%2Fb %23c 100%25#0",
		]);
		expect(keys(map)).not.toContain(PREAMBLE_SECTION_KEY);
		expect(keys(map)).not.toContain(DOCUMENT_SECTION_KEY);
	});

	it("keys a heading whose text is only decoration", () => {
		expect(keys(buildSectionMap("## ***\n\nText.\n\n## ***"))).toEqual([
			"p1:#0",
			"p1:#1",
		]);
	});

	it("names a section by its decoded heading text, not its link destination", () => {
		const map = buildSectionMap(
			"## [Scope](https://example.com/a%20b) `v2`",
		);

		expect(map.sections[0]).toMatchObject({
			key: "p1:scope v2#0",
			headingText: "Scope v2",
		});
		expect(
			keys(buildSectionMap("## [Scope](https://example.com/other) `v2`")),
		).toEqual(keys(map));
	});
});

describe("prose hash projection", () => {
	it("ignores a mermaid fence entirely, colours and marker included", () => {
		const fence = (fill: string, id: string) =>
			lines(
				"Intro.",
				"",
				"```mermaid",
				`%% fabric-visual: ${id}`,
				"flowchart TD",
				"  A[Plan] --> B[Build]",
				`  style A fill:${fill}`,
				"```",
			);

		expect(
			sameSection(
				fence("#ffffff", "a1b2c3d4e5f6"),
				fence("#123456", "f6e5d4c3b2a1"),
			),
		).toBe(true);
		expect(sameSection(fence("#ffffff", "a1b2c3d4e5f6"), "Intro.")).toBe(
			true,
		);
	});

	it("ignores the fences the editor saves as diagrams", () => {
		expect(sameSection("```flowchart\nA-->B\n```", "")).toBe(true);
		expect(sameSection("```\ngraph TD\n  A-->B\n```", "")).toBe(true);
	});

	it("counts a stat-tiles fence's values, never its visual marker", () => {
		const tiles = (id: string, weeks: string) =>
			`\`\`\`stat-tiles\n%% fabric-visual: ${id}\nWeeks: ${weeks}\nTeams: 3\n\`\`\``;

		expect(
			sameSection(
				tiles("a1b2c3d4e5f6", "12"),
				tiles("b2c3d4e5f6a1", "12"),
			),
		).toBe(true);
		expect(
			sameSection(
				tiles("a1b2c3d4e5f6", "12"),
				tiles("a1b2c3d4e5f6", "14"),
			),
		).toBe(false);
		// The diagram sniff never applies to stat tiles.
		expect(sameSection("```stat-tiles\nTimeline: 6 weeks\n```", "")).toBe(
			false,
		);
	});

	it("ignores visual-slot tags", () => {
		expect(
			sameSection(
				'Text.\n\n<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="a > b"></visual-slot>',
				"Text.",
			),
		).toBe(true);
	});

	it("counts other fences by their text, not their language", () => {
		expect(
			sameSection('```json\n{ "a": 1 }\n```', '```js\n{ "a": 1 }\n```'),
		).toBe(true);
		expect(
			sameSection('```json\n{ "a": 1 }\n```', '```json\n{ "a": 2 }\n```'),
		).toBe(false);
		expect(sameSection('```json\n{ "a": 1 }\n```', "")).toBe(false);
	});

	it("hashes emphasis, bullet and escape spellings identically", () => {
		expect(
			sameSection("An *important* point.", "An _important_ point."),
		).toBe(true);
		expect(sameSection("A **bold** claim.", "A __bold__ claim.")).toBe(
			true,
		);
		expect(sameSection("- one\n- two", "* one\n* two")).toBe(true);
		expect(sameSection("- one\n- two", "+ one\n+ two")).toBe(true);
		expect(sameSection("A \\*literal\\* star", "A *literal* star")).toBe(
			true,
		);
		expect(
			sameSection("snake\\_case and 50\\%", "snake_case and 50%"),
		).toBe(true);
		expect(sameSection("AT&amp;T &mdash; ok", "AT&T — ok")).toBe(true);
	});

	it("collapses whitespace and soft wraps, but not hard breaks", () => {
		expect(sameSection("One  long\nsentence.", "One long sentence.")).toBe(
			true,
		);
		expect(
			sameSection("Line one  \nLine two", "Line one\\\nLine two"),
		).toBe(true);
		expect(
			sameSection("Line one  \nLine two", "Line one<br>Line two"),
		).toBe(true);
		expect(sameSection("Line one  \nLine two", "Line one\nLine two")).toBe(
			false,
		);
	});

	it("ignores link and image destinations, but counts their text and alt", () => {
		const link = (text: string, url: string) => `See [${text}](${url}).`;
		const image = (alt: string, url: string) => `![${alt}](${url})`;

		expect(
			sameSection(
				link("the terms", "https://example.com/a"),
				link("the terms", "https://example.com/b"),
			),
		).toBe(true);
		expect(
			sameSection(
				link("the terms", "https://example.com/a"),
				link("our terms", "https://example.com/a"),
			),
		).toBe(false);
		expect(
			sameSection(
				image("Overview", "https://example.com/a.png"),
				image("Overview", "https://example.com/b.png"),
			),
		).toBe(true);
		expect(
			sameSection(
				image("Overview", "https://example.com/a.png"),
				image("Summary", "https://example.com/a.png"),
			),
		).toBe(false);
		// A resized image is saved as an <img> tag and keeps its alt.
		expect(
			sameSection(
				image("Overview", "https://example.com/a.png"),
				'<img src="https://example.com/a.png" alt="Overview" width="320" />',
			),
		).toBe(true);
	});

	it("counts inline code text", () => {
		expect(sameSection("Run `deploy` now.", "Run deploy now.")).toBe(true);
		expect(sameSection("Run `deploy` now.", "Run `release` now.")).toBe(
			false,
		);
	});

	it("changes when a list item is split or text moves between table cells", () => {
		expect(sameSection("- alpha beta", "- alpha\n- beta")).toBe(false);
		expect(
			sameSection(
				"| A | B |\n|---|---|\n| one two | three |",
				"| A | B |\n|---|---|\n| one | two three |",
			),
		).toBe(false);
	});

	it("ignores list numbering, tight versus loose lists and table alignment", () => {
		expect(sameSection("1. one\n1. two", "3. one\n4. two")).toBe(true);
		expect(sameSection("- one\n- two", "- one\n\n- two")).toBe(true);
		expect(sameSection("| A |\n|:--|\n| x |", "| A |\n|--:|\n| x |")).toBe(
			true,
		);
	});

	it("reads a task item's box as the text the editor saves it as", () => {
		expect(
			sameSection("- [x] Kickoff agreed.", "- \\[x\\] Kickoff agreed."),
		).toBe(true);
		expect(
			sameSection("- [x] Kickoff agreed.", "- [ ] Kickoff agreed."),
		).toBe(false);
	});

	it("counts HTML by its text: comments and tags go, entities decode", () => {
		expect(
			sameSection(
				"A <mark>key</mark> point.<!-- note -->",
				"A key point.",
			),
		).toBe(true);
		expect(sameSection("<div>Note &amp; more</div>", "Note & more")).toBe(
			true,
		);
	});

	it("excludes a section's own heading, so renumbering changes no hash", () => {
		expect(hashOf("## 3. Scope\n\nText.", "p1:scope#0")).toBe(
			hashOf("## 4. Scope (Required)\n\nText.", "p1:scope#0"),
		);
	});
});

describe("documentProseHash", () => {
	it("equals the map's document hash", () => {
		expect(documentProseHash(PROPOSAL)).toBe(
			buildSectionMap(PROPOSAL).documentProseHash,
		);
	});

	it("covers headings and the title, but not formatting", () => {
		const base = documentProseHash(PROPOSAL);

		expect(
			documentProseHash(PROPOSAL.replace("# Proposal", "# Offer")),
		).not.toBe(base);
		expect(
			documentProseHash(
				PROPOSAL.replace("## 3. Scope", "## 3. Boundaries"),
			),
		).not.toBe(base);
		expect(documentProseHash(PROPOSAL.replace("Twelve", "Ten"))).not.toBe(
			base,
		);
		expect(
			documentProseHash(
				PROPOSAL.replace("## 3. Scope", "## 3\\. Scope").replace(
					"one reporting platform",
					"one *reporting* platform",
				),
			),
		).toBe(base);
	});
});

describe("findSection and isCurrentSectionVersion", () => {
	it("finds a section by key and misses an absent one", () => {
		const map = buildSectionMap(PROPOSAL);

		expect(findSection(map, "p1:timeline#0")?.headingText).toBe(
			"4. Timeline",
		);
		expect(findSection(map, "p1:timeline#1")).toBeUndefined();
		expect(findSection(map, DOCUMENT_SECTION_KEY)).toBeUndefined();
	});

	it("recognises only the current version prefix", () => {
		expect(isCurrentSectionVersion("p1:scope#0")).toBe(true);
		expect(isCurrentSectionVersion("p1:0123456789abcdef")).toBe(true);
		expect(isCurrentSectionVersion("p2:scope#0")).toBe(false);
		expect(isCurrentSectionVersion("scope#0")).toBe(false);
	});
});

describe("module boundaries", () => {
	it.each(["markdown-ast.ts", "section-hash.ts", "finding-state.ts"])(
		"%s imports no Node built-in",
		(file) => {
			const source = readFileSync(
				new URL(`../lib/proposal-artifact/${file}`, import.meta.url),
				"utf8",
			);

			expect(source).not.toMatch(/from\s+["']node:/);
			expect(source).not.toMatch(/from\s+["'](?:fs|path|crypto|os)["']/);
		},
	);
});

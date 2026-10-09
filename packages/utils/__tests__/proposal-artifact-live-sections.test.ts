import { describe, expect, it } from "vitest";
import { completedSections } from "../lib/proposal-artifact/live-sections";

const lines = (...parts: string[]) => parts.join("\n");

const PROPOSAL = lines(
	"# Website Redesign Proposal",
	"",
	"Prepared for Example Org.",
	"",
	"## Overview",
	"",
	"Example Org wants a faster, clearer website.",
	"",
	"## Approach",
	"",
	"### Discovery",
	"",
	"Two weeks of interviews and analytics review.",
	"",
	"```mermaid",
	"flowchart LR",
	"## Not a heading",
	"```",
	"",
	"### Delivery",
	"",
	"Six two-week sprints.",
	"",
	"## Investment",
	"",
	"| Phase | Weeks |",
	"| --- | --- |",
	"| Discovery | 2 |",
);

describe("completedSections", () => {
	it("returns only the sections before the last H2 when the preview ends mid-section", () => {
		const partial = lines(
			"## Overview",
			"",
			"Example Org wants a faster website.",
			"",
			"## Approach",
			"",
			"We will start with disc",
		);

		expect(completedSections(partial)).toBe(
			lines("## Overview", "", "Example Org wants a faster website."),
		);
	});

	it("treats an H3 as a section boundary", () => {
		const partial = lines(
			"### Discovery",
			"",
			"Interviews.",
			"",
			"### Delivery",
			"",
			"Six spr",
		);

		expect(completedSections(partial)).toBe(
			lines("### Discovery", "", "Interviews."),
		);
	});

	it("falls back to H4 for a document that uses only H4 headings", () => {
		const partial = lines(
			"#### Goals",
			"",
			"Faster pages.",
			"",
			"#### Scope",
			"",
			"Home page and",
		);

		expect(completedSections(partial)).toBe(
			lines("#### Goals", "", "Faster pages."),
		);
	});

	it("does not count a leading # title when it falls back to a deeper level", () => {
		const partial = lines(
			"# Proposal",
			"",
			"#### Goals",
			"",
			"Faster pages.",
			"",
			"#### Scope",
			"",
			"Home page and",
		);

		expect(completedSections(partial)).toBe(
			lines("# Proposal", "", "#### Goals", "", "Faster pages."),
		);
	});

	it("cuts at the last # heading when every section is a # heading", () => {
		const partial = lines(
			"# Goals",
			"",
			"Faster pages.",
			"",
			"# Scope",
			"",
			"Home",
		);

		expect(completedSections(partial)).toBe(
			lines("# Goals", "", "Faster pages."),
		);
	});

	it("keeps a # title and its lead-in in the prefix once a section is complete", () => {
		const partial = PROPOSAL.slice(
			0,
			PROPOSAL.indexOf("## Investment") + 5,
		);

		expect(completedSections(partial)).toBe(
			PROPOSAL.slice(0, PROPOSAL.indexOf("## Investment")).trimEnd(),
		);
	});

	it("never treats a heading inside a fenced block as a boundary", () => {
		const partial = lines(
			"## Approach",
			"",
			"```mermaid",
			"flowchart LR",
			"## Not a heading",
			"A --> B",
		);

		expect(completedSections(partial)).toBe("");
	});

	it("excludes a fence still streaming after the last boundary", () => {
		const partial = lines(
			"## Overview",
			"",
			"Text.",
			"",
			"## Approach",
			"",
			"```mermaid",
			"flowchart LR",
			"### Phase",
		);

		expect(completedSections(partial)).toBe(
			lines("## Overview", "", "Text."),
		);
	});

	it("closes an unclosed mermaid fence in the last complete section when the stream ended", () => {
		const partial = lines(
			"## Overview",
			"",
			"Text.",
			"",
			"## Timeline",
			"",
			"```mermaid",
			"flowchart LR",
			"A --> B",
			"",
		);

		expect(completedSections(partial, { ended: true })).toBe(
			lines(
				"## Overview",
				"",
				"Text.",
				"",
				"## Timeline",
				"",
				"```mermaid",
				"flowchart LR",
				"A --> B",
				"```",
			),
		);
	});

	it("closes a fence with its opener's own marker", () => {
		expect(
			completedSections(lines("## A", "~~~~ mermaid", "graph"), {
				ended: true,
			}),
		).toBe(lines("## A", "~~~~ mermaid", "graph", "~~~~"));
		expect(
			completedSections(lines("## A", "  ````", "code"), { ended: true }),
		).toBe(lines("## A", "  ````", "code", "````"));
	});

	it("leaves balanced fences alone when the stream ended", () => {
		expect(completedSections(PROPOSAL, { ended: true })).toBe(PROPOSAL);
	});

	it("returns the whole text, trailing whitespace trimmed, when the stream ended", () => {
		expect(completedSections(`${PROPOSAL}\n\n  \n`, { ended: true })).toBe(
			PROPOSAL,
		);
	});

	it("returns an empty prefix for an empty preview", () => {
		expect(completedSections("")).toBe("");
		expect(completedSections("", { ended: true })).toBe("");
	});

	it("returns an empty prefix for a preview with no heading", () => {
		expect(completedSections("Example Org wants a faster website.")).toBe(
			"",
		);
	});

	it("shows nothing but the title while the first section is still being written", () => {
		expect(
			completedSections(lines("# Proposal", "", "## Overview", "Te")),
		).toBe(lines("# Proposal"));
		expect(completedSections(lines("## Overview", "", "Text"))).toBe("");
	});

	it("returns the whole text of a preview with no heading once the stream ended", () => {
		expect(
			completedSections("Example Org wants a faster website.", {
				ended: true,
			}),
		).toBe("Example Org wants a faster website.");
	});

	it("reads Windows line endings", () => {
		const partial = "## Overview\r\n\r\nText.\r\n\r\n## Approach\r\n\r\nWe";

		expect(completedSections(partial)).toBe(
			lines("## Overview", "", "Text."),
		);
	});

	it("only ever grows, and is always a prefix of the finished document, as the stream advances", () => {
		let previous = "";
		for (let end = 0; end <= PROPOSAL.length; end++) {
			const preview = completedSections(PROPOSAL.slice(0, end));
			expect(PROPOSAL.startsWith(preview)).toBe(true);
			expect(preview.length).toBeGreaterThanOrEqual(previous.length);
			previous = preview;
		}
		expect(previous).toBe(
			PROPOSAL.slice(0, PROPOSAL.indexOf("## Investment")).trimEnd(),
		);
	});

	it("gives the same preview for the same input", () => {
		const partial = PROPOSAL.slice(0, 300);
		expect(completedSections(partial)).toBe(completedSections(partial));
	});
});

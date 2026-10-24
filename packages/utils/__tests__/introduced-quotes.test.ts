import { describe, expect, it } from "vitest";
import { straightenIntroducedQuotes } from "../lib/introduced-quotes";

describe("straightenIntroducedQuotes", () => {
	it("straightens curly quotes the model introduced", () => {
		const baseline = "A missing role is shown as Unassigned.";
		const document =
			"A missing role is shown as “Unassigned” in each person’s row.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			'A missing role is shown as "Unassigned" in each person\'s row.',
		);
	});

	it("straightens every curly quote in a first generation", () => {
		expect(straightenIntroducedQuotes("‘a’ and “b”")).toBe("'a' and \"b\"");
	});

	it("keeps the author's quotes around text the model edited", () => {
		const baseline = "Say “hello world” twice.";
		const document = "Say “hello earth” twice.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(document);
	});

	it("keeps a quotation with an apostrophe intact when the model extends it", () => {
		const baseline = "The banner reads “don’t panic”.";
		const document = "The banner reads “don’t panic now”.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(document);
	});

	it("keeps an author's apostrophe when punctuation after its word changes", () => {
		const baseline = "Check the person’s data.";
		const document = "Check the person’s, then the team’s data.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			"Check the person’s, then the team's data.",
		);
	});

	it("straightens a new quote even when the author used the same character elsewhere", () => {
		const baseline = "Status reads “Draft”.\n\nNo quotes here.";
		const document = "Status reads “Draft”.\n\nNo “quotes” here.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			'Status reads “Draft”.\n\nNo "quotes" here.',
		);
	});

	it("straightens a curly quote that replaces an author's straight one", () => {
		const baseline = 'Label "Draft" and “Final”.';
		const document = "Label “Draft” and “Final”.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			'Label "Draft" and “Final”.',
		);
	});

	it("returns a document without curly quotes unchanged", () => {
		const document = 'Plain "straight" quotes and it\'s fine.';

		expect(straightenIntroducedQuotes(document, "“x”")).toBe(document);
	});

	it("keeps both marks curly when the model moves the end of an author's quotation", () => {
		const baseline = "Read the “A” and B.";
		const document = "Read the “A and B” now.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(document);
	});

	it("does not pair quotes across a paragraph break", () => {
		const baseline = "Intro “A”.\n\nNext line.";
		const document = "Intro “A.\n\nNext” line.";

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			'Intro “A.\n\nNext" line.',
		);
	});

	it("keeps quotes on unchanged lines however much else was rewritten", () => {
		const baseline = `Keep “this”.\n${"a ".repeat(5000)}\n`;
		const document = `Keep “this”.\n${"b ".repeat(5000)}“new”\n`;

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			`Keep “this”.\n${"b ".repeat(5000)}"new"\n`,
		);
	});

	it("straightens a region rewritten past the alignment bound", () => {
		const baseline = `“q” ${"a ".repeat(5000)}`;
		const document = `“q” ${"b ".repeat(5000)}“new”`;

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			`"q" ${"b ".repeat(5000)}"new"`,
		);
	});

	it("gives up on an unalignable region quickly", () => {
		const baseline = `“q” ${"a ".repeat(20000)}`;
		const document = `“q” ${"b ".repeat(20000)}`;

		const started = performance.now();
		straightenIntroducedQuotes(document, baseline);

		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("aligns every paragraph of a whole-document rewrite separately", () => {
		const before = (n: number) =>
			`Rule ${n}: the “owner’s” review is needed for item ${n} in every release.\n\n`;
		const after = (n: number) =>
			`Rule ${n} now says the “owner’s” review, a “final” gate, is needed for item ${n}.\n\n`;
		const baseline = Array.from({ length: 200 }, (_, n) => before(n)).join(
			"",
		);
		const document = Array.from({ length: 200 }, (_, n) => after(n)).join(
			"",
		);

		expect(straightenIntroducedQuotes(document, baseline)).toBe(
			document.replaceAll("“final”", '"final"'),
		);
	});

	it("aligns a whole-document rewrite of a long spec within the bound", () => {
		const paragraph = (n: number) =>
			`Rule ${n}: the “owner’s” review is required for item ${n}.\n\n`;
		const baseline = Array.from({ length: 120 }, (_, n) =>
			paragraph(n),
		).join("");
		const document = Array.from({ length: 120 }, (_, n) =>
			n % 3 === 0
				? `Rule ${n}: the “owner’s” sign-off, “final”, is required.\n\n`
				: paragraph(n),
		).join("");

		const result = straightenIntroducedQuotes(document, baseline);

		expect(result).toBe(document.replaceAll("“final”", '"final"'));
	});
});

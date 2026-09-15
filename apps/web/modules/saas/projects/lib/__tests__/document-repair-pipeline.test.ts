import { describe, expect, it } from "vitest";
import { fromMarkdown, repairMarkdownDocument } from "../diff-utils";
import { getTurndownService } from "../editor-markdown-save";
import { stripDiffTags } from "../editor-save-utils";
import { documentRepairFixtures } from "./document-repair-fixtures";

// Round-trip through the SAME turndown the editor uses on save
// (`getTurndownService`), not a bespoke instance — otherwise the harness can
// escape characters (e.g. a leading `*`) differently from production and test
// a serialization that never actually ships.
function simulateRoundTrip(markdown: string): string {
	const html = fromMarkdown(markdown);
	return repairMarkdownDocument(
		getTurndownService().turndown(stripDiffTags(html)),
	);
}

function canonicalizeFixtureText(text: string): string {
	// Turndown pads an ordered marker to a fixed width (`38.  Item`), so
	// collapse marker whitespace before comparing — the fixtures assert
	// structure, not the serializer's column alignment.
	return text
		.replace(/^(\s*[-*+])\s+/gm, "$1 ")
		.replace(/^(\s*\d+[.)])\s+/gm, "$1 ");
}

describe("document repair pipeline fixtures", () => {
	for (const fixture of documentRepairFixtures) {
		it(`repairs ${fixture.name}`, () => {
			const normalized = canonicalizeFixtureText(
				repairMarkdownDocument(fixture.input),
			);
			const html = fromMarkdown(fixture.input);
			const canonicalRoundTrip = canonicalizeFixtureText(
				repairMarkdownDocument(simulateRoundTrip(fixture.input)),
			);

			for (const expected of fixture.expectNormalized) {
				expect(normalized).toContain(expected);
				expect(canonicalRoundTrip).toContain(expected);
			}

			for (const expected of fixture.expectHtml) {
				expect(html).toContain(expected);
			}

			for (const absent of fixture.expectAbsent ?? []) {
				expect(normalized).not.toContain(absent);
				expect(canonicalRoundTrip).not.toContain(absent);
			}
		});
	}

	it("does not restructure diff-marked text (would corrupt ADD/DEL pairing)", () => {
		// The structure repair merges bullets; running it on diff-marked content
		// would split a marker from its pair. `repairMarkdownDocument` must leave a
		// split bullet split while ADD/DEL markers are present.
		const ZW = String.fromCharCode(0x200b);
		const ADD_START = `${ZW}ADD_START${ZW}`;
		const ADD_END = `${ZW}ADD_END${ZW}`;
		const diffMarked = [
			`- ${ADD_START}**Dependency*${ADD_END}`,
			"",
			`- ${ADD_START}*: Release notes review/approval step${ADD_END}`,
		].join("\n");
		const out = repairMarkdownDocument(diffMarked);
		expect(out).toContain(ADD_START);
		expect(out).toContain(ADD_END);
		// The two bullets stay separate (not merged into one).
		expect(out).not.toContain(
			"**Dependency**: Release notes review/approval step",
		);
	});
});

describe("bare fences and escaped list markers", () => {
	const fence = (body: string, lang = "") =>
		`Intro.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;

	it("unwraps a bare fence whose body is only sentence prose", () => {
		const repaired = repairMarkdownDocument(
			fence(
				" WHEN a user attempts active chat work capture\n THEN Fabric blocks capture and explains the setup.",
			),
		);
		expect(repaired).not.toContain("```");
		expect(repaired).toContain(
			"WHEN a user attempts active chat work capture",
		);
	});

	it("keeps a bare fence holding shell commands", () => {
		const repaired = repairMarkdownDocument(
			fence("npm install --save-dev vitest\npnpm run build"),
		);
		expect(repaired).toContain("```");
	});

	it("keeps a bare fence holding JSON", () => {
		const repaired = repairMarkdownDocument(
			fence('{\n  "name": "fabric",\n  "private": true\n}'),
		);
		expect(repaired).toContain("```");
	});

	it("keeps a bare fence holding SQL", () => {
		const repaired = repairMarkdownDocument(
			fence("SELECT id FROM stories\nWHERE project_id = $1 ORDER BY id"),
		);
		expect(repaired).toContain("```");
	});

	it("keeps a bare fence whose body is indented code", () => {
		const repaired = repairMarkdownDocument(
			fence(
				"  the quick brown fox jumps over\n  the very lazy sleeping dog",
			),
		);
		expect(repaired).toContain("```");
	});

	it("keeps a language-tagged fence even when its body reads as prose", () => {
		const repaired = repairMarkdownDocument(
			fence(
				"WHEN a user attempts active chat work capture\nTHEN Fabric blocks the capture attempt",
				"text",
			),
		);
		expect(repaired).toContain("```text");
	});

	it("drops an empty bare fence pair", () => {
		const repaired = repairMarkdownDocument(
			"Intro.\n\n```\n```\n\nOutro.\n",
		);
		expect(repaired).not.toContain("```");
		expect(repaired).toContain("Intro.");
		expect(repaired).toContain("Outro.");
	});

	it("keeps an empty language-tagged fence", () => {
		// A language tag is explicit author intent that the block is code,
		// even with nothing in it yet. Dropping it would delete content the
		// user typed, on every load.
		for (const lang of ["json", "mermaid", "bash"]) {
			const repaired = repairMarkdownDocument(
				`Intro.\n\n\`\`\`${lang}\n\`\`\`\n\nOutro.\n`,
			);
			expect(repaired, lang).toContain(`\`\`\`${lang}`);
		}
	});

	it("keeps a single-token body in a bare fence", () => {
		// The language-sniff branch moves a lone token into the info string,
		// leaving an empty body — the token must not be dropped with it.
		const repaired = repairMarkdownDocument(
			"Intro.\n\n```\nnpm\n```\n\nOutro.\n",
		);
		expect(repaired).toContain("npm");
	});

	it("keeps an unclosed trailing fence that has a body", () => {
		const repaired = repairMarkdownDocument(
			"Intro.\n\n```\nSELECT id FROM stories WHERE id = $1\n",
		);
		expect(repaired).toContain("SELECT id FROM stories");
	});

	it("does not manufacture a pair from an unclosed trailing fence", () => {
		const repaired = repairMarkdownDocument("Intro paragraph.\n\n```\n");
		expect(repaired).not.toContain("```");
	});

	it("unescapes a numbered marker at the start of a line", () => {
		expect(
			repairMarkdownDocument("38\\. GIVEN a condition holds\n"),
		).toContain("38. GIVEN a condition holds");
	});

	it("does not unescape a numbered marker inside a fenced code block", () => {
		const repaired = repairMarkdownDocument(
			"Intro.\n\n```bash\n38\\. echo hello world from here\n```\n",
		);
		expect(repaired).toContain("38\\.");
	});

	it("does not unescape a numbered marker away from line start", () => {
		const repaired = repairMarkdownDocument(
			"See item 38\\. for details.\n",
		);
		expect(repaired).toContain("38\\.");
	});

	it("does not unescape an indented code block line", () => {
		// Four-plus spaces is an indented code block, where the backslash
		// is literal text rather than a serializer artifact.
		const repaired = repairMarkdownDocument(
			"Intro.\n\n        38\\. literal text here\n",
		);
		expect(repaired).toContain("38\\.");
	});

	it("does not unescape inside a fence opened with a different delimiter", () => {
		// A ``` block is closed only by ```, so a ~~~ line inside it is
		// content and must not toggle the fence state off.
		const repaired = repairMarkdownDocument(
			"Intro.\n\n```bash\n~~~\n38\\. echo hello there friend\n```\n",
		);
		expect(repaired).toContain("38\\.");
	});

	it("keeps repairing an escaped numbered heading", () => {
		expect(
			repairMarkdownDocument("## 4\\. API Specifications\n"),
		).toContain("## 4. API Specifications");
	});
});

/**
 * Load-path repair of tilde-prefixed quote artifacts.
 *
 * This direction had no tilde coverage at all, which is how the defect stayed
 * visible after the serializer was fixed: every existing test drove HTML ->
 * markdown, proving the editor could no longer CREATE the artifact, while the
 * documents already carrying it were read back untouched on every open.
 *
 * The load half is where the repair lives, and only there. The round trip is a
 * fixed point — markdown-it emits a lone tilde as literal text and the Turndown
 * escape override never escapes one — so a reader could open a damaged
 * document, edit it, save it and see the identical characters forever. Putting
 * the repair on the SAVE path instead was tried and reverted: that is the
 * silent rewrite of user text this pipeline removed in Fizzy #1987, and it also
 * rewrites code the user never meant to touch.
 *
 * Fixtures here are synthetic. The reported document's own prose is not
 * reproduced, per the repository's identifier rule.
 */
describe("load-path quote-artifact repair", () => {
	const OPEN = "\u201C";
	const CLOSE = "\u201D";
	const STORED_CORRUPT = `a proposal to own the ~${OPEN}~${OPEN}~${OPEN}example category~~${CLOSE}~${CLOSE}~~${CLOSE} outright`;
	const EXPECTED = `a proposal to own the ${OPEN}example category${CLOSE} outright`;

	it("collapses a doubling artifact run to the single quote it should be", () => {
		expect(repairMarkdownDocument(STORED_CORRUPT)).toBe(EXPECTED);
	});

	it("leaves no stray tilde in what the reader is shown", () => {
		const html = fromMarkdown(repairMarkdownDocument(STORED_CORRUPT));
		expect(html).not.toContain("~");
		expect(html).toContain("example category");
	});

	// The repair deliberately sits OUTSIDE the diff-marker guard that protects
	// `repairDegradedMarkdown`. That guard exists because merging bullets can
	// split a marker from its pair; collapsing a tilde run restructures nothing,
	// so a document under review is no reason to keep showing the damage.
	it("still repairs a document carrying diff markers", () => {
		// Built from escapes, not literal invisibles: a formatter that
		// normalised an NBSP would otherwise make this test silently vacuous.
		const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
		const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";
		const marked = `intro ${ADD_START}added${ADD_END} and ~${OPEN}~${OPEN}quoted`;

		const repaired = repairMarkdownDocument(marked);

		expect(repaired).toContain(`${OPEN}quoted`);
		expect(repaired).not.toContain(`~${OPEN}~${OPEN}`);
		// The markers themselves must survive intact, or the diff loses its pair.
		expect(repaired).toContain(ADD_START);
		expect(repaired).toContain(ADD_END);
	});

	it("survives a full load -> save round trip without reintroducing tildes", () => {
		expect(simulateRoundTrip(STORED_CORRUPT)).toBe(EXPECTED);
	});

	it("preserves legitimate strikethrough and tilde prose on load", () => {
		expect(repairMarkdownDocument("a ~~struck~~ b")).toBe("a ~~struck~~ b");
		expect(repairMarkdownDocument("approx ~2 seconds")).toBe(
			"approx ~2 seconds",
		);
	});

	// ASCII quotes are out of scope by design — see quote-artifacts.ts. Pinned
	// here too, because this is the path a reader's shell commands travel.
	it("does not touch tildes beside ASCII quotes, including inside code", () => {
		const withCode = `\`cd ~"$HOME"\` and \`rm -rf ~'/tmp'\` and ~${OPEN}~${OPEN}damaged`;
		expect(repairMarkdownDocument(withCode)).toBe(
			`\`cd ~"$HOME"\` and \`rm -rf ~'/tmp'\` and ${OPEN}damaged`,
		);
	});

	it("round-trips clean strikethrough through load and save", () => {
		expect(simulateRoundTrip("Keep ~~deprecated~~ this text.")).toBe(
			"Keep ~~deprecated~~ this text.",
		);
	});
});

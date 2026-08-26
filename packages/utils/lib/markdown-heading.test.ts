import { describe, expect, it } from "vitest";
import { findHeadingLineEnd, stripInlineDecoration } from "./markdown-heading";

describe("stripInlineDecoration", () => {
	describe("decorated headings become matchable", () => {
		it("strips a TipTap highlight mark with a data-color attribute", () => {
			expect(
				stripInlineDecoration(
					'## <mark data-color="#fef08a">Acceptance Criteria</mark>',
				),
			).toBe("## Acceptance Criteria");
		});

		it("strips a bare <mark> — the shape the ==text== input rule emits", () => {
			expect(
				stripInlineDecoration("## <mark>Acceptance Criteria</mark>"),
			).toBe("## Acceptance Criteria");
		});

		it("strips bold emphasis", () => {
			expect(stripInlineDecoration("## **Acceptance Criteria**")).toBe(
				"## Acceptance Criteria",
			);
		});

		it("strips italic emphasis", () => {
			expect(stripInlineDecoration("## *Acceptance Criteria*")).toBe(
				"## Acceptance Criteria",
			);
		});

		it("strips underscore emphasis", () => {
			expect(stripInlineDecoration("## __Acceptance Criteria__")).toBe(
				"## Acceptance Criteria",
			);
		});

		it("strips inline code", () => {
			expect(stripInlineDecoration("## `Acceptance Criteria`")).toBe(
				"## Acceptance Criteria",
			);
		});

		it("strips strikethrough", () => {
			expect(stripInlineDecoration("## ~~Acceptance Criteria~~")).toBe(
				"## Acceptance Criteria",
			);
		});

		it("single-spaces mixed decoration", () => {
			expect(stripInlineDecoration("## **A** <mark>B</mark>")).toBe(
				"## A B",
			);
		});

		it("collapses whitespace runs left behind by stripped markup", () => {
			expect(
				stripInlineDecoration("##   <mark>Attachments</mark>\t "),
			).toBe("## Attachments");
		});
	});

	describe("identity on undecorated input", () => {
		it("returns an undecorated heading unchanged", () => {
			expect(stripInlineDecoration("## Acceptance Criteria")).toBe(
				"## Acceptance Criteria",
			);
		});

		it("returns undecorated body prose unchanged", () => {
			expect(stripInlineDecoration("The user can upload a file.")).toBe(
				"The user can upload a file.",
			);
		});

		it("returns a demoted heading unchanged, still containing the target", () => {
			expect(stripInlineDecoration("### Attachments")).toBe(
				"### Attachments",
			);
		});
	});

	describe("heading-forgery guard", () => {
		it("does not promote an inline-code body line into a heading", () => {
			const line = "`## Acceptance Criteria`";
			expect(stripInlineDecoration(line)).toBe(line);
		});

		it("does not promote an italicised body line into a heading", () => {
			const line = "*## Attachments*";
			expect(stripInlineDecoration(line)).toBe(line);
		});

		it("does not promote a struck-through body line into a heading", () => {
			const line = "~~## Resolved Decisions (pending integration)~~";
			expect(stripInlineDecoration(line)).toBe(line);
		});

		it("does not promote an HTML-wrapped body line into a heading", () => {
			const line =
				"<span>## Original Description from User (Do Not Modify)";
			expect(stripInlineDecoration(line)).toBe(line);
		});

		it("does not disable normalization for a line that already starts with #", () => {
			expect(stripInlineDecoration("## <mark>Attachments</mark>")).toBe(
				"## Attachments",
			);
		});

		it("normalizes an indented heading whose trimmed input starts with #", () => {
			expect(stripInlineDecoration("  ## **Attachments**")).toBe(
				"## Attachments",
			);
		});

		it("leaves a decorated non-heading line normalized when it stays a non-heading", () => {
			expect(stripInlineDecoration("**Acceptance Criteria:**")).toBe(
				"Acceptance Criteria:",
			);
		});
	});

	describe("single pass, never a fixpoint", () => {
		it("does not reassemble a nested tag into <mark>", () => {
			const result = stripInlineDecoration("<ma<mark>rk>");
			expect(result).not.toContain("<mark>");
			expect(result).toBe("rk>");
		});
	});

	describe("total on degenerate input", () => {
		it("returns an empty string for an empty string", () => {
			expect(stripInlineDecoration("")).toBe("");
		});

		it("returns an empty string for whitespace-only input", () => {
			expect(stripInlineDecoration("   \t  ")).toBe("");
		});

		it("returns an empty string for null", () => {
			expect(stripInlineDecoration(null)).toBe("");
		});

		it("returns an empty string for undefined", () => {
			expect(stripInlineDecoration(undefined)).toBe("");
		});

		it("returns an empty string for a line that is nothing but decoration", () => {
			expect(stripInlineDecoration("***")).toBe("");
		});
	});

	describe("input cap", () => {
		it("truncates input longer than 4000 characters", () => {
			expect(stripInlineDecoration("a".repeat(5000))).toHaveLength(4000);
		});

		it("does not truncate input at or under 4000 characters", () => {
			expect(stripInlineDecoration("a".repeat(4000))).toHaveLength(4000);
		});
	});

	describe("ReDoS — single-line adversarial fixtures", () => {
		// Per docs/solutions/security-issues/redos-in-preview-markdown-strip.md
		// prevention rule 2: the payload MUST be one long line with no newlines.
		// A "\n"-separated fixture caps per-line scan cost and passes green while
		// the hole stays open, so it is explicitly insufficient here.
		const PAYLOAD_BYTES = 128 * 1024;
		const BUDGET_MS = 200;

		it("handles 128 KB of unpaired underscore tokens on one line within budget", () => {
			const payload = "_a ".repeat(Math.ceil(PAYLOAD_BYTES / 3));
			expect(payload).not.toContain("\n");
			expect(payload.length).toBeGreaterThanOrEqual(PAYLOAD_BYTES);

			const started = performance.now();
			const result = stripInlineDecoration(payload);
			const elapsed = performance.now() - started;

			expect(elapsed).toBeLessThan(BUDGET_MS);
			expect(result).not.toContain("_");
		});

		it("handles 128 KB of unterminated tag openers on one line within budget", () => {
			const payload = "<mark ".repeat(Math.ceil(PAYLOAD_BYTES / 6));
			expect(payload).not.toContain("\n");
			expect(payload.length).toBeGreaterThanOrEqual(PAYLOAD_BYTES);

			const started = performance.now();
			const result = stripInlineDecoration(payload);
			const elapsed = performance.now() - started;

			expect(elapsed).toBeLessThan(BUDGET_MS);
			expect(result.length).toBeLessThanOrEqual(4000);
		});
	});
});

/**
 * The decoration-tolerant heading scanner. Its one non-obvious contract is that
 * the offset it returns indexes the ORIGINAL text, not the normalized copy the
 * match was made against — callers slice the real document with it.
 */
describe("findHeadingLineEnd", () => {
	const HEADING = "## Resolved Decisions (pending integration)";
	const TEXT = "Resolved Decisions (pending integration)";

	/** Assert the offset is a real index into `text`, landing at the line break. */
	function expectOffsetIntoOriginal(
		text: string,
		offset: number,
		headingLine: string,
	): void {
		expect(offset).toBeGreaterThan(-1);
		expect(text.slice(0, offset).endsWith(headingLine)).toBe(true);
		expect(text.slice(offset, offset + 1)).toBe("\n");
	}

	it("finds an undecorated heading", () => {
		const text = `# F\n\nBody.\n\n${HEADING}\n\n- **Q:** Q1?`;
		expectOffsetIntoOriginal(
			text,
			findHeadingLineEnd(text, HEADING),
			HEADING,
		);
	});

	it("finds a heading wrapped in a TipTap highlight mark", () => {
		const headingLine = `## <mark data-color="#fef08a">${TEXT}</mark>`;
		const text = `# F\n\nBody.\n\n${headingLine}\n\n- **Q:** Q1?`;
		expectOffsetIntoOriginal(
			text,
			findHeadingLineEnd(text, HEADING),
			headingLine,
		);
	});

	it("finds a bolded heading", () => {
		const headingLine = `## **${TEXT}**`;
		const text = `# F\n\n${headingLine}\n\n- **Q:** Q1?`;
		expectOffsetIntoOriginal(
			text,
			findHeadingLineEnd(text, HEADING),
			headingLine,
		);
	});

	it("finds a DEMOTED heading — the predicate is includes, not equality", () => {
		const headingLine = `### ${TEXT}`;
		const text = `# F\n\n${headingLine}\n\n- **Q:** Q1?`;
		expectOffsetIntoOriginal(
			text,
			findHeadingLineEnd(text, HEADING),
			headingLine,
		);
	});

	it("returns -1 when the heading is absent", () => {
		expect(
			findHeadingLineEnd("# F\n\n## Must Haves\n- Do the thing", HEADING),
		).toBe(-1);
	});

	it("returns -1 for empty text", () => {
		expect(findHeadingLineEnd("", HEADING)).toBe(-1);
	});

	it("finds a heading on the very first line", () => {
		const text = `${HEADING}\n\n- **Q:** Q1?`;
		expect(findHeadingLineEnd(text, HEADING)).toBe(HEADING.length);
	});

	// -------------------------------------------------------------------------
	// The offset indexes the ORIGINAL text. `stripInlineDecoration` deletes
	// characters, so an offset accumulated over normalized lines would drift
	// past every stripped tag and every collapsed whitespace run, and the
	// caller's slice would cut the document in the wrong place.
	// -------------------------------------------------------------------------

	it("measures the offset against the original text, not the normalized copy", () => {
		const decorated = `##   <mark data-color="#fef08a">${TEXT}</mark>  `;
		const preamble =
			"# F\n\n**Bold** body with `code` and <em>tags</em>.\n\n";
		const text = `${preamble}${decorated}\n\n- **Q:** Q1?`;

		const offset = findHeadingLineEnd(text, HEADING);

		expect(offset).toBe(preamble.length + decorated.length);
		expectOffsetIntoOriginal(text, offset, decorated);
		// The normalized copy is strictly shorter — an offset measured against it
		// would land inside the heading line rather than at its end.
		expect(stripInlineDecoration(decorated).length).toBeLessThan(
			decorated.length,
		);
	});

	it("measures the offset in code units when multi-byte content precedes the heading", () => {
		const preamble = "# Ünïcødé 🎯 féatüre\n\nBödy with 🚀 emoji.\n\n";
		const text = `${preamble}${HEADING}\n\n- **Q:** Q1?\n  **Decided:** A1`;

		const offset = findHeadingLineEnd(text, HEADING);

		expect(offset).toBe(preamble.length + HEADING.length);
		expectOffsetIntoOriginal(text, offset, HEADING);
	});

	it("returns the FIRST match when a document carries two heading lines", () => {
		const first = `## ${TEXT}`;
		const text = `# F\n\n${first}\n\n- **Q:** Q1?\n\n## ${TEXT}\n\n- **Q:** Q2?`;
		expect(findHeadingLineEnd(text, HEADING)).toBe(
			text.indexOf(first) + first.length,
		);
	});

	it("is general over the heading string, not bound to one section", () => {
		const text = "# F\n\n## <mark>Attachments</mark>\n\n- file.pdf";
		expect(findHeadingLineEnd(text, "## Attachments")).toBe(
			text.indexOf("## <mark>Attachments</mark>") +
				"## <mark>Attachments</mark>".length,
		);
	});
});

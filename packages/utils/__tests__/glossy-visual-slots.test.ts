import { describe, expect, it } from "vitest";
import {
	hasVisualSlots,
	parseVisualSlots,
	preserveVisualSlots,
	serializeVisualSlot,
	stripVisualSlots,
	VISUAL_SLOT_ORPHANED_FROM_ATTR,
} from "../lib/glossy/visual-slots";

const SLOT_A =
	'<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Show the phases"></visual-slot>';
const SLOT_B = '<visual-slot data-slot-id="slot-b"></visual-slot>';
const SLOT_C =
	'<visual-slot data-slot-id="slot-c" data-kind="bar-chart"></visual-slot>';

const lines = (...parts: string[]) => parts.join("\n");

describe("serializeVisualSlot", () => {
	it("writes the KTD18 markdown form with id, kind, and hint", () => {
		expect(
			serializeVisualSlot({
				id: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
			}),
		).toBe(SLOT_A);
	});

	it("omits data-kind for best fit and data-hint when there is no hint", () => {
		expect(
			serializeVisualSlot({ id: "slot-b", kind: null, hint: null }),
		).toBe(SLOT_B);
	});

	it("writes data-orphaned-from as an attribute, never as visible text", () => {
		const tag = serializeVisualSlot({
			id: "slot-b",
			orphanedFrom: "Implementation Phases",
		});

		expect(tag).toBe(
			`<visual-slot data-slot-id="slot-b" ${VISUAL_SLOT_ORPHANED_FROM_ATTR}="Implementation Phases"></visual-slot>`,
		);
	});

	it("escapes attribute values and keeps the tag on one line", () => {
		const tag = serializeVisualSlot({
			id: "slot-x",
			hint: 'Cost & "benefit" <by quarter>\nthen totals',
		});

		expect(tag).not.toContain("\n");
		expect(tag).toBe(
			'<visual-slot data-slot-id="slot-x" data-hint="Cost &amp; &quot;benefit&quot; &lt;by quarter&gt;&#10;then totals"></visual-slot>',
		);
	});

	it("round-trips through parseVisualSlots", () => {
		const slot = {
			id: "slot-x",
			kind: "table",
			hint: 'Cost & "benefit" <by quarter>\nthen totals',
			orphanedFrom: "5. Scope (Required)",
		};

		const [parsed] = parseVisualSlots(serializeVisualSlot(slot));

		expect(parsed).toMatchObject(slot);
	});
});

describe("parseVisualSlots", () => {
	it("reads every slot in document order with its 1-based line", () => {
		const markdown = lines("## A", "", SLOT_A, "", "text", "", SLOT_B);

		expect(parseVisualSlots(markdown)).toEqual([
			{
				id: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
				orphanedFrom: null,
				line: 3,
			},
			{
				id: "slot-b",
				kind: null,
				hint: null,
				orphanedFrom: null,
				line: 7,
			},
		]);
	});

	it("reads single-quoted attributes, any attribute order, and a self-closing tag", () => {
		const markdown =
			"<visual-slot data-hint='a&amp;b' data-slot-id='s1' />";

		expect(parseVisualSlots(markdown)).toEqual([
			{ id: "s1", kind: null, hint: "a&b", orphanedFrom: null, line: 1 },
		]);
	});

	it("reads a hint that contains an unescaped `>`", () => {
		const markdown =
			'<visual-slot data-slot-id="s1" data-hint="revenue > cost"></visual-slot>';

		expect(parseVisualSlots(markdown)[0]?.hint).toBe("revenue > cost");
	});

	it("ignores a slot tag inside a fenced code block", () => {
		const markdown = lines("```html", SLOT_A, "```", "", SLOT_B);

		expect(parseVisualSlots(markdown).map((slot) => slot.id)).toEqual([
			"slot-b",
		]);
	});

	it("returns an empty array for null, empty, and slot-free input", () => {
		expect(parseVisualSlots(null)).toEqual([]);
		expect(parseVisualSlots("")).toEqual([]);
		expect(parseVisualSlots("## Heading\n\nprose")).toEqual([]);
	});
});

describe("hasVisualSlots", () => {
	it("is true for a slot on its own line", () => {
		expect(hasVisualSlots(lines("text", "", SLOT_A))).toBe(true);
	});

	it("is true for a slot tag written inline", () => {
		expect(hasVisualSlots(`Some text ${SLOT_B} more text`)).toBe(true);
	});

	it("is false when the only tag sits inside a fence", () => {
		expect(hasVisualSlots(lines("~~~", SLOT_A, "~~~"))).toBe(false);
	});

	it("is false for null, empty, and slot-free input", () => {
		expect(hasVisualSlots(undefined)).toBe(false);
		expect(hasVisualSlots("")).toBe(false);
		expect(hasVisualSlots("<visual-slots>not a slot</visual-slots>")).toBe(
			false,
		);
	});
});

describe("stripVisualSlots", () => {
	it("returns the input unchanged when there is no slot", () => {
		const markdown = "## A\n\n\n\ntext  \r\nmore\n";

		expect(stripVisualSlots(markdown)).toBe(markdown);
	});

	it("leaves no blank-line gap where a slot stood between two blocks", () => {
		expect(
			stripVisualSlots(lines("para one", "", SLOT_A, "", "para two")),
		).toBe(lines("para one", "", "para two"));
	});

	it("collapses consecutive slots into a single separating blank line", () => {
		expect(
			stripVisualSlots(
				lines("para one", "", SLOT_A, "", SLOT_B, "", "para two"),
			),
		).toBe(lines("para one", "", "para two"));
	});

	it("leaves no leading or trailing blank lines and keeps the final newline", () => {
		expect(
			stripVisualSlots(lines(SLOT_A, "", "text", "", SLOT_B, "")),
		).toBe("text\n");
	});

	it("removes an inline tag but keeps the text around it", () => {
		expect(stripVisualSlots(`Before ${SLOT_B}after`)).toBe("Before after");
	});

	it("leaves a fenced slot tag alone", () => {
		const markdown = lines("```", SLOT_A, "```");

		expect(stripVisualSlots(markdown)).toBe(markdown);
	});

	it("yields a document parseVisualSlots finds nothing in", () => {
		const stripped = stripVisualSlots(
			lines("## A", SLOT_A, `inline ${SLOT_B}`, SLOT_C),
		);

		expect(hasVisualSlots(stripped)).toBe(false);
	});
});

describe("preserveVisualSlots", () => {
	describe("fast path", () => {
		it("returns next unchanged when neither body has a slot", () => {
			const previous = "## A\n\nold text\n";
			const next = "## A\r\n\r\n\r\n\r\nnew text   \n\n\n";

			expect(preserveVisualSlots(previous, next)).toBe(next);
		});

		it("returns next unchanged when previous is null or undefined", () => {
			expect(preserveVisualSlots(null, "text\n\n\n")).toBe("text\n\n\n");
			expect(preserveVisualSlots(undefined, "text")).toBe("text");
		});

		it("treats a fenced slot tag as code, not a slot", () => {
			const next = lines("```", SLOT_A, "```");

			expect(preserveVisualSlots(lines("```", SLOT_B, "```"), next)).toBe(
				next,
			);
		});
	});

	it("removes a slot from next when previous has none", () => {
		const previous = lines("## A", "", "old text");
		const next = lines("## A", "", "new text", "", SLOT_A, "", "more");

		expect(preserveVisualSlots(previous, next)).toBe(
			lines("## A", "", "new text", "", "more"),
		);
	});

	describe("AE5: a slot under Implementation Phases", () => {
		const previous = lines(
			"# Business Case",
			"",
			"## 1. Summary",
			"",
			"Summary text.",
			"",
			"## 5. Implementation Phases (Required)",
			"",
			"Phase one runs in Q1.",
			"",
			SLOT_A,
			"",
			"Phase two runs in Q2.",
			"",
			"## 6. Risks",
			"",
			"Risk text.",
			"",
		);

		it("returns under the surviving heading at the same block index", () => {
			const next = lines(
				"# Business Case",
				"",
				"## 1. Summary",
				"",
				"A rewritten summary.",
				"",
				"## 5. Implementation Phases (Required)",
				"",
				"Phase one kicks off in January.",
				"",
				"Phase two follows in April.",
				"",
				"Phase three closes in June.",
				"",
				"## 6. Risks",
				"",
				"Rewritten risk text.",
				"",
			);

			expect(preserveVisualSlots(previous, next)).toBe(
				lines(
					"# Business Case",
					"",
					"## 1. Summary",
					"",
					"A rewritten summary.",
					"",
					"## 5. Implementation Phases (Required)",
					"",
					"Phase one kicks off in January.",
					"",
					SLOT_A,
					"",
					"Phase two follows in April.",
					"",
					"Phase three closes in June.",
					"",
					"## 6. Risks",
					"",
					"Rewritten risk text.",
					"",
				),
			);
		});

		it("goes to the section end when fewer blocks remain", () => {
			const next = lines(
				"## 5. Implementation Phases (Required)",
				"",
				"A single phase.",
				"",
				"## 6. Risks",
				"",
				"Risk text.",
			);

			// The H1 is gone too, so this also exercises the own-anchor fallback.
			expect(preserveVisualSlots(previous, next)).toBe(
				lines(
					"## 5. Implementation Phases (Required)",
					"",
					"A single phase.",
					"",
					SLOT_A,
					"",
					"## 6. Risks",
					"",
					"Risk text.",
				),
			);
		});

		it("places the slot directly under the heading when the section is empty", () => {
			const next = lines(
				"# Business Case",
				"## 5. Implementation Phases (Required)",
				"## 6. Risks",
				"Risk text.",
			);

			expect(preserveVisualSlots(previous, next)).toBe(
				lines(
					"# Business Case",
					"## 5. Implementation Phases (Required)",
					"",
					SLOT_A,
					"",
					"## 6. Risks",
					"Risk text.",
				),
			);
		});

		it("still matches after the heading is renumbered and loses (Required)", () => {
			const next = lines(
				"# Business Case",
				"",
				"## 6. Implementation Phases",
				"",
				"Phase one.",
				"",
				"Phase two.",
			);

			expect(preserveVisualSlots(previous, next)).toBe(
				lines(
					"# Business Case",
					"",
					"## 6. Implementation Phases",
					"",
					"Phase one.",
					"",
					SLOT_A,
					"",
					"Phase two.",
				),
			);
		});

		it("still matches when only the document title above it changed", () => {
			const next = lines(
				"# Business Case: Example Rollout",
				"",
				"## 5. Implementation Phases (Required)",
				"",
				"Phase one.",
				"",
				"Phase two.",
			);

			expect(preserveVisualSlots(previous, next)).toBe(
				lines(
					"# Business Case: Example Rollout",
					"",
					"## 5. Implementation Phases (Required)",
					"",
					"Phase one.",
					"",
					SLOT_A,
					"",
					"Phase two.",
				),
			);
		});

		it("moves to the end with data-orphaned-from when the heading vanished", () => {
			const next = lines(
				"# Business Case",
				"",
				"## 1. Summary",
				"",
				"Summary text.",
				"",
				"## 2. Delivery Plan",
				"",
				"Plan text.",
				"",
			);

			const result = preserveVisualSlots(previous, next);

			expect(result).toBe(
				lines(
					"# Business Case",
					"",
					"## 1. Summary",
					"",
					"Summary text.",
					"",
					"## 2. Delivery Plan",
					"",
					"Plan text.",
					"",
					'<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Show the phases" data-orphaned-from="5. Implementation Phases (Required)"></visual-slot>',
					"",
				),
			);
			// The note is an attribute: no heading text leaks into the prose.
			expect(stripVisualSlots(result)).not.toContain(
				"Implementation Phases",
			);
		});
	});

	it("keeps two orphans in their original order", () => {
		const previous = lines(
			"## Alpha",
			"",
			SLOT_B,
			"",
			"## Beta",
			"",
			"text",
			"",
			SLOT_C,
		);
		const next = lines("## Gamma", "", "new text");

		const slots = parseVisualSlots(preserveVisualSlots(previous, next));

		expect(slots.map((slot) => [slot.id, slot.orphanedFrom])).toEqual([
			["slot-b", "Alpha"],
			["slot-c", "Beta"],
		]);
	});

	it("keeps the original data-orphaned-from when an orphan is orphaned again", () => {
		const previous = lines(
			"## Appendix",
			"",
			"text",
			"",
			serializeVisualSlot({ id: "slot-b", orphanedFrom: "Scope" }),
		);
		const next = lines("## Closing", "", "text");

		expect(
			parseVisualSlots(preserveVisualSlots(previous, next))[0],
		).toMatchObject({ id: "slot-b", orphanedFrom: "Scope" });
	});

	it("strips slot tags from next first, so a slot never doubles", () => {
		const previous = lines("## A", "", "one", "", SLOT_A, "", "two");
		const next = lines(
			"## A",
			"",
			SLOT_A,
			"",
			"one",
			"",
			"two",
			"",
			SLOT_A,
		);

		expect(preserveVisualSlots(previous, next)).toBe(previous);
	});

	it("never introduces a slot that previous did not hold", () => {
		const previous = lines("## A", "", "one", "", SLOT_A);
		const next = lines("## A", "", "one", "", SLOT_B);

		expect(
			parseVisualSlots(preserveVisualSlots(previous, next)).map(
				(slot) => slot.id,
			),
		).toEqual(["slot-a"]);
	});

	it("keeps two adjacent slots in one section in order", () => {
		const previous = lines(
			"## A",
			"",
			"one",
			"",
			SLOT_A,
			"",
			SLOT_B,
			"",
			"two",
		);
		const next = lines("## A", "", "uno", "", "dos");

		expect(preserveVisualSlots(previous, next)).toBe(
			lines("## A", "", "uno", "", SLOT_A, "", SLOT_B, "", "dos"),
		);
	});

	it("keeps two slots at different block indexes in one section in order", () => {
		const previous = lines(
			"## A",
			"",
			SLOT_A,
			"",
			"one",
			"",
			"two",
			"",
			SLOT_B,
		);
		const next = lines("## A", "", "uno", "", "dos", "", "tres");

		// Anchored by block index, not by "section end": slot-b sat after two
		// blocks, so it returns after two blocks even though a third now follows.
		expect(preserveVisualSlots(previous, next)).toBe(
			lines(
				"## A",
				"",
				SLOT_A,
				"",
				"uno",
				"",
				"dos",
				"",
				SLOT_B,
				"",
				"tres",
			),
		);
	});

	it("returns a slot under ### to the same ###, not its parent or sibling", () => {
		const previous = lines(
			"## Plan",
			"",
			"intro",
			"",
			"### Phase One",
			"",
			"first",
			"",
			"### Phase Two",
			"",
			"second",
			"",
			SLOT_A,
		);
		const next = lines(
			"## Plan",
			"",
			"new intro",
			"",
			"### Phase One",
			"",
			"new first",
			"",
			"### Phase Two",
			"",
			"new second",
			"",
			"### Phase Three",
			"",
			"third",
		);

		expect(preserveVisualSlots(previous, next)).toBe(
			lines(
				"## Plan",
				"",
				"new intro",
				"",
				"### Phase One",
				"",
				"new first",
				"",
				"### Phase Two",
				"",
				"new second",
				"",
				SLOT_A,
				"",
				"### Phase Three",
				"",
				"third",
			),
		);
	});

	it("keeps a ## slot above the section's ### subsections", () => {
		const previous = lines(
			"## Plan",
			"",
			"intro",
			"",
			SLOT_A,
			"",
			"### Phase One",
			"",
			"first",
		);
		const next = lines(
			"## Plan",
			"",
			"new intro",
			"",
			"### Phase One",
			"",
			"new first",
		);

		expect(preserveVisualSlots(previous, next)).toBe(
			lines(
				"## Plan",
				"",
				"new intro",
				"",
				SLOT_A,
				"",
				"### Phase One",
				"",
				"new first",
			),
		);
	});

	it("tells repeated headings apart by occurrence index", () => {
		const previous = lines(
			"## Scope",
			"",
			"first",
			"",
			"## Scope",
			"",
			"second",
			"",
			SLOT_A,
		);
		const next = lines(
			"## Scope",
			"",
			"uno",
			"",
			"## Scope",
			"",
			"dos",
			"",
			"## End",
		);

		expect(preserveVisualSlots(previous, next)).toBe(
			lines(
				"## Scope",
				"",
				"uno",
				"",
				"## Scope",
				"",
				"dos",
				"",
				SLOT_A,
				"",
				"## End",
			),
		);
	});

	it("keeps a slot above the first heading in the preamble", () => {
		const previous = lines(SLOT_A, "", "# Title", "", "text");
		const next = lines("# Renamed Title", "", "text");

		expect(preserveVisualSlots(previous, next)).toBe(
			lines(SLOT_A, "", "# Renamed Title", "", "text"),
		);
	});

	it("counts a fenced code block with blank lines inside as one block", () => {
		const previous = lines(
			"## A",
			"",
			"```",
			"code",
			"",
			"more code",
			"```",
			"",
			SLOT_A,
			"",
			"after",
		);
		const next = lines(
			"## A",
			"",
			"```",
			"new code",
			"",
			"",
			"x",
			"```",
			"",
			"after",
		);

		expect(preserveVisualSlots(previous, next)).toBe(
			lines(
				"## A",
				"",
				"```",
				"new code",
				"",
				"",
				"x",
				"```",
				"",
				SLOT_A,
				"",
				"after",
			),
		);
	});

	it("re-issues a duplicate slot id, deterministically", () => {
		const previous = lines(
			"## A",
			"",
			SLOT_B,
			"",
			"text",
			"",
			SLOT_B,
			"",
			'<visual-slot data-slot-id="slot-b-2"></visual-slot>',
		);
		const next = lines("## A", "", "new text");

		const first = preserveVisualSlots(previous, next);
		const ids = parseVisualSlots(first).map((slot) => slot.id);

		expect(ids).toEqual(["slot-b", "slot-b-3", "slot-b-2"]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(preserveVisualSlots(previous, next)).toBe(first);
	});

	it("issues an id to a slot that has none", () => {
		const previous = lines(
			"## A",
			"",
			'<visual-slot data-kind="table"></visual-slot>',
		);

		const [slot] = parseVisualSlots(preserveVisualSlots(previous, "## A"));

		expect(slot).toMatchObject({ id: "slot-1", kind: "table" });
	});

	it("keeps an unmodified slot's tag byte-for-byte, unknown attributes included", () => {
		const tag =
			'<visual-slot data-kind="table" data-slot-id="s9" data-future="x"></visual-slot>';
		const previous = lines("## A", "", "one", "", tag);

		expect(preserveVisualSlots(previous, lines("## A", "", "uno"))).toBe(
			lines("## A", "", "uno", "", tag),
		);
	});

	it("is idempotent: preserving a body against itself returns it unchanged", () => {
		const body = lines(
			"# Title",
			"",
			SLOT_C,
			"",
			"## A",
			"",
			"one",
			"",
			SLOT_A,
			"",
			"two",
			"",
			"### A.1",
			"",
			SLOT_B,
			"",
		);

		expect(preserveVisualSlots(body, body)).toBe(body);
	});
});

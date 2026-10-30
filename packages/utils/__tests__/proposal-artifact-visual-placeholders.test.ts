import { describe, expect, it } from "vitest";
import {
	holdVisualPlaceholders,
	restoreVisualPlaceholders,
	type VisualPlaceholderFormat,
} from "../lib/proposal-artifact/visual-placeholders";

const FORMATS: Array<[string, VisualPlaceholderFormat]> = [
	[
		"bracket tokens",
		{
			prefix: (attempt) =>
				attempt === 0
					? "[[fabric-visual-"
					: `[[fabric-visual-${attempt}x-`,
			suffix: "]]",
		},
	],
	[
		"angle tokens",
		{
			prefix: (attempt) =>
				`<<<FABRIC_VISUAL${attempt === 0 ? "" : `_${attempt}`}_`,
			suffix: ">>>",
		},
	],
];

const DIAGRAM = ["```mermaid", "flowchart TD", "  a --> b", "```"].join("\n");
const SLOT =
	'<visual-slot data-slot-id="slot-1" data-kind="timeline"></visual-slot>';

describe.each(FORMATS)("visual placeholders with %s", (_name, format) => {
	const token = (n: number) => `${format.prefix(0)}${n}${format.suffix}`;

	it("holds a closed diagram fence as one line and restores it byte for byte", () => {
		const source = ["Intro.", "", DIAGRAM, "", "Outro."].join("\n");
		const view = holdVisualPlaceholders(source, format);
		expect(view.modelDocument).toBe(
			["Intro.", "", token(1), "", "Outro."].join("\n"),
		);
		expect(view.sourceStartLine[2]).toBe(3);
		expect(view.sourceEndLine[2]).toBe(6);
		expect(view.sourceStartLine[4]).toBe(8);
		expect(restoreVisualPlaceholders(view, view.modelDocument)).toEqual({
			ok: true,
			document: source,
		});
	});

	it("holds an unclosed diagram fence through the last line", () => {
		const source = ["Intro.", "", "```mermaid", "flowchart TD", "a"].join(
			"\n",
		);
		const view = holdVisualPlaceholders(source, format);
		expect(view.modelDocument).toBe(["Intro.", "", token(1)].join("\n"));
		expect(view.placeholders[0].raw).toBe(
			["```mermaid", "flowchart TD", "a"].join("\n"),
		);
		expect(view.sourceEndLine[2]).toBe(5);
		expect(restoreVisualPlaceholders(view, view.modelDocument)).toEqual({
			ok: true,
			document: source,
		});
	});

	it("leaves a non-diagram fence and a slot tag inside it as content", () => {
		const source = ["```html", SLOT, "```"].join("\n");
		const view = holdVisualPlaceholders(source, format);
		expect(view.modelDocument).toBe(source);
		expect(view.placeholders).toEqual([]);
	});

	it("holds a slot-only line as a line placeholder", () => {
		const source = ["Intro.", "", SLOT].join("\n");
		const view = holdVisualPlaceholders(source, format);
		expect(view.modelDocument).toBe(["Intro.", "", token(1)].join("\n"));
		expect(view.placeholders[0]).toMatchObject({
			raw: SLOT,
			ownLine: true,
		});
		const inline = `Intro. ${token(1)}`;
		const refused = restoreVisualPlaceholders(view, inline);
		expect(refused).toMatchObject({ ok: false, misplaced: [token(1)] });
	});

	it("holds an inline slot tag in place and lets the text around it change", () => {
		const source = `See ${SLOT} here.`;
		const view = holdVisualPlaceholders(source, format);
		expect(view.modelDocument).toBe(`See ${token(1)} here.`);
		expect(view.placeholders[0].ownLine).toBe(false);
		expect(
			restoreVisualPlaceholders(view, `Now see ${token(1)} there.`),
		).toEqual({ ok: true, document: `Now see ${SLOT} there.` });
	});

	it("names missing, repeated and unknown placeholders", () => {
		const source = [DIAGRAM, "", SLOT].join("\n");
		const view = holdVisualPlaceholders(source, format);
		expect(
			restoreVisualPlaceholders(
				view,
				[token(1), "", token(1), "", token(7)].join("\n"),
			),
		).toEqual({
			ok: false,
			missing: [token(2)],
			repeated: [token(1)],
			unknown: [token(7)],
			misplaced: [],
		});
	});

	it("lets a removable placeholder go", () => {
		const source = [DIAGRAM, "", SLOT].join("\n");
		const view = holdVisualPlaceholders(source, format);
		expect(
			restoreVisualPlaceholders(view, token(1), new Set([token(2)])),
		).toEqual({ ok: true, document: DIAGRAM });
	});

	it("picks another prefix when the source already holds the first", () => {
		const source = [`Text ${token(1)} here.`, "", DIAGRAM].join("\n");
		const view = holdVisualPlaceholders(source, format);
		expect(view.tokenPrefix).toBe(format.prefix(1));
		expect(view.modelDocument).toContain(`Text ${token(1)} here.`);
		expect(restoreVisualPlaceholders(view, view.modelDocument)).toEqual({
			ok: true,
			document: source,
		});
	});
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	computeDetectedVisualKey,
	computeDetectionKey,
	computeExtractionKey,
	computeMermaidVisualKey,
	computeRewriteKey,
	computeSectionKey,
	computeSlotVisualKey,
	normalizeForKey,
} from "../lib/glossy/keys";

const V = "pipeline-1";
const HEX_KEY = /^[0-9a-f]{64}$/;

const section = {
	headingPath: ["delivery approach"],
	occurrenceIndex: 0,
	markdown: "Discovery runs for four weeks.\n\nPilot follows with two teams.",
};

describe("normalizeForKey", () => {
	it("sits on normalizeForComparison: line endings, trailing whitespace, blank-line runs", () => {
		expect(normalizeForKey("A  \r\nB\t\r\n\r\n\r\n\r\nC\n")).toBe(
			normalizeForKey("A\nB\n\nC"),
		);
	});

	it("unescapes an ordered marker the editor escaped (ported rule)", () => {
		expect(normalizeForKey("38\\. GIVEN a user")).toBe("38. GIVEN a user");
		expect(normalizeForKey("  2\\. nested")).toBe("2. nested");
	});

	it("undoes the serializer's other escapes", () => {
		expect(normalizeForKey("See \\[S1\\] and \\#tag \\- item")).toBe(
			normalizeForKey("See [S1] and #tag - item"),
		);
	});

	it("unifies list markers, their padding, and emphasis delimiters", () => {
		expect(
			normalizeForKey("-   one\n*   two\n1.  three\n_italic_ __bold__"),
		).toBe(normalizeForKey("- one\n- two\n1. three\n*italic* **bold**"));
	});

	it("unifies thematic breaks and table padding", () => {
		expect(normalizeForKey("* * *\n|a|b|\n|:--|--|\n|1|2|")).toBe(
			normalizeForKey("---\n| a | b |\n| --- | --- |\n| 1 | 2 |"),
		);
	});

	it("joins soft-wrapped lines the way the editor does, but not list items", () => {
		expect(
			normalizeForKey("Line one\nline two\n- item\ncontinued\n- next"),
		).toBe("Line one line two\n- item continued\n- next");
	});

	it("ignores the blank line the editor puts before a list", () => {
		expect(normalizeForKey("Intro:\n\n- item")).toBe(
			normalizeForKey("Intro:\n- item"),
		);
	});

	it("leaves fenced code as written, apart from runs of spaces", () => {
		const code = "```ts\nconst a_b = [1];\n\n x\\. y\n```";
		expect(normalizeForKey(code)).toBe(code);
		expect(normalizeForKey(code.replace(" x", "    x"))).toBe(code);
	});

	it("stays linear on a long interior space run", () => {
		const start = performance.now();
		expect(normalizeForKey(`x${" ".repeat(100_000)}y`)).toBe("x y");
		expect(performance.now() - start).toBeLessThan(2000);
	});

	it("still tells different words apart", () => {
		expect(normalizeForKey("Budget is 240k")).not.toBe(
			normalizeForKey("Budget is 250k"),
		);
	});
});

describe("computeSectionKey", () => {
	it("is a SHA-256 hex digest and deterministic", () => {
		const key = computeSectionKey({ ...section, pipelineVersion: V });

		expect(key).toMatch(HEX_KEY);
		expect(computeSectionKey({ ...section, pipelineVersion: V })).toBe(key);
	});

	it("changes with the heading path, the occurrence index, the text, and the pipeline version", () => {
		const base = computeSectionKey({ ...section, pipelineVersion: V });

		expect(
			computeSectionKey({
				...section,
				headingPath: ["scope"],
				pipelineVersion: V,
			}),
		).not.toBe(base);
		expect(
			computeSectionKey({
				...section,
				occurrenceIndex: 1,
				pipelineVersion: V,
			}),
		).not.toBe(base);
		expect(
			computeSectionKey({
				...section,
				markdown: "Discovery runs for five weeks.",
				pipelineVersion: V,
			}),
		).not.toBe(base);
		expect(
			computeSectionKey({ ...section, pipelineVersion: "pipeline-2" }),
		).not.toBe(base);
	});

	it("ignores formatting an editor round trip changes", () => {
		expect(
			computeSectionKey({
				...section,
				markdown:
					"Discovery runs for four weeks.  \r\n\r\n\r\nPilot follows with two teams.",
				pipelineVersion: V,
			}),
		).toBe(computeSectionKey({ ...section, pipelineVersion: V }));
	});

	it("does not confuse a path segment boundary with text", () => {
		expect(
			computeSectionKey({
				headingPath: ["a", "b"],
				occurrenceIndex: 0,
				markdown: "",
				pipelineVersion: V,
			}),
		).not.toBe(
			computeSectionKey({
				headingPath: ["a\u0000b"],
				occurrenceIndex: 0,
				markdown: "",
				pipelineVersion: V,
			}),
		);
	});
});

describe("cache keys (KTD8)", () => {
	const sectionKey = computeSectionKey({ ...section, pipelineVersion: V });

	it("keys a rewrite by section, length mode, key-section class, and document type", () => {
		const input = {
			sectionKey,
			lengthMode: "BRIEF",
			keySectionClass: "key",
			documentType: "BUSINESS_CASE",
			pipelineVersion: V,
		};
		const base = computeRewriteKey(input);

		expect(base).toMatch(HEX_KEY);
		for (const change of [
			{ lengthMode: "STANDARD" },
			{ keySectionClass: "standard" },
			{ documentType: "PROPOSAL" },
			{ pipelineVersion: "pipeline-2" },
		]) {
			expect(computeRewriteKey({ ...input, ...change })).not.toBe(base);
		}
	});

	it("keys detection by ordered sections and the slot set", () => {
		const slots = [
			{ id: "slot-1", kind: "timeline", hint: "Phases" },
			{ id: "slot-2", kind: null, hint: null },
		];
		const input = {
			sectionKeys: ["a", "b"],
			slots,
			documentType: "PROPOSAL",
			pipelineVersion: V,
		};
		const base = computeDetectionKey(input);

		expect(
			computeDetectionKey({ ...input, slots: [...slots].reverse() }),
		).toBe(base);
		expect(
			computeDetectionKey({ ...input, sectionKeys: ["b", "a"] }),
		).not.toBe(base);
		expect(
			computeDetectionKey({
				...input,
				slots: [{ ...slots[0], hint: "Milestones" }, slots[1]],
			}),
		).not.toBe(base);
		expect(computeDetectionKey({ ...input, slots: [slots[0]] })).not.toBe(
			base,
		);
		expect(
			computeDetectionKey({ ...input, documentType: "BUSINESS_CASE" }),
		).not.toBe(base);
	});

	it("keys extraction by section, kind, slot hint, and style direction", () => {
		const input = {
			sectionKey,
			kind: "timeline",
			slotHint: null,
			styleDirection: "Calm, spacious",
			pipelineVersion: V,
		};
		const base = computeExtractionKey(input);

		expect(
			computeExtractionKey({
				...input,
				styleDirection: "  Calm,\n spacious ",
			}),
		).toBe(base);
		expect(
			computeExtractionKey({ ...input, styleDirection: "Bold" }),
		).not.toBe(base);
		expect(computeExtractionKey({ ...input, slotHint: "Phases" })).not.toBe(
			base,
		);
		expect(computeExtractionKey({ ...input, kind: "kpi" })).not.toBe(base);
	});

	it("keys a slot's extraction by its slot id too, leaving an opportunity's key as it was", () => {
		const opportunity = {
			sectionKey,
			kind: "timeline",
			slotHint: null,
			styleDirection: "Calm",
			pipelineVersion: V,
		};
		// Pinned: an opportunity's key must stay byte-identical, so every
		// detected, pinned, and confirmed visual keeps its cached spec.
		const pinned = createHash("sha256")
			.update(
				JSON.stringify([
					"glossy:extraction",
					V,
					sectionKey,
					"timeline",
					"",
					"Calm",
				]),
			)
			.digest("hex");
		expect(computeExtractionKey(opportunity)).toBe(pinned);
		expect(computeExtractionKey({ ...opportunity, slotId: null })).toBe(
			pinned,
		);

		// Two hintless slots of one kind in one section are two visuals.
		const first = computeExtractionKey({
			...opportunity,
			slotId: "slot-a",
		});
		const second = computeExtractionKey({
			...opportunity,
			slotId: "slot-b",
		});
		expect(first).toMatch(HEX_KEY);
		expect(first).not.toBe(second);
		expect(first).not.toBe(pinned);
		expect(computeExtractionKey({ ...opportunity, slotId: "slot-a" })).toBe(
			first,
		);
	});

	it("keys visuals by their source, each kind in its own space", () => {
		const detected = computeDetectedVisualKey({
			sectionKey,
			kind: "timeline",
			pipelineVersion: V,
		});
		const slot = computeSlotVisualKey({
			slotId: "timeline",
			sectionKey,
			pipelineVersion: V,
		});

		expect(detected).toMatch(HEX_KEY);
		expect(slot).not.toBe(detected);
		expect(
			computeDetectedVisualKey({
				sectionKey,
				kind: "kpi",
				pipelineVersion: V,
			}),
		).not.toBe(detected);
		expect(
			computeSlotVisualKey({
				slotId: "slot-2",
				sectionKey,
				pipelineVersion: V,
			}),
		).not.toBe(slot);
	});

	it("keys existing Mermaid by its normalized source", () => {
		const source = "flowchart LR\n  A --> B";

		expect(
			computeMermaidVisualKey({
				source: "flowchart LR  \r\n  A --> B\n",
				pipelineVersion: V,
			}),
		).toBe(computeMermaidVisualKey({ source, pipelineVersion: V }));
		expect(
			computeMermaidVisualKey({
				source: "flowchart LR\n  A --> C",
				pipelineVersion: V,
			}),
		).not.toBe(computeMermaidVisualKey({ source, pipelineVersion: V }));
		expect(
			computeMermaidVisualKey({ source, pipelineVersion: "pipeline-2" }),
		).not.toBe(computeMermaidVisualKey({ source, pipelineVersion: V }));
	});

	it("requires a pipeline version on every builder", () => {
		expect(() =>
			// @ts-expect-error pipelineVersion is required
			computeSectionKey({ ...section }),
		).toThrow(/pipeline version/);
		expect(() =>
			// @ts-expect-error pipelineVersion is required
			computeMermaidVisualKey({ source: "graph TD" }),
		).toThrow(/pipeline version/);
		expect(() =>
			computeSlotVisualKey({
				slotId: "s",
				sectionKey,
				pipelineVersion: " ",
			}),
		).toThrow(/pipeline version/);
	});
});

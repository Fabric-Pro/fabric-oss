import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { GlossyAppendix } from "../lib/glossy/cleanup";
import {
	type EditionAppendix,
	type EditionContent,
	editionContentSchema,
} from "../lib/glossy/edition-content";
import { type VisualSpec, specHash } from "../lib/glossy/visual-spec";

const timeline: VisualSpec = {
	kind: "timeline",
	items: [
		{ date: "Q1 2026", label: "Pilot launch" },
		{ date: "Q2 2026", label: "General availability" },
	],
};

function validContent(): EditionContent {
	return {
		title: "Example Field Service Portal",
		pipelineVersion: "glossy-1",
		lengthMode: "standard",
		mode: "roll_the_dice",
		sections: [
			{
				sectionKey: "section-a",
				headingPath: ["2. Goals"],
				heading: "2. Goals",
				level: 2,
				markdown: "Dispatch runs faster.\n\nCrews see the day's jobs.",
				wording: "rewritten",
				anchors: [
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: "visual-1" },
					},
					{
						blockIndex: 2,
						ref: {
							type: "image",
							s3Key: "document-media/p1/map.png",
						},
					},
				],
			},
			{
				sectionKey: "section-b",
				headingPath: ["3. Budget"],
				heading: "3. Budget",
				level: 2,
				markdown: "The first phase stays under the ceiling.",
				wording: "original",
				keptOriginalReason: "fact_guard",
				anchors: [],
			},
		],
		visuals: {
			"visual-1": {
				kind: "timeline",
				spec: timeline,
				specHash: specHash(timeline),
				source: "detected",
				reason: "The section lists dated milestones.",
			},
		},
		appendix: {
			sources: [{ id: "S1", text: "Discovery workshop notes" }],
			details: [{ label: "Client", value: "Example Org" }],
			placeholders: [
				{ heading: "1. Proposal Cover", text: "Sponsor: TBD" },
			],
			assumptions: [
				{
					heading: "3. Budget",
					text: "The ceiling holds for phase one",
					status: "ASSUMED",
					qualifier: "assumed",
				},
			],
			additionalMaterial: [
				{
					heading: "Glossary",
					level: 3,
					markdown: "Dispatcher: the person assigning jobs.",
					anchors: [],
				},
			],
		},
		report: {
			keptOriginal: [{ heading: "3. Budget", reason: "fact_guard" }],
			droppedVisuals: [
				{ kind: "stat", heading: "2. Goals", reason: "label_guard" },
			],
			unfilledSlots: [{ slotId: "slot-1", reason: "no_opportunity" }],
			scaffoldingUnrecognized: false,
		},
		provenance: {
			sourceTitle: "Project Proposal: Example Field Service Portal",
			sourceVersion: 7,
			builtAt: "2026-09-24T10:15:00.000Z",
		},
	};
}

describe("editionContentSchema", () => {
	it("accepts a complete edition and round-trips it through JSON", () => {
		const content = validContent();
		const parsed = editionContentSchema.parse(
			JSON.parse(JSON.stringify(content)),
		);
		expect(parsed).toEqual(content);
	});

	it("accepts an empty edition with a numeric pipeline version", () => {
		const content: EditionContent = {
			...validContent(),
			pipelineVersion: 3,
			sections: [],
			visuals: {},
			appendix: {
				sources: [],
				details: [],
				placeholders: [],
				assumptions: [],
				additionalMaterial: [],
			},
		};
		expect(editionContentSchema.safeParse(content).success).toBe(true);
	});

	it("rejects an anchor that names a visual the edition does not carry", () => {
		const content = validContent();
		content.sections[1].anchors.push({
			blockIndex: 0,
			ref: { type: "visual", visualKey: "missing" },
		});
		const result = editionContentSchema.safeParse(content);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual([
			"sections",
			1,
			"anchors",
			0,
			"ref",
			"visualKey",
		]);
	});

	it("checks anchors in the appendix's additional material too", () => {
		const content = validContent();
		content.appendix.additionalMaterial[0].anchors.push({
			blockIndex: 0,
			ref: { type: "visual", visualKey: "missing" },
		});
		expect(editionContentSchema.safeParse(content).success).toBe(false);
	});

	it("rejects a visual whose kind disagrees with its spec", () => {
		const content = validContent();
		content.visuals["visual-1"].kind = "flow";
		expect(editionContentSchema.safeParse(content).success).toBe(false);
	});

	it("rejects an unresolved auto visual", () => {
		const content = validContent();
		content.visuals["visual-1"] = {
			kind: "auto",
			spec: { kind: "auto" },
			specHash: "0000",
			source: "slot",
		};
		expect(editionContentSchema.safeParse(content).success).toBe(false);
	});

	it("rejects an invalid visual spec", () => {
		const content = validContent();
		content.visuals["visual-1"].spec = {
			kind: "timeline",
			items: [{ date: "Q1", label: "Only one" }],
		};
		expect(editionContentSchema.safeParse(content).success).toBe(false);
	});

	it("rejects an unknown wording, mode, or length", () => {
		for (const patch of [
			{ lengthMode: "long" },
			{ mode: "surprise_me" },
		] as const) {
			expect(
				editionContentSchema.safeParse({ ...validContent(), ...patch })
					.success,
			).toBe(false);
		}
		const content = validContent() as unknown as {
			sections: Array<{ wording: string }>;
		};
		content.sections[0].wording = "paraphrased";
		expect(editionContentSchema.safeParse(content).success).toBe(false);
	});

	it("keeps the sections the build's detection covered, and still reads an edition stored before they were recorded", () => {
		const recorded = validContent();
		recorded.report.detectedSectionKeys = ["section-a"];
		expect(
			editionContentSchema.parse(JSON.parse(JSON.stringify(recorded)))
				.report.detectedSectionKeys,
		).toEqual(["section-a"]);

		const older = validContent();
		expect("detectedSectionKeys" in older.report).toBe(false);
		const parsed = editionContentSchema.parse(older);
		expect(parsed.report.detectedSectionKeys).toBeUndefined();

		const malformed = validContent() as unknown as {
			report: { detectedSectionKeys: unknown };
		};
		malformed.report.detectedSectionKeys = "section-a";
		expect(editionContentSchema.safeParse(malformed).success).toBe(false);
	});

	it("requires an ISO build timestamp in the provenance", () => {
		const content = validContent();
		content.provenance.builtAt = "yesterday";
		expect(editionContentSchema.safeParse(content).success).toBe(false);
	});

	it("stores cleanup's appendix entries without reshaping them", () => {
		expectTypeOf<Omit<GlossyAppendix, "additionalMaterial">>().toExtend<
			Omit<EditionAppendix, "additionalMaterial">
		>();
	});

	it("stays browser-safe: no Node built-ins", () => {
		const source = readFileSync(
			join(__dirname, "../lib/glossy/edition-content.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/from "node:/);
	});
});

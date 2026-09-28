/**
 * Synthetic Glossy editions for the page tests (Fizzy #2589). Every name,
 * organization, and host is an example value.
 */

import type {
	EditionContent,
	EditionVisual,
} from "@repo/utils/glossy/edition-content";
import type { GlossyEdition } from "../../../hooks/use-glossy-edition";

export const PROJECT_ID = "project-1";
export const DOCUMENT_ID = "document-1";

export const TIMELINE_KEY = "visual-timeline";
export const COMPARISON_KEY = "visual-comparison";
export const DIAGRAM_KEY = "visual-diagram";

export function timelineVisual(
	overrides: Partial<EditionVisual> = {},
): EditionVisual {
	return {
		kind: "timeline",
		spec: {
			kind: "timeline",
			title: "Delivery plan",
			items: [
				{ date: "Q3 2026", label: "Discovery" },
				{ date: "Q4 2026", label: "Rollout" },
			],
		},
		specHash: "hash-timeline",
		source: "detected",
		reason: "The section lists phases with dates.",
		...overrides,
	};
}

export function comparisonVisual(
	overrides: Partial<EditionVisual> = {},
): EditionVisual {
	return {
		kind: "comparison",
		spec: {
			kind: "comparison",
			title: "Options compared",
			items: [
				{ title: "Option A", points: ["Lower cost"] },
				{ title: "Option B", points: ["Faster delivery"] },
			],
		},
		specHash: "hash-comparison",
		source: "detected",
		reason: "Two options are weighed against each other.",
		...overrides,
	};
}

export function diagramVisual(): EditionVisual {
	return {
		kind: "existing_mermaid",
		spec: {
			kind: "existing_mermaid",
			title: "Approval flow",
			source: "graph TD; A-->B",
		},
		specHash: "hash-diagram",
		source: "existing_mermaid",
	};
}

export function editionContent(
	overrides: Partial<EditionContent> = {},
): EditionContent {
	return {
		title: "Example business case",
		pipelineVersion: "1",
		lengthMode: "brief",
		mode: "roll_the_dice",
		sections: [
			{
				sectionKey: "section-summary",
				headingPath: ["Executive summary"],
				heading: "Executive summary",
				level: 2,
				markdown:
					"The programme costs 240k and starts in Q3.\n\nIt pays back within a year.",
				wording: "rewritten",
				anchors: [
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: TIMELINE_KEY },
					},
				],
			},
			{
				sectionKey: "section-options",
				headingPath: ["Budget and options"],
				heading: "Budget and options",
				level: 2,
				markdown: "Two options were considered.",
				wording: "original",
				keptOriginalReason: "fact_guard",
				anchors: [
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: COMPARISON_KEY },
					},
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: DIAGRAM_KEY },
					},
				],
			},
		],
		visuals: {
			[TIMELINE_KEY]: timelineVisual(),
			[COMPARISON_KEY]: comparisonVisual(),
			[DIAGRAM_KEY]: diagramVisual(),
		},
		appendix: {
			sources: [{ id: "S1", text: "Example Org annual report" }],
			details: [{ label: "Client", value: "Example Corp" }],
			placeholders: [],
			assumptions: [],
			additionalMaterial: [],
		},
		report: {
			keptOriginal: [
				{ heading: "Budget and options", reason: "fact_guard" },
			],
			droppedVisuals: [],
			unfilledSlots: [],
			scaffoldingUnrecognized: false,
		},
		provenance: {
			sourceTitle: "Example business case",
			sourceVersion: 4,
			builtAt: "2026-09-20T10:00:00.000Z",
		},
		...overrides,
	};
}

type EditionOverrides = Partial<Omit<GlossyEdition, "edition" | "brand">> & {
	edition?: Partial<NonNullable<GlossyEdition["edition"]>> | null;
	brand?: Partial<GlossyEdition["brand"]>;
};

export function glossyEdition(overrides: EditionOverrides = {}): GlossyEdition {
	const { edition: editionOverrides, brand, ...rest } = overrides;
	const edition: GlossyEdition["edition"] =
		editionOverrides === null
			? null
			: {
					content: editionContent(),
					contentRevision: 1,
					updatedAt: new Date("2026-09-20T10:00:00.000Z"),
					builtFrom: {
						title: "Example business case",
						version: 4,
						builtAt: new Date("2026-09-20T10:00:00.000Z"),
					},
					outOfDate: false,
					lastRebuildFailed: false,
					decisions: [],
					lastOptions: {
						mode: "roll_the_dice",
						lengthMode: "brief",
						styleDirection: null,
						preparerOverrides: null,
					},
					...editionOverrides,
				};
	return {
		document: {
			title: "Example business case",
			type: "BUSINESS_CASE",
			version: 4,
		},
		eligibility: { eligible: true, reason: null },
		canEdit: true,
		build: { status: "idle" },
		imageUrls: {},
		...rest,
		edition,
		brand: {
			preparer: {
				name: "Example Org",
				logoUrl: null,
				brandColorName: null,
				accentColors: [],
				guidance: "Calm and factual.",
			},
			recipient: null,
			recipientVersion: 0,
			...brand,
		},
	};
}

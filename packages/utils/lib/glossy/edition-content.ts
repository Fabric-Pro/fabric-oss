/**
 * The stored Glossy edition content (Fizzy #2589, KTD15, KTD16, R43).
 *
 * One JSON document per edition, in `GlossyEdition.content`: the build's
 * finalize step writes it (U10), the get procedure serves it (U11), and the
 * browser renders it into the preview, PDF, and DOCX (U13, U14). Branding is
 * not part of it — the browser applies the Brand kit and recipient brand at
 * render time, so a brand change never needs a rebuild.
 *
 * Section and appendix shapes follow `cleanup.ts`; visual specs are U5's
 * `visualSpecSchema`. The one departure from cleanup is the anchor: cleanup
 * lifts raw slot tags, Mermaid fences, and image tags, while a stored anchor
 * only points at what the renderer draws — a visual in `visuals` or one of
 * the document's own uploaded images. Raw diagram source therefore never
 * reaches section text (R13).
 *
 * No Node built-ins: the web bundle parses this schema.
 */

import { z } from "zod";
import { visualSpecSchema } from "./visual-spec";

// ---------------------------------------------------------------------------
// Anchors and sections
// ---------------------------------------------------------------------------

/** What an anchor draws: a visual from `visuals`, or an uploaded image. */
const editionAnchorRefSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("visual"),
		/** Key into `EditionContent.visuals`. */
		visualKey: z.string().min(1),
	}),
	z.object({
		type: z.literal("image"),
		/** The document's own upload; the server re-signs it for each render (KTD16). */
		s3Key: z.string().min(1),
	}),
]);

/**
 * Layout placed next to the text it illustrates (R19). `blockIndex` counts
 * the section's text blocks above the anchor, the rule `splitMarkdownBlocks`
 * and `placeAnchors` in `cleanup.ts` use; anchors sharing an index keep
 * their order.
 */
export const editionAnchorSchema = z.object({
	blockIndex: z.number().int().min(0),
	ref: editionAnchorRefSchema,
});

/** One main-flow section, in document order. */
export const editionSectionSchema = z.object({
	/** `computeSectionKey` of the cleaned source section; review decisions hang off it. */
	sectionKey: z.string().min(1),
	/** Cleaned heading path from `parseOutline`; `[]` for text before the first heading. */
	headingPath: z.array(z.string()),
	/** Cleaned heading text; `null` for text before the first heading. */
	heading: z.string().nullable(),
	/** ATX level of the heading; `0` for text before the first heading. */
	level: z.number().int().min(0).max(6),
	/** Section body as Markdown, anchors lifted out. Rendered without raw HTML or remote images (KTD16). */
	markdown: z.string(),
	/** `original` when the fact guard or the model failed and the cleaned source text was kept. */
	wording: z.enum(["rewritten", "original"]),
	/** Why the original wording was kept; set only when `wording` is `original`. */
	keptOriginalReason: z.string().optional(),
	anchors: z.array(editionAnchorSchema),
});

/** A section of the source's own Appendix, cleaned like the main flow but never rewritten. */
export const editionAppendixSectionSchema = z.object({
	heading: z.string().nullable(),
	level: z.number().int().min(0).max(6),
	markdown: z.string(),
	anchors: z.array(editionAnchorSchema),
});

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

/** One visual, rendered in the browser from its spec (KTD15). */
export const editionVisualSchema = z
	.object({
		/** Mirrors `spec.kind`, so a listing never has to open the spec. */
		kind: z.string().min(1),
		spec: visualSpecSchema,
		/** `specHash(spec)`; an acceptance applies only while it matches (U20). */
		specHash: z.string().min(1),
		/** Model detection, an editor's slot, or a restyled ```mermaid fence (R19). */
		source: z.enum(["detected", "slot", "existing_mermaid"]),
		/** The detection reason shown to editors; plain text, never HTML. */
		reason: z.string().optional(),
	})
	.superRefine((visual, ctx) => {
		if (visual.spec.kind === "auto") {
			ctx.addIssue({
				code: "custom",
				path: ["spec", "kind"],
				message: "A stored visual must have a resolved kind, not auto.",
			});
		}
		if (visual.kind !== visual.spec.kind) {
			ctx.addIssue({
				code: "custom",
				path: ["kind"],
				message: `Visual kind "${visual.kind}" does not match its spec kind "${visual.spec.kind}".`,
			});
		}
	});

// ---------------------------------------------------------------------------
// Appendix, report, provenance
// ---------------------------------------------------------------------------

/** Scaffolding relocated out of the main flow (R11, R12, R41); last in every download (R36). */
export const editionAppendixSchema = z.object({
	/** Source Index entries; `id` is "S1" for an `[S1]` entry. */
	sources: z.array(z.object({ id: z.string().nullable(), text: z.string() })),
	/** Document-control and cover fields, such as `Client: Example Org`. */
	details: z.array(
		z.object({ label: z.string().nullable(), value: z.string() }),
	),
	/** TBD and placeholder fields moved out of the main flow, by source heading. */
	placeholders: z.array(
		z.object({ heading: z.string().nullable(), text: z.string() }),
	),
	/** Statements kept in the main flow with a qualifier such as "assumed" (R41). */
	assumptions: z.array(
		z.object({
			heading: z.string().nullable(),
			text: z.string(),
			status: z.enum([
				"DIRECTIONALLY_CONFIRMED",
				"ASSUMED",
				"TBD",
				"DERIVED_DEPENDENCY",
			]),
			qualifier: z.enum([
				"indicative",
				"assumed",
				"to be confirmed",
				"dependent",
			]),
		}),
	),
	/** The source document's own Appendix section. */
	additionalMaterial: z.array(editionAppendixSectionSchema),
});

/** What editors see in the status strip; never rendered into a download. */
export const editionReportSchema = z.object({
	keptOriginal: z.array(
		z.object({ heading: z.string().nullable(), reason: z.string() }),
	),
	droppedVisuals: z.array(
		z.object({
			kind: z.string(),
			heading: z.string().nullable(),
			reason: z.string(),
		}),
	),
	unfilledSlots: z.array(
		z.object({ slotId: z.string(), reason: z.string() }),
	),
	/** Cleanup recognized none of the type's scaffolding, or left citation-like text behind (KTD11). */
	scaffoldingUnrecognized: z.boolean(),
	/**
	 * Build bookkeeping, not shown to editors: the sections whose detection
	 * this edition settled, in document order (KTD9). A Roll-the-dice rebuild
	 * detects again over every other section, such as one whose detection
	 * degraded. Absent from an edition stored before it was recorded; every
	 * section of such an edition counts as detected.
	 */
	detectedSectionKeys: z.array(z.string().min(1)).optional(),
});

/**
 * The section key review decisions use for a diagram only the source's own
 * Appendix shows: the appendix has no section key of its own. A build keeps
 * decisions filed under it, like those of a main-flow section that still
 * exists (R29).
 */
export const GLOSSY_APPENDIX_SECTION_KEY = "appendix";

/** The appendix's closing provenance line (R43). */
export const editionProvenanceSchema = z.object({
	sourceTitle: z.string(),
	/** `ProjectDocument.version` of the build snapshot. */
	sourceVersion: z.number().int().min(0),
	/** ISO 8601 timestamp of the finalize step. */
	builtAt: z.iso.datetime({ offset: true }),
});

// ---------------------------------------------------------------------------
// Edition content
// ---------------------------------------------------------------------------

export const editionContentSchema = z
	.object({
		title: z.string().min(1),
		/** `GLOSSY_PIPELINE_VERSION` at build time (KTD14). */
		pipelineVersion: z.union([z.string().min(1), z.number()]),
		lengthMode: z.enum(["brief", "standard"]),
		mode: z.enum(["roll_the_dice", "align_first"]),
		sections: z.array(editionSectionSchema),
		/** Keyed by the visual key from `keys.ts`. */
		visuals: z.record(z.string().min(1), editionVisualSchema),
		appendix: editionAppendixSchema,
		report: editionReportSchema,
		provenance: editionProvenanceSchema,
	})
	.superRefine((content, ctx) => {
		// Every visual anchor must resolve, so a renderer never meets a
		// dangling reference it would silently drop.
		const checkAnchors = (
			anchors: ReadonlyArray<z.infer<typeof editionAnchorSchema>>,
			path: (string | number)[],
		) => {
			anchors.forEach((anchor, index) => {
				if (
					anchor.ref.type === "visual" &&
					!Object.hasOwn(content.visuals, anchor.ref.visualKey)
				) {
					ctx.addIssue({
						code: "custom",
						path: [...path, index, "ref", "visualKey"],
						message: `Anchor references unknown visual "${anchor.ref.visualKey}".`,
					});
				}
			});
		};
		content.sections.forEach((section, index) => {
			checkAnchors(section.anchors, ["sections", index, "anchors"]);
		});
		content.appendix.additionalMaterial.forEach((section, index) => {
			checkAnchors(section.anchors, [
				"appendix",
				"additionalMaterial",
				index,
				"anchors",
			]);
		});
	});

export type EditionAnchor = z.infer<typeof editionAnchorSchema>;
export type EditionSection = z.infer<typeof editionSectionSchema>;
export type EditionAppendixSection = z.infer<
	typeof editionAppendixSectionSchema
>;
export type EditionVisual = z.infer<typeof editionVisualSchema>;
export type EditionAppendix = z.infer<typeof editionAppendixSchema>;
export type EditionReport = z.infer<typeof editionReportSchema>;
export type EditionProvenance = z.infer<typeof editionProvenanceSchema>;
export type EditionContent = z.infer<typeof editionContentSchema>;
export type EditionLengthMode = EditionContent["lengthMode"];
export type EditionMode = EditionContent["mode"];

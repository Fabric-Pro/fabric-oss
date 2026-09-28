import {
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
	GLOSSY_DETECTABLE_KINDS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import { generateObject, NoObjectGeneratedError, zodSchema } from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays unmocked in tests
// that mock the root module, as in update-with-context-core.ts.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import type { GlossySection } from "@repo/utils/glossy/cleanup";
import {
	checkVisualFacts,
	type FactGuardViolation,
} from "@repo/utils/glossy/fact-guard";
import {
	type VisualKind,
	type VisualSpec,
	visualSpecFacts,
	visualSpecSchema,
} from "@repo/utils/glossy/visual-spec";
import { z } from "zod";
import {
	type GlossyAiProviderNotConfigured,
	type GlossyModelContext,
	resolveGlossyModel,
} from "./model";

/**
 * Visual extraction for one Glossy opportunity or slot (Fizzy #2589, R18,
 * R22, AE4).
 *
 * One `generateObject` per visual, with the requested kind's schema; `auto`
 * (a slot that lets the model choose) offers all five. The variant nonce
 * drives a single-visual regenerate. The result is then:
 * 1. validated against the strict `visualSpecSchema` (bounds, org chart tree),
 * 2. required to be the kind asked for (any concrete kind for `auto`),
 * 3. fact-checked: `checkVisualFacts(visualSpecFacts(spec), section)`.
 * A visual that fails any step, or whose response was truncated, is
 * `dropped` with its reason and never shown (R18). Slot callers report the
 * same outcome as an unfilled slot (R22).
 *
 * The model-facing schema below is deliberately lenient — no bounds, every
 * optional field nullable — and built with this package's zod: bounds are
 * enforced by the strict schema in step 1, where a failure is a reasoned drop
 * instead of an unparseable response, and a schema with every key required
 * is what strict structured-output providers accept.
 */

const EXTRACTION_LOG = "[GlossyExtract]";

/** The kinds a spec can be extracted as; existing Mermaid is restyled, not extracted. */
export type GlossyExtractableKind = Exclude<VisualKind, "existing_mermaid">;

export type GlossyExtractedVisualSpec = Extract<
	VisualSpec,
	{ kind: GlossyDetectableKind }
>;

const nullableText = (description: string) =>
	z.string().nullable().describe(`${description} null when not used.`);

const OUTPUT_SPEC_SCHEMAS = {
	timeline: z.object({
		kind: z.enum(["timeline"]),
		title: nullableText("Optional title from the section's wording."),
		items: z
			.array(
				z.object({
					date: z
						.string()
						.describe(
							"The section's own date, quarter, or phase name.",
						),
					label: z.string().describe("What happens."),
					description: nullableText("Optional detail."),
				}),
			)
			.describe("2–8 entries in chronological order."),
	}),
	comparison: z.object({
		kind: z.enum(["comparison"]),
		title: nullableText("Optional title from the section's wording."),
		items: z
			.array(
				z.object({
					title: z.string().describe("The option's name."),
					points: z.array(z.string()).describe("1–6 short points."),
				}),
			)
			.describe("2–4 options."),
	}),
	stat: z.object({
		kind: z.enum(["stat"]),
		title: nullableText("Optional title from the section's wording."),
		items: z
			.array(
				z.object({
					value: z
						.string()
						.describe(
							"The figure exactly as the section writes it.",
						),
					label: z.string().describe("What the figure measures."),
				}),
			)
			.describe("1–4 figures."),
	}),
	flow: z.object({
		kind: z.enum(["flow"]),
		title: nullableText("Optional title from the section's wording."),
		steps: z
			.array(
				z.object({
					label: z.string().describe("The step."),
					description: nullableText("Optional detail."),
					lane: nullableText(
						"Who performs the step, as the section names them.",
					),
				}),
			)
			.describe("2–8 steps in order."),
	}),
	org_chart: z.object({
		kind: z.enum(["org_chart"]),
		title: nullableText("Optional title from the section's wording."),
		nodes: z
			.array(
				z.object({
					id: z.string().describe("A short unique id."),
					label: z.string().describe("The role or person."),
					parentId: z
						.string()
						.nullable()
						.describe(
							"The id of the node this one reports to; null for exactly one top node.",
						),
				}),
			)
			.describe("2–16 roles forming one tree."),
	}),
} satisfies Record<GlossyDetectableKind, z.ZodType>;

/** Structured-output providers want an object at the root, so the spec is a property. */
function outputSchemaFor(
	kind: GlossyExtractableKind,
): z.ZodType<{ spec: unknown }> {
	if (kind === "auto") {
		return z.object({
			spec: z
				.union([
					OUTPUT_SPEC_SCHEMAS.timeline,
					OUTPUT_SPEC_SCHEMAS.comparison,
					OUTPUT_SPEC_SCHEMAS.stat,
					OUTPUT_SPEC_SCHEMAS.flow,
					OUTPUT_SPEC_SCHEMAS.org_chart,
				])
				.describe("The spec, of the kind that fits the section best."),
		});
	}
	return z.object({ spec: OUTPUT_SPEC_SCHEMAS[kind] });
}

export interface ExtractGlossyVisualInput extends GlossyModelContext {
	documentType: string;
	/** The cleaned section the visual belongs to. */
	section: Pick<GlossySection, "heading" | "markdown">;
	kind: GlossyExtractableKind;
	slotHint?: string | null;
	styleDirection?: string | null;
	/** Server-generated; set for a regenerate so the model offers a different variant. */
	variantNonce?: string | null;
}

export type GlossyExtractionDropReason =
	/** The response hit the output-token limit. */
	| "truncated"
	/** The response did not parse, or failed the strict spec schema. */
	| "invalidSpec"
	/** The spec is not the kind that was asked for. */
	| "kindMismatch"
	/** A label, figure, or date is not in the section (R18). */
	| "factCheck";

export type GlossyExtractionResult =
	| { status: "extracted"; spec: GlossyExtractedVisualSpec }
	| {
			status: "dropped";
			reason: GlossyExtractionDropReason;
			/** Fixed text per reason; safe to persist and show. */
			message: string;
			/** The fact guard's findings, for `factCheck` only. */
			violations: FactGuardViolation[];
	  }
	| GlossyAiProviderNotConfigured;

const DROP_MESSAGES: Readonly<Record<GlossyExtractionDropReason, string>> = {
	truncated: "The visual's response was cut off before it was complete.",
	invalidSpec: "The visual's content did not form a valid spec for its kind.",
	kindMismatch: "The visual came back as a different kind than requested.",
	factCheck:
		"The visual showed a label, figure, or date that is not in its section.",
};

function dropped(
	reason: GlossyExtractionDropReason,
	violations: FactGuardViolation[] = [],
): GlossyExtractionResult {
	return {
		status: "dropped",
		reason,
		message: DROP_MESSAGES[reason],
		violations,
	};
}

/** A leading heading number ("5. ", "1A) ") is structure, not a fact the visual may show. */
const HEADING_NUMBERING = /^\d+[A-Za-z]?\\?[.)]\s+/;

/** The segment a visual is checked against: its heading text and body. */
function factSource(
	section: Pick<GlossySection, "heading" | "markdown">,
): string {
	const heading = section.heading?.trim().replace(HEADING_NUMBERING, "");
	return heading ? `${heading}\n\n${section.markdown}` : section.markdown;
}

/** Map the lenient output back to the strict spec shape: null optionals become absent. */
function toSpecCandidate(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(toSpecCandidate);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(value)) {
		// `parentId: null` marks the org chart root and stays.
		if (field === null && key !== "parentId") {
			continue;
		}
		out[key] = toSpecCandidate(field);
	}
	return out;
}

function isExtractedKind(
	spec: VisualSpec,
	requested: GlossyExtractableKind,
): spec is GlossyExtractedVisualSpec {
	if (requested === "auto") {
		return (GLOSSY_DETECTABLE_KINDS as readonly string[]).includes(
			spec.kind,
		);
	}
	return spec.kind === requested;
}

export async function extractGlossyVisual(
	input: ExtractGlossyVisualInput,
): Promise<GlossyExtractionResult> {
	const resolved = await resolveGlossyModel(input);
	if (resolved.status !== "resolved") {
		return resolved;
	}
	const { model, metadata, trackUsage } = resolved;

	const instructions = buildGlossyExtractInstructions(input.documentType);
	const prompt = buildGlossyExtractPrompt({
		kind: input.kind,
		heading: input.section.heading,
		markdown: input.section.markdown,
		slotHint: input.slotHint,
		styleDirection: input.styleDirection,
		variantNonce: input.variantNonce,
	});
	// A spec is bounded (at most 16 short entries), so the floor suffices.
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: 0,
		promptChars: instructions.length + prompt.length,
	});

	let raw: unknown;
	try {
		const { object } = await generateObject({
			model,
			schema: zodSchema(outputSchemaFor(input.kind)),
			instructions,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
		});
		raw = object.spec;
	} catch (error) {
		if (NoObjectGeneratedError.isInstance(error)) {
			const reason =
				error.finishReason === "length" ? "truncated" : "invalidSpec";
			console.warn(`${EXTRACTION_LOG} Visual dropped`, {
				reason,
				kind: input.kind,
				projectId: input.projectId,
				provider: metadata.provider,
			});
			return dropped(reason);
		}
		throw error;
	}
	trackUsage();

	const parsed = visualSpecSchema.safeParse(toSpecCandidate(raw));
	if (!parsed.success) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "invalidSpec",
			kind: input.kind,
			projectId: input.projectId,
			issues: parsed.error.issues.length,
		});
		return dropped("invalidSpec");
	}
	const spec = parsed.data;
	if (!isExtractedKind(spec, input.kind)) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "kindMismatch",
			kind: input.kind,
			returnedKind: spec.kind,
			projectId: input.projectId,
		});
		return dropped("kindMismatch");
	}

	const facts = checkVisualFacts(
		visualSpecFacts(spec),
		factSource(input.section),
	);
	if (!facts.pass) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "factCheck",
			kind: spec.kind,
			projectId: input.projectId,
			violations: facts.violations.map((violation) => violation.kind),
		});
		return dropped("factCheck", facts.violations);
	}
	return { status: "extracted", spec };
}

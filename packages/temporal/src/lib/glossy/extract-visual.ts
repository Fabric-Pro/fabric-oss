import {
	boundGlossyField,
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_EDIT_INSTRUCTION_MAX_CHARS,
	GLOSSY_EDITABLE_KINDS,
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
	type VisualFactsInput,
	violationCode,
} from "@repo/utils/glossy/fact-guard";
import {
	type VisualKind,
	type VisualSpec,
	visualSpecFacts,
	visualSpecSchema,
} from "@repo/utils/glossy/visual-spec";
import { diagramFences } from "@repo/utils/proposal-artifact/visual-identity";
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
 * 3. fact-checked: `checkVisualFacts(visualFactsOf(…), section)`, which
 *    also checks a flow's order (a flow the author's slot asked for states
 *    its own) and an org chart's reporting lines.
 * A visual that fails any step, or whose response was truncated, is
 * `dropped` with its reason and never shown (R18). Slot callers report the
 * same outcome as an unfilled slot (R22).
 *
 * Edit with instructions (Fizzy #2946) runs the same call with the editor's
 * request and the diagram's current source. The section the model reads and
 * the fact check reads then has every diagram fence removed, so a wrong
 * date in the old diagram cannot justify itself, and `auto` offers only the
 * kinds drawn as a diagram.
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
	editing: boolean,
): z.ZodType<{ spec: unknown }> {
	if (kind === "auto" && editing) {
		return z.object({
			spec: z
				.union([
					OUTPUT_SPEC_SCHEMAS.timeline,
					OUTPUT_SPEC_SCHEMAS.flow,
					OUTPUT_SPEC_SCHEMAS.org_chart,
				])
				.describe("The spec, of the kind the current diagram shows."),
		});
	}
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
	/**
	 * Where the request comes from: an author's visual slot that asked for
	 * exactly `kind`, or anything else. A slot that asks for a flow states the
	 * order itself, so its flow skips the stated-order rule (Fizzy #2589
	 * follow-up). Unset means detected: the stricter check.
	 */
	source?: "slot" | "detected";
	/**
	 * The Proposal artifact's visuals step: asks for labels short enough to
	 * read at page width (Fizzy #2946). Unset for Glossy, whose prompt is
	 * unchanged.
	 */
	proposalArtifact?: boolean;
	/**
	 * Edit with instructions on a Proposal (Fizzy #2946): the editor's
	 * request for a change to one diagram. Read only with
	 * `proposalArtifact`; with it, `currentSource` is the diagram's source
	 * and every diagram fence leaves the section first. A request that
	 * bounds to nothing is dropped as `invalidSpec` before any model call.
	 */
	instruction?: string | null;
	/** The diagram's current Mermaid source, marker line excluded. */
	currentSource?: string | null;
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
		"The visual showed a label, figure, date, or structure that is not in its section.",
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

/**
 * Whether the author asked for a flow: a slot whose own kind is flow. A
 * best-fit (`auto`) slot leaves the kind to the model, so its flow is
 * checked like a detected one.
 */
function isAuthorRequestedFlow(input: ExtractGlossyVisualInput): boolean {
	return input.source === "slot" && input.kind === "flow";
}

/**
 * What the fact check reads from a spec: its text and figures, plus the
 * section heading, a flow's step labels and whether the author asked for
 * it, and an org chart's drawn edges as (child label, parent label) pairs,
 * so a flow drawn from a list or an org chart with an unstated reporting
 * line fails (Fizzy #2589 follow-up).
 */
function visualFactsOf(
	spec: GlossyExtractedVisualSpec,
	section: Pick<GlossySection, "heading">,
	authorRequested: boolean,
): VisualFactsInput {
	const facts: VisualFactsInput = {
		...visualSpecFacts(spec),
		heading: section.heading,
	};
	if (spec.kind === "flow") {
		return {
			...facts,
			flowSteps: spec.steps.map((step) => step.label),
			authorRequested,
		};
	}
	if (spec.kind === "org_chart") {
		const labelById = new Map(
			spec.nodes.map((node) => [node.id, node.label]),
		);
		return {
			...facts,
			orgChartEdges: spec.nodes.flatMap((node) => {
				const parent =
					node.parentId === null
						? undefined
						: labelById.get(node.parentId);
				return parent === undefined
					? []
					: [{ child: node.label, parent }];
			}),
		};
	}
	return facts;
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
	editing: boolean,
): spec is GlossyExtractedVisualSpec {
	if (requested === "auto") {
		return (
			(editing
				? GLOSSY_EDITABLE_KINDS
				: GLOSSY_DETECTABLE_KINDS) as readonly string[]
		).includes(spec.kind);
	}
	return spec.kind === requested;
}

/**
 * `markdown` without its diagram fences: every fence `diagramFences` finds,
 * nested ones (in a blockquote or a list item) included, loses its whole
 * line range. An unclosed fence runs to the end of its container, as a
 * Markdown reader takes it.
 */
function withoutDiagramFences(markdown: string): string {
	const normalised = markdown.replace(/\r\n?/g, "\n");
	const lines = normalised.split("\n");
	const fences = diagramFences(normalised);
	for (let index = fences.length - 1; index >= 0; index--) {
		const position = fences[index].position;
		if (!position) {
			continue;
		}
		lines.splice(
			position.start.line - 1,
			position.end.line - position.start.line + 1,
		);
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function extractGlossyVisual(
	input: ExtractGlossyVisualInput,
): Promise<GlossyExtractionResult> {
	const resolved = await resolveGlossyModel(input);
	if (resolved.status !== "resolved") {
		return resolved;
	}
	const { model, metadata, trackUsage } = resolved;

	// An edit is a Proposal call that carries a request at all, so a request
	// that bounds to nothing (only whitespace or control characters) is
	// refused rather than run as a plain extraction over the old diagram.
	const editing =
		input.proposalArtifact === true && input.instruction != null;
	const instruction = editing
		? boundGlossyField(input.instruction, GLOSSY_EDIT_INSTRUCTION_MAX_CHARS)
		: null;
	if (editing && instruction === null) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "invalidSpec",
			cause: "emptyInstruction",
			kind: input.kind,
			projectId: input.projectId,
		});
		return dropped("invalidSpec");
	}
	const section: Pick<GlossySection, "heading" | "markdown"> = editing
		? {
				heading: input.section.heading,
				markdown: withoutDiagramFences(input.section.markdown),
			}
		: input.section;

	const instructions = buildGlossyExtractInstructions(input.documentType, {
		proposalArtifact: input.proposalArtifact,
		...(editing ? { editInstruction: true } : {}),
	});
	const prompt = buildGlossyExtractPrompt({
		kind: input.kind,
		heading: section.heading,
		markdown: section.markdown,
		slotHint: input.slotHint,
		styleDirection: input.styleDirection,
		variantNonce: input.variantNonce,
		...(editing
			? { instruction, currentSource: input.currentSource ?? "" }
			: {}),
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
			schema: zodSchema(outputSchemaFor(input.kind, editing)),
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
	if (!isExtractedKind(spec, input.kind, editing)) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "kindMismatch",
			kind: input.kind,
			returnedKind: spec.kind,
			projectId: input.projectId,
		});
		return dropped("kindMismatch");
	}

	const facts = checkVisualFacts(
		visualFactsOf(spec, section, isAuthorRequestedFlow(input)),
		factSource(section),
	);
	if (!facts.pass) {
		// Codes only (`presence:date`), never the fact or section text.
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "factCheck",
			kind: spec.kind,
			projectId: input.projectId,
			violations: facts.violations.map(violationCode),
		});
		return dropped("factCheck", facts.violations);
	}
	return { status: "extracted", spec };
}

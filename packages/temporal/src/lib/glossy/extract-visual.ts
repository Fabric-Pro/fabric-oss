import {
	boundGlossyField,
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_EDIT_AUTO_KINDS,
	GLOSSY_EDIT_INSTRUCTION_MAX_CHARS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import {
	generateText,
	NoObjectGeneratedError,
	Output,
	zodSchema,
} from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays unmocked in tests
// that mock the root module, as in update-with-context-core.ts.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { requireStructuredOutput } from "@repo/ai/lib/structured-output";
import type { GlossySection } from "@repo/utils/glossy/cleanup";
import {
	checkVisualFacts,
	type FactGuardViolation,
	type VisualFactsInput,
	violationCode,
} from "@repo/utils/glossy/fact-guard";
import {
	balancedProposalComparison,
	isProposalTimelinePeriod,
	type ProposalOnlyVisualKind,
	type ProposalVisualSpec,
	proposalVisualSpecSchema,
	type VisualKind,
	type VisualSpec,
	visualSpecFacts,
	visualSpecSchema,
} from "@repo/utils/glossy/visual-spec";
import { proposalLabelCase } from "@repo/utils/glossy/visual-templates";
import { scrubCitationText } from "@repo/utils/proposal-artifact/export-scrub";
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
 * One structured `generateText` per visual, with the requested kind's schema; `auto`
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
 * timeline, flow and org chart kinds (`GLOSSY_EDIT_AUTO_KINDS`): a layers or
 * team figure always carries its figure line, so its edit names its kind.
 *
 * A Proposal (`proposalArtifact`) may also ask for `layers` or `team`, which
 * only its figure templates draw: their schemas, prompt rules and the strict
 * `proposalVisualSpecSchema` are used for a Proposal only, so a Glossy call
 * still validates with `visualSpecSchema` and never returns either kind.
 *
 * A Proposal also holds its timeline and comparison to what its figures and
 * tables show (Fizzy #2946), after the kind check and before the fact
 * check: a new timeline whose every date is not a short period
 * (`isProposalTimelinePeriod`; an edit keeps an existing timeline's dates)
 * and a comparison whose columns are badly
 * uneven (`balancedProposalComparison`) are dropped as `invalidSpec`, so
 * the section keeps its prose; a kept comparison loses the points no other
 * column has a row for. Its visuals step, outside an edit, also asks for a
 * `caption` beside the spec: the extracted result carries the spec's title,
 * else that caption once it is cleaned and passes the fact check on its
 * own; a caption that does not is left out and the visual kept. An edit
 * asks for none: the editor keeps the fence's own caption.
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

/** The kinds a Proposal can ask for: Glossy's and its own. */
export type ProposalExtractableKind =
	| GlossyExtractableKind
	| ProposalOnlyVisualKind;

export type ProposalExtractedVisualSpec = Extract<
	ProposalVisualSpec,
	{ kind: GlossyDetectableKind | ProposalOnlyVisualKind }
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

/** The Proposal-only kinds' model-facing schemas, in the same lenient style. */
const PROPOSAL_OUTPUT_SPEC_SCHEMAS = {
	layers: z.object({
		kind: z.enum(["layers"]),
		title: nullableText("Optional title from the section's wording."),
		layers: z
			.array(
				z.object({
					name: z
						.string()
						.describe(
							"The layer's name, as the section writes it.",
						),
					description: nullableText(
						"Optional: what the layer is for, in a few words.",
					),
					components: z
						.array(z.string())
						.describe("1–5 components in this layer."),
				}),
			)
			.describe("2–8 layers, top to bottom."),
		crosscutting: z
			.object({
				name: z.string().describe("What spans every layer."),
				description: nullableText("Optional detail."),
				items: z.array(z.string()).describe("1–6 names."),
			})
			.nullable()
			.describe(
				"Capabilities the section says span every layer. null when it names none.",
			),
	}),
	team: (() => {
		const side = (description: string) =>
			z
				.object({
					name: z
						.string()
						.describe(
							"The team or organization, as the section writes it.",
						),
					description: nullableText("Optional detail."),
					members: z
						.array(
							z.object({
								role: z.string().describe("The role."),
								name: nullableText(
									"The person's name, only when the section gives it.",
								),
								description: nullableText("Optional detail."),
							}),
						)
						.describe("1–10 people or roles."),
				})
				.describe(description);
		return z.object({
			kind: z.enum(["team"]),
			title: nullableText("Optional title from the section's wording."),
			proposer: side("The team the proposal offers."),
			client: side("The client's own people."),
			shared: nullableText(
				"One forum or rhythm both sides take part in, as the section names it.",
			),
		});
	})(),
} satisfies Record<ProposalOnlyVisualKind, z.ZodType>;

/**
 * A Proposal's timeline, its date described as `date` says. The same shape
 * as Glossy's, so the parameter counts match.
 */
function proposalTimelineSchema(date: string) {
	return z.object({
		kind: z.enum(["timeline"]),
		title: nullableText("Optional title from the section's wording."),
		items: z
			.array(
				z.object({
					date: z.string().describe(date),
					label: z.string().describe("What happens."),
					description: nullableText("Optional detail."),
				}),
			)
			.describe("2–8 entries in chronological order."),
	});
}

/**
 * A Proposal's timeline and comparison, described as its rules ask
 * (Fizzy #2946): a date is a short period and points are parallel
 * attributes. The same shape as Glossy's, so the parameter counts match.
 */
const PROPOSAL_DESCRIBED_SPEC_SCHEMAS = {
	timeline: proposalTimelineSchema(
		"A short date or period as the section gives it, such as Week 1 or Q3 2026; never a phase name or a step.",
	),
	comparison: z.object({
		kind: z.enum(["comparison"]),
		title: nullableText("Optional title from the section's wording."),
		items: z
			.array(
				z.object({
					title: z.string().describe("The option's name."),
					points: z
						.array(z.string())
						.describe(
							"2–6 short parallel attributes: the same aspects, in the same order, for every option.",
						),
				}),
			)
			.describe("2–4 options."),
	}),
};

const ALL_OUTPUT_SPEC_SCHEMAS = {
	...OUTPUT_SPEC_SCHEMAS,
	...PROPOSAL_OUTPUT_SPEC_SCHEMAS,
};

const PROPOSAL_ALL_OUTPUT_SPEC_SCHEMAS = {
	...ALL_OUTPUT_SPEC_SCHEMAS,
	...PROPOSAL_DESCRIBED_SPEC_SCHEMAS,
};

/**
 * A Proposal's schemas for an edit, which redraws a diagram that already
 * exists: a timeline keeps each entry's date as the current diagram writes
 * it, as the edit's instructions ask, since one drawn before the period
 * rule must stay editable (`proposalShaped` does not hold an edit to it).
 */
const PROPOSAL_EDIT_OUTPUT_SPEC_SCHEMAS = {
	...PROPOSAL_ALL_OUTPUT_SPEC_SCHEMAS,
	timeline: proposalTimelineSchema(
		"The entry's date or period as the current diagram writes it, when it is a timeline, else as the section gives it; never one the section does not state.",
	),
};

/**
 * The figure's caption, which a Proposal's visuals step asks for beside the
 * spec. Required and never null, so it adds no union-typed parameter.
 */
const CAPTION_OUTPUT_SCHEMA = z
	.string()
	.describe(
		"A caption for the figure: what it shows, in a short phrase of at most 60 characters built from the section's own words like every label, in sentence case, without a full stop, citation markers, links, or markdown.",
	);

/**
 * Structured-output providers want an object at the root, so the spec is a
 * property; a Proposal's visuals step, outside an edit, also asks for a
 * caption beside it.
 */
function outputSchemaFor(
	kind: ProposalExtractableKind,
	editing: boolean,
	proposalArtifact: boolean,
): z.ZodType<{ spec: unknown; caption?: string }> {
	const schemas = proposalArtifact
		? editing
			? PROPOSAL_EDIT_OUTPUT_SPEC_SCHEMAS
			: PROPOSAL_ALL_OUTPUT_SPEC_SCHEMAS
		: ALL_OUTPUT_SPEC_SCHEMAS;
	if (kind === "auto" && editing) {
		return z.object({
			spec: z
				.union(
					GLOSSY_EDIT_AUTO_KINDS.map((editable) => schemas[editable]),
				)
				.describe("The spec, of the kind the current diagram shows."),
		});
	}
	const spec =
		kind === "auto"
			? z
					.union([
						schemas.timeline,
						schemas.comparison,
						schemas.stat,
						schemas.flow,
						schemas.org_chart,
					])
					.describe(
						"The spec, of the kind that fits the section best.",
					)
			: schemas[kind];
	if (proposalArtifact && !editing) {
		return z.object({ spec, caption: CAPTION_OUTPUT_SCHEMA });
	}
	return z.object({ spec });
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

/** A Proposal's call, which may ask for and get back `layers` or `team` too. */
export interface ExtractProposalVisualInput
	extends Omit<ExtractGlossyVisualInput, "kind" | "proposalArtifact"> {
	kind: ProposalExtractableKind;
	proposalArtifact: true;
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

export type GlossyExtractionResult<
	Spec extends ProposalExtractedVisualSpec = GlossyExtractedVisualSpec,
> =
	| {
			status: "extracted";
			spec: Spec;
			/**
			 * A Proposal's visuals step only: the figure's caption, plain text
			 * without a full stop. Absent when neither the title nor the
			 * returned caption makes one.
			 */
			caption?: string;
	  }
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
): GlossyExtractionResult<never> {
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
function isAuthorRequestedFlow(
	input: Pick<ExtractGlossyVisualInput, "source"> & { kind: string },
): boolean {
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
	spec: ProposalExtractedVisualSpec,
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
	spec: ProposalVisualSpec,
	requested: ProposalExtractableKind,
	editing: boolean,
): spec is ProposalExtractedVisualSpec {
	if (requested === "auto") {
		return (
			(editing
				? GLOSSY_EDIT_AUTO_KINDS
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

export function extractGlossyVisual(
	input: ExtractProposalVisualInput,
): Promise<GlossyExtractionResult<ProposalExtractedVisualSpec>>;
export function extractGlossyVisual(
	input: ExtractGlossyVisualInput,
): Promise<GlossyExtractionResult>;
export async function extractGlossyVisual(
	input: ExtractGlossyVisualInput | ExtractProposalVisualInput,
): Promise<GlossyExtractionResult<ProposalExtractedVisualSpec>> {
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

	const proposalArtifact = input.proposalArtifact === true;
	let raw: unknown;
	let rawCaption: unknown;
	try {
		const { output: object } = await requireStructuredOutput(
			generateText({
				model,
				output: Output.object({
					schema: zodSchema(
						outputSchemaFor(input.kind, editing, proposalArtifact),
					),
				}),
				instructions,
				prompt,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
				...(input.abortSignal
					? { abortSignal: input.abortSignal }
					: {}),
			}),
		);
		raw = object.spec;
		rawCaption = object.caption;
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

	// Only a Proposal admits its own kinds; Glossy's validator refuses them.
	const parsed = (
		proposalArtifact ? proposalVisualSpecSchema : visualSpecSchema
	).safeParse(toSpecCandidate(raw));
	if (!parsed.success) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "invalidSpec",
			kind: input.kind,
			projectId: input.projectId,
			issues: parsed.error.issues.length,
		});
		return dropped("invalidSpec");
	}
	const extracted = parsed.data;
	if (!isExtractedKind(extracted, input.kind, editing)) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "kindMismatch",
			kind: input.kind,
			returnedKind: extracted.kind,
			projectId: input.projectId,
		});
		return dropped("kindMismatch");
	}
	const spec = proposalArtifact
		? proposalShaped(extracted, editing)
		: extracted;
	if (spec === null) {
		console.warn(`${EXTRACTION_LOG} Visual dropped`, {
			reason: "invalidSpec",
			cause:
				extracted.kind === "timeline"
					? "timelineDates"
					: "comparisonColumns",
			kind: extracted.kind,
			projectId: input.projectId,
		});
		return dropped("invalidSpec");
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
	const caption =
		proposalArtifact && !editing
			? proposalCaption(spec, rawCaption, section)
			: null;
	return caption === null
		? { status: "extracted", spec }
		: { status: "extracted", spec, caption };
}

/**
 * A Proposal's spec held to what its figures and tables show (Fizzy #2946),
 * or null to drop it: a new timeline needs a short period in every date,
 * and a comparison needs columns even enough to read as one table, trimmed
 * so no row is filled in one column only. An edit redraws a timeline that
 * already exists, so it keeps its dates as they are: a document generated
 * before the rule must stay editable. Every other kind passes unchanged.
 */
function proposalShaped(
	spec: ProposalExtractedVisualSpec,
	editing: boolean,
): ProposalExtractedVisualSpec | null {
	if (spec.kind === "timeline" && !editing) {
		return spec.items.every((item) => isProposalTimelinePeriod(item.date))
			? spec
			: null;
	}
	if (spec.kind === "comparison") {
		return balancedProposalComparison(spec);
	}
	return spec;
}

/** The longest caption kept; the extraction asks for 60 characters. */
const PROPOSAL_CAPTION_MAX_CHARS = 80;

/**
 * Markup a caption must not hold: code, emphasis, link brackets, tags,
 * escapes and URLs. Both readers show a caption as plain text, so any of
 * them would print as typed.
 */
const CAPTION_MARKUP = /[`*_[\]<>\\]|:\/\//u;

/**
 * A figure caption as a Proposal stores it, or null: citation markers
 * removed, whitespace collapsed, a trailing full stop dropped as the
 * figure captions are written, and an all-lower-case caption started with
 * a capital. One that still holds markup, or runs past
 * `PROPOSAL_CAPTION_MAX_CHARS`, is not a caption.
 */
function cleanProposalCaption(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const text = scrubCitationText(value)
		.text.replace(/\s+/gu, " ")
		.trim()
		.replace(/[\s.;:,]+$/u, "");
	if (
		text === "" ||
		CAPTION_MARKUP.test(text) ||
		Array.from(text).length > PROPOSAL_CAPTION_MAX_CHARS
	) {
		return null;
	}
	return proposalLabelCase(text);
}

/**
 * The figure's caption: the spec's own title when it has one (already
 * checked with the spec), else the caption the model returned, checked on
 * its own as a label with no kind's structural words. Null when neither
 * makes one; the visual is kept either way.
 */
function proposalCaption(
	spec: ProposalExtractedVisualSpec,
	rawCaption: unknown,
	section: Pick<GlossySection, "heading" | "markdown">,
): string | null {
	const title = cleanProposalCaption(spec.title);
	if (title !== null) {
		return title;
	}
	const caption = cleanProposalCaption(rawCaption);
	if (caption === null) {
		return null;
	}
	// An `auto` spec's hint is a label of its own with no structural words
	// and no structure check, which is how a caption is read.
	const facts = checkVisualFacts(
		{
			...visualSpecFacts({ kind: "auto", hint: caption }),
			heading: section.heading,
		},
		factSource(section),
	);
	return facts.pass ? caption : null;
}

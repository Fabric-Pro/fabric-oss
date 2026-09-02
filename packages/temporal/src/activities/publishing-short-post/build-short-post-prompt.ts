/**
 * Short Post / Tweet — output schema, prompt composition and locked clauses
 * (Fizzy #1853, Phase 2B-2).
 *
 * The pure half of the slice: no DB, no model, no Temporal context, so all of it
 * is unit-testable. It is deliberately a thin layer over its Planning & Analysis
 * sibling rather than a parallel implementation — the source-context half of the
 * prompt (truncation caps, PR citation form, the "omit an empty section rather
 * than render a bare heading" invariant) is `buildPlanningAnalysisVariables`,
 * imported and reused. Reimplementing it here would double the surface where a
 * cap or a blank-section rule can drift between two prompts that read the same
 * project.
 *
 * What this module adds on top is what a short post needs and a planning
 * worksheet does not: the planning analysis itself as an input, the topic's
 * settled decisions, the run's user guidance, and the three-option contract.
 */

import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";
import { humanizeDecisionKind } from "@repo/utils/publishing-restrictions";
import {
	PUBLISHING_SHORT_POST_AGENT_KEY,
	PUBLISHING_SHORT_POST_FALLBACK_BODY,
} from "@repo/utils/publishing-short-post-prompt";
import { z } from "zod";
import {
	buildPlanningAnalysisVariables,
	type PlanningAnalysisContext,
	type PlanningAnalysisTopic,
	SOURCE_EXCERPT_CHAR_CAP,
} from "../publishing-planning/build-planning-analysis-prompt";

export { PUBLISHING_SHORT_POST_AGENT_KEY, PUBLISHING_SHORT_POST_FALLBACK_BODY };

// =============================================================================
// Output schema
// =============================================================================

/** How many options FR16 requires. Named so the schema and the prompt agree. */
export const SHORT_POST_OPTION_COUNT = 3;

/**
 * Bound on one option's text.
 *
 * Generous rather than tight — this is a guard against a model that ignores the
 * length instruction entirely and returns an essay, not an enforcement of the
 * platform's limit. Enforcing 280 here would reject a legitimate post written
 * for a platform with a longer limit, which the user's guidance is allowed to
 * ask for.
 */
const OPTION_TEXT_CAP = 2000;

/**
 * One short post option.
 *
 * `label` is a model field, not an enum, because FR17 makes the labels
 * prompt-governed: an org editing the prompt may ask for labels that describe
 * its own house framings. The UI renders whatever comes back.
 *
 * `estimatedCharacters` is the MODEL's estimate and is stored as such. It is
 * deliberately not recomputed from `text` server-side: the two would disagree
 * whenever the model counted a rendered form differently from the raw Markdown,
 * and silently replacing the model's number with ours would make the prompt's
 * "report an estimated character count" instruction unfalsifiable — a model
 * that stopped reporting one would look identical to one that still did.
 */
const ShortPostOptionSchema = z.object({
	label: z.string().min(1).max(80),
	text: z.string().min(1).max(OPTION_TEXT_CAP),
	estimatedCharacters: z.number().int().nonnegative(),
});

export type ShortPostOption = z.infer<typeof ShortPostOptionSchema>;

/**
 * The short post document persisted as a draft's `content`.
 *
 * `options` is `.length(3)`, not `.min(1)`. FR16 requires exactly three, and a
 * lower bound would let a two-option run persist as READY — the panel would
 * render it as a finished answer and nothing downstream would ever notice the
 * contract had been broken. Because the run is `safeParse`d before it is
 * written, a short set fails the attempt visibly instead.
 *
 * `inputsNeeded` and `hashtags` are optional in the prompt's own output format
 * ("only include if…"), so they default to empty rather than being required.
 * `safetyNote` carries FR29's "the draft was generalized, and here is why" —
 * without it, a generalized draft is indistinguishable from one that had
 * nothing to generalize.
 *
 * Labels must be DISTINCT, and that is a correctness rule rather than a
 * presentational one. The label is the selection key: the client sends a label
 * and the server reads that option's text back out of the stored draft. Two
 * options sharing a label make the key ambiguous, so choosing the second one
 * silently adopts the first one's text — the reader picks one post and a
 * different post enters the publishing pipeline, with nothing anywhere
 * reporting a problem. It also collapses the two in the panel, which marks both
 * as saved and disables both.
 *
 * Compared after `trim().toLowerCase()`, because the label's whole job is to
 * let a person tell the three options apart. "Direct" and "direct " are
 * distinct strings — so selection would in fact resolve — but they are not a
 * choice, and a run that produced them has degenerated in the way the "make the
 * three meaningfully different" instruction exists to prevent.
 *
 * The refinement is invisible to the model: `generateObject` converts this
 * schema to JSON Schema, which cannot express cross-element uniqueness. That is
 * why the same requirement is also stated in the locked clauses, which an org's
 * prompt edit cannot remove. This half is the enforcement; that half is the
 * instruction that keeps enforcement from firing.
 */
export const PublishingShortPostSchema = z.object({
	options: z
		.array(ShortPostOptionSchema)
		.length(SHORT_POST_OPTION_COUNT)
		.refine(
			(options) =>
				new Set(options.map((o) => o.label.trim().toLowerCase()))
					.size === options.length,
			{ message: "Option labels must be distinct" },
		),
	hashtags: z.array(z.string().min(1).max(80)).max(8).default([]),
	inputsNeeded: z.array(z.string().min(1).max(400)).max(12).default([]),
	safetyNote: z.string().max(1000).nullable().default(null),
});

export type PublishingShortPost = z.infer<typeof PublishingShortPostSchema>;

// =============================================================================
// Template variables
// =============================================================================

/**
 * A settled decision or answered question, as the prompt sees it.
 *
 * Both arrive from `listTopicDecisions`. They are rendered into ONE block, not
 * two: from the writer's point of view "we decided to name the customer" and
 * "the customer-name question was answered yes" are the same instruction, and
 * splitting them invited the model to weigh one above the other.
 */
export interface ShortPostDecision {
	subject: string | null;
	decisionKind: string;
	/** The settled answer. A decision with no answer text is not included. */
	answer: string;
}

export interface ShortPostPromptVariables {
	has_planning_analysis: boolean;
	planning_analysis: string;
	has_decisions: boolean;
	decisions: string;
	has_guidance: boolean;
	guidance: string;
}

/**
 * Bound on the user's per-run guidance once it reaches the prompt.
 *
 * The API bounds the stored value too. Both, deliberately: the stored bound
 * protects the column and the audit trail, this one protects the prompt from a
 * value that predates the bound or arrives from a future caller. A guard that
 * exists only at the edge stops guarding the moment a second caller appears.
 */
export const GUIDANCE_CHAR_CAP = 2000;

/**
 * Bound on the planning analysis once flattened into the prompt.
 *
 * The analysis is itself model output with no server-side length bound, and it
 * is the single largest block here. Left uncapped, a long worksheet plus the
 * source context it was derived FROM can push one request past the provider's
 * input window — which fails the whole run rather than degrading it.
 */
export const PLANNING_ANALYSIS_CHAR_CAP = 8000;

function clamp(text: string, cap: number): string {
	const trimmed = text.trim();
	return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}…`;
}

/**
 * Flatten the planning analysis document into the prose block the prompt reads.
 *
 * Deliberately structure-agnostic: it walks whatever the stored JSON holds
 * rather than naming the fields of `PublishingPlanningAnalysisSchema`. 2A owns
 * that schema and will keep evolving it; a field list duplicated here would go
 * stale silently — the prompt would simply stop passing on whichever section 2A
 * added last, and no test on either side would fail. Walking the object means a
 * new section reaches the writer the day 2A ships it.
 */
export function flattenPlanningAnalysis(analysis: unknown): string {
	if (analysis == null || typeof analysis !== "object") {
		return "";
	}

	const lines: string[] = [];

	const renderValue = (value: unknown, depth: number): string[] => {
		const pad = "  ".repeat(depth);
		if (value == null) {
			return [];
		}
		if (typeof value === "string") {
			const trimmed = value.trim();
			return trimmed ? [`${pad}${trimmed}`] : [];
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return [`${pad}${String(value)}`];
		}
		if (Array.isArray(value)) {
			return value.flatMap((item) => renderValue(item, depth));
		}
		if (typeof value === "object") {
			return Object.entries(value as Record<string, unknown>).flatMap(
				([key, nested]) => {
					const body = renderValue(nested, depth + 1);
					return body.length > 0
						? [`${pad}${humanizeKey(key)}:`, ...body]
						: [];
				},
			);
		}
		return [];
	};

	for (const [key, value] of Object.entries(
		analysis as Record<string, unknown>,
	)) {
		const body = renderValue(value, 1);
		if (body.length > 0) {
			lines.push(`### ${humanizeKey(key)}`, ...body, "");
		}
	}

	return clamp(lines.join("\n"), PLANNING_ANALYSIS_CHAR_CAP);
}

/**
 * `keyDetailsToUse` → `Key details to use`.
 *
 * Sentence case, not Title Case: these become headings inside a prompt the model
 * reads as prose, and `Key Details To Use` reads as a proper noun — something to
 * quote rather than a label over the content beneath it.
 */
function humanizeKey(key: string): string {
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The short-post-specific half of the prompt's data.
 *
 * Pure and synchronous, like its planning sibling, so it stays testable without
 * a model or a database. Each block is a value WITHOUT its heading — the heading
 * lives in the editable template, so an org can relabel a section without losing
 * what is under it, and the paired `has_*` flag keeps an empty section omitted
 * rather than rendered as a bare heading the model would feel invited to fill.
 */
export function buildShortPostVariables({
	planningAnalysis,
	decisions,
	guidance,
}: {
	planningAnalysis: unknown;
	decisions: ShortPostDecision[];
	guidance: string | null;
}): ShortPostPromptVariables {
	const analysisBlock = flattenPlanningAnalysis(planningAnalysis);

	const decisionLines = decisions
		.filter((d) => d.answer.trim().length > 0)
		.map((d) => {
			// The SHARED humanizer, not the local one: the tab lists an
			// approval by exactly this string under "unresolved before
			// drafting", so two spellings of the same thing would read as two
			// different approvals.
			const subject =
				d.subject?.trim() || humanizeDecisionKind(d.decisionKind);
			return `- ${subject}: ${clamp(d.answer, SOURCE_EXCERPT_CHAR_CAP)}`;
		});

	const guidanceText = guidance ? clamp(guidance, GUIDANCE_CHAR_CAP) : "";

	return {
		has_planning_analysis: analysisBlock.length > 0,
		planning_analysis: analysisBlock,
		has_decisions: decisionLines.length > 0,
		decisions: decisionLines.join("\n"),
		has_guidance: guidanceText.length > 0,
		guidance: guidanceText,
	};
}

// =============================================================================
// Locked clauses
// =============================================================================

/**
 * The rules an org override cannot remove, appended after the rendered body.
 *
 * Two groups, and they are locked for different reasons:
 *
 *  - The OUTPUT CONTRACT (exactly three, distinct, labeled). It is also enforced
 *    by the schema, so an override that drops it produces a failed attempt
 *    rather than a bad one — but a failed attempt for a reason the model was
 *    never told is a worse experience than one that never happens.
 *  - The APPROVAL RULES (FR28/FR29). These have no schema to catch them: a draft
 *    that asserts an unapproved customer name parses perfectly and persists as
 *    READY. Code-side is the only place they hold.
 *
 * `restrictedSubjects` is what makes FR29 concrete rather than aspirational.
 * Naming the specific unresolved approvals beats a general instruction to be
 * careful, and it is why 2B-1 computed them: the tab already tells the reader
 * these will be generalized, and this is the half that makes that true.
 */
export function buildShortPostLockedClauses(
	restrictedSubjects: string[] = [],
): string {
	const restricted = restrictedSubjects
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const restrictedBlock =
		restricted.length > 0
			? `

## Unresolved approvals for this topic

The following are NOT approved for use. Write around each one: generalize it,
use a neutral placeholder, or leave it out. Do not assert any of them, and do
not imply approval was given. Say in your safety note which ones shaped the
draft.

${restricted.map((s) => `- ${s}`).join("\n")}`
			: "";

	return `## Rules that override anything above

- Produce EXACTLY ${SHORT_POST_OPTION_COUNT} options. Not two, not four. Give each a short label
  describing what makes it different, and make the three meaningfully different
  in framing, tone or emphasis rather than three rewordings of one sentence.
- Every label must be DIFFERENT from the other two. The label is how a person
  picks one option over another, so reusing one makes the choice meaningless and
  the run is rejected rather than saved.
- Do NOT treat a customer name, customer logo, customer or stakeholder quote,
  screenshot, internal UI capture, outcome metric, or AI voice or video likeness
  as approved for publication. Where one would strengthen the post, write around
  it and record what is missing under inputs needed.
- Do NOT invent facts, metrics, dates, release status or outcomes. If the source
  context does not support a claim, the claim does not go in the post.
- Do NOT state or imply that unshipped work has shipped.
- Do NOT publish, schedule or post anything. Your output is a draft for a person
  to review.
- Where a required fact is missing, list it under inputs needed rather than
  filling the gap with a plausible substitute.
- Where you generalized rather than asserted something, say so in your safety
  note. A generalized draft that does not say it was generalized reads as a
  complete one.${restrictedBlock}`;
}

// =============================================================================
// Composition
// =============================================================================

const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface ComposedShortPostPrompt {
	prompt: string;
	/** Guard 1 fired: a non-templating format was rendered as Handlebars. */
	formatOverridden: boolean;
	/**
	 * Guard 2 or 3 fired: the supplied body yielded nothing usable and the
	 * default was used instead. One flag for both, because the consequence a
	 * reader needs is identical — this draft did not come from the prompt it is
	 * bound to.
	 */
	bodyRecovered: boolean;
}

/**
 * Render the editable body against this topic's context and append the locked
 * clauses.
 *
 * The same three guards as `composePlanningAnalysisPrompt`, for the same
 * reasons, each learned from a real failure:
 *
 *   1. MARKDOWN / PLAIN_TEXT do no templating at all — `renderTemplate` returns
 *      the body verbatim with NO error set. For a prompt whose entire context
 *      arrives as variables, that silently ships zero topic data to the model,
 *      which then writes a post about nothing in particular and sounds fine
 *      doing it. Decided from the format alone, before rendering.
 *   2. Output still containing an unrendered template construct means the body
 *      did not render — a parse error `renderHandlebars` swallowed into a
 *      raw-body return. Matches "{{{" or "{{#" rather than a bare "{{", because
 *      the context is user prose and a document title can plausibly contain
 *      mustaches.
 *   3. Output that is blank once rendered. `{{#unknown}}x{{/unknown}}` is a
 *      falsy block, not a syntax error: it parses, renders to "", and guard 2
 *      cannot see it precisely because nothing survived.
 *
 * `bodyRecovered` is returned rather than only logged, and persisted as
 * `promptSource`. A degraded run produces three perfectly plausible posts, so
 * "these came from the default body because your prompt would not render" is
 * exactly what a reader cannot infer from the output.
 */
export async function composeShortPostPrompt({
	templateBody,
	format,
	topic,
	context,
	planningAnalysis,
	decisions,
	guidance,
	restrictedSubjects,
}: {
	templateBody: string;
	format: TemplateFormat;
	topic: PlanningAnalysisTopic;
	context: PlanningAnalysisContext;
	planningAnalysis: unknown;
	decisions: ShortPostDecision[];
	guidance: string | null;
	restrictedSubjects: string[];
}): Promise<ComposedShortPostPrompt> {
	const variables = {
		...buildPlanningAnalysisVariables({ topic, context }),
		...buildShortPostVariables({ planningAnalysis, decisions, guidance }),
	};

	let effectiveFormat = format;
	let formatOverridden = false;
	if (format === "MARKDOWN" || format === "PLAIN_TEXT") {
		logger.error(
			"[publishing-short-post] bound prompt has a non-templating format; rendering as Handlebars",
			{ format },
		);
		effectiveFormat = "HANDLEBARS";
		formatOverridden = true;
	}

	const rendered = await renderTemplate({
		format: effectiveFormat,
		template: templateBody,
		variables,
	});

	let body = rendered.rendered;
	let bodyRecovered = false;
	// Not `trim()`: a template can render down to zero-width characters, which
	// trim leaves standing and the model reads as nothing.
	const renderedBlank = isEffectivelyBlank(body);
	if (rendered.error || UNRENDERED_TEMPLATE.test(body) || renderedBlank) {
		logger.error(
			"[publishing-short-post] bound prompt did not render; using the default body",
			{ format: effectiveFormat, error: rendered.error, renderedBlank },
		);
		const recovery = await renderTemplate({
			format: "HANDLEBARS",
			template: PUBLISHING_SHORT_POST_FALLBACK_BODY,
			variables,
		});
		body = recovery.rendered;
		bodyRecovered = true;
	}

	return {
		prompt: `${body.trimEnd()}\n\n${buildShortPostLockedClauses(restrictedSubjects)}`,
		formatOverridden,
		bodyRecovered,
	};
}

/**
 * LinkedIn Post — output schema, prompt composition and locked clauses
 * (Fizzy #1851).
 *
 * The pure half of the slice: no DB, no model, no Temporal context, so all of it
 * is unit-testable. Like every other writer in the family it is a THIN layer
 * over the Short Post / Tweet builder rather than a parallel implementation —
 * `buildShortPostVariables` composes the planning analysis, the settled
 * decisions and the run's guidance, and `buildPlanningAnalysisVariables` under
 * it composes the source context with its truncation caps and its "omit an
 * empty section rather than render a bare heading" invariant. Blog Post, Case
 * Study and Stakeholder Email all reuse the same two. Reimplementing either
 * here would double the surface where a cap or a blank-section rule can drift
 * between prompts that read the same project.
 *
 * ## What is genuinely different, and what is deliberately not
 *
 * DIFFERENT: the editable body, and the option-text bound below. A LinkedIn
 * feed folds a post behind "see more" after roughly the first line or two and
 * imposes no hard ceiling on what follows; X imposes a hard ceiling and folds
 * nothing. Those are opposite constraints on the same sentence, which is why
 * this is a second prompt rather than the short post's under another label.
 *
 * NOT DIFFERENT: the locked clauses. This module does not define its own — it
 * re-exports `buildShortPostLockedClauses`, so the two content types cannot
 * merely START with the same output contract and approval rules, they cannot
 * diverge at all. The fold instruction lives in the EDITABLE body instead, and
 * that placement is the point: the fold is craft advice an org may reword for
 * its own house style, where the approval rules are safety and an org must not
 * be able to drop them. A future clause that is genuinely tweet-only belongs in
 * a per-type extension appended alongside the shared set, never inside it.
 */

import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";
import type { AnalysisData } from "@repo/utils/publishing-analysis-prose";
import {
	PUBLISHING_LINKEDIN_POST_AGENT_KEY,
	PUBLISHING_LINKEDIN_POST_FALLBACK_BODY,
} from "@repo/utils/publishing-linkedin-post-prompt";
import { buildRefinementSection } from "@repo/utils/publishing-refinement";
import { z } from "zod";
import {
	buildPlanningAnalysisVariables,
	type PlanningAnalysisContext,
	type PlanningAnalysisTopic,
} from "../publishing-planning/build-planning-analysis-prompt";
import {
	buildShortPostLockedClauses,
	buildShortPostVariables,
	SHORT_POST_OPTION_COUNT,
	type ShortPostDecision,
} from "../publishing-short-post/build-short-post-prompt";

export {
	PUBLISHING_LINKEDIN_POST_AGENT_KEY,
	PUBLISHING_LINKEDIN_POST_FALLBACK_BODY,
};

/**
 * A settled decision, as this prompt sees it.
 *
 * The short post's type, re-exported under this module's name rather than
 * redeclared: it is the shape `buildShortPostVariables` consumes, and a second
 * structurally-identical interface would let the two drift into an incompatible
 * pair that still compiles at every call site until one of them gains a field.
 */
export type LinkedInPostDecision = ShortPostDecision;

// =============================================================================
// Output schema
// =============================================================================

/** How many options this prompt requires. The short post's contract, shared. */
export const LINKEDIN_POST_OPTION_COUNT = SHORT_POST_OPTION_COUNT;

/**
 * Bound on one option's text.
 *
 * 4,000 rather than the short post's 2,000, and the difference is the platform
 * difference in miniature. LinkedIn's own ceiling is around 3,000 characters
 * where X's is 280, so a bound copied from the short post would REJECT a
 * perfectly legal LinkedIn post — the schema is checked before anything is
 * persisted, so that failure is the whole run, not a trimmed field.
 *
 * Generous rather than exact, for the same reason the short post's is: this
 * guards against a model that ignores the length instruction entirely and
 * returns an essay. It is not an enforcement of the platform's limit, which
 * moves and which the user's guidance is allowed to ask to stay well under.
 */
const OPTION_TEXT_CAP = 4000;

/**
 * One LinkedIn post option.
 *
 * `label` is a model field, not an enum: the labels are prompt-governed, so an
 * org editing the prompt may ask for labels describing its own house framings.
 * The UI renders whatever comes back.
 *
 * `estimatedCharacters` is the MODEL's estimate and is stored as such, not
 * recomputed from `text`. Silently replacing the model's number with ours would
 * make the prompt's "report an estimated character count" instruction
 * unfalsifiable — a model that stopped reporting one would look identical to one
 * that still did.
 */
const LinkedInPostOptionSchema = z.object({
	label: z.string().min(1).max(80),
	text: z.string().min(1).max(OPTION_TEXT_CAP),
	estimatedCharacters: z.number().int().nonnegative(),
});

export type LinkedInPostOption = z.infer<typeof LinkedInPostOptionSchema>;

/**
 * The LinkedIn post document persisted as a draft's `content`.
 *
 * Structurally the short post's document, and deliberately so — the panel that
 * renders it is the short post's panel with a different frame, and a reader
 * choosing between three candidates is choosing between three candidates
 * whichever network they will publish to. Declared here rather than imported
 * because the two bounds differ (see `OPTION_TEXT_CAP`), and a shared schema
 * parameterised by a cap would be a shared schema in name only.
 *
 * `options` is `.length(3)`, not `.min(1)`. A lower bound would let a
 * two-option run persist as READY — the panel would render it as a finished
 * answer and nothing downstream would ever notice the contract had been broken.
 * Because the run is `safeParse`d before it is written, a short set fails the
 * attempt visibly instead.
 *
 * Labels must be DISTINCT, and that is correctness rather than presentation.
 * The label is the selection key: the client sends a label and the server reads
 * that option's text back out of the stored draft. Two options sharing a label
 * make the key ambiguous, so choosing the second silently adopts the first one's
 * text — the reader picks one post and a different post enters the publishing
 * pipeline, with nothing anywhere reporting a problem.
 *
 * Compared after `trim().toLowerCase()`: "Result first" and "result first " are
 * distinct strings, so selection would in fact resolve, but they are not a
 * choice, and a run that produced them has degenerated in the way the "make the
 * three meaningfully different" instruction exists to prevent.
 *
 * The refinement is invisible to the model — `generateObject` converts this
 * schema to JSON Schema, which cannot express cross-element uniqueness — which
 * is why the same requirement is also stated in the locked clauses, where an
 * org's prompt edit cannot remove it. This half is the enforcement; that half is
 * the instruction that keeps enforcement from firing.
 */
export const PublishingLinkedInPostSchema = z.object({
	options: z
		.array(LinkedInPostOptionSchema)
		.length(LINKEDIN_POST_OPTION_COUNT)
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

export type PublishingLinkedInPost = z.infer<
	typeof PublishingLinkedInPostSchema
>;

// =============================================================================
// Composition
// =============================================================================

const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface ComposedLinkedInPostPrompt {
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
 * The same three guards as `composeShortPostPrompt`, for the same reasons, each
 * learned from a real failure:
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
export async function composeLinkedInPostPrompt({
	templateBody,
	format,
	topic,
	context,
	analysisProse,
	analysisData,
	decisions,
	guidance,
	currentDraft,
	restrictedSubjects,
}: {
	templateBody: string;
	format: TemplateFormat;
	topic: PlanningAnalysisTopic;
	context: PlanningAnalysisContext;
	analysisProse: string;
	analysisData: AnalysisData;
	decisions: LinkedInPostDecision[];
	guidance: string | null;
	/**
	 * The topic's saved working LinkedIn post — the option a reader adopted —
	 * when this run REFINES it rather than producing a fresh set. Read
	 * server-side and passed down; null on every ordinary generation.
	 *
	 * The output contract is unchanged on this path: the locked clauses still
	 * demand exactly three distinct options, so a refinement produces three
	 * revisions of the saved post rather than one.
	 */
	currentDraft: string | null;
	restrictedSubjects: string[];
}): Promise<ComposedLinkedInPostPrompt> {
	const writerVariables = buildShortPostVariables({
		analysisProse,
		analysisData,
		decisions,
		guidance,
	});
	const variables = {
		...buildPlanningAnalysisVariables({ topic, context }),
		...writerVariables,
	};

	let effectiveFormat = format;
	let formatOverridden = false;
	if (format === "MARKDOWN" || format === "PLAIN_TEXT") {
		logger.error(
			"[publishing-linkedin-post] bound prompt has a non-templating format; rendering as Handlebars",
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
			"[publishing-linkedin-post] bound prompt did not render; using the default body",
			{ format: effectiveFormat, error: rendered.error, renderedBlank },
		);
		const recovery = await renderTemplate({
			format: "HANDLEBARS",
			template: PUBLISHING_LINKEDIN_POST_FALLBACK_BODY,
			variables,
		});
		body = recovery.rendered;
		bodyRecovered = true;
	}

	// BEFORE the locked clauses, never after: "Rules that override anything
	// above" must keep overriding the refinement framing, or a refine run would
	// be a route around the grounding and unresolved-approval rules. Empty on an
	// ordinary generation, and the filter then reproduces the previous prompt
	// byte for byte. `writerVariables.guidance` rather than the raw argument, so
	// the instruction is clamped by the guidance bound exactly once.
	const refinement = buildRefinementSection({
		currentDraft,
		instruction: writerVariables.guidance,
	});

	return {
		prompt: [
			body.trimEnd(),
			refinement,
			buildShortPostLockedClauses(restrictedSubjects),
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		formatOverridden,
		bodyRecovered,
	};
}

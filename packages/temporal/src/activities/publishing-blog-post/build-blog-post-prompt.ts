/**
 * Blog Post — output schema, prompt composition and locked clauses
 * (Fizzy #1853, Phase 2B-3).
 *
 * The pure half of the slice: no DB, no model, no Temporal context, so all of it
 * is unit-testable. Like its Short Post sibling it is a thin layer over the
 * Planning & Analysis builder rather than a parallel implementation — the
 * source-context half of the prompt (truncation caps, PR citation form, the
 * "omit an empty section rather than render a bare heading" invariant) is
 * `buildPlanningAnalysisVariables`, imported and reused.
 *
 * It reuses the SHORT POST builder for the second layer too: the planning
 * analysis flattener, the decision-list shape and the guidance clamp are
 * identical for both writers, and a second copy is a place for one of the two
 * caps to drift. What this module adds is the blog's own output contract.
 */

import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";
import {
	PUBLISHING_BLOG_POST_AGENT_KEY,
	PUBLISHING_BLOG_POST_FALLBACK_BODY,
} from "@repo/utils/publishing-blog-post-prompt";
import { z } from "zod";
import {
	buildPlanningAnalysisVariables,
	type PlanningAnalysisContext,
	type PlanningAnalysisTopic,
} from "../publishing-planning/build-planning-analysis-prompt";
import {
	buildShortPostVariables,
	type ShortPostDecision,
} from "../publishing-short-post/build-short-post-prompt";

export { PUBLISHING_BLOG_POST_AGENT_KEY, PUBLISHING_BLOG_POST_FALLBACK_BODY };

/** A settled decision as the prompt sees it. Identical for both writers. */
export type BlogPostDecision = ShortPostDecision;

// =============================================================================
// Output schema
// =============================================================================

/**
 * Bound on the post body.
 *
 * Generous rather than tight, for the same reason the short post's text cap is:
 * this guards against a model that ignores the shape instruction entirely and
 * returns a book, not against a legitimate long-form post. A blog post is the
 * long content type in this family, and the user's guidance is allowed to ask
 * for a substantial one.
 */
const BODY_CHAR_CAP = 40000;

/**
 * The blog post document persisted as a draft's `content`.
 *
 * ONE post, not a set of options — which is the whole difference from the short
 * post's schema and the reason FR21 and DV2 needed different components rather
 * than one behind a flag.
 *
 * `body` is Markdown and is the only field that reaches the working draft. The
 * title and subtitle are composed onto it at seed time (see
 * `composeWorkingDraftBody`); `categories`, `keywords`, `inputsNeeded` and
 * `safetyNote` are advice to the person publishing and stay OUT of the editable
 * text. That split is the point of using structured output here at all: the PO's
 * v1 prompt emits them as Markdown sections, which would land in the editor as
 * body text the author deletes by hand after every regeneration.
 *
 * `subtitle` is nullable because the prompt's own format calls it optional
 * ("omit if not useful"), and a model that omits it should produce a draft
 * rather than a failed attempt.
 */
export const PublishingBlogPostSchema = z.object({
	title: z.string().min(1).max(300),
	subtitle: z.string().max(500).nullable().default(null),
	body: z.string().min(1).max(BODY_CHAR_CAP),
	categories: z.array(z.string().min(1).max(80)).max(8).default([]),
	keywords: z.array(z.string().min(1).max(80)).max(20).default([]),
	inputsNeeded: z.array(z.string().min(1).max(400)).max(12).default([]),
	safetyNote: z.string().max(1000).nullable().default(null),
});

export type PublishingBlogPost = z.infer<typeof PublishingBlogPostSchema>;

/**
 * Compose the Markdown a reader actually edits.
 *
 * The title and subtitle are separate FIELDS in the schema — that is what lets
 * the panel show a title without parsing Markdown — but they are part of the
 * post, so the editable body has to carry them or the first thing every author
 * does is retype the headline. The publishing suggestions are the opposite case
 * and are deliberately absent here.
 *
 * Kept as a function rather than inlined at the one call site because the seed
 * and any later "adopt this version" path must produce byte-identical text; two
 * copies would drift the moment one of them started emitting a subtitle
 * differently.
 */
export function composeWorkingDraftBody(post: {
	title: string;
	subtitle: string | null;
	body: string;
}): string {
	const parts = [`# ${post.title.trim()}`];
	const subtitle = post.subtitle?.trim();
	if (subtitle) {
		// Emphasis rather than a heading: a subtitle rendered as `##` competes
		// with the post's own section headings in every Markdown renderer, and
		// the author would have to fix the outline before publishing.
		parts.push(`_${subtitle}_`);
	}
	parts.push(post.body.trim());
	return parts.join("\n\n");
}

// =============================================================================
// Locked clauses
// =============================================================================

/**
 * The rules an org override cannot remove, appended after the rendered body.
 *
 * The same two groups its Short Post sibling locks, for the same reasons — the
 * output contract (which the schema also enforces, so an override that drops it
 * produces a failed attempt rather than a bad one) and the FR28/FR29 approval
 * rules (which have no schema to catch them: a post asserting an unapproved
 * customer name parses perfectly and persists as READY).
 *
 * The blog's output contract is thinner than the short post's because there is
 * no option count to hold. What it does hold is the split the structured output
 * depends on: the suggestions are FIELDS, not sections of the post. A model that
 * writes "## Suggested Keywords" into `body` produces a draft whose author has
 * to delete it, and nothing downstream would report that as wrong.
 */
export function buildBlogPostLockedClauses(
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

- Produce ONE post, not a set of alternatives to choose between. The reader
  edits what you return.
- Put ONLY the post in the body. Suggested categories, suggested keywords and
  anything missing are separate fields — a body containing them as sections
  becomes text the author has to delete before publishing.
- Do not repeat the title or subtitle inside the body. They are their own
  fields and are placed above it.
- Do NOT treat a customer name, customer logo, customer or stakeholder quote,
  screenshot, internal UI capture, outcome metric, or AI voice or video likeness
  as approved for publication. Where one would strengthen the post, write around
  it and record what is missing under inputs needed.
- Do NOT invent facts, metrics, dates, release status or outcomes. If the source
  context does not support a claim, the claim does not go in the post.
- Do NOT state or imply that unshipped work has shipped.
- Do NOT publish, schedule or post anything. Your output is a draft for a person
  to review.
- Where a required fact is missing, use a short bracketed placeholder in the post
  and list the fact under inputs needed rather than filling the gap with a
  plausible substitute.
- Where you generalized rather than asserted something, say so in your safety
  note. A generalized draft that does not say it was generalized reads as a
  complete one.${restrictedBlock}`;
}

// =============================================================================
// Composition
// =============================================================================

const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface ComposedBlogPostPrompt {
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
 * `promptSource`. A degraded run produces a perfectly plausible post, so "this
 * came from the default body because your prompt would not render" is exactly
 * what a reader cannot infer from the output.
 */
export async function composeBlogPostPrompt({
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
	decisions: BlogPostDecision[];
	guidance: string | null;
	restrictedSubjects: string[];
}): Promise<ComposedBlogPostPrompt> {
	const variables = {
		...buildPlanningAnalysisVariables({ topic, context }),
		...buildShortPostVariables({ planningAnalysis, decisions, guidance }),
	};

	let effectiveFormat = format;
	let formatOverridden = false;
	if (format === "MARKDOWN" || format === "PLAIN_TEXT") {
		logger.error(
			"[publishing-blog-post] bound prompt has a non-templating format; rendering as Handlebars",
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
			"[publishing-blog-post] bound prompt did not render; using the default body",
			{ format: effectiveFormat, error: rendered.error, renderedBlank },
		);
		const recovery = await renderTemplate({
			format: "HANDLEBARS",
			template: PUBLISHING_BLOG_POST_FALLBACK_BODY,
			variables,
		});
		body = recovery.rendered;
		bodyRecovered = true;
	}

	return {
		prompt: `${body.trimEnd()}\n\n${buildBlogPostLockedClauses(restrictedSubjects)}`,
		formatOverridden,
		bodyRecovered,
	};
}

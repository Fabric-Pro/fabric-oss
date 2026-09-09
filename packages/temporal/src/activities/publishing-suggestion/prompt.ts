/**
 * Publishing Suggestion — Topic-Suggestion prompt composition (Fizzy #1851).
 *
 * The editable body lives in `@repo/utils`; this module renders whatever body
 * the Prompt Library resolved, appends the clauses an override must not be able
 * to remove, and appends the serialized source context. It is the suggestion
 * step's counterpart to `publishing-planning/build-planning-analysis-prompt.ts`
 * and follows it deliberately, including its render guards — with the one
 * departure the input shape forces, documented on `composeTopicSuggestionPrompt`.
 *
 * `context` is the record the workflow assembles from whichever collectors
 * succeeded this cycle — `{ [sourceKey]: item[] }` for a subset of `stories`,
 * `documents`, `transcripts`, `pullRequests`, `releases` (see
 * `publishing-suggestion-generation-workflow.ts`, Task 9). Each item array is
 * already recency-ordered and byte-bounded by its collector (§6.7), so this
 * module does no further trimming.
 *
 * Typed `unknown` deliberately: the Temporal workflow sandbox cannot import
 * `@repo/database`'s collector output types, so the boundary is opaque JSON by
 * design.
 */

import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";
// Defined in @repo/utils, not here, so the seed and this activity share ONE
// definition instead of two copies a test has to keep byte-identical.
// Re-exported because this module is the natural import site for everything
// about the Topic Suggestion prompt.
import {
	PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
	PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
} from "@repo/utils/publishing-suggestion-prompt";

export {
	PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
	PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
};

/**
 * The clauses no override can remove, appended to whatever body is bound.
 *
 * Every line here is moved verbatim out of the body that shipped hard-coded,
 * and every one of them is load-bearing in a way tone and selection criteria
 * are not:
 *
 *  - The grounding rule decides whether `topic.pitch` — the summary at the top
 *    of every Topic Item Page, and the text every downstream draft is built
 *    from — describes the project's actual work or something adjacent to it.
 *    Content drifting off its topic is the one confirmed correctness bug in
 *    this feature; an org must not be able to delete the sentence that guards
 *    against it while retuning what counts as newsworthy.
 *  - "Do not fabricate a topic to fill space" is what makes an empty answer
 *    available at all. Without it a quiet week produces invented topics that
 *    read exactly like real ones.
 *  - The citation rule protects provenance, which is the only way a reader can
 *    check a topic against its sources — and the ids it names are the ones
 *    `persistCycleTerminal` stores.
 *
 * The output contract is here for the same reason its four siblings' are: it
 * describes the shape `generateObject` will parse, not something a tenant gets
 * to have an opinion about.
 */
export function buildTopicSuggestionLockedClauses(): string {
	return `## Output contract

Return ONLY the topics — no commentary, no restating the context, no meta-discussion.

## Rules that override anything above

- Ground every claim in the given context — never invent details, numbers, or outcomes that are not present.
- Do not fabricate a topic to fill space. If nothing in the context is genuinely publishing-worthy, return an empty "topics" array — that is a valid and expected answer for a quiet window.
- Never cite an id, PR number, or repo name that does not appear verbatim in the context below.`;
}

/** A body that still carries template syntax after rendering did not render. */
const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface ComposedTopicSuggestionPrompt {
	prompt: string;
	/** Guard 1 fired: a non-templating format was rendered as Handlebars. */
	formatOverridden: boolean;
	/**
	 * Guard 2 or 3 fired: the supplied body yielded nothing usable and the
	 * default was used instead. One flag for both, because the consequence a
	 * reader needs is identical — this cycle's topics did not come from the
	 * prompt they are bound to.
	 */
	bodyRecovered: boolean;
}

/**
 * Render the editable body, append the locked clauses, then append the context.
 *
 * THE CONTEXT IS APPENDED CODE-SIDE, not exposed as a template variable. That
 * is the one place this diverges from the Planning & Analysis sibling, and the
 * reason is the input shape rather than taste: that prompt weaves ~15 named
 * variables through its prose, while this one has a single input that is always
 * terminal. A `{{{context}}}` slot would put every mention of "the context
 * below" at the mercy of where an org moved it, and would make deleting the
 * whole context a one-token edit that renders cleanly, passes every guard
 * below, and yields a full set of invented topics on a schedule nobody is
 * watching.
 *
 * The body is still RENDERED, with an empty variable map, so a body written as
 * Handlebars behaves the way the Prompt Library says it will rather than
 * shipping raw `{{#if}}` to the model. Three guards, inherited from
 * `composePlanningAnalysisPrompt`:
 *
 *   1. MARKDOWN / PLAIN_TEXT do no templating at all — `renderTemplate` returns
 *      the body verbatim with NO error set. A no-op for the ordinary body,
 *      which has no template syntax in it; it matters only for a body that
 *      does, and there evaluating the construct is closer to what its author
 *      meant than printing it.
 *   2. Output still containing a template construct means the body did not
 *      render — a parse error `renderHandlebars` swallowed into a raw-body
 *      return. Matches "{{{" or "{{#" rather than a bare "{{", so a body that
 *      merely mentions mustaches in prose is not discarded over it.
 *   3. Output that is blank once rendered. `{{#unknown}}x{{/unknown}}` is a
 *      falsy block, not a syntax error: it parses, renders to "", and guard 2
 *      cannot see it precisely because nothing survived. The model would
 *      receive the locked clauses and the context with no instructions at all,
 *      and would still return a plausible set of topics.
 *
 * `bodyRecovered` is returned rather than only logged for the same reason its
 * sibling returns it: a degraded cycle produces topics that look entirely
 * normal, so "these came from the default body because your prompt would not
 * render" is exactly what a reader cannot infer from the output.
 */
export async function composeTopicSuggestionPrompt({
	templateBody,
	format,
	context,
}: {
	templateBody: string;
	format: TemplateFormat;
	context: unknown;
}): Promise<ComposedTopicSuggestionPrompt> {
	let effectiveFormat = format;
	let formatOverridden = false;
	if (format === "MARKDOWN" || format === "PLAIN_TEXT") {
		effectiveFormat = "HANDLEBARS";
		formatOverridden = true;
	}

	const rendered = await renderTemplate({
		format: effectiveFormat,
		template: templateBody,
		variables: {},
	});

	let body = rendered.rendered;
	let bodyRecovered = false;
	// Not `trim()`: a template can render down to zero-width characters, which
	// trim leaves standing and the model reads as nothing.
	const renderedBlank = isEffectivelyBlank(body);
	if (rendered.error || UNRENDERED_TEMPLATE.test(body) || renderedBlank) {
		logger.error(
			"[publishing-suggestion] bound prompt did not render; using the default body",
			{ format: effectiveFormat, error: rendered.error, renderedBlank },
		);
		const recovery = await renderTemplate({
			format: "HANDLEBARS",
			template: PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
			variables: {},
		});
		body = recovery.rendered;
		bodyRecovered = true;
	}

	return {
		prompt: `${body.trimEnd()}\n\n${buildTopicSuggestionLockedClauses()}\n\nCONTEXT:\n${JSON.stringify(context, null, 2)}\n`,
		formatOverridden,
		bodyRecovered,
	};
}

/**
 * Strip the publishing-suite-only `authorGithubId` from `pullRequests` context
 * items before the prompt is built. The numeric GitHub id is consumed by the
 * workflow's PR-author contributor map (see `publishing-suggestion-pr-authors`),
 * NOT by the model — the prompt only asks the LLM to cite `(repoFullName,
 * prNumber)`. Keeping the id out of the serialized CONTEXT avoids sending a real
 * person's numeric GitHub id to the model provider and prompt logs, and trims a
 * few tokens. Pure and non-mutating.
 */
export function stripPrAuthorGithubIdsForPrompt(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const prs = context.pullRequests;
	if (!Array.isArray(prs)) {
		return context;
	}
	return {
		...context,
		pullRequests: prs.map((item) => {
			if (item && typeof item === "object") {
				const { authorGithubId, ...rest } = item as Record<
					string,
					unknown
				>;
				return rest;
			}
			return item;
		}),
	};
}

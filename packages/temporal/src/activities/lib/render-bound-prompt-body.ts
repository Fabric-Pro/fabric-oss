/**
 * Rendering a Prompt Library body against a run's facts, with the fallback when
 * the body will not render. Free of `@repo/database`, so the pure prompt
 * builders can use it without loading the database client; the lookup that
 * finds the body is `bound-prompt.ts`.
 */

import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";

/** Template syntax that survived a render means the body did not render. */
const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface RenderedPromptBody {
	text: string;
	/** The body yielded nothing usable, so the fallback body was rendered instead. */
	recovered: boolean;
	/** A non-templating format was rendered as Handlebars. */
	formatOverridden: boolean;
}

/**
 * Renders `body` (in `format`) against `variables`, or `fallbackBody` when the
 * body will not render. Three deterministic guards, none of them heuristics:
 *
 * 1. MARKDOWN and PLAIN_TEXT do no templating and report no error, so a body
 *    bound under either would reach the model as literal mustaches with none of
 *    the run's facts in it. They are rendered as Handlebars instead.
 * 2. Output still holding a triple-stache or a block helper means the body did
 *    not render (a Handlebars body under LIQUID, a parse error swallowed into a
 *    raw-body return). A bare `{{` is not enough: the facts are user prose, and
 *    discarding a working prompt because someone wrote mustaches in a ticket
 *    would be the worse bug.
 * 3. Output that is blank once rendered: `{{#unknown}}x{{/unknown}}` is a falsy
 *    block, not a syntax error, so it parses and renders to nothing. Tested on
 *    the rendered output, not the source, because "renders to nothing against
 *    this run's real facts" is a fact where the same judgement at save time
 *    would be a guess. Not `trim()`: a template can render down to zero-width
 *    characters.
 */
export async function renderBoundPromptBody(input: {
	body: string;
	format: TemplateFormat;
	fallbackBody: string;
	variables: Record<string, unknown>;
	escape?: boolean;
	logTag: string;
}): Promise<RenderedPromptBody> {
	const { variables, logTag } = input;
	let format = input.format;
	let formatOverridden = false;
	if (format === "MARKDOWN" || format === "PLAIN_TEXT") {
		logger.error(
			`[${logTag}] bound prompt has a non-templating format; rendering as Handlebars`,
			{ format },
		);
		format = "HANDLEBARS";
		formatOverridden = true;
	}

	const rendered = await renderTemplate({
		format,
		template: input.body,
		variables,
		escape: input.escape,
	});
	const renderedBlank = isEffectivelyBlank(rendered.rendered);
	if (
		!(
			rendered.error ||
			UNRENDERED_TEMPLATE.test(rendered.rendered) ||
			renderedBlank
		)
	) {
		return { text: rendered.rendered, recovered: false, formatOverridden };
	}

	logger.error(
		`[${logTag}] bound prompt did not render; using the default body`,
		{ format, error: rendered.error, renderedBlank },
	);
	const recovery = await renderTemplate({
		format: "HANDLEBARS",
		template: input.fallbackBody,
		variables,
		escape: input.escape,
	});
	return { text: recovery.rendered, recovered: true, formatOverridden };
}

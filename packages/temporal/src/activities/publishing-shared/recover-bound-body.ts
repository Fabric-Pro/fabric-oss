/**
 * Recovery for a bound publishing prompt body that did not render (Publishing
 * Suite, Fizzy #1988).
 *
 * Every publishing prompt composer renders an organization-editable body and
 * falls back to its built-in default when the result cannot be sent to a
 * model. Nine composers carried this block as a copy; it lives here once. Each
 * composer still decides its own format override before rendering and makes
 * its own first `renderTemplate` call — this starts from that result.
 *
 * The bound body is unusable when any of three things holds, each learned from
 * a real failure:
 *
 *   1. The renderer reported an error. `renderHandlebars` hands back the RAW
 *      template as `rendered` when compilation fails, so the text alone does
 *      not always show it: `Write about {{topic_title}}. {{/if}}` fails while
 *      containing neither `{{{` nor `{{#`.
 *   2. The output still carries `{{{` or `{{#`. Not a bare `{{`: the context is
 *      user prose, and a document title can plausibly contain mustaches —
 *      discarding a working prompt over that would be the worse bug.
 *   3. The output is blank. `{{#unknown}}x{{/unknown}}` parses and renders to
 *      "", and check 2 cannot see it precisely because nothing survived.
 *      `isEffectivelyBlank`, not `trim()`: a template can render down to
 *      zero-width characters, which trim leaves standing and the model reads
 *      as nothing.
 *
 * The default body is rendered as HANDLEBARS with the caller's own variables,
 * whatever format the bound body declared. Its output is deliberately NOT
 * re-tested against checks 2 and 3: the default is a known template, and a
 * topic title carrying `{{#` survives a triple-stash substitution into it
 * legitimately. Only its render error is checked, and logged, because
 * `bodyRecovered` is true either way and a run whose default body also failed
 * would otherwise read as a clean recovery.
 *
 * Not re-exported from `./index.ts`: that barrel reaches `@repo/database`, and
 * the composers importing this are pure modules.
 */

import { logger } from "@repo/logs";
import {
	isEffectivelyBlank,
	type RenderOptions,
	type RenderResult,
	renderTemplate,
	type TemplateFormat,
} from "@repo/utils";

const UNRENDERED_TEMPLATE = /\{\{[{#]/;

export interface RecoverBoundBodyInput {
	/**
	 * The log prefix, without brackets — `"publishing-blog-post"`. It is the
	 * string operators search the logs for, so each composer passes the prefix
	 * its own inline block used.
	 */
	subject: string;
	/** The composer's render of the bound body. */
	rendered: RenderResult;
	/** The format that render used, after any MARKDOWN / PLAIN_TEXT override. */
	format: TemplateFormat;
	/** The composer's built-in default body, a Handlebars template. */
	fallbackTemplate: string;
	variables: RenderOptions["variables"];
}

export interface RecoveredBoundBody {
	body: string;
	/** True whenever the default body was used, whether or not it rendered. */
	bodyRecovered: boolean;
}

export async function recoverBoundBody({
	subject,
	rendered,
	format,
	fallbackTemplate,
	variables,
}: RecoverBoundBodyInput): Promise<RecoveredBoundBody> {
	const renderedBlank = isEffectivelyBlank(rendered.rendered);
	if (
		!rendered.error &&
		!UNRENDERED_TEMPLATE.test(rendered.rendered) &&
		!renderedBlank
	) {
		return { body: rendered.rendered, bodyRecovered: false };
	}

	logger.error(
		`[${subject}] bound prompt did not render; using the default body`,
		{ format, error: rendered.error, renderedBlank },
	);
	const recovery = await renderTemplate({
		format: "HANDLEBARS",
		template: fallbackTemplate,
		variables,
	});
	if (recovery.error) {
		logger.error(`[${subject}] the DEFAULT body did not render either`, {
			error: recovery.error,
		});
	}
	return { body: recovery.rendered, bodyRecovered: true };
}

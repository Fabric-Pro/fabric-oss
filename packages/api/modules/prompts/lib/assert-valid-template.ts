import { ORPCError } from "@orpc/server";
import {
	isEffectivelyBlank,
	type TemplateFormat,
	validateTemplate,
} from "@repo/utils";
import {
	PROMPT_CONTENT_EMPTY_MESSAGE,
	PROMPT_CONTENT_MAX_LENGTH,
	promptContentTooLongMessage,
} from "@repo/utils/prompt-content";

/**
 * Reject a prompt body that cannot render under its declared format, or that
 * has no content to render at all.
 *
 * Without this, an invalid body saves cleanly and only misfires later inside a
 * Temporal run — where the failure is a log line nobody is watching and the
 * model receives a prompt full of literal mustaches. Validating at the save
 * path puts the parser's message in front of the person who can fix it.
 */
export function assertValidTemplate(
	format: TemplateFormat,
	template: string,
): void {
	// A contentless body parses cleanly under every format, so the parser below
	// will never reject it, and `z.string().min(1)` counts "   \n  " as one
	// character and lets it through. Saved, it binds like any other version and
	// the agent reading it gets a prompt carrying neither instructions nor
	// context — which still yields a confident-looking result that is persisted
	// as a success. Checked before the format is even considered, because no
	// format has a meaningful blank template.
	//
	// `isEffectivelyBlank` rather than `trim()`: trim leaves zero-width
	// characters standing, and a body of a single U+200B reached production
	// through exactly this check (Fizzy #2178 QA).
	if (isEffectivelyBlank(template)) {
		throw new ORPCError("BAD_REQUEST", {
			message: PROMPT_CONTENT_EMPTY_MESSAGE,
		});
	}

	const result = validateTemplate(format, template);
	if (!result.valid) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Template is not valid ${format}: ${result.error ?? "unknown error"}`,
		});
	}
}

/**
 * Reject a body over the product length limit.
 *
 * Applied wherever content is saved, and also where EXISTING content is put
 * to new use — forked into a new prompt, or bound or nominated as a default.
 * A body saved before the limit existed can exceed it; it keeps working where
 * it already runs, but must not be copied or promoted into a default, where
 * its tokens would ride every generation that resolves to it.
 */
export function assertWithinPromptContentLimit(content: string): void {
	if (content.length > PROMPT_CONTENT_MAX_LENGTH) {
		throw new ORPCError("BAD_REQUEST", {
			message: promptContentTooLongMessage(content.length),
		});
	}
}

/**
 * The full save-time guard for a prompt body: reject one over the product
 * length limit before even trying to render it, then apply the ordinary
 * blank/parse checks `assertValidTemplate` already does.
 *
 * Kept as its own function rather than folded into `assertValidTemplate`:
 * that function also re-validates a prompt's EXISTING latest body on a
 * format-change-only edit (see `update.ts`), and a legacy body saved before
 * this limit existed must not start blocking an unrelated metadata edit.
 */
export function assertSavablePromptContent(
	format: TemplateFormat,
	content: string,
): void {
	assertWithinPromptContentLimit(content);
	assertValidTemplate(format, content);
}

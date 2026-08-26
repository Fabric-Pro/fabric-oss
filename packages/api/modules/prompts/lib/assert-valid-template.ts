import { ORPCError } from "@orpc/server";
import {
	isEffectivelyBlank,
	type TemplateFormat,
	validateTemplate,
} from "@repo/utils";

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
			message: "Prompt content cannot be empty",
		});
	}

	const result = validateTemplate(format, template);
	if (!result.valid) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Template is not valid ${format}: ${result.error ?? "unknown error"}`,
		});
	}
}

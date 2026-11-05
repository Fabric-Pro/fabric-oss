import { ORPCError } from "@orpc/server";
import type { PromptWorkbenchDraft } from "@repo/ai/lib/prompt-workbench-contracts";
/**
 * Interactive previews accept text placeholders, never template programs.
 * Keep untrusted loops, includes, property traversal and callable expressions
 * out of the request process. Production rendering remains owned by its runtime.
 */
export function renderPromptPreview(
	draft: PromptWorkbenchDraft,
	values: Record<string, string>,
) {
	if (draft.format === "PLAIN_TEXT" || draft.format === "MARKDOWN") {
		return draft.content;
	}
	const placeholder = /\{\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\}?/g;
	const stripped = draft.content.replace(placeholder, "");
	if (/\{[{%]|[%}]\}|\{\{/.test(stripped)) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Interactive preview supports text placeholders such as {{topic}}. Template logic, filters, includes and nested expressions require a workflow run; they are not executed here.",
		});
	}
	return draft.content.replace(placeholder, (_token, name: string) => {
		if (!Object.hasOwn(values, name)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Supply a text value for input ${name}.`,
			});
		}
		return values[name];
	});
}

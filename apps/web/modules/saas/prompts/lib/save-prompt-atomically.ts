import { orpcClient } from "@shared/lib/orpc-client";

type PromptFormatValue =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

export type PromptUpdateInput = {
	name?: string;
	description?: string;
	format?: PromptFormatValue;
	category?: string;
	tags?: string[];
	isPublic?: boolean;
	content?: string;
	changeNote?: string;
};

/**
 * One request for metadata and content, instead of the two
 * `PromptDetails.updateMutation` used to fire — `prompts.update` for
 * metadata, then `prompts.version.create` for the body. A rename plus a
 * blank/invalid body used to update the metadata, THEN fail on the version
 * create: the toast said "Failed to update prompt" while the rename had
 * already persisted (Fizzy #2250).
 *
 * `prompts.update` now accepts content and validates + writes both in one
 * database transaction, so this is the only call.
 *
 * `content` is sent only when it actually changed, matching the save's own
 * "was anything to save" check: a metadata-only edit must not force a new
 * version.
 */
export async function savePromptAtomically(
	promptId: string,
	updateData: PromptUpdateInput,
	currentContent: string,
) {
	const { content: newContent, changeNote, ...metadataUpdate } = updateData;
	return await orpcClient.prompts.update({
		id: promptId,
		...metadataUpdate,
		content:
			newContent !== undefined && newContent !== currentContent
				? newContent
				: undefined,
		changeNote,
	});
}

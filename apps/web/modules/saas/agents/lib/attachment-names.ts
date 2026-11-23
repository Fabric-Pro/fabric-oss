/**
 * The file names a Direct question was sent with, saved in the question's
 * `metadata` so a reload still lists them under the user's bubble. Only the
 * names: the files themselves live in the chat's documents.
 *
 * Both save paths write them (the Direct chat's own save and the agent
 * runtime's), and every reader goes through `readAttachmentNames`, which
 * also bounds what a client may send.
 */

const MAX_ATTACHMENT_NAMES = 20;
const MAX_ATTACHMENT_NAME_LENGTH = 255;

/** The names in `value`, or undefined when it holds none. */
export function readAttachmentNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const names = value
		.filter((name): name is string => typeof name === "string")
		.map((name) => name.slice(0, MAX_ATTACHMENT_NAME_LENGTH))
		.filter((name) => name.length > 0)
		.slice(0, MAX_ATTACHMENT_NAMES);
	return names.length > 0 ? names : undefined;
}

/** The `metadata` field that saves `names` with a question; empty for none. */
export function attachmentNamesMetadata(names: unknown): {
	metadata?: { attachmentNames: string[] };
} {
	const attachmentNames = readAttachmentNames(names);
	return attachmentNames ? { metadata: { attachmentNames } } : {};
}

/**
 * References to stored objects in a client Proposal's text (Fizzy #2946).
 * A file that leaves the app, the PDF, the Word file or the Markdown
 * download, never carries a storage key or a presigned URL: the server
 * export removes them while it prints, and the browser's Markdown download
 * removes them from the finished text with {@link withoutStoredObjects}.
 *
 * Pure functions and data only: client components import this module.
 */

/**
 * A reference to a stored object: the key prefix of a document's media, a
 * project's or an organization's brand assets, a story's media or
 * attachments, a workspace file or an export, or a presigned URL's
 * signature, which grants whoever holds it the object. Only prefixes no
 * ordinary prose or public URL path uses are listed (not `projects/` or
 * `docs/`).
 */
export const STORAGE_REFERENCE =
	/(?:document-media|project-brand|organization-brand|story-media|story-attachments|workspace-files|proposal-exports)\/|X-Amz-(?:Signature|Credential)=/i;

/**
 * A run of URL characters that holds a storage reference. It stops at the
 * quotes, brackets and angle brackets a URL is written between, so removing
 * it leaves the Markdown, code or diagram syntax around it intact.
 */
const STORAGE_REFERENCE_TOKEN = new RegExp(
	`[^\\s"'<>()\\[\\]{}\`]*(?:${STORAGE_REFERENCE.source})[^\\s"'<>()\\[\\]{}\`]*`,
	"gi",
);

/** Text with every token that refers to a stored object removed. */
export function withoutStorageReferences(text: string): string {
	return text.replace(STORAGE_REFERENCE_TOKEN, "");
}

/** An HTML image tag, as the editor writes an uploaded image. */
const IMAGE_TAG = /<img\b[^>]*>/gi;

/** A Markdown image: `![alt](url "title")`, on one line. */
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/** A Markdown link: `[text](url "title")`, on one line. */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/**
 * Markdown with nothing in it that refers to a stored object, for a file
 * that leaves the app. An image tag or a Markdown image that names one is
 * dropped whole, since without its address it shows nothing; a link to one
 * keeps only its words, as the server export prints it; any other token
 * that holds one (prose, code, a diagram) is removed. Images already
 * embedded as `data:` URLs pass: base64 holds no `-`, so it never matches.
 */
export function withoutStoredObjects(markdown: string): string {
	const dropped = markdown
		.replace(IMAGE_TAG, (tag) => (STORAGE_REFERENCE.test(tag) ? "" : tag))
		.replace(MARKDOWN_IMAGE, (image, _alt: string, url: string) =>
			STORAGE_REFERENCE.test(url) ? "" : image,
		)
		.replace(MARKDOWN_LINK, (link, text: string, url: string) =>
			STORAGE_REFERENCE.test(url) ? text : link,
		);
	return withoutStorageReferences(dropped);
}

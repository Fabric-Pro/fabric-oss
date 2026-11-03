/**
 * The meeting transcript files a project accepts (Fizzy #1877).
 *
 * A separate vocabulary from `context-upload`, on purpose: that list is about
 * documents, and neither `.vtt` nor a 25 MB limit belongs on it. Every surface
 * that names a format or a limit reads it from here, for the reason given in
 * docs/solutions/conventions/accept-and-validation-share-one-vocabulary.md.
 */

export const TRANSCRIPT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** `metadata.provider` on the context row of an uploaded transcript. */
export const UPLOADED_TRANSCRIPT_PROVIDER = "file-upload";

export const TRANSCRIPT_UPLOAD_FORMATS = {
	txt: "text/plain",
	vtt: "text/vtt",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type TranscriptUploadFormat = keyof typeof TRANSCRIPT_UPLOAD_FORMATS;

const EXTENSIONS = Object.keys(TRANSCRIPT_UPLOAD_FORMATS).map(
	(format) => `.${format}`,
);

/** ".txt, .vtt, .docx", for messages. */
export const TRANSCRIPT_UPLOAD_FORMAT_LIST: string = EXTENSIONS.join(", ");

/** ".txt,.vtt,.docx", for a file input's `accept`. */
export const TRANSCRIPT_UPLOAD_ACCEPT_ATTR: string = EXTENSIONS.join(",");

/**
 * The format of a file, from its name alone. A browser reports nothing useful
 * for `.vtt`, so the reported MIME type is not consulted. Null when the name
 * has no extension or one this surface does not accept.
 */
export function transcriptUploadFormatOf(
	filename: string,
): TranscriptUploadFormat | null {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0) {
		return null;
	}
	const extension = filename.slice(dot + 1).toLowerCase();
	// `hasOwn`, not `in`: "standup.constructor" would otherwise pass as a format.
	return Object.hasOwn(TRANSCRIPT_UPLOAD_FORMATS, extension)
		? (extension as TranscriptUploadFormat)
		: null;
}

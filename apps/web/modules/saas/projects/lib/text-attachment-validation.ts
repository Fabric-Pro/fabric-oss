import {
	DEFAULT_MAX_ATTACHMENT_BYTES,
	resolveAttachmentMime,
	type StoryAttachmentDesignation,
	TEXT_ATTACHMENT_MIME_ALLOWLIST,
} from "@repo/utils/attachment";

export type { StoryAttachmentDesignation };

/**
 * Per-file size cap for create-flow text attachments (#1849). Reuses the shared
 * server default (25 MB) as the single source of truth so the client guardrail
 * cannot drift from what the API accepts. There is no client count cap — the
 * server's 20-per-story default stays authoritative.
 */
export const MAX_TEXT_ATTACHMENT_BYTES = DEFAULT_MAX_ATTACHMENT_BYTES; // 25 MB

/** A file staged in the create dialog, not yet uploaded. */
export interface PendingDocAttachment {
	file: File;
	designation: StoryAttachmentDesignation;
}

/**
 * Default designation for a newly attached file: Context only (UNLOCKED).
 * At creation time most attachments are reference material; Asset is an
 * explicit opt-in that also gates later deletion. (Plan KTD5 / OQ1.)
 */
export const DEFAULT_DOC_ATTACHMENT_DESIGNATION: StoryAttachmentDesignation =
	"UNLOCKED";

/** Machine-readable failure reason; the UI maps this to a translated message. */
type TextAttachmentValidationErrorCode = "unsupported-type" | "too-large";

export interface TextAttachmentValidationResult {
	valid: boolean;
	errorCode?: TextAttachmentValidationErrorCode;
}

/**
 * Validate a single pending file against the create-flow docx/md/txt + 25 MB
 * rules. There is no client-side count cap (the server's 20-per-story default
 * is authoritative). Uses `resolveAttachmentMime` so empty/ambiguous browser
 * mimes (e.g. `.md` reported as "") are rescued via the filename extension.
 */
export function validateTextAttachmentFile(
	file: File,
): TextAttachmentValidationResult {
	const resolvedMime = resolveAttachmentMime(
		file.name,
		file.type,
		TEXT_ATTACHMENT_MIME_ALLOWLIST,
	);
	if (!resolvedMime) {
		return { valid: false, errorCode: "unsupported-type" };
	}
	if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
		return { valid: false, errorCode: "too-large" };
	}
	return { valid: true };
}

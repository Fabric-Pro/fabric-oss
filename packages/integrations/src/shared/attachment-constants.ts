/**
 * Shared attachment constants for the chat-thread image-attachments feature.
 *
 * Authoritative values per `fabric/specs/2026-05-23-chat-thread-image-attachments/decisions.md` § 7
 * and `spec.md` § 7.4. Both the fetch-time MIME filter (Slack & Teams activities)
 * and the apply-time orchestrator `attachPendingMediaToStory` consume these.
 *
 * The legacy `MAX_IMAGE_SIZE` constant at
 * `packages/api/modules/projects/procedures/stories/create-media-upload-url.ts:24`
 * mirrors `MAX_BYTES_PER_IMAGE` here. The two must stay in sync — see the
 * cross-reference comment in that file and Open Question 2 of the spec.
 */

/** MIME types we durably re-host into R2. SVG is excluded for XSS; PDF is a separate flow. */
export const SUPPORTED_ATTACHMENT_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

/** Type literal union over the allowlisted MIME strings. */
export type SupportedAttachmentMime =
	(typeof SUPPORTED_ATTACHMENT_MIMES)[number];

/** Maximum number of images we attach to a single backlog item. */
export const MAX_IMAGES_PER_THREAD = 10;

/** Per-image byte ceiling: 5 MB (matches the existing `MAX_IMAGE_SIZE`). */
export const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;

/** Aggregate byte ceiling across all images on a single thread: 20 MB. */
export const MAX_TOTAL_BYTES_PER_THREAD = 20 * 1024 * 1024;

/** Per-image download timeout used by both Slack and Teams download helpers. */
export const DOWNLOAD_TIMEOUT_MS = 10_000;

/** End-to-end budget for `attachPendingMediaToStory` (download + upload + patch). */
export const APPROVAL_BUDGET_MS = 60_000;

/** Bounded concurrency for in-flight downloads (and pipelined uploads). */
export const DOWNLOAD_CONCURRENCY = 3;

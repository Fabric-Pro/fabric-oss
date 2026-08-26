/**
 * Re-export only. The implementation moved to @repo/utils/attachment-limits so
 * the Temporal PM pull path (Fizzy #1745, AC-9) enforces the same numbers as
 * the API upload path; @repo/temporal cannot import @repo/api, so a shared
 * home was the only way to keep one definition. Existing importers of this
 * path are unchanged on purpose.
 *
 * The `AttachmentLimits` type is deliberately NOT re-exported here — nothing
 * imports it through this path, and re-exporting it makes it dead code. Import
 * it from @repo/utils/attachment-limits if a caller ever needs it.
 */
export { resolveAttachmentLimits } from "@repo/utils/attachment-limits";

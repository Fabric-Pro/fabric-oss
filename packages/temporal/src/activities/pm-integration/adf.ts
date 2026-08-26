/**
 * Atlassian Document Format (ADF) helpers.
 *
 * The implementation now lives in `@repo/utils/adf-text` so it can be shared
 * with client-side code (project-context ingestion) without reaching into a
 * Temporal activities path. This module re-exports the helpers so existing
 * PM-integration consumers and Temporal replay are unaffected.
 *
 * Jira (Atlassian Rovo) returns `fields.description` as an ADF document
 * (`{ type: "doc", version, content: [...] }`), not a plain string. When that
 * value reaches a consumer expecting text — the sync-conflict preview, for
 * example — the object must be flattened or it renders as "(empty)".
 */

export {
	descriptionToText,
	extractTextFromAdf,
	isAdfDocument,
} from "@repo/utils/adf-text";

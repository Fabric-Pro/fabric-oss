/**
 * Which ticket attachments are eligible to reach an AI prompt.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * The eligible set is an intersection of vocabulary that already exists in two
 * sibling modules, and it cannot live in either of them:
 *
 * - `attachment.ts` owns the ticket allowlist (`DEFAULT_ATTACHMENT_MIME_ALLOWLIST`).
 * - `ai-chat-attachment.ts` owns the chat partitions, and already imports
 *   `attachment.ts`. Deriving the set there would put ticket-attachment policy
 *   in a chat module; deriving it in `attachment.ts` would close an import cycle.
 *
 * So this is a leaf that imports both. Two consumers read it — the server-side
 * resolver that builds prompt entries, and the attachment panel that renders the
 * inverse ("the AI does not read this file"). Deciding eligibility twice is how
 * those two drift, and the drift is silent: the panel would promise the model
 * read something it never received.
 *
 * ── The set ─────────────────────────────────────────────────────────────────
 * (chat text ∪ chat binary documents) ∩ ticket allowlist
 *
 * The intersection does all of the work on its own. `application/json` falls
 * out because no ticket surface accepts it, and legacy `.xls`
 * (`application/vnd.ms-excel`) falls out because it is not in the chat binary
 * set at all — exceljs reads OOXML `.xlsx` and CSV, not BIFF. So no
 * subtraction is needed and none is written.
 *
 * `text/html` was once listed here as falling out, on the rationale that
 * tickets never accepted it. Card #1684 reversed that: HTML is now an accepted
 * attachment type and reaches AI context at parity with the other text
 * formats, extracted by `LocalHtmlExtractor` rather than passed through as raw
 * markup.
 *
 * `.xlsx` was once subtracted here as a deferred product decision; that
 * decision has since been made the other way — spreadsheets reach ticket AI
 * context now, matching what chat already does, since the `local-xlsx`
 * extractor bounds itself (budget + walk caps).
 */

import {
	AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
	AI_CHAT_TEXT_MIME_TYPES,
} from "./ai-chat-attachment";
import { DEFAULT_ATTACHMENT_MIME_ALLOWLIST } from "./attachment";

/**
 * MIME types whose text is extracted and delivered inline when the attachment
 * is designated context-only (`UNLOCKED`).
 *
 * Resolves to: `text/plain`, `text/markdown`, `text/html`, `text/csv`,
 * `application/pdf`, `.docx`, and `.xlsx`.
 *
 * An attachment outside this set stays attachable and stays invisible to the
 * model — including when the user marks it context-only. That combination is
 * what the panel has to disclose, or the user is left believing the AI read a
 * screenshot it never received.
 */
export const STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES: readonly string[] = [
	...AI_CHAT_TEXT_MIME_TYPES,
	...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
].filter((mime) => DEFAULT_ATTACHMENT_MIME_ALLOWLIST.includes(mime));

/**
 * Whether this attachment's text can reach a prompt. Designation is a separate
 * gate the caller applies — a LOCKED `.md` answers `true` here and still must
 * never be delivered.
 */
export function isAiContextEligibleAttachmentMime(mimeType: string): boolean {
	return STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES.includes(
		mimeType.trim().toLowerCase(),
	);
}

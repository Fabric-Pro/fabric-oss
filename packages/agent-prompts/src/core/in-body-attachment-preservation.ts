/**
 * In-body attachment preservation clause.
 *
 * Single source of truth for the system-prompt augmentation that tells the
 * model which content it must keep byte-for-byte across an AI rewrite and
 * which transport tokens it must never copy into the document body.
 *
 * Two prompt-composition surfaces append the return value verbatim:
 *
 * - `buildSystemPromptAsync` in the `project_document_generator` langgraph
 *   agent (CopilotKit streaming path — stage transitions, "Update using
 *   context", Re-evaluate Bug).
 * - `enhanceFeatureWithAI` in `packages/api/.../enhance-feature.ts` (the
 *   sync-flow fallback that fires when the frontend cannot resolve a prompt).
 *
 * Centralising the wording here guarantees the two surfaces cannot drift:
 * a misbehaving model on Surface A and a misbehaving model on Surface B
 * read identical instructions. Callers MUST append the return value
 * verbatim and MUST NOT mutate it (concatenation only — no string
 * substitution, no truncation, no reformatting).
 *
 * The clause is composed of three independent, scope-labelled blocks
 * separated by blank lines so the model can index them quickly:
 *
 * 1. `INPUT-DOCUMENT IMAGES — PRESERVE VERBATIM` — protects in-body images
 *    whose URL contains the `story-media/` substring (the canonical S3
 *    keyspace for user-pasted screenshots).
 * 2. `CHAT-ATTACHMENT TOKENS — DO NOT EMBED IN THE DOCUMENT` — keeps the
 *    pre-existing chat-attachment hygiene rule: `data:` URLs and
 *    `[attached image: …]` bookkeeping tokens must never land in the
 *    document body.
 * 3. `FENCED CODE BLOCKS — PRESERVE VERBATIM` — protects triple-backtick
 *    code blocks across rewrites.
 *
 * The image-preservation and chat-attachment rules are mutually exclusive
 * by URL substring (`story-media/` vs `data:`), so the model never has to
 * arbitrate between them.
 */
export function getInBodyAttachmentPreservationClause(): string {
	const inputDocumentImages = `INPUT-DOCUMENT IMAGES — PRESERVE VERBATIM
The current document body may already contain inline image markdown
whose URL contains the substring "story-media/" (example:
\`![](https://example.cloudfront.net/story-media/<projectId>/<storyId>/<key>?signed=…)\`).
These images were added by the user via the document editor and MUST
be preserved byte-for-byte in your output:
- Do NOT remove the image markdown.
- Do NOT paraphrase or rewrite the URL — keep the "story-media/" path
  segment exactly as it appears.
- Do NOT replace the image with a placeholder like "[image]" or with
  prose describing what the image shows.
- Do NOT move the image into a different section unless the user
  explicitly asked for that move.`;

	const chatAttachmentTokens = `CHAT-ATTACHMENT TOKENS — DO NOT EMBED IN THE DOCUMENT
Separately, the user may attach files to THIS CHAT via the paperclip /
paste / drop pipeline. Those attachments arrive in the message stream
either as vision content parts (look at them directly) or as bookkeeping
tokens of the form \`[attached image: <filename>]\` in the RAG context, and
data URLs (\`data:image/png;base64,…\`) may also appear in the chat.
Tokens, data URLs, and \`[attached image: …]\` markers are transport
bookkeeping for files the user attached to the CONVERSATION, not to the
document body. Never copy them into the document content you produce
via \`write_document_local\`, \`apply_document_patches\`, or any other
document-write tool. Describe what the chat-attached image shows in
prose if that is useful for the document.`;

	const fencedCodeBlocks = `FENCED CODE BLOCKS — PRESERVE VERBATIM
Triple-backtick code blocks (\`\`\`lang … \`\`\`) that already exist in the
document MUST be preserved verbatim — exact contents, exact language
tag, exact placement relative to surrounding prose — unless the user
explicitly asked you to modify a specific code block.`;

	return [inputDocumentImages, chatAttachmentTokens, fencedCodeBlocks].join(
		"\n\n",
	);
}

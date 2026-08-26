/**
 * Tests for `getInBodyAttachmentPreservationClause`.
 *
 * The helper is the single source of truth for the prompt augmentation
 * shared by `buildSystemPromptAsync` (Surface A — CopilotKit langgraph
 * agent) and `enhanceFeatureWithAI` (Surface B — sync-flow fallback).
 * Both surfaces append the return value verbatim; any drift in the
 * marker labels, the `story-media/` URL anchor, or the chat-attachment
 * hygiene wording is a model-contract change that must show up here as
 * a snapshot diff.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import { getInBodyAttachmentPreservationClause } from "../src/core/in-body-attachment-preservation";

describe("getInBodyAttachmentPreservationClause", () => {
	describe("marker substrings", () => {
		it("includes the INPUT-DOCUMENT IMAGES scope marker", () => {
			const clause = getInBodyAttachmentPreservationClause();
			expect(clause).toContain("INPUT-DOCUMENT IMAGES");
		});

		it("includes the CHAT-ATTACHMENT TOKENS scope marker", () => {
			const clause = getInBodyAttachmentPreservationClause();
			expect(clause).toContain("CHAT-ATTACHMENT TOKENS");
		});

		it("includes the FENCED CODE BLOCKS scope marker", () => {
			const clause = getInBodyAttachmentPreservationClause();
			expect(clause).toContain("FENCED CODE BLOCKS");
		});
	});

	describe("URL anchors", () => {
		it("anchors the preservation rule on the story-media/ URL substring (AC #1)", () => {
			const clause = getInBodyAttachmentPreservationClause();
			expect(clause).toContain("story-media/");
		});

		it("retains the data: chat-attachment hygiene wording (backwards-compat)", () => {
			const clause = getInBodyAttachmentPreservationClause();
			expect(clause).toContain("data:");
		});
	});

	describe("block composition", () => {
		it("separates the three blocks with a blank line so the model can index by scope", () => {
			const clause = getInBodyAttachmentPreservationClause();
			const blocks = clause.split("\n\n");
			// Exactly three blocks, joined by `\n\n`.
			const scopeBlocks = blocks.filter(
				(block) =>
					block.startsWith("INPUT-DOCUMENT IMAGES") ||
					block.startsWith("CHAT-ATTACHMENT TOKENS") ||
					block.startsWith("FENCED CODE BLOCKS"),
			);
			expect(scopeBlocks).toHaveLength(3);
		});

		it("orders the blocks as preserve-images, no-embed-chat-tokens, preserve-code", () => {
			const clause = getInBodyAttachmentPreservationClause();
			const imagesIdx = clause.indexOf("INPUT-DOCUMENT IMAGES");
			const tokensIdx = clause.indexOf("CHAT-ATTACHMENT TOKENS");
			const codeIdx = clause.indexOf("FENCED CODE BLOCKS");
			expect(imagesIdx).toBeGreaterThanOrEqual(0);
			expect(tokensIdx).toBeGreaterThan(imagesIdx);
			expect(codeIdx).toBeGreaterThan(tokensIdx);
		});
	});

	describe("full snapshot — single source of truth", () => {
		// Snapshot churn here is the right signal that the model contract
		// changed. Both prompt-composition surfaces consume this exact
		// string, so a diff is intentional surface area.
		it("matches the locked clause wording", () => {
			expect(
				getInBodyAttachmentPreservationClause(),
			).toMatchInlineSnapshot(`
				"INPUT-DOCUMENT IMAGES — PRESERVE VERBATIM
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
				  explicitly asked for that move.

				CHAT-ATTACHMENT TOKENS — DO NOT EMBED IN THE DOCUMENT
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
				prose if that is useful for the document.

				FENCED CODE BLOCKS — PRESERVE VERBATIM
				Triple-backtick code blocks (\`\`\`lang … \`\`\`) that already exist in the
				document MUST be preserved verbatim — exact contents, exact language
				tag, exact placement relative to surrounding prose — unless the user
				explicitly asked you to modify a specific code block."
			`);
		});
	});
});

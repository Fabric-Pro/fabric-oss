/**
 * Tests for `getLockedAttachmentRulesClause` (FR-25 / Fizzy #1747, parent #1702).
 *
 * The helper is the single source of truth for the dedicated-attachment
 * non-editability rule shared by `buildSystemPromptAsync` (Surface A — the
 * CopilotKit langgraph agent) and `enhanceFeatureWithAI` (Surface B — the
 * sync-flow fallback). Both surfaces append the return value verbatim; any
 * drift in the `DEDICATED ATTACHMENTS` scope marker, the `LOCKED` / `UNLOCKED`
 * designation anchors, or the anti-fabrication wording is a model-contract
 * change that must show up here as a snapshot diff.
 *
 * Sibling of `in-body-attachment-preservation.test.ts` — that clause protects
 * in-body content; this one governs the dedicated `StoryAttachment` assets that
 * live OUTSIDE the document body.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import { getLockedAttachmentRulesClause } from "../src/core/locked-attachment-rules";

describe("getLockedAttachmentRulesClause", () => {
	describe("audit label", () => {
		it("is headed with the DEDICATED ATTACHMENTS scope marker (AC-1/AC-8)", () => {
			// The block must be human-readable and easy to grep/audit. An
			// UPPERCASE non-`#` scope marker (like the sibling in-body clause)
			// is used instead of a `### heading` so the model cannot mistake
			// it for a document section to emit / echo into the body.
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toContain(
				"DEDICATED ATTACHMENTS — READ-ONLY REFERENCE ASSETS",
			);
			// Guard the echo-pollution fix: no `#` markdown heading in the clause.
			expect(clause).not.toMatch(/^#{1,6}\s/m);
		});
	});

	describe("lock-state distinction (AC-6)", () => {
		it("marks LOCKED attachments as immutable / read-only", () => {
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toContain("LOCKED");
			expect(clause).toMatch(/read-only|immutable/i);
		});

		it("names UNLOCKED (context-only) attachments as a distinct category", () => {
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toContain("UNLOCKED");
			expect(clause.toLowerCase()).toContain("context-only");
		});
	});

	describe("anti-fabrication (AC-3/AC-4)", () => {
		it("forbids claiming to have read / seen / analysed attachment contents", () => {
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toMatch(/never claim/i);
			expect(clause).toMatch(/analys|read|view|seen/i);
		});

		it("forbids fabricating attachment contents beyond metadata", () => {
			expect(getLockedAttachmentRulesClause()).toMatch(
				/invent|fabricat/i,
			);
		});
	});

	describe("delivery split — LOCKED withheld, context-only delivered (R8/R9)", () => {
		it("scopes the never-receive-contents rule to LOCKED", () => {
			const clause = getLockedAttachmentRulesClause();

			// The pre-narrowing wording was an unqualified "You do NOT receive
			// attachment files or their contents." Shipping that alongside
			// inline delivery tells the model to disbelieve text it was handed.
			expect(clause).not.toContain(
				"You do NOT receive attachment files or their contents.",
			);

			// Narrowed, not deleted: the sentence must still exist and must
			// name LOCKED as its subject.
			expect(clause).toMatch(
				/do NOT receive the contents of a LOCKED attachment/,
			);
		});

		it("tells the model that inline context-only text is input it was given", () => {
			// Without this the model holds a rule saying "never claim to have
			// read an attachment" and a prompt section containing an
			// attachment's full text, with no way to reconcile the two.
			// The clause is hard-wrapped, so any phrase assertion has to
			// tolerate a newline landing mid-sentence.
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toMatch(/inline/i);
			expect(clause).toMatch(/input\s+you\s+have\s+been\s+given/i);
		});

		it("broadens anti-fabrication to any attachment whose text is absent", () => {
			// The narrowing must not shrink this rule. It now has to cover more
			// than before: LOCKED files AND context-only files whose type
			// carries no extractable text (images, video, archives), which the
			// user sees marked context-only but the model never receives.
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toMatch(/whatever its lock state/i);
			expect(clause).toMatch(/image, video, or archive/i);
		});
	});

	describe("immutability (AC-2/AC-5)", () => {
		it("forbids modifying, deleting, or implying a change to an attachment", () => {
			const clause = getLockedAttachmentRulesClause();
			expect(clause).toMatch(/modify|delete|remove/i);
		});
	});

	describe("no-op safety when no metadata is present (AC-9)", () => {
		it("tells the model not to invent an attachments section when none are in context", () => {
			expect(getLockedAttachmentRulesClause()).toMatch(
				/do not add an attachments section|do not reference any attachment/i,
			);
		});
	});

	describe("full snapshot — single source of truth", () => {
		// Snapshot churn here is the right signal that the model contract
		// changed. Both prompt-composition surfaces consume this exact string,
		// so a diff is intentional surface area.
		it("matches the locked FR-25 wording", () => {
			expect(getLockedAttachmentRulesClause()).toMatchInlineSnapshot(`
				"DEDICATED ATTACHMENTS — READ-ONLY REFERENCE ASSETS
				This work item may have file attachments that are stored SEPARATELY from the
				document body — they are never part of the text you write or edit. When the
				context you are given lists such attachments (for example by filename and lock
				state), follow these rules:

				- LOCKED attachments (this is the default state) are read-only, immutable
				  reference assets. Never modify, delete, regenerate, rename, or reorder them,
				  and never produce output that implies you changed, removed, or added an
				  attachment.
				- You do NOT receive the contents of a LOCKED attachment. Never claim to have
				  opened, read, viewed, seen, or analysed one (such as a screenshot, mockup, or
				  PDF), and never describe or invent its contents beyond metadata that is
				  literally present in the context (such as a filename).
				- UNLOCKED (context-only) attachments may be supplied to you inline, with their
				  text already present in your context. Where that text is present, it is input
				  you have been given: use it, and do not say you opened or retrieved the file.
				- Never invent, describe, or fabricate the contents of any attachment whose text
				  is NOT present in your context, whatever its lock state. A filename on its own
				  is metadata, not content — an image, video, or archive named in the context was
				  not read by you.
				- If the context does not mention any attachment, do not add an attachments
				  section and do not reference any attachment."
			`);
		});
	});
});

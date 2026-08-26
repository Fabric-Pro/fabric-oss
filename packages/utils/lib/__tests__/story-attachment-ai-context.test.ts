/**
 * The eligible-MIME set is derived, not typed out, so these tests guard the
 * derivation rather than restating a list. The failure they exist to catch is a
 * silent widening: someone adds a format to the chat partitions or the ticket
 * allowlist and it starts flowing to the model without anyone deciding it should.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ATTACHMENT_MIME_ALLOWLIST } from "../attachment";
import {
	isAiContextEligibleAttachmentMime,
	STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES,
} from "../story-attachment-ai-context";

describe("STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES", () => {
	it("resolves to exactly the prose formats plus .xlsx and html", () => {
		expect([...STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES].sort()).toEqual(
			[
				"application/pdf",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				"text/csv",
				"text/html",
				"text/markdown",
				"text/plain",
			].sort(),
		);
	});

	it("contains nothing the ticket allowlist does not accept", () => {
		// The intersection is what keeps chat-only formats (e.g.
		// application/json) from reaching a surface that never accepted them.
		// text/html used to be one of those chat-only formats; card #1684 moved
		// it onto the ticket allowlist too, so it no longer gets filtered here.
		for (const mime of STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES) {
			expect(DEFAULT_ATTACHMENT_MIME_ALLOWLIST).toContain(mime);
		}
	});

	it("includes text/html now that tickets accept it", () => {
		// Reversal, not drift. Card #1684 decided HTML uploads reach AI context
		// at parity with other text formats, so the ticket allowlist gained
		// text/html and this derived set followed automatically. The extraction
		// is real (LocalHtmlExtractor), not raw-markup passthrough.
		expect(STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES).toContain("text/html");
	});

	it("still excludes application/json — no ticket surface accepts it", () => {
		expect(STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES).not.toContain(
			"application/json",
		);
	});

	it("includes .xlsx now that spreadsheets reach ticket AI context", () => {
		// Once deferred by product decision; that decision was reversed — chat
		// already reads .xlsx and the extractor bounds itself.
		expect(STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES).toContain(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
	});

	it("still excludes legacy .xls — not extractable, not deferred", () => {
		// `.xls` never qualified: it is absent from the chat binary set because
		// exceljs reads OOXML, not BIFF. Marking it eligible would promise text
		// the extractor cannot produce.
		expect(STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES).not.toContain(
			"application/vnd.ms-excel",
		);
	});

	it("excludes every format with no extractable text", () => {
		for (const mime of [
			"image/png",
			"image/jpeg",
			"image/svg+xml",
			"video/mp4",
			"video/webm",
			"application/zip",
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"application/vnd.excalidraw+json",
		]) {
			expect(STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES).not.toContain(mime);
		}
	});

	it("has no duplicates", () => {
		expect(new Set(STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES).size).toBe(
			STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES.length,
		);
	});
});

describe("isAiContextEligibleAttachmentMime", () => {
	it("accepts the prose formats", () => {
		expect(isAiContextEligibleAttachmentMime("text/markdown")).toBe(true);
		expect(isAiContextEligibleAttachmentMime("application/pdf")).toBe(true);
	});

	it("rejects images and video", () => {
		expect(isAiContextEligibleAttachmentMime("image/png")).toBe(false);
		expect(isAiContextEligibleAttachmentMime("video/mp4")).toBe(false);
	});

	it("normalizes case and surrounding whitespace", () => {
		// Stored MIME is client-declared and pinned at PUT, so it is not
		// guaranteed to arrive normalized.
		expect(isAiContextEligibleAttachmentMime("  TEXT/Markdown ")).toBe(
			true,
		);
	});

	it("rejects an empty or unknown type rather than throwing", () => {
		expect(isAiContextEligibleAttachmentMime("")).toBe(false);
		expect(isAiContextEligibleAttachmentMime("application/x-made-up")).toBe(
			false,
		);
	});
});

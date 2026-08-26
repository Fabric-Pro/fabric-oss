import { describe, expect, it } from "vitest";
import { extractReasoningText } from "../reasoning-stream";

describe("extractReasoningText", () => {
	// ─── TextStreamPart shape (what streamText().fullStream actually emits) ─────
	// Verified at apps/web/node_modules/ai/dist/index.d.ts:2592, 2614:
	//   type: "reasoning-delta", id: string, text: string, providerMetadata?
	// The content field is `text` on TextStreamPart — NOT `delta`.
	it("returns the text of a reasoning-delta part (TextStreamPart shape from fullStream)", () => {
		// AI SDK 6 streamText().fullStream emits TextStreamPart, where reasoning-delta carries `text`
		// (verified at apps/web/node_modules/ai/dist/index.d.ts:2614). The plan's round-5 review
		// missed this — it verified the UIMessageChunk union (line 2090) which uses `delta` instead.
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				text: "First, ",
			}),
		).toBe("First, ");
	});

	// ─── UIMessageChunk / SingleRequestTextStreamPart shape (defensive fallback) ─
	// Other SDK 6 unions (UIMessageChunk at line 2090, SingleRequestTextStreamPart at line 4573)
	// use `delta` instead of `text`. Helper supports both for forward-compat.
	it("returns the delta of a reasoning-delta part (UIMessageChunk shape — defensive)", () => {
		// Other SDK 6 unions (UIMessageChunk, SingleRequestTextStreamPart) use `delta`.
		// Helper supports both for forward-compat / defensive coverage.
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				delta: "Second, ",
			}),
		).toBe("Second, ");
	});

	it("prefers `text` when both fields are present", () => {
		// If a hybrid SDK version emits both, `text` wins because it's the documented
		// TextStreamPart shape — the actual fullStream surface.
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				text: "preferred",
				delta: "fallback",
			}),
		).toBe("preferred");
	});

	it("returns null when neither text nor delta is a non-empty string", () => {
		expect(
			extractReasoningText({ type: "reasoning-delta", id: "r1" }),
		).toBeNull();
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				text: "",
			}),
		).toBeNull();
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				delta: "",
			}),
		).toBeNull();
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				text: 42,
			}),
		).toBeNull();
	});

	// ─── Non-content part types ──────────────────────────────────────────────────

	it("returns null for reasoning-start (no content yet)", () => {
		// reasoning-start carries no content; it only signals begin-of-block.
		// Timing capture for reasoningStartedAt uses this event, but the text
		// extractor returns null for it.
		expect(
			extractReasoningText({ type: "reasoning-start", id: "r1" }),
		).toBeNull();
	});

	it("returns null for reasoning-end (terminator, no content)", () => {
		expect(
			extractReasoningText({ type: "reasoning-end", id: "r1" }),
		).toBeNull();
	});

	it("returns null for unrelated stream parts", () => {
		expect(
			extractReasoningText({
				type: "text-delta",
				id: "t1",
				delta: "Answer",
			}),
		).toBeNull();
		expect(
			extractReasoningText({ type: "tool-call", toolCallId: "x" }),
		).toBeNull();
	});

	it("returns null for malformed parts", () => {
		expect(extractReasoningText(null)).toBeNull();
		expect(extractReasoningText(undefined)).toBeNull();
		expect(extractReasoningText("not an object")).toBeNull();
		expect(
			extractReasoningText({ type: "reasoning-delta", id: "r1" }),
		).toBeNull();
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				text: 42,
			}),
		).toBeNull();
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				delta: 42,
			}),
		).toBeNull();
	});

	it("returns null for empty-string text or delta", () => {
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				text: "",
			}),
		).toBeNull();
		expect(
			extractReasoningText({
				type: "reasoning-delta",
				id: "r1",
				delta: "",
			}),
		).toBeNull();
	});
});

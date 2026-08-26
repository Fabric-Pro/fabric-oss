import {
	type BaseMessage,
	HumanMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG } from "@repo/agent-core/recursion";
import { describe, expect, it } from "vitest";
import { splitImageToolMessages } from "../nodes/tool-node";

// =============================================================================
// splitImageToolMessages — tool-result contiguity
// =============================================================================
//
// Image parts are only schema-valid on a `user` message, never inside a
// tool-role message, so an image tool result is split into a text-only
// ToolMessage plus a synthetic HumanMessage. The provider additionally
// requires every tool result for one assistant turn to follow it
// contiguously, so those synthetic user turns must land AFTER the whole batch
// — never between two tool results. Splicing them in place is only safe when
// the image tool happens to be the last call in the batch, and this agent
// emits parallel tool calls in the large majority of turns.

/** A tool result carrying the `__images` marker the tool node splits on. */
function imageToolResult(
	toolCallId: string,
	opts: { images?: number; skipped?: number; name?: string } = {},
): ToolMessage {
	const images = Array.from({ length: opts.images ?? 1 }, (_, i) => ({
		id: `img_${i}`,
		contentType: "image/png",
		base64: `BASE64_${i}`,
	}));
	return new ToolMessage({
		content: JSON.stringify({
			__images: true,
			text: `Found ${images.length} image(s) in this message.`,
			images,
			skipped: opts.skipped ?? 0,
		}),
		tool_call_id: toolCallId,
		name: opts.name ?? "get_message_hosted_content",
	});
}

/** An ordinary, non-image tool result. */
function plainToolResult(toolCallId: string, name = "list_message_replies") {
	return new ToolMessage({
		content: "No replies found for this message.",
		tool_call_id: toolCallId,
		name,
	});
}

function isSynthetic(msg: BaseMessage): boolean {
	return (
		(msg as { additional_kwargs?: Record<string, unknown> })
			.additional_kwargs?.[SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG] === true
	);
}

describe("splitImageToolMessages", () => {
	it("keeps every tool result before the synthetic image turn", () => {
		// The image tool is FIRST here — the ordering that an in-place splice
		// would have broken, producing Tool, Human, Tool.
		const out = splitImageToolMessages([
			imageToolResult("call_img"),
			plainToolResult("call_plain"),
		]);

		expect(out).toHaveLength(3);
		expect(out[0]).toBeInstanceOf(ToolMessage);
		expect(out[1]).toBeInstanceOf(ToolMessage);
		expect(out[2]).toBeInstanceOf(HumanMessage);
		expect(isSynthetic(out[2])).toBe(true);
	});

	it("keeps ordering when the image tool is last", () => {
		const out = splitImageToolMessages([
			plainToolResult("call_plain"),
			imageToolResult("call_img"),
		]);

		expect(out.slice(0, 2).every((m) => m instanceof ToolMessage)).toBe(
			true,
		);
		expect(out[2]).toBeInstanceOf(HumanMessage);
	});

	it("appends one synthetic turn per image result, after all tool results", () => {
		const out = splitImageToolMessages([
			imageToolResult("call_a"),
			plainToolResult("call_plain"),
			imageToolResult("call_b"),
		]);

		expect(out).toHaveLength(5);
		expect(out.slice(0, 3).every((m) => m instanceof ToolMessage)).toBe(
			true,
		);
		expect(out.slice(3).every((m) => m instanceof HumanMessage)).toBe(true);
		expect(out.slice(3).every(isSynthetic)).toBe(true);
	});

	it("strips image parts out of the ToolMessage and moves them to the user turn", () => {
		const out = splitImageToolMessages([imageToolResult("call_img")]);

		const toolMsg = out[0] as ToolMessage;
		// The tool result is now plain text and still satisfies its tool_call.
		expect(typeof toolMsg.content).toBe("string");
		expect(toolMsg.tool_call_id).toBe("call_img");
		expect(JSON.stringify(toolMsg.content)).not.toContain("image_url");

		const parts = (out[1] as HumanMessage).content as Array<
			Record<string, unknown>
		>;
		expect(Array.isArray(parts)).toBe(true);
		expect(parts.some((p) => p.type === "image_url")).toBe(true);
	});

	it("labels the synthetic turn with the originating tool call id", () => {
		// Provenance: these turns are appended after the batch, so position no
		// longer identifies which call produced them.
		const out = splitImageToolMessages([
			imageToolResult("call_img", { name: "get_message_hosted_content" }),
		]);
		const parts = (out[1] as HumanMessage).content as Array<{
			type: string;
			text?: string;
		}>;
		expect(parts[0]?.text).toContain("get_message_hosted_content");
		expect(parts[0]?.text).toContain("call_img");
	});

	it("notes skipped oversized images on the synthetic turn", () => {
		const out = splitImageToolMessages([
			imageToolResult("call_img", { images: 1, skipped: 2 }),
		]);
		const parts = (out[1] as HumanMessage).content as Array<{
			type: string;
			text?: string;
		}>;
		expect(
			parts.some((p) => p.text?.includes("2 image(s) were too large")),
		).toBe(true);
	});

	it("passes non-image tool results through untouched", () => {
		const plain = plainToolResult("call_plain");
		const out = splitImageToolMessages([plain]);
		expect(out).toHaveLength(1);
		expect(out[0]).toBe(plain);
	});

	it("passes through a malformed __images payload rather than dropping it", () => {
		const malformed = new ToolMessage({
			content: '{"__images":true, this is not valid json',
			tool_call_id: "call_bad",
			name: "get_message_hosted_content",
		});
		const out = splitImageToolMessages([malformed]);
		expect(out).toHaveLength(1);
		expect(out[0]).toBe(malformed);
	});

	it("passes through an __images payload with no images", () => {
		const empty = new ToolMessage({
			content: JSON.stringify({
				__images: true,
				text: "none",
				images: [],
				skipped: 0,
			}),
			tool_call_id: "call_empty",
			name: "get_message_hosted_content",
		});
		const out = splitImageToolMessages([empty]);
		expect(out).toHaveLength(1);
		expect(out[0]).toBe(empty);
	});

	it("returns an empty array for an empty batch", () => {
		expect(splitImageToolMessages([])).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";
import {
	applyFrameBlockEdits,
	validateEditFrameBlockArgs,
} from "../src/activities/shared/frame-args";

const args = {
	frameId: "example-frame",
	blockId: "example-block",
	edits: [{ oldText: "hello", newText: "world" }],
};
describe("frame block edits", () => {
	it("applies a literal replacement and deletion", () => {
		expect(applyFrameBlockEdits("hello!", args.edits)).toEqual({
			content: "world!",
			replacements: [1],
		});
		expect(
			applyFrameBlockEdits("hello!", [{ oldText: "hello", newText: "" }]),
		).toEqual({ content: "!", replacements: [1] });
	});
	it.each([
		["absent", 0],
		["hello hello", 2],
	])("refuses ambiguous input %s", (content, count) => {
		expect(() => applyFrameBlockEdits(String(content), args.edits)).toThrow(
			`Edit 1 matched ${count}`,
		);
	});
	it("replaces all literal occurrences and applies later edits to the result", () => {
		expect(
			applyFrameBlockEdits("hello hello", [
				{ oldText: "hello", newText: "$&", replaceAll: true },
				{ oldText: "$& $&", newText: "done" },
			]),
		).toEqual({ content: "done", replacements: [2, 1] });
	});
	it.each([
		[],
		Array(21).fill(args.edits[0]),
		[{ oldText: "", newText: "x" }],
		[{ oldText: "x", newText: 1 }],
		[{ oldText: "x", newText: "y", replaceAll: "true" }],
	])("refuses malformed edits %j", (edits) => {
		expect(validateEditFrameBlockArgs({ ...args, edits }).ok).toBe(false);
	});
	it.each(["oldText", "newText"])(
		"refuses a placeholder embedded in %s",
		(field) => {
			expect(
				validateEditFrameBlockArgs({
					...args,
					edits: [
						{
							...args.edits[0],
							[field]:
								"prefix [content omitted: 3000 chars - rendered to frame] suffix",
						},
					],
				}),
			).toMatchObject({
				ok: false,
				error: expect.stringContaining("placeholder"),
			});
		},
	);
	it("refuses malformed timestamps", () => {
		expect(
			validateEditFrameBlockArgs({ ...args, expectedUpdatedAt: "bad" })
				.ok,
		).toBe(false);
	});
});

it("refuses overlapping ambiguity and zero matches with replaceAll", () => {
	expect(() =>
		applyFrameBlockEdits("aaa", [{ oldText: "aa", newText: "b" }]),
	).toThrow("Edit 1 matched 2");
	expect(() =>
		applyFrameBlockEdits("aaa", [
			{ oldText: "missing", newText: "b", replaceAll: true },
		]),
	).toThrow("Edit 1 matched 0");
});

it("refuses chained doubling before allocating content beyond the block limit", () => {
	const edits = Array.from({ length: 20 }, () => ({
		oldText: "a",
		newText: "aa",
		replaceAll: true,
	}));
	expect(() => applyFrameBlockEdits("a", edits)).toThrow(
		"Edit 20 would exceed block limit of 1000000 characters",
	);
}, 2000);

it("allows large existing blocks to retain their size but refuses further growth", () => {
	const content = "a".repeat(1_000_001);
	expect(
		applyFrameBlockEdits(content, [
			{ oldText: "a", newText: "b", replaceAll: true },
		]).content,
	).toHaveLength(content.length);
	expect(() =>
		applyFrameBlockEdits(content, [
			{ oldText: "a", newText: "aa", replaceAll: true },
		]),
	).toThrow("Edit 1 would exceed block limit of 1000001 characters");
});

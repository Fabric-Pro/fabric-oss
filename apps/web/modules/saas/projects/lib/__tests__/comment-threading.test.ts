import { describe, expect, it } from "vitest";
import { groupCommentsIntoThreads } from "../comment-threading";

type C = { id: string; parentId?: string | null; tag?: string };

const c = (id: string, parentId: string | null = null): C => ({ id, parentId });

describe("groupCommentsIntoThreads", () => {
	it("returns flat roots (no parentId) with empty replies, in order", () => {
		const out = groupCommentsIntoThreads([c("a"), c("b"), c("c")]);
		expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
		expect(out.every((r) => r.replies.length === 0)).toBe(true);
	});

	it("nests a reply under its root, not at top level", () => {
		const out = groupCommentsIntoThreads([c("a"), c("b", "a")]);
		expect(out.map((r) => r.id)).toEqual(["a"]);
		expect(out[0].replies.map((r) => r.id)).toEqual(["b"]);
	});

	it("collapses a reply-to-a-reply to the same root (single level)", () => {
		// a (root) <- b (reply) <- d (reply to the reply)
		const out = groupCommentsIntoThreads([
			c("a"),
			c("b", "a"),
			c("d", "b"),
		]);
		expect(out.map((r) => r.id)).toEqual(["a"]);
		expect(out[0].replies.map((r) => r.id)).toEqual(["b", "d"]);
	});

	it("treats a comment whose parent is absent from the list as its own root", () => {
		// parent "gone" was soft-deleted / not in the list
		const out = groupCommentsIntoThreads([c("orphan", "gone")]);
		expect(out.map((r) => r.id)).toEqual(["orphan"]);
		expect(out[0].replies).toEqual([]);
	});

	it("keeps roots and replies in chronological (input) order", () => {
		const out = groupCommentsIntoThreads([
			c("a"),
			c("b", "a"),
			c("x"),
			c("d", "a"),
		]);
		expect(out.map((r) => r.id)).toEqual(["a", "x"]);
		expect(out[0].replies.map((r) => r.id)).toEqual(["b", "d"]);
	});

	it("terminates on a parent cycle, yielding roots without hanging", () => {
		const out = groupCommentsIntoThreads([c("a", "b"), c("b", "a")]);
		// both resolve to themselves once the cycle is detected → both roots
		expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
	});

	it("does not mutate the input objects", () => {
		const input = [c("a"), c("b", "a")];
		groupCommentsIntoThreads(input);
		expect("replies" in input[0]).toBe(false);
	});
});

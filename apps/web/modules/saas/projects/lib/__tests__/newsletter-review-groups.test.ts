import { describe, expect, it } from "vitest";
import {
	groupReviewHighlights,
	moveWithinGroup,
} from "../newsletter-review-groups";

function highlight(title: string, releaseTag?: string, repo?: string) {
	return {
		title,
		description: `${title} description`,
		releaseTag,
		repoFullName: repo,
	};
}

describe("moveWithinGroup", () => {
	it.each([
		{
			name: "moves within a group",
			order: [0, 1, 2],
			group: [0, 1, 2],
			active: 2,
			over: 0,
			expected: [2, 0, 1],
		},
		{
			name: "only the group's positions change when groups interleave",
			order: [0, 1, 2, 3],
			group: [0, 2],
			active: 2,
			over: 0,
			expected: [2, 1, 0, 3],
		},
		{
			name: "a group's later member moves down past an outsider",
			order: [3, 0, 1, 2],
			group: [3, 1],
			active: 3,
			over: 1,
			expected: [1, 0, 3, 2],
		},
		{
			name: "a single-item group is a no-op",
			order: [0, 1],
			group: [1],
			active: 1,
			over: 1,
			expected: [0, 1],
		},
		{
			name: "a drop onto another group's highlight is a no-op",
			order: [0, 1, 2, 3],
			group: [0, 2],
			active: 0,
			over: 1,
			expected: [0, 1, 2, 3],
		},
		{
			name: "a group that does not match the order is a no-op",
			order: [0, 1],
			group: [0, 1, 2],
			active: 0,
			over: 2,
			expected: [0, 1],
		},
	])("$name", ({ order, group, active, over, expected }) => {
		expect(moveWithinGroup(order, group, active, over)).toEqual(expected);
	});

	it("does not mutate the order it was given", () => {
		const order = [0, 1, 2];
		moveWithinGroup(order, order, 2, 0);
		expect(order).toEqual([0, 1, 2]);
	});
});

describe("groupReviewHighlights", () => {
	it("groups like the email: newest release first, untagged last", () => {
		const highlights = [
			highlight("Untagged"),
			highlight("Old", "v1.2.0"),
			highlight("New", "v1.3.0"),
			highlight("Also old", "v1.2.0"),
		];

		const groups = groupReviewHighlights(highlights, [0, 1, 2, 3]);

		expect(groups.map((g) => [g.tag, g.indexes])).toEqual([
			["v1.3.0", [2]],
			["v1.2.0", [1, 3]],
			[null, [0]],
		]);
	});

	it("keeps the reviewer's order within a release", () => {
		const highlights = [
			highlight("A", "v1.2.0"),
			highlight("B", "v1.2.0"),
			highlight("C", "v1.2.0"),
		];

		const groups = groupReviewHighlights(highlights, [2, 0, 1]);

		expect(groups).toHaveLength(1);
		expect(groups[0].indexes).toEqual([2, 0, 1]);
	});

	it("keeps the same tag in two repositories apart", () => {
		const highlights = [
			highlight("Web", "v1.0.0", "example-org/web"),
			highlight("Api", "v1.0.0", "example-org/api"),
		];

		const groups = groupReviewHighlights(highlights, [0, 1]);

		expect(groups.map((g) => [g.repoFullName, g.indexes])).toEqual([
			["example-org/web", [0]],
			["example-org/api", [1]],
		]);
	});

	it("skips indexes that name no highlight", () => {
		const groups = groupReviewHighlights([highlight("Only")], [0, 5]);

		expect(groups.flatMap((g) => g.indexes)).toEqual([0]);
	});
});

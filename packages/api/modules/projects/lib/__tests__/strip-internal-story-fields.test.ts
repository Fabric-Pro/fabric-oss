/**
 * Regression lock for the Labels removal.
 *
 * `UserStory.labels` survives in the database as system-owned state for the
 * GitLab label↔status sync pipeline, but it must never cross a user- or
 * agent-facing boundary. The strip is a one-token destructure, so without a
 * test any refactor can silently re-expose the field — and the sync tests
 * mock `getStoryById`, so they would not notice.
 */
import { describe, expect, it } from "vitest";
import {
	stripInternalStoryFields,
	stripInternalStoryFieldsFromMany,
} from "../strip-internal-story-fields";

const storyRow = {
	id: "story-1",
	identifier: "F-001",
	title: "A feature",
	statusId: "status-1",
	priority: "P2_MEDIUM" as const,
	// Sync-owned: GitLab status label, an internal provenance marker, and a
	// legacy value a user typed before the picker was removed.
	labels: ["workflow::in-review", "supersedes:F-042", "legacy-label"],
	tags: [{ id: "tag-1", value: "checkout", createdById: "user-1" }],
};

describe("stripInternalStoryFields", () => {
	it("removes labels from the payload", () => {
		const result = stripInternalStoryFields(storyRow);
		expect(result).not.toHaveProperty("labels");
	});

	it("preserves tags — they are the user-facing classification primitive", () => {
		const result = stripInternalStoryFields(storyRow);
		expect(result.tags).toEqual([
			{ id: "tag-1", value: "checkout", createdById: "user-1" },
		]);
	});

	it("preserves every other field verbatim", () => {
		const result = stripInternalStoryFields(storyRow);
		const { labels: _dropped, ...expected } = storyRow;
		expect(result).toEqual(expected);
	});

	it("does not mutate the input row — sync reads the same object", () => {
		const row = { ...storyRow, labels: [...storyRow.labels] };
		stripInternalStoryFields(row);
		expect(row.labels).toEqual([
			"workflow::in-review",
			"supersedes:F-042",
			"legacy-label",
		]);
	});

	it("accepts a row with no labels field and returns it unchanged", () => {
		// The constraint is `object`, not `{ labels?: unknown }` — the latter is
		// a weak type, and TS would reject this call outright ("has no properties
		// in common"). This file is not type-checked (tsconfig excludes tests),
		// so the compile-time half of that contract is pinned by a probe in
		// review, not here; this asserts the runtime half.
		const { labels: _omit, ...withoutLabels } = storyRow;
		expect(() => stripInternalStoryFields(withoutLabels)).not.toThrow();
		expect(stripInternalStoryFields(withoutLabels)).toEqual(withoutLabels);
	});

	it("tolerates an empty labels array", () => {
		const result = stripInternalStoryFields({ ...storyRow, labels: [] });
		expect(result).not.toHaveProperty("labels");
	});
});

describe("stripInternalStoryFieldsFromMany", () => {
	it("strips labels from every element", () => {
		const result = stripInternalStoryFieldsFromMany([
			storyRow,
			{ ...storyRow, id: "story-2", labels: ["blocked"] },
		]);
		expect(result).toHaveLength(2);
		for (const story of result) {
			expect(story).not.toHaveProperty("labels");
		}
	});

	it("returns an empty array unchanged", () => {
		expect(stripInternalStoryFieldsFromMany([])).toEqual([]);
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("StoryWorkspace AI Readiness invalidation", () => {
	it("clears a cached assessment when the work-item kind changes", () => {
		const source = readFileSync(
			resolve(__dirname, "../StoryWorkspace.tsx"),
			"utf8",
		);
		const invalidationEffect = source.match(
			/\/\/ Clear the assessment whenever scoreable content[\s\S]*?\}, \[([\s\S]*?)\]\);/,
		)?.[1];

		expect(invalidationEffect).toBeDefined();
		expect(invalidationEffect).toContain("story.kind");
		expect(invalidationEffect).toContain("story.description");
		expect(invalidationEffect).toContain("story.acceptanceCriteria");
		expect(invalidationEffect).toContain("lastEditedAtTimestamp");
	});
});

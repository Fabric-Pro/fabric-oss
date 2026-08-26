import { describe, expect, it } from "vitest";
import { githubItemSchema } from "../src/daily-brief-schema";

const baseItem = {
	occurredAt: new Date("2026-06-01T00:00:00Z"),
	title: "Add feature",
	kind: "pr_merged" as const,
	prNumber: 1,
	repoFullName: "o/r",
	url: "https://github.com/o/r/pull/1",
	author: "octocat",
};

describe("githubItemSchema — authorGithubId", () => {
	it("accepts and round-trips authorGithubId", () => {
		const parsed = githubItemSchema.parse({
			...baseItem,
			authorGithubId: "583231",
		});
		expect(parsed.authorGithubId).toBe("583231");
	});

	it("accepts an item without authorGithubId (backward compatible)", () => {
		const parsed = githubItemSchema.parse(baseItem);
		expect(parsed.authorGithubId).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import {
	buildTopicSuggestionPrompt,
	stripPrAuthorGithubIdsForPrompt,
} from "../prompt";

describe("buildTopicSuggestionPrompt — role-aware fields", () => {
	const p = buildTopicSuggestionPrompt({ stories: [] });
	it("instructs postTypeRecommendations with type/theme/rationale", () => {
		expect(p).toContain("postTypeRecommendations");
		expect(p).toContain("theme");
		expect(p).toContain("rationale");
	});
	it("instructs relevantFunctionTags with the FunctionTag whitelist", () => {
		expect(p).toContain("relevantFunctionTags");
		expect(p).toContain("DEVELOPER");
	});
	it("no longer instructs a bare suggestedPostTypes array", () => {
		expect(p).not.toContain('"suggestedPostTypes"');
	});
	it("instructs the model to emit a short topic angle", () => {
		const prompt = buildTopicSuggestionPrompt({ stories: [] });
		expect(prompt).toContain('"angle"');
	});
});

describe("stripPrAuthorGithubIdsForPrompt (Copilot #2148)", () => {
	it("removes authorGithubId from pullRequests items while preserving other fields", () => {
		const out = stripPrAuthorGithubIdsForPrompt({
			pullRequests: [
				{ repoFullName: "o/r", prNumber: 1, authorGithubId: "583231" },
				{ repoFullName: "o/r", prNumber: 2 },
			],
		});
		expect(out.pullRequests).toEqual([
			{ repoFullName: "o/r", prNumber: 1 },
			{ repoFullName: "o/r", prNumber: 2 },
		]);
	});

	it("leaves non-pullRequests context keys untouched", () => {
		const stories = [{ id: "s1", title: "T" }];
		const out = stripPrAuthorGithubIdsForPrompt({
			stories,
			pullRequests: [],
		});
		expect(out.stories).toBe(stories);
	});

	it("returns the context unchanged when pullRequests is not an array", () => {
		const ctx = { pullRequests: "not-an-array" as unknown };
		expect(stripPrAuthorGithubIdsForPrompt(ctx)).toBe(ctx);
	});

	it("is non-mutating — the input item still carries authorGithubId", () => {
		const item = {
			repoFullName: "o/r",
			prNumber: 1,
			authorGithubId: "583231",
		};
		stripPrAuthorGithubIdsForPrompt({ pullRequests: [item] });
		expect(item.authorGithubId).toBe("583231");
	});

	it("keeps the numeric id out of the serialized prompt CONTEXT", () => {
		const stripped = stripPrAuthorGithubIdsForPrompt({
			pullRequests: [
				{ repoFullName: "o/r", prNumber: 1, authorGithubId: "583231" },
			],
		});
		const prompt = buildTopicSuggestionPrompt(stripped);
		expect(prompt).not.toContain("authorGithubId");
		expect(prompt).not.toContain("583231");
	});
});
